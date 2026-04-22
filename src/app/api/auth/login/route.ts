import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/auth";

export async function GET() {
  const url = getAuthUrl();
  return NextResponse.redirect(url);
}
