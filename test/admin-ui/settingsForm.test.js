import {describe, it, expect} from './harness.js';
import {describeChange, isDirty, toForm, toPatch, toolSwitches, validateForm} from '../../src/public/admin/lib/settingsForm.js';

const CONFIGURABLE = ['place_order', 'apply_discount_or_offer', 'get_discounts_and_offers', 'cancel_order', 'request_order_cancellation', 'confirm_order_cancellation', 'get_order_details', 'list_my_orders'];

describe('tool switches', () => {
  it('groups the store type\'s actions into the switches from the design', () => {
    expect(toolSwitches(CONFIGURABLE).map((s) => s.label)).toEqual(['Place orders', 'Look up orders', 'Cancel orders', 'Mention discount codes']);
    expect(toolSwitches(CONFIGURABLE)[1].tools).toEqual(['get_order_details', 'list_my_orders']);
    expect(toolSwitches(CONFIGURABLE)[2].tools).toEqual(['cancel_order', 'request_order_cancellation', 'confirm_order_cancellation']);
  });
  it('shows only what the store type allows, and any new action on its own', () => {
    expect(toolSwitches(['place_order', 'book_table']).map((s) => s.label)).toEqual(['Place orders', 'Book table']);
    expect(toolSwitches([])).toEqual([]);
  });
});

describe('form <-> settings', () => {
  const stored = {version: 3, persona: {name: 'Orbi', tone: 'Playful'}, instructions: 'Be nice', knowledge: [{question: 'EMI?', answer: 'Yes'}], disabledTools: ['place_order'], logging: {storeTranscripts: false, retentionDays: 180}, notificationEmail: 'a@b.co'};
  it('fills the form from what is stored, with defaults for what is not', () => {
    expect(toForm(stored)).toMatchObject({name: 'Orbi', tone: 'Playful', storeTranscripts: false, retentionDays: 180, disabledTools: ['place_order']});
    expect(toForm({}, {defaultRetentionDays: 90})).toMatchObject({name: '', storeTranscripts: true, retentionDays: 90, knowledge: []});
  });
  it('turns empty fields back into defaults and drops blank question rows', () => {
    const form = {...toForm({}), name: '  ', instructions: '', knowledge: [{question: ' ', answer: ''}, {question: 'Do you ship?', answer: ' Yes '}]};
    const patch = toPatch(form);
    expect(patch.persona).toEqual({name: null, tone: null});
    expect(patch.instructions).toBe(null);
    expect(patch.knowledge).toEqual([{question: 'Do you ship?', answer: 'Yes'}]);
    expect(patch.notificationEmail).toBe(null);
  });
  it('knows when something changed', () => {
    const saved = toForm(stored);
    expect(isDirty({...saved}, saved)).toBe(false);
    expect(isDirty({...saved, name: 'Orbi '}, saved)).toBe(false);
    expect(isDirty({...saved, tone: 'Professional'}, saved)).toBe(true);
    expect(isDirty({...saved, disabledTools: []}, saved)).toBe(true);
  });
});

describe('checks', () => {
  const base = toForm({});
  it('accepts a normal form', () => {
    expect(validateForm({...base, name: 'Orbi', notificationEmail: 'owner@shop.com'})).toEqual({});
  });
  it('points at the exact field that is wrong', () => {
    const errors = validateForm({...base, name: 'x'.repeat(41), notificationEmail: 'nope', retentionDays: 3, knowledge: [{question: 'Hi', answer: ''}, {question: '', answer: ''}]});
    expect(Object.keys(errors).sort()).toEqual(['answer-0', 'name', 'notificationEmail', 'question-0', 'retentionDays']);
  });
});

describe('history', () => {
  it('says what changed in plain words', () => {
    expect(describeChange({changed: ['knowledge', 'persona']})).toBe('Changed: Questions and answers, Agent name or tone');
    expect(describeChange({changed: ['industry']})).toBe('Changed: Industry');
    expect(describeChange({})).toBe('Saved');
  });
});

describe('calls, alerts and files', () => {
  const OPTIONS = {bookingDefaults: {enabled: false, days: [1, 2, 3, 4, 5], from: '10:00', to: '18:00', slotMinutes: 30, timezone: 'Europe/London', leadHours: 2, maxDaysAhead: 14, autoConfirm: false}};
  it('starts with calls off, the store\'s own time zone, and every alert and file type on', () => {
    const form = toForm({}, OPTIONS);
    expect(form).toMatchObject({callsOn: false, callTimezone: 'Europe/London', callFrom: '10:00', callMinutes: 30, alertCall: true, alertFiles: true, alertFollowUp: true, allowPhotos: true, allowVideos: true, allowPdf: true, calendarId: ''});
  });
  it('shows what the owner saved', () => {
    const form = toForm({booking: {enabled: true, days: [3, 1], from: '09:30', to: '17:00', slotMinutes: 20, timezone: 'Asia/Kolkata', autoConfirm: true, calendarId: 'a@b.com'}, alerts: {onFiles: false}, files: {videos: false}}, OPTIONS);
    expect(form).toMatchObject({callsOn: true, callDays: [1, 3], callFrom: '09:30', callTo: '17:00', callMinutes: 20, callTimezone: 'Asia/Kolkata', callAutoConfirm: true, calendarId: 'a@b.com', alertFiles: false, allowVideos: false, allowPhotos: true});
  });
  it('saves the whole call setup when on, and only the switch when off', () => {
    const on = toPatch({...toForm({}, OPTIONS), callsOn: true, calendarId: ' me@gmail.com '});
    expect(on.booking).toEqual({enabled: true, days: [1, 2, 3, 4, 5], from: '10:00', to: '18:00', slotMinutes: 30, timezone: 'Europe/London', leadHours: 2, maxDaysAhead: 14, autoConfirm: false, calendarId: 'me@gmail.com'});
    expect(toPatch(toForm({}, OPTIONS)).booking).toEqual({enabled: false});
    expect(toPatch({...toForm({}, OPTIONS), allowPdf: false}).files).toEqual({photos: true, videos: true, pdf: false});
    expect(toPatch(toForm({}, OPTIONS)).alerts).toEqual({onCallRequest: true, onFiles: true, onFollowUp: true});
  });
  it('changing hours while calls are off is not a change', () => {
    const saved = toForm({}, OPTIONS);
    expect(isDirty({...saved, callFrom: '08:00'}, saved)).toBe(false);
    expect(isDirty({...saved, callsOn: true}, saved)).toBe(true);
    expect(isDirty({...saved, alertFiles: false}, saved)).toBe(true);
  });
  it('points at the wrong call field only while calls are on', () => {
    const base = {...toForm({}, OPTIONS), callFrom: '18:00', callTo: '10:00', callDays: [], calendarId: 'has space'};
    expect(validateForm(base)).toEqual({});
    expect(Object.keys(validateForm({...base, callsOn: true})).sort()).toEqual(['calendarId', 'callDays', 'callTo']);
    expect(validateForm({...toForm({}, OPTIONS), callsOn: true, callFrom: '10:00', callTo: '10:20', callMinutes: 30}).callTo).toMatch(/shorter than one call/);
    expect(validateForm({...toForm({}, OPTIONS), callsOn: true})).toEqual({});
  });
  it('names the new sections in the change history', () => {
    expect(describeChange({changed: ['booking', 'alerts', 'files']})).toBe('Changed: Calls, When to call you in, Photos, videos and PDFs');
  });
});
