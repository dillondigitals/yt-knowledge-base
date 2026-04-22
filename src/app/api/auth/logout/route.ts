import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session";

export async function POST() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const response = NextResponse.redirect(`${baseUrl}/`);
  response.headers.set("Set-Cookie", clearSessionCookie());
  return response;
}
