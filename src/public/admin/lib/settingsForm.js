// The agent settings form: from the stored settings to the form, back to a save request, and the
// checks the server makes (so mistakes show next to the field before saving). No UI code here.

export const TONES = ['Friendly, like a shop owner', 'Professional', 'Playful', 'Short and to the point'];
export const RETENTION_CHOICES = [30, 90, 180, 365];
export const LIMITS = {name: 40, tone: 300, instructions: 1500, question: 200, answer: 1000, knowledge: 50};

// Call booking choices (the server checks the same ranges).
export const WEEKDAYS = [
  {id: 1, label: 'Mon'}, {id: 2, label: 'Tue'}, {id: 3, label: 'Wed'}, {id: 4, label: 'Thu'},
  {id: 5, label: 'Fri'}, {id: 6, label: 'Sat'}, {id: 0, label: 'Sun'},
];
export const CALL_MINUTES = [15, 20, 30, 45, 60];
export const LEAD_HOURS = [0, 1, 2, 4, 12, 24, 48];
export const AHEAD_DAYS = [3, 7, 14, 30, 60];
/** Opening hours can be picked every half hour. */
export const TIME_CHOICES = Array.from({length: 48}, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
export const TIMEZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Paris',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC',
];
const CALL_DEFAULTS = {enabled: false, days: [1, 2, 3, 4, 5], from: '10:00', to: '18:00', slotMinutes: 30, timezone: 'Asia/Kolkata', leadHours: 2, maxDaysAhead: 14, autoConfirm: false};

// Switches the owner sees. Each one turns a group of the agent's actions on or off together.
export const TOOL_GROUPS = [
  {id: 'orders', label: 'Place orders', details: 'Cash on delivery and payment links', tools: ['place_order']},
  {id: 'lookup', label: 'Look up orders', details: 'Order status and past orders, after the shopper verifies their email', tools: ['get_order_details', 'list_my_orders']},
  {id: 'cancel', label: 'Cancel orders', details: 'Only unfulfilled orders, after verification', tools: ['cancel_order', 'request_order_cancellation', 'confirm_order_cancellation']},
  {id: 'discounts', label: 'Mention discount codes', details: 'Public codes only', tools: ['apply_discount_or_offer', 'get_discounts_and_offers']},
  {id: 'complaints', label: 'Raise complaints', details: 'Writes down a customer\'s problem and raises it to you by email or a person', tools: ['raise_complaint', 'track_issue']},
];

/** @param {string} name */
const humanize = (name) => String(name).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The switches to show: the known groups the store type allows, then any other switchable action on its own. */
/**
 * @param {string[]} [configurableTools]
 * @returns {{id: string, label: string, details: string, tools: string[]}[]}
 */
export function toolSwitches(configurableTools = []) {
  const allowed = new Set(configurableTools);
  const groups = TOOL_GROUPS.map((g) => ({...g, tools: g.tools.filter((t) => allowed.has(t))})).filter((g) => g.tools.length);
  const grouped = new Set(groups.flatMap((g) => g.tools));
  const others = configurableTools.filter((t) => !grouped.has(t)).map((t) => ({id: t, label: humanize(t), details: '', tools: [t]}));
  return [...groups, ...others];
}

/**
 * @param {import('../types.js').AgentSettings} [settings]
 * @param {import('../types.js').SettingsOptions} [options]
 * @returns {import('../types.js').SettingsForm}
 */
export function toForm(settings = {}, options = {}) {
  const call = {...CALL_DEFAULTS, ...(options.bookingDefaults || {}), ...Object.fromEntries(Object.entries(settings.booking || {}).filter(([, v]) => v !== null && v !== undefined))};
  return {
    name: settings.persona?.name || '',
    tone: settings.persona?.tone || '',
    instructions: settings.instructions || '',
    knowledge: (settings.knowledge || []).map((k) => ({question: k.question, answer: k.answer})),
    disabledTools: [...(settings.disabledTools || [])].sort(),
    storeTranscripts: settings.logging?.storeTranscripts !== false,
    retentionDays: settings.logging?.retentionDays || options.defaultRetentionDays || 90,
    notificationEmail: settings.notificationEmail || '',
    callsOn: call.enabled === true,
    callDays: [...(call.days || [])].sort((a, b) => a - b),
    callFrom: String(call.from),
    callTo: String(call.to),
    callMinutes: Number(call.slotMinutes),
    callTimezone: String(call.timezone),
    callLeadHours: Number(call.leadHours),
    callMaxDays: Number(call.maxDaysAhead),
    callAutoConfirm: call.autoConfirm === true,
    calendarId: settings.booking?.calendarId || '',
    alertCall: settings.alerts?.onCallRequest !== false,
    alertFiles: settings.alerts?.onFiles !== false,
    alertFollowUp: settings.alerts?.onFollowUp !== false,
    allowPhotos: settings.files?.photos !== false,
    allowVideos: settings.files?.videos !== false,
    allowPdf: settings.files?.pdf !== false,
    // live help from a person: all off until the owner switches them on
    supportLive: settings.support?.liveEnabled === true,
    supportAudio: settings.support?.audioEnabled !== false,
    supportRecording: settings.support?.recordingEnabled === true,
  };
}

/** @param {import('../types.js').KnowledgeEntry} k */
const blankRow = (k) => !k.question.trim() && !k.answer.trim();

/** The save request. Empty fields go back to the default (null) instead of saving empty text. */
/**
 * @param {import('../types.js').SettingsForm} form
 * @returns {import('../types.js').AgentSettings}
 */
