import {describe, it, expect} from './harness.js';
import {attentionItems, chartLines, chartSummary, funnelBars, niceMax} from '../../src/public/admin/lib/overview.js';

describe('funnel bars', () => {
  const funnel = [
    {stage: 'conversation_started', conversations: 128},
    {stage: 'products_shown', conversations: 96},
    {stage: 'cart_add', conversations: 41},
    {stage: 'checkout_started', conversations: 22},
    {stage: 'order_placed', conversations: 1},
    {stage: 'something_new', conversations: 0},
  ];
  it('sizes each bar against the chats that started', () => {
    const bars = funnelBars(funnel);
    expect(bars.map((b) => b.percent)).toEqual([100, 75, 32, 17, 2, 0]);
  });
  it('uses plain labels and makes one up for an unknown step', () => {
    const bars = funnelBars(funnel);
    expect(bars[0].label).toBe('Chatted');
    expect(bars[5].label).toBe('Something new');
  });
  it('shows empty bars when nobody chatted', () => {
    expect(funnelBars([{stage: 'conversation_started', conversations: 0}, {stage: 'cart_add', conversations: 0}]).map((b) => b.percent)).toEqual([0, 0]);
    expect(funnelBars(undefined)).toEqual([]);
  });
});

describe('chart', () => {
  const series = [
    {date: '2026-10-01', conversations: 4, orders: 0},
    {date: '2026-10-02', conversations: 8, orders: 1},
    {date: '2026-10-03', conversations: 0, orders: 2},
  ];
  it('draws one point per day, the biggest day at the top and zero on the baseline', () => {
    const c = chartLines(series, {width: 100, height: 100, left: 0, right: 0, top: 0, bottom: 0});
    expect(c.chats.split(' ')).toEqual(['0,50', '50,0', '100,100']);
    expect(c.orders.split(' ')).toEqual(['0,100', '50,50', '100,0']);
  });
  it('labels the first, middle and last day', () => {
    expect(chartLines(series).labels.map((l) => l.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });
  it('copes with one day and with no days', () => {
    expect(chartLines([series[0]]).chats.split(' ')).toHaveLength(1);
    const none = chartLines([]);
    expect(none.chats).toBe('');
    expect(none.labels).toEqual([]);
  });
  it('flat zero data stays on the baseline instead of dividing by zero', () => {
    const c = chartLines([{date: 'a', conversations: 0, orders: 0}, {date: 'b', conversations: 0, orders: 0}], {width: 100, height: 100, left: 0, right: 0, top: 0, bottom: 0});
    expect(c.chats).toBe('0,100 100,100');
  });
  it('describes itself for screen readers', () => {
    expect(chartSummary(series)).toBe('Line chart over 3 days: 12 chats and 3 orders in total.');
    expect(chartSummary([])).toBe('No chats in this period.');
  });
});

describe('needs your attention', () => {
  it('lists only what is there, with the right wording for one or many', () => {
    expect(attentionItems({dropoffs: {checkoutNoOrder: 1}, needsFollowUp: 3, failedReplies: 2}).map((i) => i.text)).toEqual([
      '1 shopper reached checkout but did not order',
      '3 chats waiting on you',
      '2 replies the agent could not write',
    ]);
    expect(attentionItems({dropoffs: {checkoutNoOrder: 0}, failedReplies: 0})).toEqual([]);
    expect(attentionItems({})).toEqual([]);
  });
});

import {ordersNote} from '../../src/public/admin/lib/overview.js';
describe('orders note', () => {
  it('says who placed the orders', () => {
    expect(ordersNote({agent: 12, assisted: 2})).toBe('12 placed in chat, 2 later on the site');
    expect(ordersNote({agent: 3})).toBe('All 3 placed in chat');
    expect(ordersNote({assisted: 1})).toBe('All 1 placed later on the site');
    expect(ordersNote({})).toBe('');
    expect(ordersNote(undefined)).toBe('');
  });
});

describe('chart axes', () => {
  it('rounds the top of an axis so four equal steps read cleanly', () => {
    expect(niceMax(84)).toBe(100);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(0)).toBe(4);
    expect(niceMax(412)).toBe(800);
  });
  it('draws each line against its rounded top when asked, and keeps the exact top otherwise', () => {
    const series = [{date: '2026-10-01', conversations: 10, orders: 1}, {date: '2026-10-02', conversations: 84, orders: 3}];
    const plain = chartLines(series);
    const nice = chartLines(series, {nice: true});
    expect(plain.axisChats).toBe(0);
    expect(nice.axisChats).toBe(100);
    expect(nice.axisOrders).toBe(4);
    expect(plain.chats.split(' ')[1]).not.toBe(nice.chats.split(' ')[1]);
  });
});
