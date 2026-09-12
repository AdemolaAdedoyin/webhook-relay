import { createHash } from "crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }

  return value;
}

export function fingerprintEventRequest(type: string, payload: unknown): string {
  const canonical = JSON.stringify({ type, payload: canonicalize(payload) });
  return createHash("sha256").update(canonical).digest("hex");
}
