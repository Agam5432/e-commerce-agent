import {describe, it, expect} from './harness.js';
import {chatLink, chatsLink, customerLink, customersLink, href, metricForStage, metricForTop, metricTitle, ordersLink} from '../../src/public/admin/lib/links.js';
import {attentionItems} from '../../src/public/admin/lib/overview.js';

const RANGE = {from: '2026-10-01', to: '2026-10-30'};

describe('links between pages', () => {
  it('leaves empty values out and encodes the rest', () => {
    expect(href('/chats', {a: 'x y', b: '', c: undefined, d: 0})).toBe('/chats?a=x+y&d=0');
    expect(href('/orders')).toBe('/orders');
  });
  it('a number opens the chats it counted, for the same dates', () => {
    expect(chatsLink('dropoff:cartOnly', RANGE)).toBe('/chats?metric=dropoff%3AcartOnly&from=2026-10-01&to=2026-10-30');
    expect(customersLink(RANGE)).toBe('/chats?view=customers&from=2026-10-01&to=2026-10-30');
    expect(ordersLink(RANGE, {source: 'agent'})).toBe('/orders?from=2026-10-01&to=2026-10-30&source=agent');
    expect(chatLink('abc')).toBe('/chats?conversation=abc');
    expect(customerLink('c778899')).toBe('/chats?view=customers&customer=c778899');
  });
  it('a funnel step and a top-list name become the metric the backend understands', () => {
    expect(metricForStage('conversation_started')).toBe('started');
    expect(metricForStage('order_placed')).toBe('reached:order_placed');
    expect(metricForTop('productsShown', 'Earbuds: Pro')).toBe('top:productsShown:Earbuds: Pro');
  });
  it('a list always says what it is a list of', () => {
    expect(metricTitle('dropoff:checkoutNoOrder')).toBe('Reached checkout but did not order');
    expect(metricTitle('reached:order_placed')).toBe('Chats that became orders');
    expect(metricTitle('top:productsShown:Earbuds')).toBe('Chats where "Earbuds" was shown');
    expect(metricTitle('top:productsAdded:Power bank: 10k')).toBe('Chats where "Power bank: 10k" was added to the cart');
    expect(metricTitle('reached:something_new')).toBe('Chats that reached "something new"');
    expect(metricTitle('')).toBe('');
    expect(metricTitle('weird')).toBe('Selected chats');
  });
  it('"needs your attention" items open the matching chats', () => {
    const items = attentionItems({dropoffs: {checkoutNoOrder: 2}, needsFollowUp: 1, failedReplies: 3}, RANGE);
    expect(items.map((i) => i.to)).toEqual([
      chatsLink('dropoff:checkoutNoOrder', RANGE),
      chatsLink('needs_follow_up', RANGE),
      chatsLink('failed', RANGE),
    ]);
  });
});
