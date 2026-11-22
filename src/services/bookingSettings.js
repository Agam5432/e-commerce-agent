// The owner's call-booking rules: which days and hours they take calls, how long a call is, and whether
// a request needs their OK. Validated here; the booking service and the agent read them through bookingConfig.
import { isValidTimeZone, parseClock, formatClock } from "./bookingTime.js";

export const BOOKING_DEFAULTS = Object.freeze({
  enabled: false,
  days: [1, 2, 3, 4, 5],
  from: "10:00",
  to: "18:00",
  slotMinutes: 30,
  timezone: "Asia/Kolkata",
  leadHours: 2,
  maxDaysAhead: 14,
  autoConfirm: false,
});

const KEYS = ["enabled", "days", "from", "to", "slotMinutes", "timezone", "leadHours", "maxDaysAhead", "autoConfirm", "calendarId"];
const intIn = (v, min, max) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);

/** Checks a patch of `booking`. null clears a value (the default applies again). */
export function validateBookingPatch(input) {
  const errors = [];
  if (input === null) return { value: null, errors };
  if (typeof input !== "object" || Array.isArray(input)) return { value: {}, errors: ["booking must be an object."] };
  const value = {};
  for (const key of Object.keys(input)) if (!KEYS.includes(key)) errors.push(`Unknown booking setting: ${key}`);
  const bool = (key) => {
    if (!(key in input)) return;
    if (input[key] === null) value[key] = null;
    else if (typeof input[key] !== "boolean") errors.push(`booking.${key} must be true or false.`);
    else value[key] = input[key];
  };
  bool("enabled");
  bool("autoConfirm");
  if ("days" in input) {
    if (input.days === null) value.days = null;
    else if (!Array.isArray(input.days) || !input.days.length || input.days.some((d) => intIn(d, 0, 6) == null)) errors.push("booking.days must list at least one weekday (0 = Sunday to 6 = Saturday).");
    else value.days = [...new Set(input.days.map(Number))].sort((a, b) => a - b);
  }
  for (const key of ["from", "to"]) {
    if (!(key in input)) continue;
    if (input[key] === null) value[key] = null;
    else if (parseClock(input[key]) == null) errors.push(`booking.${key} must be a time like 10:00.`);
    else value[key] = formatClock(parseClock(input[key]));
  }
  if ("slotMinutes" in input) {
    if (input.slotMinutes === null) value.slotMinutes = null;
    else if (intIn(input.slotMinutes, 10, 120) == null) errors.push("booking.slotMinutes must be a whole number from 10 to 120.");
    else value.slotMinutes = Number(input.slotMinutes);
  }
  if ("leadHours" in input) {
    if (input.leadHours === null) value.leadHours = null;
    else if (intIn(input.leadHours, 0, 72) == null) errors.push("booking.leadHours must be a whole number from 0 to 72.");
    else value.leadHours = Number(input.leadHours);
  }
  if ("maxDaysAhead" in input) {
    if (input.maxDaysAhead === null) value.maxDaysAhead = null;
    else if (intIn(input.maxDaysAhead, 1, 60) == null) errors.push("booking.maxDaysAhead must be a whole number from 1 to 60.");
    else value.maxDaysAhead = Number(input.maxDaysAhead);
  }
  if ("timezone" in input) {
    if (input.timezone === null) value.timezone = null;
    else if (!isValidTimeZone(String(input.timezone))) errors.push("booking.timezone must be a time zone name like Asia/Kolkata.");
    else value.timezone = String(input.timezone);
  }
  if ("calendarId" in input) {
    const id = input.calendarId === null ? null : String(input.calendarId).trim();
    if (id === null || id === "") value.calendarId = null;
    else if (id.length > 200 || /\s/.test(id)) errors.push("booking.calendarId is not a valid Google Calendar ID.");
    else value.calendarId = id;
  }
  const merged = { ...BOOKING_DEFAULTS, ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) };
  if (!errors.length && parseClock(merged.to) <= parseClock(merged.from)) errors.push("booking.to must be later than booking.from.");
  if (!errors.length && parseClock(merged.to) - parseClock(merged.from) < merged.slotMinutes) errors.push("The opening hours are shorter than one call.");
  return { value, errors };
}

/** The effective rules for a store: the owner's values over the defaults. */
export function bookingConfig(settings) {
  const own = settings?.booking && typeof settings.booking === "object" ? settings.booking : {};
  return { ...BOOKING_DEFAULTS, ...own, days: Array.isArray(own.days) && own.days.length ? own.days : BOOKING_DEFAULTS.days };
}

export const bookingEnabled = (settings) => bookingConfig(settings).enabled === true;

// ---- "when to call me in" and which files shoppers may send ---------------------------------------
export const ALERT_KEYS = ["onCallRequest", "onFiles", "onFollowUp"];
export const FILE_KEYS = ["photos", "videos", "pdf"];

// ---- live help from a person (audio call in the chat) -------------------------------------------------
// All off until the owner switches them on: nothing changes for a store that never opens this setting.
export const SUPPORT_KEYS = ["liveEnabled", "audioEnabled", "recordingEnabled"];
const SUPPORT_DEFAULTS = Object.freeze({ liveEnabled: false, audioEnabled: true, recordingEnabled: false });
export const supportOn = (settings, key) => (typeof settings?.support?.[key] === "boolean" ? settings.support[key] : SUPPORT_DEFAULTS[key] === true);
/** A shopper may ask for a person only when the owner has switched live help on. */
export const liveSupportEnabled = (settings) => supportOn(settings, "liveEnabled");
/** The audio call itself (live help can also be text only). */
export const audioCallEnabled = (settings) => supportOn(settings, "liveEnabled") && supportOn(settings, "audioEnabled");
/** Recording needs live audio and the owner's explicit choice; the shopper's consent is asked on top of it. */
export const recordingAllowed = (settings) => audioCallEnabled(settings) && supportOn(settings, "recordingEnabled");

/** Validates a flat object of booleans. null clears one key. */
export function validateFlags(name, input, allowed) {
  if (input === null) return { value: null, errors: [] };
  if (typeof input !== "object" || Array.isArray(input)) return { value: {}, errors: [`${name} must be an object.`] };
  const errors = [];
  const value = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.includes(k)) errors.push(`Unknown ${name} setting: ${k}`);
    else if (v === null) value[k] = null;
    else if (typeof v !== "boolean") errors.push(`${name}.${k} must be true or false.`);
    else value[k] = v;
  }
  return { value, errors };
}

/** On unless the owner switched it off. */
export const alertOn = (settings, key) => settings?.alerts?.[key] !== false;
export const fileKindAllowed = (settings, kind) => {
  const key = kind === "image" ? "photos" : kind === "video" ? "videos" : "pdf";
  return settings?.files?.[key] !== false;
};
