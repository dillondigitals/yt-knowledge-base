import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const baseUrl = request.nextUrl.origin;
  const response = NextResponse.redirect(`${baseUrl}/`);
  response.cookies.set({
    name: "yt_kb_session",
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
