import { cookies } from "next/headers";
import crypto from "crypto";

const COOKIE_NAME = "yt_kb_session";
const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.AUTH_SECRET || "default-secret-change-me-please!!";
  return crypto.scryptSync(secret, "salt", 32);
}

function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decrypt(text: string): string {
  const key = getKey();
  const [ivHex, authTagHex, encrypted] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export interface SessionData {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  email?: string;
}

export async function getSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);
  if (!cookie?.value) return null;
  try {
    return JSON.parse(decrypt(cookie.value));
  } catch {
    return null;
  }
}

export async function setSessionCookie(data: SessionData): Promise<string> {
  const encrypted = encrypt(JSON.stringify(data));
  return encrypted;
}

export function buildSessionCookie(encrypted: string): string {
  return `${COOKIE_NAME}=${encrypted}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
