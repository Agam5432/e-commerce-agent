import {describe, it, expect} from './harness.js';
import {chatRow, contactLine, fileSize, languageLabel, outcomeLabel, personDetail, personLabel, statusLabel, timelineLines, transcriptLines} from '../../src/public/admin/lib/chats.js';
import {customerRow, customerSummary, spendText} from '../../src/public/admin/lib/customers.js';
import {orderRow} from '../../src/public/admin/lib/orders.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const opts = {timezone: 'UTC', now: NOW, locale: 'en-US'};

describe('who a chat was with', () => {
  it('uses the name, then the email, then the phone, then says what is known', () => {
    expect(personLabel({name: 'Priya Sharma', email: 'p@x.com'})).toBe('Priya Sharma');
    expect(personLabel({email: 'p@x.com'})).toBe('p@x.com');
    expect(personLabel({phone: '+91 98765 00001'})).toBe('+91 98765 00001');
    expect(personLabel({}, true)).toBe('Signed-in customer');
    expect(personLabel(undefined)).toBe('Visitor');
  });
  it('shows the other details only when there is a name above them', () => {
    expect(personDetail({name: 'Priya', email: 'p@x.com', phone: '123456'})).toBe('p@x.com · 123456');
    expect(personDetail({email: 'p@x.com'})).toBe('');
    expect(personDetail(undefined)).toBe('');
    expect(contactLine({name: 'Priya', email: 'p@x.com', phone: '123456'})).toBe('p@x.com');
    expect(contactLine({name: 'Priya', phone: '123456'})).toBe('123456');
    expect(contactLine({email: 'p@x.com', phone: '123456'})).toBe('123456');
    expect(contactLine(undefined)).toBe('');
  });
});

describe('chat rows', () => {
  /** @type {import('../src/types.js').ConversationSummary} */
  const chat = /** @type {any} */ ({id: 'c1', startedAt: '2026-10-30T05:00:00Z', lastMessageAt: '2026-10-30T05:10:00Z', messageCount: 6, channel: 'voice', language: 'hi', outcome: 'checkout_started', status: 'needs_human', firstMessage: 'earbuds dikhao', failedReplies: 2, verifiedCustomer: false, personKey: 'vabc', contact: {name: 'Rahul', email: 'r@x.com', phone: ''}});
  it('says who, what came of it and what to do next', () => {
    expect(chatRow(chat, opts)).toMatchObject({id: 'c1', who: 'Rahul', detail: 'r@x.com', preview: 'earbuds dikhao', channel: 'Voice', messages: 6, result: 'Reached checkout', resultTone: 'caution', status: 'Needs follow-up', statusTone: 'critical', failed: 2, personKey: 'vabc'});
    expect(chatRow(chat, opts).when).toMatch(/^Today/);
  });
  it('cuts a long first message and copes with an empty one', () => {
    expect(chatRow({...chat, firstMessage: 'x'.repeat(100)}, opts).preview).toHaveLength(68);
    expect(chatRow({...chat, firstMessage: ''}, opts).preview).toBe('No message saved');
    expect(chatRow(/** @type {any} */ ({id: 'c2'}), opts)).toMatchObject({who: 'Visitor', result: 'Just chatted', status: 'Open'});
  });
  it('names outcomes, statuses and languages plainly, and unknown ones as words', () => {
    expect(outcomeLabel('order_placed')).toBe('Placed an order');
    expect(outcomeLabel('future_step')).toBe('Future step');
    expect(statusLabel('resolved')).toBe('Resolved');
    expect(languageLabel('hi')).toBe('Hindi');
    expect(languageLabel('')).toBe('');
    expect(languageLabel('fr')).toBe('FR');
  });
});

describe('files in a chat', () => {
  it('shows what the customer attached next to their words', () => {
    const [line] = transcriptLines([{role: 'user', text: '', at: '2026-10-30T05:00:00Z', attachments: [{id: 'a1', name: 'shoe.png', kind: 'image', mime: 'image/png', size: 2048}]}], opts);
    expect(line.attachments).toEqual([{id: 'a1', name: 'shoe.png', kind: 'image', size: '2 KB'}]);
    expect(transcriptLines([{role: 'user', text: 'hi', at: '2026-10-30T05:00:00Z'}], opts)[0].attachments).toEqual([]);
  });
  it('writes file sizes in plain units', () => {
    expect(fileSize(10)).toBe('1 KB');
    expect(fileSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fileSize(/** @type {any} */ (undefined))).toBe('1 KB');
  });
  it('marks a chat the customer cleared on their screen', () => {
    expect(chatRow(/** @type {any} */ ({id: '1', clearedByCustomer: true, contact: {}}), opts).cleared).toBe(true);
    expect(chatRow(/** @type {any} */ ({id: '1', contact: {}}), opts).cleared).toBe(false);
  });
});

