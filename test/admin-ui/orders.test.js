import {describe, it, expect} from './harness.js';
import {orderRow, paymentLabel, paidVsCod, paymentOptions, placedByAgent} from '../../src/public/admin/lib/orders.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

describe('order rows', () => {
  it('shows the store-currency total when Shopify reported it', () => {
    const row = orderRow({orderName: '#1006', at: '2026-10-30T05:30:00Z', total: 16278996.8, currency: 'INR', shopTotal: 170960.39, shopCurrency: 'USD', paymentMethod: 'cod', items: 1, source: 'agent', conversationId: 'c1'}, {timezone: 'UTC', now: NOW, locale: 'en-US'});
    expect(row).toMatchObject({order: '#1006', placedBy: 'Agent', payment: 'Cash on delivery', items: 1, total: '$170,960.39', conversationId: 'c1'});
    expect(row.date).toMatch(/^Today/);
  });
  it('falls back to what the shopper paid, and names unknown values plainly', () => {
    const row = orderRow({orderName: '#1002', at: '2026-10-28T05:00:00Z', total: 500, currency: 'INR', paymentMethod: 'bank_transfer', source: 'assisted'}, {now: NOW, locale: 'en-US'});
    expect(row.total).toBe('₹500');
    expect(row.payment).toBe('Bank transfer');
    expect(row.placedBy).toMatch(/^Assisted/);
    expect(row.conversationId).toBe(null);
  });
  it('never breaks on a half-empty record', () => {
    expect(orderRow({})).toMatchObject({order: '—', total: '—', payment: '—', placedBy: '—', items: '—'});
  });
});

describe('placed by the agent', () => {
  it('reads "x of y"', () => {
    expect(placedByAgent({agent: 12, assisted: 2}, 14)).toBe('12 of 14');
    expect(placedByAgent(undefined, 0)).toBe('0 of 0');
  });
});

describe('how orders were paid', () => {
  it('names each way in plain words', () => {
    expect(paymentLabel('cod')).toBe('Cash on delivery');
    expect(paymentLabel('prepaid')).toBe('Prepaid');
    expect(paymentLabel('gift_card')).toBe('Gift card');
    expect(paymentLabel('')).toBe('—');
  });
  it('offers only the ways this store was really paid, after "Any payment"', () => {
    expect(paymentOptions({cod: 41, prepaid: 22, unknown: 3, online: 0}).map((o) => o.id)).toEqual(['', 'cod', 'prepaid']);
    expect(paymentOptions().map((o) => o.id)).toEqual(['']);
  });
  it('counts orders paid online against cash on delivery, and leaves out the ones with no payment recorded', () => {
    expect(paidVsCod({cod: 5, prepaid: 6, online: 3, unknown: 2})).toEqual({online: 9, cod: 5, text: '9 / 5'});
    expect(paidVsCod({}).text).toBe('0 / 0');
  });
});

import {orderDetailView, statusBadges} from '../../src/public/admin/lib/orders.js';

describe('order status badges', () => {
  it('shows payment and delivery, with a tone that matches what it means', () => {
    expect(statusBadges({payment: 'paid', fulfillment: 'unfulfilled'})).toEqual([
      {key: 'payment', label: 'Paid', tone: 'success'},
      {key: 'fulfillment', label: 'Unfulfilled', tone: 'caution'},
    ]);
  });
  it('a cancelled order says only that, and a missing status shows nothing', () => {
    expect(statusBadges({payment: 'paid', fulfillment: 'fulfilled', cancelled: true})).toEqual([{key: 'cancelled', label: 'Cancelled', tone: 'critical'}]);
    expect(statusBadges(null)).toEqual([]);
    expect(statusBadges({payment: null, fulfillment: null})).toEqual([]);
  });
  it('an unknown Shopify word still shows, in a neutral tone', () => {
    expect(statusBadges({payment: 'something new'})).toEqual([{key: 'payment', label: 'Something new', tone: 'neutral'}]);
  });
  it('the row carries them', () => {
    expect(orderRow({orderName: '#1', status: {payment: 'paid', fulfillment: null}}).badges.map((b) => b.label)).toEqual(['Paid']);
    expect(orderRow({orderName: '#1', status: null}).badges).toEqual([]);
  });
});

