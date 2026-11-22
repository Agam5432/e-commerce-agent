import {describe, it, expect} from './harness.js';

/** @typedef {import('../src/types.js').Booking} Booking */
import {callSpan, callView, callWhen, calendarNote, emailNote, shownView, slotChoices, callDoneText, CALL_FILTERS, INBOX_CHIPS, MORE_FILTERS, STATUS_NOTE} from '../../src/public/admin/lib/bookings.js';
import {chatTags, chatRow} from '../../src/public/admin/lib/chats.js';

const NOW = Date.parse('2026-11-02T06:00:00Z');
/** @param {Partial<Booking>} [over] @returns {Booking} */
const call = (over = {}) => ({
  id: 'b1', conversationId: 'c1', personKey: 'e1', name: 'Riya', email: 'riya@example.com', phone: '+91 98765 43210', topic: 'bulk order', language: 'en',
  status: 'requested', startAt: '2026-11-03T04:30:00.000Z', endAt: '2026-11-03T05:00:00.000Z', timezone: 'Asia/Kolkata', note: '',
  calendar: {status: 'pending', link: '', error: ''}, emails: {customer: 'none', owner: 'sent'}, ...over,
});

describe('a call', () => {
  it('is shown in the time zone it was booked in', () => {
    expect(callWhen('2026-11-03T04:30:00.000Z', 'Asia/Kolkata', 'en-IN')).toMatch(/Tue.*3 Nov.*10:00/i);
    expect(callWhen('2026-11-03T04:30:00.000Z', 'America/New_York', 'en-US')).toMatch(/Mon.*11:30/); // the evening before, in New York
    expect(callWhen('nonsense', 'UTC')).toBe('');
    expect(callWhen('2026-11-03T04:30:00.000Z', 'Mars/Base', 'en-US')).toMatch(/4:30/); // a bad zone falls back to UTC
  });

  it('a new request waits for the owner, who can confirm, move, mark not reached or cancel it', () => {
    const v = callView(call(), {now: NOW, locale: 'en-IN'});
    expect([v.status, v.tone, v.open, v.overdue]).toEqual(['Waiting for you', 'caution', true, false]);
    expect(v.actions.map((a) => a.id)).toEqual(['confirm', 'change', 'missed', 'cancelled']);
    expect(v.actions[0].primary).toBe(true);
    expect(v.actions[v.actions.length - 1].tone).toBe('critical');
    expect(v.who).toBe('Riya');
    expect(v.contact).toBe('+91 98765 43210 · riya@example.com');
    expect(v.calendar.text).toMatch(/when you confirm/);
    expect(v.email.text).toMatch(/once you confirm/);
  });

  it('a confirmed call can be marked called; a problem with the calendar or email offers "Try again"', () => {
    const ok = callView(call({status: 'confirmed', calendar: {status: 'synced', link: 'https://calendar.google.com/e', error: ''}, emails: {customer: 'sent', owner: 'sent'}}), {now: NOW});
    expect(ok.actions.map((a) => a.id)).toEqual(['change', 'completed', 'missed', 'cancelled']);
    expect(ok.calendar).toMatchObject({text: 'In your Google Calendar', link: 'https://calendar.google.com/e'});
    expect(ok.email.text).toBe('Confirmation emailed to riya@example.com');
    const broken = callView(call({status: 'confirmed', calendar: {status: 'failed', link: '', error: 'Google Calendar said 403'}, emails: {customer: 'failed', owner: 'none'}}), {now: NOW});
    expect(broken.actions[0]).toMatchObject({id: 'retry', primary: true});
    expect(broken.calendar.text).toBe('Not in your calendar: Google Calendar said 403');
    expect(broken.email.text).toMatch(/did not send/);
  });

  it('says plainly when Google Calendar or email is not set up', () => {
    expect(calendarNote(call({calendar: {status: 'off', link: '', error: ''}})).text).toBe('Google Calendar is not connected');
    expect(emailNote(call({emails: {customer: 'off', owner: 'off'}})).text).toMatch(/not set up/);
  });

  it('a closed call has no buttons, and a call past its time is flagged', () => {
    for (const status of /** @type {const} */ (['completed', 'missed', 'cancelled'])) {
      const v = callView(call({status}), {now: NOW});
      expect([v.open, v.actions.length]).toEqual([false, 0]);
    }
    expect(callView(call(), {now: Date.parse('2026-11-04T00:00:00Z')}).overdue).toBe(true);
    expect(callView(call({status: 'cancelled'}), {now: Date.parse('2026-11-04T00:00:00Z')}).overdue).toBe(false);
    expect(callView(call({name: '', phone: '123'})).who).toBe('123');
  });

  it('has words for every action and a list of free times to move it to', () => {
    for (const id of ['confirm', 'retry', 'change', 'completed', 'missed', 'cancelled']) expect(callDoneText(id)).not.toBe('Saved');
    expect(callDoneText('unknown')).toBe('Saved');
    expect(slotChoices([{start: 'a', local: 'Tue 10:00'}])).toEqual([{value: 'a', label: 'Tue 10:00'}]);
    expect(CALL_FILTERS.map((f) => f.id)).toEqual(['requested', 'confirmed', 'completed', '']);
  });
});

