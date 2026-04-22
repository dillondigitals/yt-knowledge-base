import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const CAPTION_PROXY = process.env.CAPTION_PROXY_URL || "";

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

async function fetchCaptionViaProxy(videoId: string): Promise<string> {
  if (!CAPTION_PROXY) {
    throw new Error("Caption proxy not configured");
  }

  const proxyUrl = `${CAPTION_PROXY}?v=${videoId}&lang=en`;
  const res = await fetch(proxyUrl, { redirect: "follow" });

  if (!res.ok) {
    throw new Error(`Proxy returned ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error);
  }

  const body = data.transcript || "";
  if (!body || body.length < 50) {
    throw new Error("Empty transcript from proxy");
  }

  if (data.format === "json3" || body.startsWith("{")) {
    return parseJson3Captions(body);
  }
  if (body.includes("<text")) {
    return parseXmlCaptions(body);
  }

  return body;
}

async function fetchCaptionDirect(videoId: string): Promise<string> {
  // Direct fetch - works from residential IPs (localhost)
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
    throw new Error("No captions in page");
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
    if (body.length > 50 && body.startsWith("{")) return parseJson3Captions(body);
  }

  const xmlRes = await fetch(enTrack.baseUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (xmlRes.ok) {
    const body = await xmlRes.text();
    if (body.includes("<text")) return parseXmlCaptions(body);
  }

  throw new Error("Failed to download captions");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, transcript: clientTranscript } = body;

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

    // Use client-provided transcript if available (fetched from browser via proxy)
    let transcript = clientTranscript || "";

    // If no client transcript, try server-side strategies
    if (!transcript) {
      // Strategy 1: Google Apps Script proxy (server-side)
      if (CAPTION_PROXY) {
        try {
          transcript = await fetchCaptionViaProxy(videoId);
        } catch (e) {
          console.error("Proxy caption fetch failed:", e);
        }
      }

      // Strategy 2: Direct fetch (works from residential IPs / localhost)
      if (!transcript) {
        try {
          transcript = await fetchCaptionDirect(videoId);
        } catch (e) {
          console.error("Direct caption fetch failed:", e);
        }
      }
    }

    if (!transcript || transcript.length === 0) {
      return NextResponse.json(
        { error: `No captions available for: ${title}` },
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
