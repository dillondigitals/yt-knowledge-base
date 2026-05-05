import { NextRequest, NextResponse } from "next/server";
import { getTokensFromCode, createOAuth2Client } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";
import { google } from "googleapis";

export async function GET(request: NextRequest) {
  // Always redirect back to the same origin the user landed on. Hard-coding via
  // NEXT_PUBLIC_BASE_URL caused the cookie to be set on one origin while the
  // browser was sent to another — the session looked like it never persisted.
  const baseUrl = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${baseUrl}/?error=no_code`);
  }

  try {
    const tokens = await getTokensFromCode(code);

    let email = "";
    try {
      const client = createOAuth2Client();
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const userInfo = await oauth2.userinfo.get();
      email = userInfo.data.email || "";
    } catch {
      // Non-critical
    }

    const encrypted = await setSessionCookie({
      access_token: tokens.access_token || "",
      refresh_token: tokens.refresh_token || undefined,
      expiry_date: tokens.expiry_date || undefined,
      email,
    });

    const response = NextResponse.redirect(`${baseUrl}/`);
    // Use the Next cookies API instead of raw Set-Cookie header — Netlify's CDN
    // sometimes strips Set-Cookie on 3xx redirects when set via headers.set().
    response.cookies.set({
      name: "yt_kb_session",
      value: encrypted,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return response;
  } catch (error) {
    console.error("Auth callback error:", error);
    return NextResponse.redirect(`${baseUrl}/?error=auth_failed`);
  }
}