describe('what the agent showed in a chat', () => {
  const shown = {
    products: [
      {id: 'p1', title: 'Earbuds', image: 'https://cdn/e.jpg', price: '1999.00', compareAtPrice: '2999.00', currency: 'INR', url: 'https://s/products/earbuds', inStock: true},
      {id: 'p2', title: 'Case', price: '299', currency: 'INR', inStock: false},
    ],
    actions: [
      {type: 'add_to_cart', title: 'Earbuds', quantity: 2},
      {type: 'begin_checkout', total: 3998, currency: 'INR'},
      {type: 'order_placed', orderId: '#1001', total: 3998, currency: 'INR', paymentMethod: 'cod'},
      {type: 'call_booked', bookingId: 'b1', startAt: '2026-11-03T04:30:00.000Z', timezone: 'Asia/Kolkata', status: 'requested'},
      {type: 'flag_for_owner', reason: 'refund dispute'},
      {type: 'set_shipping_address'},
    ],
  };
  it('lists the product cards with price, old price and stock', () => {
    const {products} = shownView(shown, {timezone: 'Asia/Kolkata'});
    expect(products.map((p) => p.title)).toEqual(['Earbuds', 'Case']);
    expect(products[0]).toMatchObject({url: 'https://s/products/earbuds', outOfStock: false});
    expect(products[0].price).toMatch(/1,999/);
    expect(products[0].was).toMatch(/2,999/);
    expect(products[1]).toMatchObject({was: '', outOfStock: true, image: ''});
  });
  it('tells each step in plain words and skips the ones it has no words for', () => {
    const {steps} = shownView(shown, {timezone: 'Asia/Kolkata'});
    expect(steps.map((s) => s.text)).toEqual([
      'Added Earbuds × 2 to the cart',
      expect.stringMatching(/^Started checkout \(.*3,998\)$/),
      expect.stringMatching(/^Order #1001 placed \(.*3,998, cash on delivery\)$/),
      expect.stringMatching(/^Asked for a call on Tue.*(3 Nov|Nov 3)/),
      'Asked for your team: refund dispute',
    ]);
    expect(steps[3].call).toBe(true);
    expect(steps[4].flag).toBe(true);
  });
  it('nothing shown means nothing to draw', () => {
    expect(shownView(undefined)).toEqual({products: [], steps: []});
  });
});

describe('the chats list filters', () => {
  it('four chips for the four statuses, and the other filters in one drop-down', () => {
    expect(INBOX_CHIPS.map((c) => c.id)).toEqual(['', 'waiting', 'person', 'resolved']);
    expect(MORE_FILTERS.map((c) => c.id)).toEqual(['calls', 'files', 'ordered', 'follow_up']);
  });
  it('every filter is one the server knows (see INBOX_FILTERS in the admin stats)', () => {
    const server = ['waiting', 'person', 'follow_up', 'calls', 'files', 'ordered', 'resolved'];
    for (const f of [...INBOX_CHIPS, ...MORE_FILTERS].filter((c) => c.id)) expect(server.includes(f.id)).toBe(true);
  });
  it('explains the one status a chat has', () => {
    expect(STATUS_NOTE).toMatch(/One status per chat/);
  });
});

describe('labels on a chat row', () => {
  const chat = (over = {}) => ({id: 'c', startedAt: '2026-11-01T10:00:00Z', lastMessageAt: '2026-11-01T10:05:00Z', messageCount: 3, channel: 'text', language: 'en', outcome: 'chat', status: 'open', firstMessage: 'hi', failedReplies: 0, verifiedCustomer: false, personKey: 'v1', contact: {}, ...over});
  it('shows a call, a follow-up and files, and nothing for an ordinary chat', () => {
    expect(chatTags(chat())).toEqual([]);
    const tags = chatTags(chat({flags: {callRequested: true, needsFollowUp: true, hasFiles: true, reason: ''}, fileCount: 2}));
    expect(tags.map((t) => t.text)).toEqual(['Call requested', 'Needs follow-up', '2 files']);
    expect(tags.map((t) => t.tone)).toEqual(['call', 'caution', 'info']);
    expect(chatTags(chat({fileCount: 1})).map((t) => t.text)).toEqual(['1 file']);
  });
  it('a resolved chat no longer says "Needs follow-up", and the row carries the tags', () => {
    expect(chatTags(chat({status: 'resolved', flags: {callRequested: false, needsFollowUp: true, hasFiles: false, reason: ''}})).map((t) => t.id)).toEqual([]);
    expect(chatRow(chat({fileCount: 1})).tags).toHaveLength(1);
  });
});

describe('the span of one call', () => {
  it('shows the day and the start and end in the time zone the call was booked in', () => {
    expect(callSpan('2026-11-04T11:00:00Z', '2026-11-04T11:30:00Z', 'Asia/Kolkata')).toBe('Wed 4 Nov, 4:30 to 5:00 PM');
    expect(callSpan('2026-11-04T05:00:00Z', '2026-11-04T05:30:00Z', 'Asia/Kolkata')).toBe('Wed 4 Nov, 10:30 to 11:00 AM');
    expect(callSpan('2026-11-04T06:15:00Z', '2026-11-04T06:45:00Z', 'Asia/Kolkata')).toBe('Wed 4 Nov, 11:45 AM to 12:15 PM');
  });
  it('never throws on a bad date or an unknown time zone', () => {
    expect(callSpan('nope', 'nope')).toBe('');
    expect(callSpan('2026-11-04T11:00:00Z', undefined, 'Not/AZone')).toMatch(/Wed 4 Nov/);
  });
});
