// What every screen shares: the store, the chosen period, the screens themselves and the click actions.
// Screens register themselves in `screens`; buttons name an action with data-action="name" and the page
// calls actions[name] (one listener for the whole page, so redrawing a screen never loses its buttons).
import {addDays, rangeFor, todayIn} from './lib/dateRange.js';

export const NAV = [
  {id: 'home', label: 'Home', icon: 'home'},
  {id: 'conversations', label: 'Conversations', icon: 'message-square', badge: 'unread'},
  {id: 'orders', label: 'Orders & Customers', icon: 'shopping-bag'},
  {id: 'calls', label: 'Calls', icon: 'phone'},
  {id: 'complaints', label: 'Complaints', icon: 'flag', badge: 'complaints'},
  {id: 'bookings', label: 'Bookings', icon: 'calendar', badge: 'calls'},
  {id: 'catalog', label: 'Catalog insights', icon: 'compass'},
  {id: 'quality', label: 'AI quality', icon: 'sparkles'},
  {id: 'train', label: 'Train your assistant', icon: 'sliders-horizontal'},
  {id: 'widget', label: 'Widget', icon: 'layout-template'},
  {id: 'settings', label: 'Settings', icon: 'settings'},
];

export const state = {
  screen: 'home',
  store: {shop: '', name: '', currency: '', timezone: 'UTC', industry: 'ecommerce'},
  period: 'last7',
  custom: {from: '', to: ''},
  attention: null,
  sidebarCollapsed: false,
  /** the data of the screen on show: {status: 'loading'|'ready'|'error', data, error} */
  view: {status: 'loading'},
};

/** @type {Record<string, {load: (ctx: any) => Promise<any>, html: (data: any, ctx: any) => string, after?: (data: any, ctx: any) => void}>} */
export const screens = {};
/** @type {Record<string, (el: HTMLElement, event: Event) => any>} */
export const actions = {};

export const PERIODS = [
  {id: 'today', label: 'Today'},
  {id: 'last7', label: '7d'},
  {id: 'last30', label: '30d'},
  {id: 'custom', label: 'Custom'},
];

export const range = () => rangeFor(state.period, state.store.timezone, Date.now(), state.custom);

/** The longest span the server accepts (a year): used where a list should reach back as far as it can. */
export const wideRange = () => {
  const to = todayIn(state.store.timezone);
  return {from: addDays(to, -364), to};
};


