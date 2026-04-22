import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

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

async function fetchCaptionText(videoId: string): Promise<string> {
  // Strategy 1: Fetch the watch page with consent bypass and extract signed caption URLs
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

  if (!pageRes.ok) {
    throw new Error(`Failed to fetch video page (${pageRes.status})`);
  }

  const html = await pageRes.text();

  // Try to extract caption tracks from the player response
  const captionTracksMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
  if (captionTracksMatch) {
    try {
      const rawJson = captionTracksMatch[1]
        .replace(/\\u0026/g, "&")
        .replace(/\\"/g, '"');
      const tracks = JSON.parse(rawJson);

      if (tracks && tracks.length > 0) {
        // Prefer English manual captions, then English ASR, then first
        const enManual = tracks.find(
          (t: { languageCode: string; kind?: string }) =>
            t.languageCode === "en" && t.kind !== "asr"
        );
        const enAsr = tracks.find(
          (t: { languageCode: string }) => t.languageCode === "en"
        );
        const track = enManual || enAsr || tracks[0];

        if (track?.baseUrl) {
          // Try fetching caption content
          const fetchHeaders = {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          };

          // Try JSON3 format first
          const json3Res = await fetch(track.baseUrl + "&fmt=json3", {
            headers: fetchHeaders,
          });
          if (json3Res.ok) {
            const body = await json3Res.text();
            if (body.length > 0 && body.startsWith("{")) {
              return parseJson3Captions(body);
            }
          }

          // Try XML format
          const xmlRes = await fetch(track.baseUrl, {
            headers: fetchHeaders,
          });
          if (xmlRes.ok) {
            const body = await xmlRes.text();
            if (body.includes("<text")) {
              return parseXmlCaptions(body);
            }
          }
        }
      }
    } catch {
      // Fall through to Strategy 2
    }
  }

  // Strategy 2: Use the unsigned timedtext endpoint
  // This works when the watch page doesn't include caption URLs (cloud IPs)
  const formats = ["json3", "srv3", ""];
  const kinds = ["asr", ""];
  const langs = ["en", "en-US"];

  for (const lang of langs) {
    for (const kind of kinds) {
      for (const fmt of formats) {
        const params = new URLSearchParams({
          v: videoId,
          lang,
        });
        if (kind) params.set("kind", kind);
        if (fmt) params.set("fmt", fmt);

        const url = `https://video.google.com/timedtext?${params.toString()}`;
        try {
          const res = await fetch(url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
          });

          if (res.ok) {
            const body = await res.text();
            if (body.length > 100) {
              if (body.startsWith("{")) {
                return parseJson3Captions(body);
              }
              if (body.includes("<text")) {
                return parseXmlCaptions(body);
              }
            }
          }
        } catch {
          continue;
        }
      }
    }
  }

  throw new Error("No captions available for this video");
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (!YOUTUBE_API_KEY) {
      return NextResponse.json(
        {
          error:
            "YouTube API key not configured. Set YOUTUBE_API_KEY in .env.local",
        },
        { status: 500 }
      );
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return NextResponse.json(
        { error: "Invalid YouTube URL" },
        { status: 400 }
      );
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

    // Get transcript using multiple strategies
    const transcript = await fetchCaptionText(videoId);

    if (!transcript || transcript.length === 0) {
      return NextResponse.json(
        { error: "Captions returned empty for this video" },
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
