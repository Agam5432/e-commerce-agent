// A store for express-rate-limit that keeps the counters in MongoDB, so every server instance sees the
// same counts and a restart does not hand everyone a fresh allowance.
// While the database is not reachable it counts in this process instead (still limited, never wide open).
import mongoose from "mongoose";
import RateLimitHit from "../models/RateLimitHit.js";

const LOCAL_PRUNE_AT = 5000;

export function createSharedRateLimitStore({
  prefix = "",
  Model = RateLimitHit,
  connected = () => mongoose.connection?.readyState === 1,
  now = Date.now,
  log = console,
} = {}) {
  let windowMs = 60_000;
  const local = new Map();
  let warned = false;

  const windowOf = () => {
    const start = Math.floor(now() / windowMs) * windowMs;
    return { start, resetTime: new Date(start + windowMs) };
  };
  const rowId = (key, start) => `${prefix}${key}@${start}`;

  function countLocally(id, resetTime) {
    if (local.size > LOCAL_PRUNE_AT) {
      const t = now();
      for (const [k, v] of local) if (v.resetTime.getTime() <= t) local.delete(k);
    }
    const row = local.get(id) || { hits: 0, resetTime };
    row.hits += 1;
    local.set(id, row);
    return { totalHits: row.hits, resetTime };
  }

  async function bump(id, resetTime) {
    const row = await Model.findOneAndUpdate(
      { _id: id },
      { $inc: { hits: 1 }, $setOnInsert: { expiresAt: resetTime } },
      { upsert: true, new: true, lean: true }
    );
    return { totalHits: Number(row?.hits) || 1, resetTime };
  }

  return {
    prefix,
    localKeys: false,
    init(options) {
      if (Number(options?.windowMs) > 0) windowMs = Number(options.windowMs);
    },
    async increment(key) {
      const { start, resetTime } = windowOf();
      const id = rowId(key, start);
      if (!connected()) return countLocally(id, resetTime);
      try {
        return await bump(id, resetTime);
      } catch (error) {
        // two requests created the same counter at once: the second simply adds to it
        if (error?.code === 11000) {
          try {
            return await bump(id, resetTime);
          } catch {
            /* fall through to counting here */
          }
        }
        if (!warned) {
          warned = true;
          log.warn?.(`[rate-limit] shared counter unavailable (${String(error?.message || error).slice(0, 120)}); counting in this process`);
        }
        return countLocally(id, resetTime);
      }
    },
    async decrement(key) {
      const { start } = windowOf();
      const id = rowId(key, start);
      const row = local.get(id);
      if (row) row.hits = Math.max(0, row.hits - 1);
      if (connected()) await Model.updateOne({ _id: id, hits: { $gt: 0 } }, { $inc: { hits: -1 } }).catch(() => {});
    },
    async resetKey(key) {
      const { start } = windowOf();
      const id = rowId(key, start);
      local.delete(id);
      if (connected()) await Model.deleteOne({ _id: id }).catch(() => {});
    },
  };
}
