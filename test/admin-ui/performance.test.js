import {describe, it, expect} from './harness.js';
import {barsSummary, dailyBars, formatDuration, percent, performanceTiles} from '../../src/public/admin/lib/performance.js';

describe('durations and shares', () => {
  it('reads as seconds or minutes, and a dash for nothing', () => {
    expect(formatDuration(2000)).toBe('2.0 s');
    expect(formatDuration(900)).toBe('0.9 s');
    expect(formatDuration(90000)).toBe('1.5 min');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
  it('rounds a share to a whole percent', () => {
    expect(percent(0.667)).toBe('67%');
    expect(percent(undefined)).toBe('0%');
    expect(percent(0.001)).toBe('<1%');
  });
});

describe('performance tiles', () => {
  const totals = {conversations: 3, handledAlone: 2, handledAloneRate: 0.667, needPerson: 1, replies: 3, failedReplies: 1, failedRate: 0.333, averageResponseMs: 2000, orderedChats: 2, orderRate: 0.667, channels: {text: 2, voice: 1}};
  const by = (t) => Object.fromEntries(performanceTiles(t).map((x) => [x.id, x]));
  it('shows the numbers with plain notes, and flags only what needs a look', () => {
    const tiles = by(totals);
    expect([tiles.alone.value, tiles.alone.note]).toEqual(['67%', '2 chats of 3']);
    expect([tiles.needs.value, tiles.needs.tone]).toEqual(['1', 'caution']);
    expect([tiles.speed.value, tiles.speed.tone]).toEqual(['2.0 s', '']);
    expect([tiles.failed.value, tiles.failed.tone, tiles.failed.note]).toEqual(['1', 'critical', '33% of replies']);
    expect([tiles.orders.value, tiles.orders.note]).toEqual(['67%', '2 chats placed an order']);
    expect(tiles.channels.value).toBe('1 / 2');
  });
  it('a slow average is flagged', () => {
    expect(by({...totals, averageResponseMs: 12000}).speed).toMatchObject({value: '12.0 s', tone: 'caution', note: 'Slower than usual'});
  });
  it('a quiet store shows dashes and no alarms, never NaN', () => {
    const tiles = performanceTiles({});
    expect(tiles.map((x) => x.tone)).toEqual(['', '', '', '', '', '']);
    expect(tiles.find((x) => x.id === 'alone').value).toBe('—');
    expect(JSON.stringify(tiles)).not.toMatch(/NaN|undefined/);
    expect(performanceTiles().length).toBe(6);
  });
});

describe('daily bars', () => {
  const series = [{date: '2026-10-27', replies: 0}, {date: '2026-10-28', replies: 5}, {date: '2026-10-29', replies: 10}];
  it('scales to the busiest day, with no bar for an empty one', () => {
    const c = dailyBars(series, 'replies', {width: 300, height: 100, gap: 0});
    expect(c.peak).toBe(10);
    expect(c.bars.map((b) => b.h)).toEqual([0, 50, 100]);
    expect(c.bars[2]).toMatchObject({x: 200, y: 0, w: 100});
  });
  it('a tiny non-zero day is still visible, and no data draws nothing', () => {
    expect(dailyBars([{date: 'a', n: 1}, {date: 'b', n: 1000}], 'n', {height: 100}).bars[0].h).toBe(2);
    expect(dailyBars([], 'n').bars).toEqual([]);
    expect(dailyBars([{date: 'a', n: 0}], 'n').bars[0].h).toBe(0);
  });
  it('describes the chart in words', () => {
    expect(barsSummary(series, 'replies', (n) => `${n} replies`)).toBe('2 of 3 days have data. Highest on 2026-10-29: 10 replies.');
    expect(barsSummary([], 'replies', String)).toBe('No data in these dates.');
  });
});