describe('the order page', () => {
  const money = (amount) => ({amount, currency: 'INR'});
  const order = {
    name: '#1002', shopifyId: '555', createdAt: '2026-10-29T09:05:00Z', cancelledAt: null, cancelReason: null,
    paymentStatus: 'paid', fulfillmentStatus: 'fulfilled', gateways: ['Razorpay'], discountCodes: ['WELCOME10'], email: 'riya@example.com', phone: '',
    items: [{title: 'Earbuds', variant: 'Black', quantity: 2, unitPrice: money(225), lineTotal: money(450)}, {title: 'Cable', variant: '', quantity: 1, unitPrice: money(50), lineTotal: money(50)}],
    amounts: {subtotal: money(500), shipping: money(0), tax: money(0), discounts: money(45), total: money(455), refunded: money(0)},
    shippingMethod: 'Standard', shippingAddress: {name: 'Riya', phone: '', lines: ['12 MG Road', 'Pune']}, billingAddress: null,
    shipments: [{status: 'in transit', shippedAt: '2026-10-30T00:00:00Z', estimatedDeliveryAt: '2026-11-02T00:00:00Z', deliveredAt: null, tracking: [{company: 'Delhivery', number: 'DL1', url: 'https://t/DL1'}]}],
  };
  const view = orderDetailView({recorded: {orderName: '#1002', source: 'agent', conversationId: 'c3', total: 455, currency: 'INR'}, order, notice: ''}, {now: Date.UTC(2026, 9, 30, 12), locale: 'en-US', handle: 'my-shop'});

  it('lists the items and the money in order, leaving out lines that are zero', () => {
    expect(view.itemCount).toBe(3);
    expect(view.items.map((i) => [i.title, i.variant, i.quantity, i.line])).toEqual([['Earbuds', 'Black', 2, '₹450'], ['Cable', '', 1, '₹50']]);
    expect(view.summary.map((r) => [r.label, r.value])).toEqual([['Subtotal', '₹500'], ['Discount (WELCOME10)', '−₹45'], ['Shipping (Standard)', 'Free'], ['Total', '₹455']]);
  });
  it('links to the chat and to the order in Shopify, and names how it was paid', () => {
    expect(view.conversationId).toBe('c3');
    expect(view.shopifyUrl).toBe('https://admin.shopify.com/store/my-shop/orders/555');
    expect(view.payment).toBe('Razorpay');
    expect(view.badges.map((b) => b.label)).toEqual(['Paid', 'Fulfilled']);
    expect(view.shipments[0]).toMatchObject({status: 'In transit', delivered: ''});
    expect(view.shipments[0].expected).not.toBe('');
  });
  it('notes a cancelled order', () => {
    const v = orderDetailView({recorded: {}, order: {...order, cancelledAt: '2026-10-29T10:00:00Z', cancelReason: 'customer'}});
    expect(v.cancelNote).toMatch(/^Cancelled .*customer$/);
    expect(v.badges.map((b) => b.label)).toEqual(['Cancelled']);
  });
  it('without Shopify it still shows what the chat recorded, plus the note', () => {
    const v = orderDetailView({recorded: {orderName: '#1002', total: 500, currency: 'INR', paymentMethod: 'cod', items: 2, source: 'agent'}, order: null, notice: 'Shopify could not find this order.'}, {locale: 'en-US'});
    expect([v.name, v.notice, v.payment, v.itemCount, v.items.length, v.shopifyUrl]).toEqual(['#1002', 'Shopify could not find this order.', 'Cash on delivery', 2, 0, '']);
    expect(v.summary).toEqual([{label: 'Total', value: '₹500', strong: true}]);
  });
  it('never breaks on nothing', () => {
    expect(orderDetailView(null).name).toBe('—');
  });
});
