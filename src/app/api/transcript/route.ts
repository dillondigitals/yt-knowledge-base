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

    // If the client already fetched the transcript (browser-side), use it
    if (clientTranscript && clientTranscript.length > 0) {
      return NextResponse.json({
        videoId,
        title,
        channelTitle,
        publishedAt,
        duration,
        transcript: clientTranscript,
        url,
        charCount: clientTranscript.length,
      });
    }

    // Otherwise return metadata + videoId so client can fetch captions
    return NextResponse.json({
      videoId,
      title,
      channelTitle,
      publishedAt,
      duration,
      transcript: "",
      url,
      charCount: 0,
      needsClientFetch: true,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Transcript error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
