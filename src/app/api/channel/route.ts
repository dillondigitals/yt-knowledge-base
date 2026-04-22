import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

export async function POST(request: NextRequest) {
  try {
    const { channel } = await request.json();

    if (!channel) {
      return NextResponse.json(
        { error: "Channel URL or handle is required" },
        { status: 400 }
      );
    }

    if (!YOUTUBE_API_KEY) {
      return NextResponse.json(
        { error: "YouTube API key not configured. Set YOUTUBE_API_KEY in .env.local" },
        { status: 500 }
      );
    }

    const youtube = google.youtube({ version: "v3", auth: YOUTUBE_API_KEY });

    // Extract handle from various input formats
    let handle = channel.trim();
    if (handle.includes("youtube.com/")) {
      const match = handle.match(/youtube\.com\/(@[\w.-]+)/);
      if (match) handle = match[1];
    }
    if (handle.startsWith("@")) {
      handle = handle.substring(1);
    }

    // Search for the channel by handle
    const searchRes = await youtube.search.list({
      part: ["snippet"],
      q: handle,
      type: ["channel"],
      maxResults: 1,
    });

    const channelResult = searchRes.data.items?.[0];
    if (!channelResult?.snippet?.channelId) {
      return NextResponse.json(
        { error: "Channel not found" },
        { status: 404 }
      );
    }

    const channelId = channelResult.snippet.channelId;

    // Get all video uploads from the channel
    // First, get the uploads playlist ID
    const channelRes = await youtube.channels.list({
      part: ["contentDetails"],
      id: [channelId],
    });

    const uploadsPlaylistId =
      channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsPlaylistId) {
      return NextResponse.json(
        { error: "Could not find uploads playlist" },
        { status: 404 }
      );
    }

    // Fetch all videos from uploads playlist (paginated)
    const urls: string[] = [];
    let nextPageToken: string | undefined;

    do {
      const playlistRes = await youtube.playlistItems.list({
        part: ["contentDetails"],
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken: nextPageToken,
      });

      const items = playlistRes.data.items || [];
      for (const item of items) {
        const videoId = item.contentDetails?.videoId;
        if (videoId) {
          urls.push(`https://www.youtube.com/watch?v=${videoId}`);
        }
      }

      nextPageToken = playlistRes.data.nextPageToken || undefined;
    } while (nextPageToken && urls.length < 500);

    if (urls.length === 0) {
      return NextResponse.json(
        { error: "No videos found for this channel" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      channelId,
      channelName: channelResult.snippet.title,
      urls,
      count: urls.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Channel error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
