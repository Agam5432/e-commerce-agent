// Re-encrypts every stored Shopify token with the current key (see utils/tokenEncryption.js).
// Safe to run twice and safe to stop half way: each store is updated only if its token is still the one
// that was read, and a token already under the current key is left alone.
import StoreIntegration from "../models/StoreIntegration.js";
import { decryptToken, encryptToken, needsReencryption } from "../utils/tokenEncryption.js";

const FIELDS = ["accessTokenEncrypted", "refreshTokenEncrypted"];

export async function reencryptStoredTokens({ Model = StoreIntegration, dryRun = false, env = process.env, log = console } = {}) {
  const out = { stores: 0, reencrypted: 0, alreadyCurrent: 0, failed: [] };
  const rows = await Model.find({ $or: FIELDS.map((f) => ({ [f]: { $type: "string" } })) })
    .select(FIELDS.map((f) => `+${f}`).join(" ") + " storeDomain")
    .lean();
  for (const row of rows) {
    out.stores++;
    const set = {};
    const guard = { _id: row._id };
    try {
      for (const field of FIELDS) {
        const value = row[field];
        if (!value) continue;
        guard[field] = value;
        if (!needsReencryption(value, env)) continue;
        set[field] = encryptToken(decryptToken(value, env), env);
      }
    } catch (error) {
      out.failed.push({ store: row.storeDomain, error: String(error?.message || error).slice(0, 160) });
      continue;
    }
    if (!Object.keys(set).length) {
      out.alreadyCurrent++;
      continue;
    }
    if (!dryRun) {
      const result = await Model.updateOne(guard, { $set: set });
      if (!result.modifiedCount && !result.nModified) {
        log.warn?.(`[tokens] ${row.storeDomain}: its token changed while rotating; it is already new, skipped`);
        continue;
      }
    }
    out.reencrypted++;
  }
  return out;
}