describe('reading a chat', () => {
  it('lists the words in order and flags an answer the agent could not write', () => {
    const lines = transcriptLines([{role: 'user', text: 'hi', at: '2026-10-30T05:00:00Z'}, {role: 'assistant', text: 'sorry', at: '2026-10-30T05:00:05Z', failed: true}], opts);
    expect(lines.map((l) => [l.who, l.text, l.fromCustomer, l.failed])).toEqual([['Customer', 'hi', true, false], ['Agent', 'sorry', false, true]]);
    expect(transcriptLines(undefined)).toEqual([]);
  });
  it('tells what happened in plain words and skips events it cannot describe', () => {
    const lines = timelineLines([
      {type: 'conversation_started', at: '2026-10-30T05:00:00Z'},
      {type: 'products_shown', at: '2026-10-30T05:00:10Z', props: {items: [{title: 'A'}, {title: 'B'}, {title: 'C'}, {title: 'D'}]}},
      {type: 'cart_add', at: '2026-10-30T05:01:00Z', props: {title: 'Earbuds'}},
      {type: 'order_placed', at: '2026-10-30T05:02:00Z', props: {orderName: '#1007', total: 1500, currency: 'INR'}},
      {type: 'turn', at: '2026-10-30T05:02:00Z'},
    ], opts);
    expect(lines.map((l) => l.text)).toEqual(['Chat started', 'Saw A, B, C and 1 more', 'Added Earbuds to the cart', 'Placed order #1007 (₹1,500)']);
  });
});

describe('customer rows', () => {
  /** @type {import('../src/types.js').Person} */
  const person = /** @type {any} */ ({id: 'c778899', kind: 'customer', name: 'Priya Sharma', email: 'p@x.com', phone: '', chats: 2, messages: 8, voiceChats: 1, firstSeen: '2026-10-27T10:00:00Z', lastSeen: '2026-10-29T10:00:00Z', needsFollowUp: true, bestOutcome: 'order_placed', orders: 1, spend: {currency: 'INR', amount: 1500}, spendByCurrency: {INR: 1500}});
  it('shows what they spent and how far they got', () => {
    expect(customerRow(person, opts)).toMatchObject({who: 'Priya Sharma', kind: 'Signed in (verified)', kindTone: 'success', chats: 2, orders: 1, spend: '₹1,500', result: 'Placed an order', needsFollowUp: true, voiceChats: 1});
    expect(customerSummary(person)).toBe('2 chats, 1 order');
    expect(customerSummary({...person, chats: 1, orders: 0})).toBe('1 chat, no orders yet');
  });
  it('never adds money in different currencies together', () => {
    expect(spendText({...person, spendByCurrency: {USD: 20, INR: 1500}}, 'en-US')).toBe('₹1,500 + $20');
    expect(spendText({...person, spendByCurrency: {}})).toBe('—');
  });
  it('a visitor with no details is just a visitor', () => {
    expect(customerRow({...person, kind: /** @type {'visitor'} */ ('visitor'), name: '', email: '', orders: 0, spendByCurrency: {}}, opts)).toMatchObject({who: 'Visitor', kind: 'Visitor (this browser)', spend: '—'});
  });
});

describe('order rows show who ordered', () => {
  it('names the customer and links to them', () => {
    const row = orderRow({orderName: '#1007', total: 1500, currency: 'INR', customer: {personKey: 'c1', name: 'Priya', email: 'p@x.com'}}, opts);
    expect(row).toMatchObject({customer: 'Priya', customerDetail: 'p@x.com', customerKey: 'c1'});
    expect(orderRow({orderName: '#1'}, opts)).toMatchObject({customer: '—', customerKey: null});
  });
});

describe('who a chat row says it is', () => {
  const base = {id: 'c', startedAt: '2026-11-03T10:00:00Z', lastMessageAt: '2026-11-03T10:05:00Z', messageCount: 2, channel: 'text', language: 'en', outcome: 'chat', status: 'open', firstMessage: 'Hi', failedReplies: 0, personKey: 'v1'};
  it('tells signed-in shoppers, guests who left details, and unknown visitors apart', () => {
    expect(chatRow({...base, verifiedCustomer: true, contact: {email: 'a@b.com'}}).kind).toBe('Signed in');
    expect(chatRow({...base, verifiedCustomer: false, contact: {name: 'Aman'}}).kind).toBe('Guest');
    expect(chatRow({...base, verifiedCustomer: false, contact: {}}).kind).toBe('');
  });
});

import {replyBox, transcriptLines as lines2, chatTags as tags2} from '../../src/public/admin/lib/chats.js';

describe('talking to the customer from the dashboard', () => {
  it('shows team messages as the team, not the agent', () => {
    const rows = lines2([{role: 'user', text: 'hi', at: '2026-10-30T10:00:00Z'}, {role: 'assistant', text: 'hello', at: '2026-10-30T10:00:05Z'}, {role: 'staff', text: 'I am here', at: '2026-10-30T10:05:00Z'}]);
    expect(rows.map((r) => [r.who, r.fromCustomer, r.fromTeam])).toEqual([['Customer', true, false], ['Agent', false, false], ['Team', false, true]]);
  });
  it('tags a chat a person has', () => {
    expect(tags2({handoff: {active: true}, flags: {needsFollowUp: true}, status: 'needs_human'}).map((t) => t.id)).toEqual(['person', 'follow']);
    expect(tags2({flags: {}}).map((t) => t.id)).toEqual([]);
  });
  it('explains what sending does, and refuses a chat the customer cleared', () => {
    expect(replyBox({})).toMatchObject({canReply: true, active: false, reopens: false});
    expect(replyBox({}).hint).toMatch(/takes over/);
    expect(replyBox({handoff: {active: true}})).toMatchObject({canReply: true, active: true});
    expect(replyBox({status: 'resolved'}).reopens).toBe(true);
    expect(replyBox({clearedByCustomer: true, handoff: {active: true}})).toMatchObject({canReply: false, active: false});
    expect(replyBox()).toMatchObject({canReply: true});
  });
});
