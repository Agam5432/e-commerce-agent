// Settings: what the assistant may do, who gets alerted, calls and opening hours, and what is kept about shoppers.
import {screens, state} from '../core.js';
import {AHEAD_DAYS, CALL_MINUTES, LEAD_HOURS, LIMITS, RETENTION_CHOICES, TIMEZONES, TIME_CHOICES, WEEKDAYS, toolSwitches} from '../lib/settingsForm.js';
import {esc} from '../ui.js';
import {card, loadSettings, saveBar, select, sf, text, toggle} from './_form.js';

const hoursLabel = (h) => (h === 0 ? 'No notice needed' : h < 24 ? `${h} hour${h === 1 ? '' : 's'} ahead` : `${h / 24} day${h === 24 ? '' : 's'} ahead`);

function supportCard() {
  const o = sf.options;
  const f = sf.form;
  const cb = f.callsOn;
  const status = (ok, onText, offText) => `<span class="${ok ? 'text-success-text' : 'text-warning-text'}">${esc(ok ? onText : offText)}</span>`;
  const rows = f.supportLive ? `<div class="pl-7 space-y-1">
      ${toggle('supportAudio', 'Offer audio calls', 'The shopper talks to you in the chat, with sound only. No camera, no phone number needed.')}
      ${toggle('supportRecording', 'Allow saving calls', 'Always asked first. If the shopper says no, nothing is recorded, and they get the same help.')}
      ${f.supportRecording ? '<p class="text-[11px] text-warning-text">Tell your shoppers in your privacy policy that calls may be recorded with their consent, and follow the recording rules where you and they are.</p>' : ''}</div>` : '';
  return card('Live help from a person', 'Let a shopper who asks for a person talk to you right now. You take calls from this dashboard, in the browser: no app and no phone.',
    `${toggle('supportLive', 'Let shoppers ask for a person in the chat', 'You must be set to Online (top right) to take calls. If nobody is free, the shopper can try again or book a callback.')}${rows}
    <div class="mt-2 p-3 rounded-md bg-subtle/50 text-[11px] space-y-1 text-ink-secondary">
      <div>Callbacks: ${status(cb, 'on (hours and length are under Calls below)', 'off: shoppers will not be offered a callback')}</div>
      <div>Google Calendar: ${status(Boolean(o.calendar?.configured), 'credentials are set on the server (access is only proven when a callback is added)', 'not set up, so callbacks will not be added to a calendar')}</div>
      <div>Audio across strict networks: ${status(Boolean(o.support?.turnConfigured), 'relay server is set up (not tested from here)', 'no relay server yet: calls work on most networks, not all')}</div>
      <div>Email for alerts: ${status(Boolean(f.notificationEmail), f.notificationEmail, 'not set (see "When to tell you")')}</div>
    </div>`);
}

function actionsCard() {
  const switches = toolSwitches(sf.options.configurableTools || []);
  if (!switches.length) return '';
  return card('What the assistant may do', 'Turn an action off and the assistant will not do it, even when asked. Safety checks stay on either way.',
    `<div class="divide-y divide-line-subtle">${switches.map((g) => `<label class="flex items-start gap-3 py-2.5 cursor-pointer"><input type="checkbox" data-tool-group="${esc(g.tools.join(','))}" ${g.tools.every((t) => !sf.form.disabledTools.includes(t)) ? 'checked' : ''} class="mt-0.5 w-4 h-4 accent-[var(--accent-primary)]" /><span><span class="block text-xs font-medium text-ink-primary">${esc(g.label)}</span>${g.details ? `<span class="block text-[11px] text-ink-muted">${esc(g.details)}</span>` : ''}</span></label>`).join('')}</div>`);
}

