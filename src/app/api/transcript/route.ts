import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import Innertube from "youtubei.js";

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

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (res.status !== 429) return res;
    // Wait before retrying (exponential backoff)
    await sleep(2000 * (i + 1));
  }
  // Last attempt
  return fetch(url);
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

    // Get caption track URL via Innertube (youtubei.js)
    // This gives us the signed timedtext URL
    const yt = await Innertube.create({ lang: "en", location: "US" });
    const info = await yt.getBasicInfo(videoId);
    const captionTracks = info.captions?.caption_tracks;

    if (!captionTracks || captionTracks.length === 0) {
      return NextResponse.json(
        { error: "No captions available for this video" },
        { status: 404 }
      );
    }

    // Prefer English standard captions, then any English, then first available
    const enStandard = captionTracks.find(
      (t) => t.language_code === "en" && t.kind !== "asr"
    );
    const enAny = captionTracks.find((t) => t.language_code === "en");
    const track = enStandard || enAny || captionTracks[0];

    if (!track.base_url) {
      return NextResponse.json(
        { error: "Caption track URL not found" },
        { status: 404 }
      );
    }

    // Fetch the caption content with retry logic
    const captionRes = await fetchWithRetry(track.base_url + "&fmt=json3");

    if (!captionRes.ok) {
      // If timedtext is rate-limited, try the raw XML URL
      const xmlRes = await fetchWithRetry(track.base_url);
      if (!xmlRes.ok) {
        return NextResponse.json(
          {
            error: `Captions temporarily unavailable (rate limited). Try again in a few minutes.`,
          },
          { status: 429 }
        );
      }

      const xmlBody = await xmlRes.text();
      const segments: string[] = [];
      const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
      let match;
      while ((match = textRegex.exec(xmlBody)) !== null) {
        const text = decodeHtmlEntities(match[1]);
        if (text) segments.push(text);
      }

      const transcript = segments.join(" ");
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
    }

    const captionBody = await captionRes.text();

    let transcript = "";
    if (captionBody.startsWith("{")) {
      // JSON3 format
      const ttData = JSON.parse(captionBody);
      const segments = ttData.events
        ?.filter((e: { segs?: Array<{ utf8: string }> }) => e.segs)
        .flatMap((e: { segs: Array<{ utf8: string }> }) =>
          e.segs.map((s: { utf8: string }) => s.utf8)
        )
        .filter((t: string) => t && t.trim() !== "\n");
      transcript = (segments || []).join("").replace(/\n/g, " ").trim();
    } else {
      // XML format
      const segments: string[] = [];
      const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
      let match;
      while ((match = textRegex.exec(captionBody)) !== null) {
        const text = decodeHtmlEntities(match[1]);
        if (text) segments.push(text);
      }
      transcript = segments.join(" ");
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
