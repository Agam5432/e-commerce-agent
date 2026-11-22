// The one live-support hub of this process, shared by the HTTP routes and the WebSocket server, plus the sweeper
// that closes what nobody is looking after.
import { createSupportHub } from "./supportHub.js";
import { verifySessionToken } from "../admin/auth.js";
import { verifyConsoleToken } from "../admin/consoleAuth.js";
import * as support from "./supportService.js";

let hub;
/** The process-wide hub (created on first use). */
export function supportHub() {
  if (!hub) hub = createSupportHub({ verifyAdmin: async (token) => { try { return verifySessionToken(token); } catch { return verifyConsoleToken(token); } } });
  return hub;
}
export function __setSupportHubForTest(value) {
  hub = value;
}

let timer;
/** Every few seconds: close unanswered requests and calls whose team member vanished, and tell whoever is connected. */
export function startSupportSweeper({ every = 10_000, log = console } = {}) {
  if (timer) return timer;
  timer = setInterval(async () => {
    try {
      const closed = await support.sweepSupport();
      if (closed.length) supportHub().announceClosed(closed);
    } catch (error) {
      log.warn?.("[support] sweep failed:", error?.message);
    }
  }, every);
  timer.unref?.();
  return timer;
}
export function stopSupportSweeper() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
