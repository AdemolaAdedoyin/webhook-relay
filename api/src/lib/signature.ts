import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Webhook payloads are signed the way Stripe/GitHub do it: a timestamp is
 * mixed into the signed string so a captured request can't be replayed
 * indefinitely, and the header carries both the timestamp and the digest.
 *
 *   Webhook-Signature: t=1699999999,v1=<hex hmac-sha256>
 *
 * Receivers should recompute the HMAC over `${t}.${rawBody}` using the
 * shared secret and compare with `verifySignature`, then reject requests
 * whose timestamp is too old to stop replay attacks.
 */

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export function signPayload(rawBody: string, secret: string, timestamp: number = Date.now()): string {
  const signedContent = `${timestamp}.${rawBody}`;
  const digest = createHmac("sha256", secret).update(signedContent).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifySignature(
  rawBody: string,
  secret: string,
  signatureHeader: string,
  toleranceMs = 5 * 60 * 1000
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => part.split("=") as [string, string])
  );
  const timestamp = Number(parts.t);
  const providedDigest = parts.v1;
  if (!timestamp || !providedDigest) return false;
  if (Math.abs(Date.now() - timestamp) > toleranceMs) return false;

  const expectedDigest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  const expected = Buffer.from(expectedDigest, "hex");
  const provided = Buffer.from(providedDigest, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
