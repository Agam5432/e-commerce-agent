// "Use once" for short-lived storefront tokens: the first use of a token id wins, every later one is
// refused. Kept in MongoDB so all server instances agree; while the database is unreachable the ids
// are remembered in this process (still single-use on this instance).
import mongoose from "mongoose";
import UsedToken from "../models/UsedToken.js";

export function createTokenReplayGuard({
  Model = UsedToken,
  connected = () => mongoose.connection?.readyState === 1,
  now = Date.now,
  log = console,
} = {}) {
  const local = new Map();
  let warned = false;

  const rememberLocally = (id, expiresAtMs) => {
    const t = now();
    for (const [k, until] of local) if (until <= t) local.delete(k);
    if (local.has(id)) return false;
    local.set(id, expiresAtMs);
    return true;
  };

  return {
    /** True the first time `id` is used; false for a replay. `expSeconds` is the token's own expiry. */
    async consume(id, expSeconds) {
      if (typeof id !== "string" || !id) return false;
      const expiresAtMs = Number(expSeconds) * 1000;
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) return false;
      if (local.has(id) && local.get(id) > now()) return false;
      if (!connected()) return rememberLocally(id, expiresAtMs);
      try {
        await Model.create({ _id: id, expiresAt: new Date(expiresAtMs) });
        local.set(id, expiresAtMs);
        return true;
      } catch (error) {
        if (error?.code === 11000) return false;
        if (!warned) {
          warned = true;
          log.warn?.(`[tokens] shared use-once list unavailable (${String(error?.message || error).slice(0, 120)}); checking in this process`);
        }
        return rememberLocally(id, expiresAtMs);
      }
    },
  };
}

let shared;
export function tokenReplayGuard() {
  shared ||= createTokenReplayGuard();
  return shared;
}
