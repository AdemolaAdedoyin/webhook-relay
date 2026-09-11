import { randomBytes, createHash } from "crypto";
import { prisma } from "../db";

/**
 * Creates one demo tenant and prints its plaintext API key. Run with:
 *   npm run seed
 * The plaintext key is only ever shown here — the database stores just its hash.
 */
async function main() {
  const apiKey = `wr_${randomBytes(24).toString("hex")}`;
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");

  const tenant = await prisma.tenant.create({
    data: { name: "Demo Tenant", apiKeyHash },
  });

  console.log("Created tenant:", tenant.id);
  console.log("\nAPI key (save this, it will not be shown again):\n");
  console.log(`  ${apiKey}\n`);
  console.log("Try it:");
  console.log(
    `  curl -X POST http://localhost:3000/v1/subscriptions \\\n` +
      `    -H "Authorization: Bearer ${apiKey}" \\\n` +
      `    -H "Content-Type: application/json" \\\n` +
      `    -d '{"targetUrl":"https://webhook.site/your-id","eventTypes":["order.created"]}'`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
