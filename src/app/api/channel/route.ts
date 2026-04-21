import { NextRequest, NextResponse } from "next/server";

async function getChannelVideos(channelInput: string): Promise<string[]> {
  // Resolve channel URL to get the videos page
  let channelUrl: string;

  if (channelInput.startsWith("@")) {
    channelUrl = `https://www.youtube.com/${channelInput}/videos`;
  } else if (channelInput.includes("youtube.com")) {
    channelUrl = channelInput.replace(/\/$/, "");
    if (!channelUrl.endsWith("/videos")) {
      channelUrl += "/videos";
    }
  } else {
    channelUrl = `https://www.youtube.com/@${channelInput}/videos`;
  }

  const res = await fetch(channelUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const html = await res.text();

  // Extract video IDs from the page's initial data
  const videoIds = new Set<string>();

  // Match video IDs from ytInitialData
  const idPattern = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;
  while ((match = idPattern.exec(html)) !== null) {
    videoIds.add(match[1]);
  }

  return Array.from(videoIds).map(
    (id) => `https://www.youtube.com/watch?v=${id}`
  );
}

export async function POST(request: NextRequest) {
  try {
    const { channel } = await request.json();

    if (!channel) {
      return NextResponse.json(
        { error: "Channel URL or handle is required" },
        { status: 400 }
      );
    }

    const urls = await getChannelVideos(channel);

    if (urls.length === 0) {
      return NextResponse.json(
        { error: "No videos found for this channel" },
        { status: 404 }
      );
    }

    return NextResponse.json({ urls, count: urls.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
