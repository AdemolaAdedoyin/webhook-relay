import { randomBytes, createHash } from "crypto";
import { prisma } from "../db";

const DEMO_TENANT_NAME = "Demo Tenant";

/**
 * Creates or refreshes the local demo tenant and prints its plaintext API key.
 *
 * When DEMO_API_KEY is supplied (the local startup script does this), the same
 * tenant/key pair can be reused across restarts. Without it, a fresh random key
 * is generated for ad-hoc/manual seeding.
 */
async function main() {
  const apiKey = process.env.DEMO_API_KEY ?? `wr_${randomBytes(24).toString("hex")}`;
  if (!apiKey.startsWith("wr_") || apiKey.length < 20) {
    throw new Error("DEMO_API_KEY must start with wr_ and be at least 20 characters long");
  }

  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  const existing = await prisma.tenant.findFirst({ where: { name: DEMO_TENANT_NAME } });

  const tenant = existing
    ? await prisma.tenant.update({
        where: { id: existing.id },
        data: { apiKeyHash },
      })
    : await prisma.tenant.create({
        data: { name: DEMO_TENANT_NAME, apiKeyHash },
      });

  console.log(existing ? "Updated demo tenant:" : "Created demo tenant:", tenant.id);
  console.log("\nAPI key (save this; only its hash is stored in Postgres):\n");
  console.log(`  ${apiKey}\n`);
  console.log("Dashboard: http://localhost:5173");
  console.log("API:       http://localhost:3000");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
