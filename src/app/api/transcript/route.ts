import { NextRequest, NextResponse } from "next/server";

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

interface TranscriptSegment {
  text: string;
  offset: number;
  duration: number;
}

async function fetchTranscript(videoId: string): Promise<{ title: string; transcript: string }> {
  // Fetch the video page to get title and caption track info
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const html = await pageRes.text();

  // Extract title
  const titleMatch = html.match(/<title>(.+?)<\/title>/);
  const title = titleMatch
    ? titleMatch[1].replace(" - YouTube", "").trim()
    : "Untitled";

  // Extract captions player response
  const playerMatch = html.match(new RegExp("ytInitialPlayerResponse\\s*=\\s*({.+?});", "s"));
  if (!playerMatch) {
    throw new Error("Could not find player response");
  }

  let playerResponse;
  try {
    playerResponse = JSON.parse(playerMatch[1]);
  } catch {
    throw new Error("Failed to parse player response");
  }

  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) {
    throw new Error("No captions available for this video");
  }

  // Prefer English captions, fall back to first available
  const englishTrack = captionTracks.find(
    (t: { languageCode: string }) => t.languageCode === "en" || t.languageCode === "en-US"
  );
  const track = englishTrack || captionTracks[0];
  const captionUrl = track.baseUrl;

  // Fetch the caption XML
  const captionRes = await fetch(captionUrl);
  const captionXml = await captionRes.text();

  // Parse the XML to extract text segments
  const segments: string[] = [];
  const textRegex = /<text[^>]*>([^<]*)<\/text>/g;
  let match;
  while ((match = textRegex.exec(captionXml)) !== null) {
    let text = match[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, " ")
      .trim();
    if (text) segments.push(text);
  }

  const transcript = segments.join(" ");
  return { title, transcript };
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
    }

    const { title, transcript } = await fetchTranscript(videoId);

    return NextResponse.json({
      videoId,
      title,
      transcript,
      url,
      charCount: transcript.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
