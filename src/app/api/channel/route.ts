import { NextRequest, NextResponse } from "next/server";
import { google, youtube_v3 } from "googleapis";

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

    // Accept: bare handle, @handle, youtube.com/@handle, /channel/UC…, bare UC…,
    // /user/Username (legacy), /c/CustomName (legacy).
    // Quota: id/handle/username = 1 unit; customName falls back to search.list = 100 units.
    const input = channel.trim();
    const part = ["snippet", "contentDetails"];

    const channelIdMatch = input.match(/youtube\.com\/channel\/(UC[\w-]{20,})/);
    const handleUrlMatch = input.match(/youtube\.com\/(@[\w.-]+)/);
    const userUrlMatch = input.match(/youtube\.com\/user\/([\w.-]+)/);
    const customUrlMatch = input.match(/youtube\.com\/c\/([\w.-]+)/);

    let listParams: youtube_v3.Params$Resource$Channels$List;
    if (channelIdMatch) {
      listParams = { part, id: [channelIdMatch[1]] };
    } else if (/^UC[\w-]{20,}$/.test(input)) {
      listParams = { part, id: [input] };
    } else if (handleUrlMatch) {
      listParams = { part, forHandle: handleUrlMatch[1].slice(1) };
    } else if (userUrlMatch) {
      listParams = { part, forUsername: userUrlMatch[1] };
    } else if (customUrlMatch) {
      // No cheap lookup for legacy /c/ URLs — resolve via search.list (100 units).
      console.warn("Resolving /c/ URL via search.list — costs 100 quota units");
      const searchRes = await youtube.search.list({
        part: ["snippet"],
        q: customUrlMatch[1],
        type: ["channel"],
        maxResults: 1,
      });
      const foundId = searchRes.data.items?.[0]?.snippet?.channelId;
      if (!foundId) {
        return NextResponse.json({ error: "Channel not found" }, { status: 404 });
      }
      listParams = { part, id: [foundId] };
    } else {
      listParams = { part, forHandle: input.startsWith("@") ? input.slice(1) : input };
    }

    const channelRes = await youtube.channels.list(listParams);

    const channelData = channelRes.data.items?.[0];
    if (!channelData?.id) {
      return NextResponse.json(
        { error: "Channel not found" },
        { status: 404 }
      );
    }

    const resolvedChannelId = channelData.id;
    const uploadsPlaylistId =
      channelData.contentDetails?.relatedPlaylists?.uploads;

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
      channelId: resolvedChannelId,
      channelName: channelData.snippet?.title,
      urls,
      count: urls.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Channel error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
