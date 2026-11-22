import {describe, it, expect} from './harness.js';
import {callRow, callTimeline, duration, handlerLabel, identityOf, totalsLine, whoCalled} from '../../src/public/admin/lib/calls.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const opts = {timezone: 'UTC', now: NOW};
const call = (extra = {}) => ({id: 'a1', status: 'ended', outcome: 'completed', customer: {name: 'Riya', email: 'r@x.com', phone: '+91 99999 00000'}, personKey: 'c42', requestedAt: '2026-10-30T10:00:00Z', acceptedAt: '2026-10-30T10:00:05Z', connectedAt: '2026-10-30T10:00:09Z', endedAt: '2026-10-30T10:01:13Z', durationSec: 64, handledBy: {type: 'human', id: 'u1', name: 'Asha'}, assignedTo: {type: 'human', id: 'u1', name: 'Asha'}, recording: {consent: true, available: false}, reason: 'damaged', conversationId: 'cv1', ...extra});

describe('call durations', () => {
  it('reads as minutes and seconds, and a dash when nobody talked', () => {
    expect(duration(64)).toBe('1m 04s');
    expect(duration(45)).toBe('45s');
    expect(duration(3725)).toBe('1h 02m');
    expect(duration(0)).toBe('—');
    expect(duration(undefined)).toBe('—');
  });
});

describe('who had a call', () => {
  it('names the person, the AI, or says nobody answered', () => {
    expect(handlerLabel({type: 'human', id: 'u1', name: 'Asha'})).toBe('Asha');
    expect(handlerLabel({type: 'human', id: 'u1', name: ''})).toBe('Team member');
    expect(handlerLabel({type: 'ai', id: 'ai-agent', name: 'AI assistant'})).toBe('AI assistant');
    expect(handlerLabel(null)).toBe('Nobody (not answered)');
  });
});

describe('a row of calls', () => {
  it('shows who called, who took it, how it ended and how long', () => {
    expect(callRow(call(), opts)).toMatchObject({who: 'Riya', outcome: 'Completed', tone: 'success', handler: 'Asha', handlerId: 'u1', duration: '1m 04s', kind: 'Human call', personKey: 'c42', recording: 'Recording agreed'});
  });
  it('waiting and cancelled are not shown as missed', () => {
    expect(callRow(call({outcome: 'pending', status: 'requested', handledBy: null, assignedTo: null, durationSec: null}), opts)).toMatchObject({outcome: 'Waiting', tone: 'warning', handler: 'Nobody (not answered)', duration: '—'});
    expect(callRow(call({outcome: 'cancelled', status: 'cancelled'}), opts).outcome).toBe('Cancelled');
    expect(callRow(call({outcome: 'missed', status: 'unanswered'}), opts)).toMatchObject({outcome: 'Missed', tone: 'danger', duration: '—'});
  });
  it('a call that did not connect shows no talk time even if a length was saved', () => {
    expect(callRow(call({outcome: 'failed', status: 'failed', durationSec: 0}), opts).duration).toBe('—');
  });
  it('an unnamed caller is a visitor', () => {
    expect(whoCalled({customer: {}})).toBe('Visitor');
    expect(whoCalled({customer: {email: 'a@b.co'}})).toBe('a@b.co');
  });
});

describe('the steps of one call', () => {
  it('lists only the steps that happened, with the handler named', () => {
    const steps = callTimeline(call({connectedAt: null, endedAt: '2026-10-30T10:00:30Z'}), opts).map((s) => s.label);
    expect(steps).toEqual(['Requested by the customer', 'Taken by Asha', 'Ended']);
  });
});

describe('how sure the dashboard is who someone is', () => {
  it('only a Shopify sign-in is verified', () => {
    expect(identityOf({identity: 'shopify'})[0]).toBe('Signed in (verified)');
    expect(identityOf({identity: 'guest_unverified_email'})[0]).toBe('Guest (email not verified)');
    expect(identityOf({identity: 'visitor_browser'})[0]).toBe('Visitor (this browser)');
    expect(identityOf({kind: 'guest'})[0]).toBe('Guest (email not verified)');
    expect(identityOf({})[0]).toBe('Visitor (this browser)');
  });
});

describe('the summary line', () => {
  it('counts each outcome and what is still open', () => {
    expect(totalsLine({total: 10, completed: 6, missed: 2, failed: 1, cancelled: 1, pending: 0, live: 0})).toBe('10 requests: 6 completed, 2 missed, 1 failed, 1 cancelled.');
    expect(totalsLine({total: 3, completed: 1, missed: 0, failed: 0, cancelled: 0, pending: 1, live: 1})).toMatch(/2 open/);
    expect(totalsLine({total: 0})).toBe('No calls in this period.');
  });
});
