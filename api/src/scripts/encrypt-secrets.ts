import "dotenv/config";
import { prisma } from "../db";
import { config } from "../config";
import { protectSecret, revealSecret } from "../lib/secretEncryption";

async function main() {
  if (!config.SIGNING_SECRET_KEY) throw new Error("SIGNING_SECRET_KEY is required for backfill");
  let cursor: string | undefined;
  let updated = 0;
  while (true) {
    const rows = await prisma.subscription.findMany({
      orderBy: { id: "asc" }, take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const sub of rows) {
      // Existing ciphertext is validated, never silently re-encrypted with a wrong key.
      const current = sub.secret.startsWith("enc:") ? (revealSecret(sub.secret, sub.id), sub.secret) : protectSecret(sub.secret, sub.id);
      const previous = !sub.previousSecret ? null : sub.previousSecret.startsWith("enc:")
        ? (revealSecret(sub.previousSecret, sub.id), sub.previousSecret) : protectSecret(sub.previousSecret, sub.id);
      const result = await prisma.subscription.updateMany({
        where: { id: sub.id, secret: sub.secret, previousSecret: sub.previousSecret },
        data: { secret: current, previousSecret: previous },
      });
      if (!result.count) throw new Error("Subscription changed during backfill; stop writers and retry");
      updated++;
    }
    cursor = rows.at(-1)!.id;
  }
  console.log(`Validated/encrypted ${updated} subscription records`);
}
main().catch(() => { console.error("Secret backfill failed; check encryption configuration and retry with writers stopped"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
