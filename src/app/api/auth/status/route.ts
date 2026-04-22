import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  if (session?.access_token) {
    return NextResponse.json({
      authenticated: true,
      email: session.email || "Connected",
    });
  }
  return NextResponse.json({ authenticated: false });
}
