// Limits for live voice sessions (each one holds a paid Gemini Live connection):
// how many may run at once (per store and in total), how long one may last, how long it may sit silent,
// and how fast a browser may push audio. Pure logic with an injectable clock, so it is unit-tested.

const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

export function voiceLimitsFromEnv(env = process.env) {
  return {
    maxPerShop: num(env.VOICE_MAX_PER_SHOP, 25),
    maxTotal: num(env.VOICE_MAX_TOTAL, 200),
    maxDurationMs: num(env.VOICE_MAX_MINUTES, 30) * 60_000,
    idleMs: num(env.VOICE_IDLE_SECONDS, 180) * 1000,
    maxChunksPerSecond: num(env.VOICE_MAX_CHUNKS_PER_SECOND, 40),
  };
}

export function createVoiceGovernor(limits = voiceLimitsFromEnv(), { now = () => Date.now() } = {}) {
  const perShop = new Map();
  let total = 0;

  return {
    limits,
    get active() {
      return total;
    },
    activeFor(shop) {
      return perShop.get(shop) || 0;
    },
    /** A slot for one session, or a reason it is refused. `release()` is safe to call more than once. */
    acquire(shop) {
      if (total >= limits.maxTotal) return { ok: false, reason: "server_busy" };
      if ((perShop.get(shop) || 0) >= limits.maxPerShop) return { ok: false, reason: "shop_busy" };
      total += 1;
      perShop.set(shop, (perShop.get(shop) || 0) + 1);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          total -= 1;
          const left = (perShop.get(shop) || 1) - 1;
          if (left <= 0) perShop.delete(shop);
          else perShop.set(shop, left);
        },
      };
    },
    /** One browser connection: tracks silence and audio speed. */
    watch() {
      const startedAt = now();
      let lastHeardAt = startedAt;
      let windowStart = startedAt;
      let inWindow = 0;
      return {
        /** Call for every audio chunk. Returns false when the browser is sending faster than a microphone can. */
        audio() {
          const t = now();
          lastHeardAt = t;
          if (t - windowStart >= 1000) {
            windowStart = t;
            inWindow = 0;
          }
          inWindow += 1;
          return inWindow <= limits.maxChunksPerSecond;
        },
        /** null while the session may continue, otherwise why it must end. */
        expired() {
          const t = now();
          if (t - startedAt >= limits.maxDurationMs) return "max_duration";
          if (t - lastHeardAt >= limits.idleMs) return "idle";
          return null;
        },
      };
    },
  };
}

/**
 * The same limits counted across every server instance (VOICE_MAX_PER_SHOP and VOICE_MAX_TOTAL then
 * mean what they say however many instances run). Each call is a row in MongoDB with a heartbeat; the
 * local governor still applies on top, and without the database only the local limits apply.
 * Two instances admitting at the same instant can go one or two over a limit for a moment; nothing
 * stays wrong, because rows of a stopped instance stop counting after `staleMs`.
 */
export function createSharedVoiceGovernor(local = createVoiceGovernor(), {
  Model,
  connected = () => false,
  now = () => Date.now(),
  instance = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  heartbeatMs = 20_000,
  staleMs = 60_000,
  log = console,
} = {}) {
  const limits = local.limits;
  let timer = null;
  const mine = new Set();

  function beat() {
    if (!mine.size || !connected()) return;
    const t = now();
    Promise.resolve(Model.updateMany({ instance }, { $set: { heartbeatAt: new Date(t), expiresAt: new Date(t + staleMs * 2) } })).catch((error) =>
      log.warn?.(`[voice] heartbeat failed: ${String(error?.message || error).slice(0, 120)}`)
    );
  }

  return {
    limits,
    instance,
    get active() {
      return local.active;
    },
    activeFor: (shop) => local.activeFor(shop),
    watch: () => local.watch(),
    /** Like the local acquire, but counts every instance's calls. Resolves to a slot or a refusal. */
    async acquire(shop) {
      const slot = local.acquire(shop);
      if (!slot.ok || !Model || !connected()) return slot;
      const t = now();
      const live = { heartbeatAt: { $gt: new Date(t - staleMs) } };
      try {
        const [total, forShop] = await Promise.all([Model.countDocuments(live), Model.countDocuments({ ...live, shop })]);
        if (total >= limits.maxTotal) {
          slot.release();
          return { ok: false, reason: "server_busy" };
        }
        if (forShop >= limits.maxPerShop) {
          slot.release();
          return { ok: false, reason: "shop_busy" };
        }
        const id = `${instance}:${t}:${Math.random().toString(36).slice(2, 10)}`;
        await Model.create({ _id: id, shop, instance, heartbeatAt: new Date(t), expiresAt: new Date(t + staleMs * 2) });
        mine.add(id);
        if (!timer) {
          timer = setInterval(beat, heartbeatMs);
          timer.unref?.();
        }
        let released = false;
        return {
          ok: true,
          release() {
            if (released) return;
            released = true;
            slot.release();
            mine.delete(id);
            Promise.resolve(Model.deleteOne({ _id: id })).catch(() => {});
            if (!mine.size && timer) {
              clearInterval(timer);
              timer = null;
            }
          },
        };
      } catch (error) {
        // the shared count could not be read: the local limits still hold
        log.warn?.(`[voice] shared session count unavailable: ${String(error?.message || error).slice(0, 120)}`);
        return slot;
      }
    },
    /** For tests: one heartbeat now. */
    beat,
  };
}