function alertsCard() {
  const o = sf.options;
  return card('When to tell you', 'You always see these in the dashboard. Emails go to the address below.',
    `${toggle('alertCall', 'A shopper asks for a call')}${toggle('alertFiles', 'A shopper sends a photo, video or PDF')}${toggle('alertFollowUp', 'The assistant needs a person')}
    ${text('notificationEmail', 'Email address for alerts and data requests', {type: 'email', placeholder: 'you@yourstore.com'})}
    ${o.emailConfigured ? '' : '<p class="text-[11px] text-warning-text">Email sending is not set up on the server yet, so alerts stay in the dashboard only.</p>'}`);
}

function callsCard() {
  const o = sf.options;
  const f = sf.form;
  const hours = f.callsOn ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
      <div class="md:col-span-2"><div class="text-xs font-medium mb-1.5">Days you take calls</div><div class="flex flex-wrap gap-2">${WEEKDAYS.map((d) => `<label class="px-2.5 py-1.5 rounded-md border text-xs cursor-pointer ${f.callDays.includes(d.id) ? 'border-accent bg-accent-soft text-accent-text' : 'border-line-subtle text-ink-secondary'}"><input type="checkbox" class="sr-only" data-day="${d.id}" ${f.callDays.includes(d.id) ? 'checked' : ''} />${d.label}</label>`).join('')}</div>${sf.errors.callDays ? `<p class="text-[11px] text-danger-text mt-1" role="alert">${esc(sf.errors.callDays)}</p>` : ''}</div>
      ${select('callFrom', 'First call', TIME_CHOICES)}${select('callTo', 'Last call ends', TIME_CHOICES)}
      ${select('callMinutes', 'Call length', CALL_MINUTES.map((m) => [m, `${m} minutes`]), {number: true})}
      ${select('callTimezone', 'Time zone', [...new Set([f.callTimezone, ...TIMEZONES])])}
      ${select('callLeadHours', 'Notice needed', LEAD_HOURS.map((h) => [h, hoursLabel(h)]), {number: true})}
      ${select('callMaxDays', 'How far ahead shoppers can book', AHEAD_DAYS.map((d) => [d, `${d} days`]), {number: true})}
      <div class="md:col-span-2">${toggle('callAutoConfirm', 'Confirm calls automatically', 'Otherwise each request waits for you in Bookings.')}</div>
      <div class="md:col-span-2">${text('calendarId', 'Google Calendar ID (optional)', {hint: o.calendar?.configured ? `Share your calendar with ${o.calendar.shareWith || 'the service account'} and paste its ID here.` : 'Google Calendar is not connected on the server, so calls will not be added to a calendar.'})}</div></div>` : '';
  return card('Calls', 'Let shoppers ask the assistant to book a call with you.', `${toggle('callsOn', 'Offer calls in the chat')}${hours}`);
}

function privacyCard() {
  return card('Photos and files', 'What shoppers may send in the chat.', `${toggle('allowPhotos', 'Photos')}${toggle('allowVideos', 'Videos')}${toggle('allowPdf', 'PDF files')}`)
    + card('Privacy', 'What is kept about shoppers.', `${toggle('storeTranscripts', 'Save chat messages', 'Off: you see counts and results, but not what was said.')}
      ${select('retentionDays', 'Delete saved messages after', [...new Set([...RETENTION_CHOICES, sf.form.retentionDays])].sort((a, b) => a - b).map((d) => [d, `${d} days`]), {number: true, hint: `Limit: ${LIMITS.knowledge === 50 ? 'between 7 and 365 days' : ''}`})}
      <p class="text-[11px] text-ink-muted">To delete one person's data on request, open Orders &amp; Customers, then the person.</p>`);
}

screens.settings = {
  async load() {
    if (!sf.loaded) await loadSettings();
    return {};
  },
  html() {
    return `<div class="space-y-5"><div><h1 class="type-h1">Settings</h1><p class="type-body text-ink-secondary">${esc(state.store.name || state.store.shop)}: actions, alerts, calls and privacy.</p></div>${supportCard()}${actionsCard()}${alertsCard()}${callsCard()}${privacyCard()}${saveBar()}</div>`;
  },
};
