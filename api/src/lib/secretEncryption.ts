import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";

export function protectSecret(secret: string, subscriptionId: string): string {
  if (!config.SIGNING_SECRET_KEY) {
    if (config.NODE_ENV === "production") throw new Error("Signing encryption key is required");
    return secret;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.SIGNING_SECRET_KEY, "hex"), iv);
  cipher.setAAD(Buffer.from(`relay:${subscriptionId}`));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function revealSecret(stored: string, subscriptionId: string): string {
  if (!stored.startsWith("enc:")) {
    if (config.NODE_ENV === "production") throw new Error("Signing secret must be encrypted before production delivery");
    return stored;
  }
  if (!config.SIGNING_SECRET_KEY) throw new Error("Signing encryption key is unavailable");
  const [prefix, version, iv, tag, ciphertext, extra] = stored.split(":");
  if (prefix !== "enc" || version !== "v1" || !iv || !tag || !ciphertext || extra) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config.SIGNING_SECRET_KEY, "hex"), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(`relay:${subscriptionId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
