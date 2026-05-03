import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(request: NextRequest) {
  try {
    const { messages, creatorName, transcriptContext } = await request.json();

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Messages required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const systemPrompt = `You are an expert analyst of ${creatorName}'s content and teachings. You have access to transcripts from their YouTube videos provided below.

Your role:
- Answer questions about ${creatorName}'s teachings, frameworks, and advice
- Quote directly from the transcripts when possible, citing the video title
- Identify patterns, recurring themes, and key principles across videos
- Compare and contrast ideas from different videos
- Help the user apply ${creatorName}'s frameworks to their own business/content

When quoting, use the format: "${creatorName} said: '...' (from: Video Title)"

Be conversational but thorough. If something isn't covered in the transcripts, say so clearly.

${transcriptContext ? `\n\n--- TRANSCRIPTS ---\n\n${transcriptContext}` : "\n\nNo transcripts loaded yet. Ask the user to build the knowledge base first."}`;

    const stream = await client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    // Stream the response
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
            );
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Chat error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
