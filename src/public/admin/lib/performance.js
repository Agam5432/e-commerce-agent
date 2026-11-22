// Turns the performance answer from the backend into what the page shows. No UI code, so it is tested on its own.
import {formatNumber} from './format.js';
import {funnelBars} from './overview.js';

/** "2.1 s", "1.4 min", or a dash when nothing was timed. @param {number} ms */
export function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

/** @param {number} fraction */
export const percent = (fraction) => {
  const f = fraction || 0;
  return f > 0 && f < 0.005 ? '<1%' : `${Math.round(f * 100)}%`;
};

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/**
 * The headline tiles. `tone` is only set when a number deserves a second look, so a quiet store shows no alarms.
 * @param {any} [totals]
 */
export function performanceTiles(totals = {}) {
  const t = {conversations: 0, handledAlone: 0, handledAloneRate: 0, needPerson: 0, replies: 0, failedReplies: 0, failedRate: 0, averageResponseMs: 0, orderedChats: 0, orderRate: 0, channels: {text: 0, voice: 0}, resolved: 0, ...totals};
  const slow = t.averageResponseMs > 8000;
  return [
    {id: 'alone', label: 'Handled without you', value: t.conversations ? percent(t.handledAloneRate) : '—', note: t.conversations ? `${count(t.handledAlone, 'chat', 'chats')} of ${formatNumber(t.conversations)}` : 'No chats in these dates', tone: ''},
    {id: 'needs', label: 'Needed a person', value: formatNumber(t.needPerson), note: t.needPerson ? 'Still waiting for you' : 'Nothing waiting', tone: t.needPerson ? 'caution' : ''},
    {id: 'speed', label: 'Average reply time', value: formatDuration(t.averageResponseMs), note: slow ? 'Slower than usual' : t.replies ? `${count(t.replies, 'reply', 'replies')}` : 'No replies yet', tone: slow ? 'caution' : ''},
    {id: 'failed', label: 'Replies that failed', value: formatNumber(t.failedReplies), note: t.replies ? `${percent(t.failedRate)} of replies` : '', tone: t.failedReplies ? 'critical' : ''},
    {id: 'orders', label: 'Chats that ordered', value: t.conversations ? percent(t.orderRate) : '—', note: t.conversations ? `${count(t.orderedChats, 'chat', 'chats')} placed an order` : '', tone: ''},
    {id: 'channels', label: 'Voice and text', value: `${formatNumber(t.channels.voice)} / ${formatNumber(t.channels.text)}`, note: 'Voice chats / text chats', tone: ''},
  ];
}

/**
 * Bars for a per-day number. Heights are relative to the tallest day; a day with nothing gets no bar.
 * @param {{date: string}[]} [series]
 * @param {string} key
 * @param {{width?: number, height?: number, gap?: number}} [box]
 */
export function dailyBars(series = [], key, {width = 640, height = 160, gap = 4} = {}) {
  const peak = Math.max(0, ...series.map((d) => Number(d[key]) || 0));
  const slot = series.length ? width / series.length : width;
  const barWidth = Math.max(2, slot - gap);
  return {
    peak,
    width,
    height,
    bars: series.map((d, i) => {
      const value = Number(d[key]) || 0;
      const h = peak ? Math.max(value ? 2 : 0, Math.round((value / peak) * height * 10) / 10) : 0;
      return {date: d.date, value, x: Math.round((i * slot + gap / 2) * 10) / 10, y: Math.round((height - h) * 10) / 10, w: Math.round(barWidth * 10) / 10, h};
    }),
  };
}

/** One line under the chart for people using a screen reader. @param {{date: string}[]} series @param {string} key @param {(n: number) => string} format */
export function barsSummary(series, key, format) {
  const days = series.filter((d) => Number(d[key]) > 0);
  if (!days.length) return 'No data in these dates.';
  const top = days.reduce((a, b) => (Number(b[key]) > Number(a[key]) ? b : a));
  return `${days.length} of ${series.length} days have data. Highest on ${top.date}: ${format(Number(top[key]))}.`;
}

export {funnelBars};
