import { createHash } from "node:crypto";
import { prisma } from "../db";

/** Create-only provisioning; never silently resets or revives an existing key. */
async function main() {
  const name = process.env.BOOTSTRAP_TENANT_NAME?.trim();
  const token = process.env.BOOTSTRAP_API_KEY ?? "";
  if (!name || name.length > 120 || !/^wrk_[0-9a-f]{64}$/.test(token)) {
    throw new Error("Set BOOTSTRAP_TENANT_NAME and BOOTSTRAP_API_KEY (wrk_ plus 32 random bytes encoded as hex)");
  }
  const keyHash = createHash("sha256").update(token).digest("hex");
  const tenant = await prisma.tenant.create({ data: { name, apiKeyHash: keyHash,
    apiKeys: { create: { name: "Initial admin", keyHash, scopes: ["admin"] } },
  }, select: { id: true } });
  console.log(`Created tenant ${tenant.id}. The supplied token is not printed or stored in plaintext.`);
}
main().catch(() => { console.error("Provisioning failed: check configuration or whether that key already exists. Existing access was not changed."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
