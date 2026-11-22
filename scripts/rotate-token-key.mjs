import "dotenv/config";
import mongoose from "mongoose";
import { reencryptStoredTokens } from "../src/services/tokenRotation.js";

// Re-encrypts every stored Shopify token with SHOPIFY_TOKEN_ENCRYPTION_KEY.
// Before: put the new key in SHOPIFY_TOKEN_ENCRYPTION_KEY and the old one in TOKEN_ENCRYPTION_PREVIOUS_KEYS.
// Usage: node scripts/rotate-token-key.mjs --dry-run   (shows what would change)
//        node scripts/rotate-token-key.mjs             (does it)
// After: remove the old key from TOKEN_ENCRYPTION_PREVIOUS_KEYS.
const dryRun = process.argv.includes("--dry-run");

await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || undefined });
try {
  const out = await reencryptStoredTokens({ dryRun });
  console.log(`${dryRun ? "[dry run] " : ""}${out.stores} store(s): ${out.reencrypted} re-encrypted, ${out.alreadyCurrent} already on the current key, ${out.failed.length} failed`);
  for (const f of out.failed) console.log(`  failed: ${f.store}: ${f.error}`);
  process.exitCode = out.failed.length ? 1 : 0;
} finally {
  await mongoose.disconnect();
}
