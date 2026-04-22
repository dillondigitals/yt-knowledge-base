import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getSession } from "@/lib/session";
import { createOAuth2Client, refreshAccessToken } from "@/lib/auth";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

function parseXmlCaptions(xml: string): string {
  const segments: string[] = [];
  const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(xml)) !== null) {
    const text = decodeHtmlEntities(match[1]);
    if (text) segments.push(text);
  }
  return segments.join(" ");
}

function parseJson3Captions(json: string): string {
  const data = JSON.parse(json);
  const segments = data.events
    ?.filter((e: { segs?: Array<{ utf8: string }> }) => e.segs)
    .flatMap((e: { segs: Array<{ utf8: string }> }) =>
      e.segs.map((s: { utf8: string }) => s.utf8)
    )
    .filter((t: string) => t && t.trim() !== "\n");
  return (segments || []).join("").replace(/\n/g, " ").trim();
}

async function fetchCaptionWithAuth(
  videoId: string,
  accessToken: string
): Promise<string> {
  // Use YouTube Data API with OAuth2 to get caption track details
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const youtube = google.youtube({ version: "v3", auth: client });

  // List caption tracks for this video (OAuth2 gives more access than API key)
  const captionsRes = await youtube.captions.list({
    part: ["snippet"],
    videoId,
  });

  const tracks = captionsRes.data.items || [];
  if (tracks.length === 0) {
    throw new Error("No caption tracks found via API");
  }

  // Find the best English track
  const enManual = tracks.find(
    (t) => t.snippet?.language === "en" && t.snippet?.trackKind !== "ASR"
  );
  const enAsr = tracks.find((t) => t.snippet?.language === "en");
  const track = enManual || enAsr || tracks[0];
  const lang = track?.snippet?.language || "en";
  const kind = track?.snippet?.trackKind === "ASR" ? "asr" : "";

  // Try multiple approaches to fetch the actual caption text

  // Approach 1: timedtext endpoint with OAuth Bearer token
  const timedtextParams = new URLSearchParams({
    v: videoId,
    lang,
    fmt: "json3",
  });
  if (kind) timedtextParams.set("kind", kind);

  for (const host of [
    "www.youtube.com",
    "video.google.com",
  ]) {
    const url = `https://${host}/api/timedtext?${timedtextParams.toString()}`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      });
      if (res.ok) {
        const body = await res.text();
        if (body.length > 100 && body.startsWith("{")) {
          return parseJson3Captions(body);
        }
      }
    } catch {
      continue;
    }

    // Try XML format
    timedtextParams.delete("fmt");
    const xmlUrl = `https://${host}/api/timedtext?${timedtextParams.toString()}`;
    try {
      const res = await fetch(xmlUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (res.ok) {
        const body = await res.text();
        if (body.includes("<text")) {
          return parseXmlCaptions(body);
        }
      }
    } catch {
      continue;
    }
  }

  // Approach 2: Fetch the watch page with auth cookie exchange
  // Use the access token to get a YouTube page with full player response
  const pageRes = await fetch(
    `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&ucbcb=1`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }
  );

  if (pageRes.ok) {
    const html = await pageRes.text();
    const captionTracksMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (captionTracksMatch) {
      const rawJson = captionTracksMatch[1]
        .replace(/\\u0026/g, "&")
        .replace(/\\"/g, '"');
      const pageTracks = JSON.parse(rawJson);
      const enTrack =
        pageTracks.find(
          (t: { languageCode: string; kind?: string }) =>
            t.languageCode === "en" && t.kind !== "asr"
        ) ||
        pageTracks.find(
          (t: { languageCode: string }) => t.languageCode === "en"
        ) ||
        pageTracks[0];

      if (enTrack?.baseUrl) {
        const captionRes = await fetch(enTrack.baseUrl + "&fmt=json3", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "Mozilla/5.0",
          },
        });
        if (captionRes.ok) {
          const body = await captionRes.text();
          if (body.length > 100 && body.startsWith("{")) {
            return parseJson3Captions(body);
          }
        }
        // Try without fmt
        const xmlRes = await fetch(enTrack.baseUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "Mozilla/5.0",
          },
        });
        if (xmlRes.ok) {
          const body = await xmlRes.text();
          if (body.includes("<text")) {
            return parseXmlCaptions(body);
          }
        }
      }
    }
  }

  throw new Error("Failed to download captions with auth");
}

async function fetchCaptionUnauthenticated(videoId: string): Promise<string> {
  // Fallback: try watch page scraping + timedtext
  const pageRes = await fetch(
    `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&ucbcb=1`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }
  );

  if (!pageRes.ok) throw new Error("Failed to fetch video page");
  const html = await pageRes.text();

  const captionTracksMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
  if (!captionTracksMatch) {
    throw new Error("No captions found - sign in with Google for better results");
  }

  const rawJson = captionTracksMatch[1]
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"');
  const tracks = JSON.parse(rawJson);
  const enTrack =
    tracks.find(
      (t: { languageCode: string; kind?: string }) =>
        t.languageCode === "en" && t.kind !== "asr"
    ) ||
    tracks.find((t: { languageCode: string }) => t.languageCode === "en") ||
    tracks[0];

  if (!enTrack?.baseUrl) throw new Error("No caption URL");

  const res = await fetch(enTrack.baseUrl + "&fmt=json3", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (res.ok) {
    const body = await res.text();
    if (body.startsWith("{")) return parseJson3Captions(body);
  }

  const xmlRes = await fetch(enTrack.baseUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (xmlRes.ok) {
    const body = await xmlRes.text();
    if (body.includes("<text")) return parseXmlCaptions(body);
  }

  throw new Error("Caption download failed - sign in with Google for better results");
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

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

    // Try to get OAuth session for authenticated caption fetching
    let transcript = "";
    const session = await getSession();

    if (session?.access_token) {
      let accessToken = session.access_token;

      // Refresh token if expired
      if (session.expiry_date && Date.now() > session.expiry_date && session.refresh_token) {
        try {
          const newCreds = await refreshAccessToken(session.refresh_token);
          accessToken = newCreds.access_token || accessToken;
        } catch {
          // Use existing token
        }
      }

      try {
        transcript = await fetchCaptionWithAuth(videoId, accessToken);
      } catch (authError) {
        console.error("Auth caption fetch failed, trying unauthenticated:", authError);
        // Fall through to unauthenticated
      }
    }

    if (!transcript) {
      try {
        transcript = await fetchCaptionUnauthenticated(videoId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Failed to get captions";
        return NextResponse.json({ error: msg }, { status: 404 });
      }
    }

    if (!transcript || transcript.length === 0) {
      return NextResponse.json(
        { error: "Captions returned empty" },
        { status: 404 }
      );
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
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Transcript error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
