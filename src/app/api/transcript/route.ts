import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getSession } from "@/lib/session";
import { saveTranscriptToDrive } from "@/lib/drive";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YTDLP_PATH = process.env.YTDLP_PATH || "/Users/dillonmoses/Library/Python/3.9/bin/yt-dlp";

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function parseJson3Captions(json: string): string {
  const data = JSON.parse(json);
  const segments = data.events
    ?.filter((e: { segs?: Array<{ utf8: string }> }) => e.segs)
    .flatMap((e: { segs: Array<{ utf8: string }> }) =>
      e.segs.map((s: { utf8: string }) => s.utf8)
    )
    .filter((t: string) => t && t.trim() !== "\n" && t.trim() !== "");
  return (segments || []).join("").replace(/\n/g, " ").trim();
}

async function fetchCaptionWithYtdlp(videoId: string): Promise<string> {
  const outputPath = join(tmpdir(), `yt_caption_${videoId}_${Date.now()}`);

  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_PATH,
      [
        "--cookies-from-browser", "firefox",
        "--write-auto-sub",
        "--sub-lang", "en",
        "--skip-download",
        "--sub-format", "json3",
        "-o", outputPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 30000 },
      async (error) => {
        const captionFile = `${outputPath}.en.json3`;
        try {
          if (error) {
            // yt-dlp might still have written the file
          }
          const content = await readFile(captionFile, "utf-8");
          const transcript = parseJson3Captions(content);
          // Clean up
          unlink(captionFile).catch(() => {});
          if (transcript.length > 0) {
            resolve(transcript);
          } else {
            reject(new Error("Empty transcript"));
          }
        } catch {
          reject(new Error("No captions available for this video"));
        }
      }
    );
  });
}

export async function POST(request: NextRequest) {
  try {
    const { url, creatorSlug } = (await request.json()) as {
      url?: string;
      creatorSlug?: string;
    };

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }
    if (!YOUTUBE_API_KEY) {
      return NextResponse.json(
        { error: "YouTube API key not configured" },
        { status: 500 }
      );
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
    }

    // Get video metadata via YouTube Data API v3
    const youtube = google.youtube({ version: "v3", auth: YOUTUBE_API_KEY });
    const videoRes = await youtube.videos.list({
      part: ["snippet", "contentDetails"],
      id: [videoId],
    });

    const videoInfo = videoRes.data.items?.[0];
    if (!videoInfo) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const title = videoInfo.snippet?.title || "Untitled";
    const channelTitle = videoInfo.snippet?.channelTitle || "";
    const publishedAt = videoInfo.snippet?.publishedAt || "";
    const duration = videoInfo.contentDetails?.duration || "";

    // Fetch captions using yt-dlp with browser cookies
    let transcript = "";
    try {
      transcript = await fetchCaptionWithYtdlp(videoId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Caption fetch failed";
      return NextResponse.json(
        { error: `${msg}: ${title}` },
        { status: 404 }
      );
    }

    // Best-effort: save to the unified Aria knowledge base in Drive so
    // the Clarity Compass KB Agent has the same content. Doesn't block the
    // response if Drive isn't authorized or the env var isn't set.
    let drive: { fileId: string; folderPath: string; webViewLink?: string | null } | null = null;
    let driveWarning: string | null = null;
    const ariaFolderId = process.env.ARIA_FOLDER_ID;
    if (ariaFolderId && creatorSlug) {
      try {
        const session = await getSession();
        if (session?.access_token) {
          const saved = await saveTranscriptToDrive(session, {
            ariaFolderId,
            creatorSlug,
            videoId,
            title,
            transcript,
          });
          drive = saved;
        } else {
          driveWarning = "not signed in — transcript not saved to Drive";
        }
      } catch (e) {
        driveWarning = e instanceof Error ? e.message : "Drive save failed";
      }
    } else if (!ariaFolderId) {
      driveWarning = "ARIA_FOLDER_ID not set on server — transcript not saved to Drive";
    } else if (!creatorSlug) {
      driveWarning = "creatorSlug missing in request — transcript not saved to Drive";
    }

    return NextResponse.json({
      videoId,
      title,
      channelTitle,
      publishedAt,
      duration,
      transcript,
      url,
      charCount: transcript.length,
      drive,
      driveWarning,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Transcript error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
