import { verifyToken } from "@clerk/backend";
import type { IncomingMessage } from "node:http";

export function clerkPublishableKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
    process.env.CLERK_PUBLISHABLE_KEY
  );
}

export async function sessionUserId(
  request: IncomingMessage,
): Promise<string | undefined> {
  const tokenHeader = request.headers["x-clerk-session-token"];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!token || !secretKey) return undefined;

  try {
    const host = request.headers.host;
    const protocolHeader = request.headers["x-forwarded-proto"];
    const protocol = Array.isArray(protocolHeader)
      ? protocolHeader[0]
      : protocolHeader ?? "https";
    const verified = await verifyToken(token, {
      secretKey,
      ...(host ? { authorizedParties: [`${protocol}://${host}`] } : {}),
    });
    return typeof verified.sub === "string" ? verified.sub : undefined;
  } catch {
    return undefined;
  }
}
