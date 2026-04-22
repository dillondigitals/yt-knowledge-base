import { NextRequest, NextResponse } from "next/server";
import { getTokensFromCode, createOAuth2Client } from "@/lib/auth";
import { setSessionCookie, buildSessionCookie } from "@/lib/session";
import { google } from "googleapis";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  if (!code) {
    return NextResponse.redirect(`${baseUrl}/?error=no_code`);
  }

  try {
    const tokens = await getTokensFromCode(code);

    // Get user email
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
    response.headers.set("Set-Cookie", buildSessionCookie(encrypted));
    return response;
  } catch (error) {
    console.error("Auth callback error:", error);
    return NextResponse.redirect(`${baseUrl}/?error=auth_failed`);
  }
}
