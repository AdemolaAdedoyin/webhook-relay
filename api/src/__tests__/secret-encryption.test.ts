import { describe, it, expect, vi } from "vitest";
const settings = vi.hoisted(() => ({ SIGNING_SECRET_KEY: "ab".repeat(32), NODE_ENV: "production" }));
vi.mock("../config", () => ({ config: settings }));
import { protectSecret, revealSecret } from "../lib/secretEncryption";
import { signPayload, verifySignature } from "../lib/signature";

describe("signing secrets", () => {
  it("encrypts with random nonces and binds ciphertext to the subscription", () => {
    const one = protectSecret("whsec_test", "sub1");
    expect(one).not.toContain("whsec_test");
    expect(one).not.toBe(protectSecret("whsec_test", "sub1"));
    expect(revealSecret(one, "sub1")).toBe("whsec_test");
    expect(() => revealSecret(one, "sub2")).toThrow();
    const pieces = one.split(":");
    pieces[4] = Buffer.from("tampered").toString("base64url");
    expect(() => revealSecret(pieces.join(":"), "sub1")).toThrow();
    expect(() => revealSecret("plaintext", "sub1")).toThrow();
  });
  it("verifies either signing key during rotation and rejects malformed digests", () => {
    const now = Date.now();
    const dual = `${signPayload("{}", "new", now)},${signPayload("{}", "old", now).split(",")[1]}`;
    expect(verifySignature("{}", "new", dual)).toBe(true);
    expect(verifySignature("{}", "old", dual)).toBe(true);
    expect(verifySignature("{}", "other", dual)).toBe(false);
    expect(verifySignature("{}", "new", `${dual},t=${now}`)).toBe(false);
    expect(verifySignature("{}", "new", `${signPayload("{}", "new", now)}junk`)).toBe(false);
  });
});
