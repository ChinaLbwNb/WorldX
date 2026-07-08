import type { Request } from "express";
import { DEFAULT_USER_ID } from "../store/user-character-store.js";
import * as authStore from "../store/auth-store.js";

const USER_ID_MAX_LENGTH = 64;

export function normalizeUserId(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_USER_ID;
  const value = raw.trim().slice(0, USER_ID_MAX_LENGTH);
  if (!value) return DEFAULT_USER_ID;
  return value.replace(/[^\w:.-]/g, "_");
}

export function getRequestUserId(req: Request): string {
  const authUser = getAuthenticatedUser(req);
  if (authUser) return authUser.id;
  const headerValue = req.header("x-user-id");
  if (headerValue) return normalizeUserId(headerValue);
  if (typeof req.query.userId === "string") return normalizeUserId(req.query.userId);
  return normalizeUserId(req.body?.userId);
}

export function getBearerToken(req: Request): string {
  const auth = req.header("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();
  if (typeof req.query.token === "string") return req.query.token.trim();
  const cookieToken = parseCookie(req.header("cookie") ?? "").worldx_session;
  if (cookieToken) return cookieToken;
  return (req.header("x-session-token") ?? "").trim();
}

export function getAuthenticatedUser(req: Request): authStore.AuthUser | null {
  const token = getBearerToken(req);
  return token ? authStore.getUserByToken(token) : null;
}

export function requireAuthenticatedUser(req: Request): authStore.AuthUser {
  const user = getAuthenticatedUser(req);
  if (!user) {
    const error = new Error("Authentication required") as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return user;
}

function parseCookie(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key || rest.length === 0) continue;
    out[key] = decodeURIComponent(rest.join("="));
  }
  return out;
}
