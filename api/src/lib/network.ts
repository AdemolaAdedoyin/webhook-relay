import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "169.254.169.254",
]);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^\[/, "").replace(/\]$/, "");
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function isUnsafeIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const a = parts[0]!;
  const b = parts[1]!;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isUnsafeIpAddress(address: string): boolean {
  if (isUnsafeIpv4(address)) return true;
  if (isIP(address) !== 6) return false;

  const lower = address.toLowerCase();

  // Reject all IPv4-mapped IPv6 destinations. This is intentionally stricter
  // than decoding every textual variant and avoids bypasses such as
  // ::ffff:7f00:1 representing a loopback IPv4 address.
  if (lower.startsWith("::ffff:")) return true;

  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8:")
  );
}

function allowedProductionHost(hostname: string): boolean {
  return config.WEBHOOK_ALLOWED_HOSTS.includes(hostname);
}

export function assertWebhookUrlConfigured(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Webhook target URL is invalid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Webhook target must use http or https");
  }

  if (url.username || url.password) {
    throw new Error("Webhook target must not contain embedded credentials");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Webhook target hostname is not allowed");
  }

  if (config.NODE_ENV === "production") {
    if (config.WEBHOOK_ALLOWED_HOSTS.length === 0) {
      throw new Error("Webhook delivery is disabled until WEBHOOK_ALLOWED_HOSTS is configured");
    }
    if (!allowedProductionHost(hostname)) {
      throw new Error("Webhook target hostname is not in WEBHOOK_ALLOWED_HOSTS");
    }
  }

  if (isIP(hostname) && isUnsafeIpAddress(hostname)) {
    throw new Error("Webhook target resolves to a private, local, or reserved address");
  }

  return url;
}

export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  const url = assertWebhookUrlConfigured(rawUrl);
  const hostname = normalizeHostname(url.hostname);

  if (isIP(hostname)) return url;

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("Webhook target hostname did not resolve");
  }

  for (const { address } of addresses) {
    if (isUnsafeIpAddress(address)) {
      throw new Error("Webhook target resolves to a private, local, or reserved address");
    }
  }

  return url;
}

export async function readResponseSnippet(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let result = "";

  try {
    while (bytesRead < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;

      const remaining = maxBytes - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      result += decoder.decode(chunk, { stream: bytesRead < maxBytes });

      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  result += decoder.decode();
  return result;
}
