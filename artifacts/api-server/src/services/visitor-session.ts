import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

const COOKIE_NAME = "transit_visitor";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function signatureFor(id: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET must be configured to protect route history.");
  return createHmac("sha256", secret).update(id).digest("hex");
}

function isValidCookie(value: string | undefined): string | null {
  if (!value) return null;
  const [id, suppliedSignature] = value.split(".");
  if (!id || !suppliedSignature || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expectedSignature = signatureFor(id);
  const supplied = Buffer.from(suppliedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? id : null;
}

export function getVisitorId(req: Request, res: Response): string {
  const existingId = isValidCookie(req.cookies?.[COOKIE_NAME]);
  if (existingId) return existingId;

  const id = randomUUID();
  res.cookie(COOKIE_NAME, `${id}.${signatureFor(id)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api",
    maxAge: MAX_AGE_SECONDS * 1000,
  });
  return id;
}
