// The two emails a booking sends: to the shopper once the owner has confirmed the time (with a calendar
// invite file attached), and to the owner when a new call is requested.
import { sendPlainEmail } from "./emailService.js";
import { describeLocal } from "./bookingTime.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icsText = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const isHindi = (lang) => lang === "hi" || lang === "hinglish";

/** A calendar file the shopper can open to add the call to their own calendar. */
export function buildIcs({ booking, shopName = "", now = Date.now() }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Orbi//Call booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${String(booking._id)}@orbi-booking`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(booking.startAt)}`,
    `DTEND:${icsStamp(booking.endAt)}`,
    `SUMMARY:${icsText(`Call from ${shopName || "the store"}`)}`,
    `DESCRIPTION:${icsText(booking.topic ? `About: ${booking.topic}` : "Your call with the store")}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Call in 15 minutes",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

export function customerEmailContent({ booking, shopName = "the store" }) {
  const when = describeLocal(booking.startAt, booking.timezone);
  const hi = isHindi(booking.language);
  const name = booking.name ? ` ${booking.name}` : "";
  const subject = hi ? `Aapki call confirm ho gayi: ${when}` : `Your call is confirmed: ${when}`;
  const body = hi
    ? [`Namaste${name},`, `${shopName} ki taraf se aapki call ${when} (${booking.timezone}) par confirm ho gayi hai.`, `Hum aapko ${booking.phone} par call karenge.`, booking.topic ? `Vishay: ${booking.topic}` : "", "Time badalna ho to is email ka reply kar do."]
    : [`Hi${name},`, `Your call with ${shopName} is confirmed for ${when} (${booking.timezone}).`, `We will call you on ${booking.phone}.`, booking.topic ? `About: ${booking.topic}` : "", "If you need another time, just reply to this email."];
  const lines = body.filter(Boolean);
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0F1A1F"><h2 style="color:#0B6E6E;margin:0 0 12px">${esc(subject)}</h2>${lines.map((l) => `<p style="margin:0 0 10px;line-height:1.5">${esc(l)}</p>`).join("")}</div>`;
  return { subject, text: lines.join("\n\n"), html };
}

export function ownerEmailContent({ booking, shopName = "your store", confirmed = false }) {
  const when = describeLocal(booking.startAt, booking.timezone);
  const subject = confirmed ? `New call booked: ${booking.name || booking.phone}, ${when}` : `New call request: ${booking.name || booking.phone}, ${when}`;
  const lines = [
    confirmed ? `A call is booked for ${when} (${booking.timezone}).` : `A shopper asked for a call on ${when} (${booking.timezone}). Open the dashboard to confirm this time or suggest another.`,
    `Name: ${booking.name || "(not given)"}`,
    `Phone: ${booking.phone}`,
    `Email: ${booking.email}`,
    booking.topic ? `About: ${booking.topic}` : "",
    `Store: ${shopName}`,
  ].filter(Boolean);
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0F1A1F"><h2 style="color:#5B3FD6;margin:0 0 12px">${esc(subject)}</h2>${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("")}</div>`;
  return { subject, text: lines.join("\n"), html };
}

/** Sends the confirmation to the shopper. Returns { ok, error? }; never throws. */
export async function sendCustomerConfirmation({ booking, shopName }, { send = sendPlainEmail, now = Date.now() } = {}) {
  try {
    const content = customerEmailContent({ booking, shopName });
    return await send({ to: booking.email, ...content, attachments: [{ filename: "call.ics", content: buildIcs({ booking, shopName, now }), contentType: "text/calendar; charset=utf-8; method=PUBLISH" }] });
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Tells the owner about a new call. Returns { ok, error? }; never throws. */
export async function sendOwnerAlert({ booking, to, shopName, confirmed }, { send = sendPlainEmail } = {}) {
  if (!to) return { ok: false, error: "No alert email is set." };
  try {
    return await send({ to, ...ownerEmailContent({ booking, shopName, confirmed }), retry: { kind: "owner_call_alert", shop: shopName } });
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Tells the owner once that a chat needs them: the shopper sent files, or the agent asked for a person. */
export async function sendChatAlert({ kind, to, shopName = "your store", reason = "", fileCount = 0 }, { send = sendPlainEmail } = {}) {
  if (!to) return { ok: false, error: "No alert email is set." };
  const files = kind === "files";
  const subject = files ? `A shopper sent ${fileCount === 1 ? "a file" : `${fileCount} files`} to ${shopName}` : `A chat at ${shopName} needs you`;
  const lines = [
    files ? `A shopper sent ${fileCount === 1 ? "a photo, video or PDF" : `${fileCount} photos, videos or PDFs`} in the chat.` : "The AI assistant asked for a person to look at a chat.",
    !files && reason ? `Why: ${reason}` : "",
    "Open the app in your Shopify admin and go to Chats to see it.",
  ].filter(Boolean);
  try {
    return await send({ to, subject, text: lines.join("\n\n"), html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0F1A1F"><h2 style="color:#0B6E6E">${esc(subject)}</h2>${lines.map((l) => `<p style="line-height:1.5">${esc(l)}</p>`).join("")}</div>`, retry: { kind: "owner_chat_alert", shop: shopName } });
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
