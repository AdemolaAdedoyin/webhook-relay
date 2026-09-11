import { describe, it, expect } from "vitest";
import { signPayload, verifySignature, generateSecret } from "../lib/signature";

describe("webhook signature", () => {
  const secret = "whsec_testsecret";
  const body = JSON.stringify({ hello: "world" });

  it("produces a signature that verifies successfully", () => {
    const sig = signPayload(body, secret);
    expect(verifySignature(body, secret, sig)).toBe(true);
  });

  it("rejects a signature verified with the wrong secret", () => {
    const sig = signPayload(body, secret);
    expect(verifySignature(body, "whsec_wrong", sig)).toBe(false);
  });

  it("rejects a signature if the body was tampered with", () => {
    const sig = signPayload(body, secret);
    const tampered = JSON.stringify({ hello: "world!!" });
    expect(verifySignature(tampered, secret, sig)).toBe(false);
  });

  it("rejects a stale signature outside the tolerance window", () => {
    const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const sig = signPayload(body, secret, oldTimestamp);
    expect(verifySignature(body, secret, sig, 5 * 60 * 1000)).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifySignature(body, secret, "not-a-valid-header")).toBe(false);
  });

  it("generates secrets with the expected prefix and sufficient entropy", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(a).not.toEqual(b);
  });
});
