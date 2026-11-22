// Puts confirmed calls into the store owner's Google Calendar, through a Google service account (no
// owner sign-in screen): the owner shares their calendar with the service account's email once.
// Only Node's own crypto and fetch are used. Every call can be given a fake `fetchImpl` / `now` for tests.
import crypto from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3/calendars";
const TIMEOUT_MS = 10000;

let tokenCache = { key: "", token: "", expiresAt: 0 };

/** The service account from GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or base64 of it), or null. */
export function loadServiceAccount(env = process.env) {
  const raw = String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    if (!json.client_email || !json.private_key) return null;
    return { email: json.client_email, key: String(json.private_key).replace(/\\n/g, "\n"), tokenUri: json.token_uri || "https://oauth2.googleapis.com/token" };
  } catch {
    return null;
  }
}

export const serviceAccountEmail = (env = process.env) => loadServiceAccount(env)?.email || "";
export const isCalendarConfigured = (env = process.env) => Boolean(loadServiceAccount(env));

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** A signed (RS256) assertion that Google exchanges for an access token. */
export function signAssertion(account, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const body = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: account.email, scope: SCOPE, aud: account.tokenUri, iat, exp: iat + 3600 })}`;
  const signature = crypto.createSign("RSA-SHA256").update(body).sign(account.key).toString("base64url");
  return `${body}.${signature}`;
}

async function request(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken({ fetchImpl, now, account }) {
  if (tokenCache.key === account.email && tokenCache.expiresAt > now() + 60000) return tokenCache.token;
  const res = await request(fetchImpl, account.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signAssertion(account, now()) }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new CalendarError(`Google sign-in failed (${res.status}${json.error ? ` ${json.error}` : ""})`, res.status);
  tokenCache = { key: account.email, token: json.access_token, expiresAt: now() + Math.max(60, Number(json.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

export class CalendarError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "CalendarError";
    this.status = status;
  }
}

export const clearTokenCache = () => {
  tokenCache = { key: "", token: "", expiresAt: 0 };
};

/** What shows in the owner's calendar for a booking. */
export function eventFor(booking, { shopName = "" } = {}) {
  const lines = [
    `Customer: ${booking.name || "(no name given)"}`,
    `Phone: ${booking.phone}`,
    `Email: ${booking.email}`,
    booking.topic ? `About: ${booking.topic}` : "",
    booking.language ? `Language: ${booking.language}` : "",
    shopName ? `Store: ${shopName}` : "",
    "Booked through the AI shopping assistant.",
  ].filter(Boolean);
  return {
    summary: `Call: ${booking.name || booking.phone}${booking.topic ? ` - ${String(booking.topic).slice(0, 60)}` : ""}`,
    description: lines.join("\n"),
    start: { dateTime: new Date(booking.startAt).toISOString(), timeZone: booking.timezone },
    end: { dateTime: new Date(booking.endAt).toISOString(), timeZone: booking.timezone },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
  };
}

/**
 * Adds (or, when it already exists, moves) the booking's event. The event id is derived from the booking,
 * so a retry after a timeout can never create a second event.
 * @returns {{ eventId: string, link: string }}
 */
export async function upsertEvent({ calendarId, booking, shopName = "" }, { fetchImpl = fetch, now = Date.now, env = process.env } = {}) {
  const account = loadServiceAccount(env);
  const calendar = String(calendarId || env.GOOGLE_CALENDAR_ID || "").trim();
  if (!account) throw new CalendarError("Google Calendar is not set up on the server.");
  if (!calendar) throw new CalendarError("No Google Calendar ID is set for this store.");
  const token = await accessToken({ fetchImpl, now, account });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const eventId = String(booking.calendar?.eventId || `b${String(booking._id)}`).toLowerCase();
  const url = `${API}/${encodeURIComponent(calendar)}/events`;
  const body = eventFor(booking, { shopName });

  let res = await request(fetchImpl, `${url}/${eventId}`, { method: "PUT", headers, body: JSON.stringify({ ...body, id: eventId }) });
  if (res.status === 404) res = await request(fetchImpl, url, { method: "POST", headers, body: JSON.stringify({ ...body, id: eventId }) });
  if (res.status === 409) res = await request(fetchImpl, `${url}/${eventId}`, { method: "PUT", headers, body: JSON.stringify({ ...body, id: eventId }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new CalendarError(`Google Calendar said ${res.status}${json.error?.message ? `: ${String(json.error.message).slice(0, 120)}` : ""}`, res.status);
  return { eventId: json.id || eventId, link: json.htmlLink || "" };
}

/** Removes the event (a 404/410 means it is already gone). */
export async function deleteEvent({ calendarId, eventId }, { fetchImpl = fetch, now = Date.now, env = process.env } = {}) {
  const account = loadServiceAccount(env);
  const calendar = String(calendarId || env.GOOGLE_CALENDAR_ID || "").trim();
  if (!account || !calendar || !eventId) return false;
  const token = await accessToken({ fetchImpl, now, account });
  const res = await request(fetchImpl, `${API}/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (res.ok || res.status === 404 || res.status === 410) return true;
  throw new CalendarError(`Google Calendar said ${res.status}`, res.status);
}
