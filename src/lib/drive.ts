import { google } from "googleapis";
import { createOAuth2Client } from "./auth";
import type { SessionData } from "./session";

export function getDriveClient(session: SessionData) {
  const oauth = createOAuth2Client();
  oauth.setCredentials({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expiry_date: session.expiry_date,
  });
  return google.drive({ version: "v3", auth: oauth });
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

export async function ensureFolder(
  session: SessionData,
  name: string,
  parentId: string
): Promise<string> {
  const drive = getDriveClient(session);
  const escaped = name.replace(/'/g, "\\'");
  const q = `'${parentId}' in parents and name = '${escaped}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const found = await drive.files.list({ q, fields: "files(id, name)" });
  if (found.data.files && found.data.files.length > 0) {
    return found.data.files[0].id!;
  }
  const created = await drive.files.create({
    requestBody: { name, parents: [parentId], mimeType: FOLDER_MIME },
    fields: "id",
  });
  return created.data.id!;
}

export interface SavedTranscript {
  fileId: string;
  fileName: string;
  webViewLink?: string | null;
  folderPath: string;
}

/**
 * Save a transcript text file to Drive at:
 *   <ARIA_FOLDER_ID>/transcripts/<creatorSlug>/<videoId>.txt
 * Idempotent — if a file with the same name exists in the creator folder,
 * its content is replaced.
 */
export async function saveTranscriptToDrive(
  session: SessionData,
  opts: {
    ariaFolderId: string;
    creatorSlug: string;
    videoId: string;
    title: string;
    transcript: string;
  }
): Promise<SavedTranscript> {
  const drive = getDriveClient(session);
  const transcriptsFolderId = await ensureFolder(session, "transcripts", opts.ariaFolderId);
  const creatorFolderId = await ensureFolder(session, opts.creatorSlug, transcriptsFolderId);

  const fileName = `${opts.videoId}.txt`;
  const body =
    `# ${opts.title}\n` +
    `videoId: ${opts.videoId}\n` +
    `creator: ${opts.creatorSlug}\n` +
    `extractedAt: ${new Date().toISOString()}\n` +
    `\n---\n\n` +
    opts.transcript;

  const existing = await drive.files.list({
    q: `'${creatorFolderId}' in parents and name = '${fileName}' and trashed = false`,
    fields: "files(id, name, webViewLink)",
  });

  if (existing.data.files && existing.data.files.length > 0) {
    const fileId = existing.data.files[0].id!;
    await drive.files.update({
      fileId,
      media: { mimeType: "text/plain", body },
    });
    return {
      fileId,
      fileName,
      webViewLink: existing.data.files[0].webViewLink,
      folderPath: `transcripts/${opts.creatorSlug}/${fileName}`,
    };
  }

  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [creatorFolderId], mimeType: "text/plain" },
    media: { mimeType: "text/plain", body },
    fields: "id, name, webViewLink",
  });
  return {
    fileId: created.data.id!,
    fileName,
    webViewLink: created.data.webViewLink,
    folderPath: `transcripts/${opts.creatorSlug}/${fileName}`,
  };
}
