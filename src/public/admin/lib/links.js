// Every link between dashboard pages is built here, so a card, a list row and a banner can never
// disagree about where they go. The address carries what the page should show (which chats, which dates).

/**
 * @param {string} path
 * @param {Record<string, unknown>} [params] empty values are left out
 */
export function href(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

/** The chats a number counted. `metric` names them (see the backend: started, reached:<step>, dropoff:<key>, ...). */
/** @param {string} metric @param {{from: string, to: string}} range @param {Record<string, unknown>} [extra] */
export const chatsLink = (metric, range, extra = {}) => href('/chats', {metric, from: range.from, to: range.to, ...extra});

/** @param {{from: string, to: string}} range @param {Record<string, unknown>} [extra] */
export const customersLink = (range, extra = {}) => href('/chats', {view: 'customers', from: range.from, to: range.to, ...extra});

/** @param {{from: string, to: string}} range @param {Record<string, unknown>} [extra] */
export const ordersLink = (range, extra = {}) => href('/orders', {from: range.from, to: range.to, ...extra});

/** @param {string} id */
export const chatLink = (id) => href('/chats', {conversation: id});

/** @param {string} key */
export const customerLink = (key) => href('/chats', {view: 'customers', customer: key});

/** A funnel step is the chats that reached it ("started a chat" is simply every chat). */
/** @param {string} stage */
export const metricForStage = (stage) => (stage === 'conversation_started' ? 'started' : `reached:${stage}`);

/** @param {string} listKey a top list (e.g. productsShown) @param {string} name */
export const metricForTop = (listKey, name) => `top:${listKey}:${name}`;

/** @type {Record<string, string>} */
const TITLES = {
  started: 'Everyone who started a chat',
  active: 'Chats with activity in this period',
  'reached:products_shown': 'Chats where products were shown',
  'reached:cart_add': 'Chats that added something to the cart',
  'reached:checkout_started': 'Chats that reached checkout',
  'reached:payment_link_created': 'Chats that got a payment link',
  'reached:order_placed': 'Chats that became orders',
  'dropoff:cartOnly': 'Added to the cart but did not order',
  'dropoff:checkoutNoOrder': 'Reached checkout but did not order',
  failed: 'Chats where the agent could not write a reply',
  needs_follow_up: 'Chats waiting on you',
};

/** The sentence at the top of a list that says what it is a list of. */
/** @param {string} [metric] */
export function metricTitle(metric) {
  if (!metric) return '';
  if (TITLES[metric]) return TITLES[metric];
  const top = /^top:([A-Za-z]+):(.+)$/.exec(metric);
  if (top) {
    const verb = /added/i.test(top[1]) ? 'was added to the cart' : 'was shown';
    return `Chats where "${top[2]}" ${verb}`;
  }
  const reached = /^reached:(.+)$/.exec(metric);
  if (reached) return `Chats that reached "${reached[1].replace(/_/g, ' ')}"`;
  return 'Selected chats';
}
