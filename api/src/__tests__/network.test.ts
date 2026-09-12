import { describe, expect, it } from "vitest";
import {
  assertWebhookUrlConfigured,
  isUnsafeIpAddress,
  readResponseSnippet,
} from "../lib/network";

describe("webhook destination security", () => {
  it("accepts public http/https destinations", () => {
    expect(assertWebhookUrlConfigured("https://example.com/hooks").hostname).toBe("example.com");
    expect(assertWebhookUrlConfigured("http://example.com/hooks").protocol).toBe("http:");
  });

  it("rejects non-http protocols and embedded credentials", () => {
    expect(() => assertWebhookUrlConfigured("file:///etc/passwd")).toThrow(/http or https/i);
    expect(() => assertWebhookUrlConfigured("https://user:password@example.com/hook")).toThrow(
      /credentials/i
    );
  });

  it("rejects localhost and private/reserved literal addresses", () => {
    expect(() => assertWebhookUrlConfigured("http://localhost:3000/hook")).toThrow(/hostname/i);
    expect(() => assertWebhookUrlConfigured("http://127.0.0.1/hook")).toThrow(/private/i);
    expect(() => assertWebhookUrlConfigured("http://10.0.0.5/hook")).toThrow(/private/i);
    expect(() => assertWebhookUrlConfigured("http://169.254.169.254/latest/meta-data")).toThrow();
    expect(() => assertWebhookUrlConfigured("http://[::1]/hook")).toThrow(/private/i);
  });

  it("classifies common unsafe address ranges", () => {
    expect(isUnsafeIpAddress("192.168.1.20")).toBe(true);
    expect(isUnsafeIpAddress("172.16.0.1")).toBe(true);
    expect(isUnsafeIpAddress("100.64.0.1")).toBe(true);
    expect(isUnsafeIpAddress("8.8.8.8")).toBe(false);
    expect(isUnsafeIpAddress("fc00::1")).toBe(true);
    expect(isUnsafeIpAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("caps response bodies while decoding a snippet", async () => {
    const response = new Response("x".repeat(10_000));
    const snippet = await readResponseSnippet(response, 2_000);
    expect(Buffer.byteLength(snippet)).toBe(2_000);
  });
});