export function toPatch(form) {
  /** @param {string} v */
  const text = (v) => (v.trim() ? v.trim() : null);
  return {
    persona: {name: text(form.name), tone: text(form.tone)},
    instructions: text(form.instructions),
    knowledge: form.knowledge.filter((k) => !blankRow(k)).map((k) => ({question: k.question.trim(), answer: k.answer.trim()})),
    disabledTools: [...form.disabledTools].sort(),
    logging: {storeTranscripts: form.storeTranscripts, retentionDays: Number(form.retentionDays)},
    notificationEmail: text(form.notificationEmail),
    // switched off: only the switch is sent, so the hours the owner set earlier are kept for when they turn it back on
    booking: form.callsOn
      ? {
          enabled: true, days: [...form.callDays].sort((a, b) => a - b), from: form.callFrom, to: form.callTo, slotMinutes: Number(form.callMinutes),
          timezone: form.callTimezone, leadHours: Number(form.callLeadHours), maxDaysAhead: Number(form.callMaxDays), autoConfirm: form.callAutoConfirm, calendarId: text(form.calendarId),
        }
      : {enabled: false},
    alerts: {onCallRequest: form.alertCall, onFiles: form.alertFiles, onFollowUp: form.alertFollowUp},
    files: {photos: form.allowPhotos, videos: form.allowVideos, pdf: form.allowPdf},
    support: {liveEnabled: form.supportLive, audioEnabled: form.supportAudio, recordingEnabled: form.supportRecording},
  };
}

/** @param {import('../types.js').SettingsForm} form @param {import('../types.js').SettingsForm} saved */
export const isDirty = (form, saved) => JSON.stringify(toPatch(form)) !== JSON.stringify(toPatch(saved));

/** The same checks as the server, keyed by field so each message shows where the mistake is. */
/**
 * @param {import('../types.js').SettingsForm} form
 * @returns {Record<string, string>}
 */
export function validateForm(form) {
  /** @type {Record<string, string>} */
  const errors = {};
  if (form.name.trim().length > LIMITS.name) errors.name = `At most ${LIMITS.name} characters.`;
  if (form.tone.trim().length > LIMITS.tone) errors.tone = `At most ${LIMITS.tone} characters.`;
  if (form.instructions.trim().length > LIMITS.instructions) errors.instructions = `At most ${LIMITS.instructions} characters.`;
  const rows = form.knowledge.filter((k) => !blankRow(k));
  if (rows.length > LIMITS.knowledge) errors.knowledge = `At most ${LIMITS.knowledge} questions.`;
  form.knowledge.forEach((k, i) => {
    if (blankRow(k)) return;
    if (k.question.trim().length < 3) errors[`question-${i}`] = 'Write a question of at least 3 characters.';
    if (!k.answer.trim()) errors[`answer-${i}`] = 'Write the answer the agent should give.';
  });
  const email = form.notificationEmail.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.notificationEmail = 'This is not a valid email address.';
  const days = Number(form.retentionDays);
  if (!Number.isInteger(days) || days < 7 || days > 365) errors.retentionDays = 'Choose between 7 and 365 days.';
  if (form.callsOn) {
    if (!form.callDays.length) errors.callDays = 'Pick at least one day.';
    if (form.callTo <= form.callFrom) errors.callTo = 'The last call must be later than the first.';
    else if (minutesOf(form.callTo) - minutesOf(form.callFrom) < Number(form.callMinutes)) errors.callTo = 'Your hours are shorter than one call.';
    const id = form.calendarId.trim();
    if (id && (/\s/.test(id) || id.length > 200)) errors.calendarId = 'This does not look like a Google Calendar ID.';
  }
  return errors;
}

/** @param {string} clock "HH:MM" */
const minutesOf = (clock) => {
  const [h, m] = String(clock).split(':').map(Number);
  return h * 60 + m;
};

/** @type {Record<string, string>} */
const SECTION_NAMES = {
  booking: 'Calls',
  alerts: 'When to call you in',
  files: 'Photos, videos and PDFs',
  support: 'Live help from a person',
  persona: 'Agent name or tone',
  instructions: 'Extra instructions',
  knowledge: 'Questions and answers',
  disabledTools: 'What the agent is allowed to do',
  logging: 'Chat saving',
  notificationEmail: 'Email for customer data requests',
};

/** "Questions and answers, Extra instructions" for one history entry. */
/** @param {Partial<import('../types.js').HistoryEntry>} [entry] */
export function describeChange(entry = {}) {
  const parts = (entry.changed || []).map((k) => SECTION_NAMES[k] || humanize(k));
  return parts.length ? `Changed: ${parts.join(', ')}` : 'Saved';
}

// ---- the settings page shows four tabs instead of one long page -------------------------------------
export const SETTINGS_TABS = [
  {id: 'behaviour', label: 'Behaviour', sections: ['talks']},
  {id: 'knowledge', label: 'Knowledge', sections: ['qa']},
  {id: 'rules', label: 'Actions and alerts', sections: ['may', 'alerts']},
  {id: 'privacy', label: 'Privacy and files', sections: ['files', 'privacy', 'history']},
];

/**
 * The tab a problem with a field sits in, so saving can open it instead of leaving the owner to hunt for the red text.
 * @param {string} field a key of the errors validateForm gives
 */
export function tabForError(field) {
  const key = String(field || '');
  if (['name', 'tone', 'instructions'].includes(key)) return 'behaviour';
  if (key === 'knowledge' || /^(question|answer)-\d+$/.test(key)) return 'knowledge';
  if (key === 'retentionDays') return 'privacy';
  return 'rules'; // calls, calendar, notification email
}
