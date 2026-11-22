// Turns call records from the backend into words for the dashboard. No UI code, so it is tested on its own.
import {formatWhen} from './format.js';

/** outcome -> [label, tone]. Waiting (asked, not answered yet) and cancelled are never shown as missed. */
export const OUTCOMES = {
  pending: ['Waiting', 'warning'],
  live: ['On a call now', 'accent'],
  completed: ['Completed', 'success'],
  missed: ['Missed', 'danger'],
  failed: ['Failed', 'danger'],
  cancelled: ['Cancelled', 'neutral'],
};
export const OUTCOME_FILTERS = [['', 'All'], ['completed', 'Completed'], ['missed', 'Missed'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['pending', 'Waiting'], ['live', 'Live']];

/** How sure the dashboard is who a customer is. Only a Shopify sign-in is proof of who someone is. */
export const IDENTITY = {
  shopify: ['Signed in (verified)', 'success'],
  guest_unverified_email: ['Guest (email not verified)', 'info'],
  visitor_browser: ['Visitor (this browser)', 'neutral'],
};
export const identityOf = (p) => IDENTITY[p?.identity] || IDENTITY[p?.kind === 'customer' ? 'shopify' : p?.kind === 'guest' ? 'guest_unverified_email' : 'visitor_browser'];

/** "1m 04s", "45s", "1h 02m", or a dash when there is no length (a call nobody joined). */
export function duration(sec) {
  const s = Math.round(Number(sec));
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Who had the call, in words. `handler` is {type, id, name} or null when nobody took it. */
export function handlerLabel(handler) {
  if (!handler) return 'Nobody (not answered)';
  if (handler.type === 'ai') return 'AI assistant';
  return handler.name || 'Team member';
}

const contactOf = (c) => [c.customer?.email, c.customer?.phone].filter(Boolean).join(' · ');
export const whoCalled = (c) => c.customer?.name || c.customer?.email || c.customer?.phone || 'Visitor';

/** One row of a list of calls. @param {any} c @param {{timezone?: string, now?: number}} [o] */
export function callRow(c, {timezone = 'UTC', now = Date.now()} = {}) {
  const [label, tone] = OUTCOMES[c.outcome] || [c.status, 'neutral'];
  return {
    id: c.id,
    who: whoCalled(c),
    contact: contactOf(c),
    personKey: c.personKey || '',
    outcome: label,
    tone,
    handler: handlerLabel(c.handledBy),
    handlerId: c.handledBy?.id || '',
    assigned: handlerLabel(c.assignedTo),
    when: formatWhen(c.requestedAt, timezone, now),
    duration: c.outcome === 'completed' ? duration(c.durationSec) : '—',
    kind: 'Human call',
    reason: c.reason || '',
    conversationId: c.conversationId || '',
    recording: c.recording?.available ? 'Recording saved' : c.recording?.consent ? 'Recording agreed' : 'Not recorded',
  };
}

/** The steps of one call with their times, only the ones that happened. */
export function callTimeline(c, {timezone = 'UTC', now = Date.now()} = {}) {
  const at = (iso) => formatWhen(iso, timezone, now);
  const steps = [['Requested by the customer', c.requestedAt], ['Taken by ' + handlerLabel(c.handledBy), c.acceptedAt], ['Audio connected', c.connectedAt], ['Ended', c.endedAt]];
  return steps.filter(([, iso]) => iso).map(([label, iso]) => ({label, at: at(iso)}));
}

/** "3 of 7 calls completed" and the like, for the top of the overview. */
export function totalsLine(h) {
  if (!h || !h.total) return 'No calls in this period.';
  return `${h.total} ${h.total === 1 ? 'request' : 'requests'}: ${h.completed} completed, ${h.missed} missed, ${h.failed} failed, ${h.cancelled} cancelled${h.pending + h.live ? `, ${h.pending + h.live} open` : ''}.`;
}
