import "dotenv/config";
import { formatMoney } from "../utils/money.js";
import nodemailer from "nodemailer";
import { redact } from "../utils/logger.js";
import { emailOutbox } from "./emailOutbox.js";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_APP_PASSWORD;

  if (!user || !pass) {
    return null;
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user,
      pass,
    },
  });

  return transporter;
}

/**
 * Send a one-time verification code email.
 * `purpose`: "login" (checkout sign-in, default) or "order_lookup" (view order status/details).
 * Returns { ok: true } or { ok: false, error }.
 */
export async function sendOtpEmail({ to, code, shopName, purpose = "login" }) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_APP_PASSWORD;
  const from = process.env.EMAIL_FROM || user;

  if (!user || !pass) {
    return {
      ok: false,
      error: "EMAIL_USER or EMAIL_APP_PASSWORD is missing in .env",
    };
  }

  const transport = getTransporter();
  if (!transport) {
    return { ok: false, error: "Email transporter could not be created." };
  }

  const store = shopName || "the store";
  const isOrderLookup = purpose === "order_lookup";
  const subject = isOrderLookup
    ? `Your verification code: ${code}`
    : `Your login code: ${code}`;
  const heading = isOrderLookup
    ? "Your one-time verification code is:"
    : "Your one-time login code is:";
  const usage = isOrderLookup
    ? "This code is only for viewing your order status and details."
    : "This code is only for signing in to continue checkout.";

  try {
    await transport.sendMail({
      from: `"${store} AI Assistant" <${from}>`,
      to,
      subject,
      text: [
        `${heading} ${code}`,
        "",
        usage,
        "Do not share it with anyone. It expires in 10 minutes.",
        "",
        "If you did not request this, you can ignore this email.",
      ].join("\n"),
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2328">
          <p style="margin:0 0 12px;font-size:16px">${heading}</p>
          <p style="margin:0 0 20px;font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#6b7280">
            ${usage} Do not share it with anyone.
          </p>
          <p style="margin:0;font-size:14px;color:#6b7280">It expires in 10 minutes.</p>
        </div>
      `,
    });

    console.log(`[email] OTP sent to ${redact(to)}`);
    return { ok: true };
  } catch (error) {
    console.error("[email] send failed:", error.message);
    return { ok: false, error: error.message || "Failed to send email" };
  }
}

/**
 * Plain message to a person (e.g. a data export for the store owner).
 * Returns { ok: true } or { ok: false, error }.
 */
export async function sendPlainEmail({ to, cc, replyTo, subject, text, html, attachments = [], retry = null }, { outbox = emailOutbox() } = {}) {
  const transport = getTransporter();
  if (!transport) return { ok: false, error: "EMAIL_USER or EMAIL_APP_PASSWORD is missing in .env" };
  const message = { from: process.env.EMAIL_FROM || process.env.EMAIL_USER, to, ...(cc ? { cc } : {}), ...(replyTo ? { replyTo } : {}), subject, text, ...(html ? { html } : {}), attachments };
  try {
    // ok only when the mail server accepted the message: the others on the list (cc) are checked too
    const info = await transport.sendMail(message);
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    if (rejected.length && rejected.length >= [].concat(to || [], cc || []).length) return { ok: false, error: `The mail server rejected: ${rejected.join(", ").slice(0, 160)}` };
    return { ok: true, messageId: info?.messageId, ...(rejected.length ? { rejected } : {}) };
  } catch (error) {
    console.error("[email] send failed:", error.message);
    // `retry: { kind, shop }`: a passing failure is kept and sent again later
    const queued = retry ? await outbox.keep({ ...retry, message, error }).catch(() => false) : false;
    return { ok: false, error: error.message || "Failed to send email", ...(queued ? { queued: true } : {}) };
  }
}

/** Sends emails kept for another try (see emailOutbox.js). Started with the server. */
export function retryKeptEmails({ outbox = emailOutbox() } = {}) {
  const transport = getTransporter();
  if (!transport) return Promise.resolve(0);
  return outbox.sweep({ send: (message) => transport.sendMail(message) });
}

/**
 * Checks once at startup that Gmail accepts the login, so a wrong or revoked App Password shows up
 * in the log right away instead of as a silently missing email after an order.
 * Returns { ok, user?, error? } and never throws.
 */
export async function verifyEmailTransport({ transport = getTransporter(), log = console, attempts = 3, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const user = process.env.EMAIL_USER || "";
  if (!user || !process.env.EMAIL_APP_PASSWORD) {
    log.warn("[email] EMAIL_USER / EMAIL_APP_PASSWORD not set: order and OTP emails are switched off.");
    return { ok: false, error: "not configured" };
  }
  if (!transport) {
    log.warn("[email] could not create the Gmail transport.");
    return { ok: false, error: "no transport" };
  }
  let message = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await transport.verify();
      log.info(`[email] Gmail SMTP ready as ${user}`);
      return { ok: true, user };
    } catch (error) {
      message = String(error?.message || error);
      // a wrong password will not fix itself; a dropped connection often does
      if (/535|invalid login|username and password/i.test(message) || attempt === attempts) break;
      log.warn(`[email] Gmail SMTP check failed (${message.slice(0, 80)}); trying again (${attempt}/${attempts - 1})`);
      await sleep(delayMs * attempt);
    }
  }
  const hint = /535|invalid login|username and password/i.test(message)
    ? " Gmail rejected the login: create a new App Password (Google account > Security > App passwords) and put it in EMAIL_APP_PASSWORD without spaces."
    : "";
  log.error(`[email] Gmail SMTP check failed: ${message.slice(0, 200)}.${hint}`);
  return { ok: false, error: message };
}

export function isEmailConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD);
}

/**
 * Send order confirmation email with full items preview, original & discounted prices,
 * discount code, the store's Shopify shipping rate, total savings,
 * delivery address, and billing address.
 * Returns { ok: true, messageId } or { ok: false, error }.
 */
export async function sendOrderConfirmationEmail({
  to,
  orderId,
  paymentMethod = "cod",
  shippingMethod = "standard",
  shippingCost = 0,
  tax = 0,
  taxLines = [],
  otherCharges = 0,
  total = 0,
  originalTotal = null,
  discountedSubtotal = null,
  currency = "USD",
  items = [],
  shipping = {},
  billing = {},
  billingSameAsShipping = true,
  discountCode = "",
  discountTitle = "",
  discountAmount = 0,
  discountPercent = 0,
  shopName = "Store",
  transport: injectedTransport = null,
}) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_APP_PASSWORD;
  const from = process.env.EMAIL_FROM || user;

  if (!user || !pass) {
    return {
      ok: false,
      error: "EMAIL_USER or EMAIL_APP_PASSWORD is missing in .env",
    };
  }

  const normalizedTo = String(to || "").trim();
  if (!normalizedTo || !normalizedTo.includes("@")) {
    return { ok: false, error: "no valid recipient email for this order" };
  }

  const transport = injectedTransport || getTransporter();
  if (!transport) {
    return { ok: false, error: "Email transporter could not be created." };
  }

  const store = shopName || "Store";
  const isPrepaid =
    String(paymentMethod).toLowerCase().includes("prepaid") ||
    String(paymentMethod).toLowerCase().includes("online") ||
    String(paymentMethod).toLowerCase().includes("card");
  const methodLabel = isPrepaid
    ? "Prepaid (Online / Credit Card)"
    : "Cash on Delivery (COD)";

  const formatAmt = (val) => formatMoney(Number(val || 0), currency);

  const shipCostNum = Math.max(
    0,
    Number(shippingCost) || 0
  );
  // The store's own Shopify shipping rate title; no invented delivery times.
  const rateTitle =
    shippingMethod && String(shippingMethod).toLowerCase() !== "standard" ? String(shippingMethod) : "Shipping";
  const shippingMethodLabel = `${rateTitle} (${shipCostNum > 0 ? formatAmt(shipCostNum) : "FREE"})`;
  const shippingCostDisplay =
    shipCostNum > 0 ? formatAmt(shipCostNum) : "FREE";
  // Cost-summary row label: the store's own rate title, never an invented Express/Standard.
  const shippingRowLabel = rateTitle === "Shipping" ? "Shipping" : `Shipping (${rateTitle})`;
  const shippingRowLabelHtml = shippingRowLabel.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const discAmtNum = Math.max(0, Number(discountAmount) || 0);
  const discPctNum = Math.max(0, Number(discountPercent) || 0);
  const origSubtotalNum =
    originalTotal != null && Number(originalTotal) > 0
      ? Number(originalTotal)
      : Math.max(0, Number(total) - shipCostNum + discAmtNum);
  const subtotalAfterDiscountNum =
    discountedSubtotal != null
      ? Number(discountedSubtotal)
      : Math.max(0, Number((origSubtotalNum - discAmtNum).toFixed(2)));
  const finalTotalNum = Number.isFinite(Number(total)) ? Number(total) : subtotalAfterDiscountNum + shipCostNum + Number(tax || 0);
  // Same breakdown the chat card shows: Subtotal, Shipping, Tax, (other charges), Total.
  const taxNum = Number(tax) || 0;
  const otherNum = Number(otherCharges) || 0;
  const taxDetail = (Array.isArray(taxLines) ? taxLines : [])
    .filter((line) => line && line.title)
    .map((line) => `${line.title}${line.ratePercent != null ? ` ${Number(line.ratePercent)}%` : ""}`)
    .join(", ");
  const taxLabel = `Tax${taxDetail ? ` (${taxDetail})` : ""}`;
  const taxLabelHtml = taxLabel.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const safeItems = Array.isArray(items) ? items : [];
  const itemsTextList = safeItems
    .map((item, idx) => {
      const title = item.title || item.name || "Product";
      const variant =
        item.variant_title && item.variant_title !== "Default Title"
          ? ` (${item.variant_title})`
          : "";
      const qty = item.quantity ?? 1;
      const lineOrig =
        item.line_price != null
          ? Number(item.line_price) / 100
          : item.price != null
          ? (Number(item.original_price ?? item.price) / 100) * qty
          : 0;
      const lineDisc =
        discPctNum > 0
          ? Number((lineOrig * (1 - discPctNum / 100)).toFixed(2))
          : lineOrig;
      const priceNote =
        discPctNum > 0 && lineDisc < lineOrig
          ? `Original: ${formatAmt(lineOrig)} -> Discounted: ${formatAmt(
              lineDisc
            )} (${discountCode || "Discount"} -${formatAmt(
              lineOrig - lineDisc
            )})`
          : formatAmt(lineOrig);
      return `  ${idx + 1}. ${title}${variant} × ${qty} — ${priceNote}`;
    })
    .join("\n");

  const itemsHtmlCards = safeItems
    .map((item) => {
      const title = item.title || item.name || "Product";
      const variant =
        item.variant_title && item.variant_title !== "Default Title"
          ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${item.variant_title}</div>`
          : "";
      const qty = item.quantity ?? 1;
      const lineOrig =
        item.line_price != null
          ? Number(item.line_price) / 100
          : item.price != null
          ? (Number(item.original_price ?? item.price) / 100) * qty
          : 0;
      const lineDisc =
        discPctNum > 0
          ? Number((lineOrig * (1 - discPctNum / 100)).toFixed(2))
          : lineOrig;
      const itemSavings = Math.max(0, Number((lineOrig - lineDisc).toFixed(2)));

      const imgUrl =
        item.image ||
        item.featured_image?.url ||
        (typeof item.featured_image === "string" ? item.featured_image : "") ||
        item.imageUrl ||
        "";

      const imgTag = imgUrl
        ? `<td style="width:64px;vertical-align:middle;padding:12px 12px 12px 0;">
             <img src="${
               String(imgUrl).startsWith("//") ? `https:${imgUrl}` : imgUrl
             }" alt="${title}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;display:block;" />
           </td>`
        : "";

      const discountBadgeHtml =
        itemSavings > 0
          ? `<div style="display:inline-block;margin-top:4px;padding:2px 8px;background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:4px;font-size:11px;font-weight:600;">
               🏷️ ${discountCode || discountTitle || "DISCOUNT"} (-${formatAmt(
              itemSavings
            )})
             </div>`
          : "";

      const priceRightHtml =
        itemSavings > 0
          ? `<div style="font-size:12px;color:#9ca3af;text-decoration:line-through;">${formatAmt(
              lineOrig
            )}</div>
             <div style="font-weight:700;font-size:14px;color:#111827;">${formatAmt(
               lineDisc
             )}</div>`
          : `<div style="font-weight:600;font-size:14px;color:#111827;">${formatAmt(
              lineOrig
            )}</div>`;

      return `
        <tr>
          ${imgTag}
          <td style="vertical-align:middle;padding:12px 0;border-bottom:1px solid #f3f4f6;">
            <div style="font-weight:600;font-size:14px;color:#111827;">${title}</div>
            ${variant}
            <div style="font-size:12px;color:#6b7280;margin-top:4px;">Quantity: ${qty}</div>
            ${discountBadgeHtml}
          </td>
          <td style="vertical-align:middle;padding:12px 0;text-align:right;border-bottom:1px solid #f3f4f6;">
            ${priceRightHtml}
          </td>
        </tr>
      `;
    })
    .join("");

  const recipientName = shipping.name || "Valued Customer";
  const addressParts = [
    shipping.address1,
    shipping.address2,
    shipping.city,
    shipping.province,
    shipping.zip,
    shipping.country,
  ]
    .filter(Boolean)
    .join(", ");

  const billingParts =
    billingSameAsShipping || !billing?.address1
      ? `Same as Delivery Address (${recipientName}, ${addressParts})`
      : [
          billing.name || recipientName,
          billing.address1,
          billing.address2,
          billing.city,
          billing.province,
          billing.zip,
          billing.country,
          billing.phone ? `Phone: ${billing.phone}` : "",
        ]
          .filter(Boolean)
          .join(", ");

  const couponLabel = discountCode
    ? `Discount code (${discountCode}${
        discPctNum ? ` · ${discPctNum}% OFF` : ""
      })`
    : discountTitle
    ? `${discountTitle}${discPctNum ? ` (${discPctNum}% OFF)` : ""}`
    : discPctNum > 0
    ? `Discount (${discPctNum}% OFF)`
    : "Discount";

  const textBody = [
    `Order Confirmation - ${orderId}`,
    `Store: ${store}`,
    `----------------------------------------`,
    `Hello ${recipientName},`,
    `Thank you for your order! Your order has been placed and synced to ${store}.`,
    ``,
    `Order Details:`,
    `Order ID: ${orderId}`,
    `Customer Email: ${normalizedTo}`,
    `Contact Phone: ${shipping.phone || "On file"}`,
    `Payment Method: ${methodLabel}`,
    `Shipping Method: ${shippingMethodLabel}`,
    `Delivery Address: ${addressParts || "On file"}`,
    `Billing Address: ${billingParts}`,
    ``,
    `Order Summary (Shopping Cart):`,
    itemsTextList || "  No items detailed",
    ``,
    `Cost Summary:`,
    discAmtNum > 0 ? `Original Price: ${formatAmt(origSubtotalNum)}` : null,
    discAmtNum > 0 ? `${couponLabel}: -${formatAmt(discAmtNum)}` : null,
    `Subtotal: ${formatAmt(subtotalAfterDiscountNum)}`,
    `${shippingRowLabel}: ${shippingCostDisplay}`,
    `${taxLabel}: ${formatAmt(taxNum)}`,
    otherNum !== 0 ? `Duties & other charges: ${formatAmt(otherNum)}` : null,
    `Total (${currency}): ${formatAmt(finalTotalNum)}`,
    discAmtNum > 0 ? `TOTAL SAVINGS: ${formatAmt(discAmtNum)}` : null,
    ``,
    `Thank you for shopping with ${store}!`,
  ]
    .filter(Boolean)
    .join("\n");

  const originalPriceRowHtml =
    discAmtNum > 0
      ? `
    <tr>
      <td style="padding:5px 0;color:#6b7280;font-size:14px;">Original price:</td>
      <td style="padding:5px 0;text-align:right;color:#6b7280;font-size:14px;text-decoration:line-through;">${formatAmt(
        origSubtotalNum
      )}</td>
    </tr>
    <tr>
      <td style="padding:5px 0;color:#059669;font-size:14px;font-weight:600;">🎉 ${couponLabel}:</td>
      <td style="padding:5px 0;text-align:right;color:#059669;font-weight:700;font-size:14px;">-${formatAmt(
        discAmtNum
      )}</td>
    </tr>
  `
      : "";

  const totalSavingsHtml =
    discAmtNum > 0
      ? `
    <tr>
      <td colspan="2" style="padding:10px 0 0 0;">
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;padding:8px 12px;color:#065f46;font-size:13px;font-weight:700;text-align:center;">
          🎉 TOTAL SAVINGS: ${formatAmt(discAmtNum)}
        </div>
      </td>
    </tr>
  `
      : "";

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="margin:0;padding:20px;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
        <div style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);padding:28px 24px;text-align:center;color:#ffffff;">
          <h2 style="margin:0 0 6px 0;font-size:22px;letter-spacing:-0.5px;">${store}</h2>
          <div style="display:inline-block;background:rgba(16,185,129,0.2);border:1px solid #10b981;color:#6ee7b7;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:600;margin-top:6px;">
            ✓ Order Confirmed (${orderId})
          </div>
        </div>

        <div style="padding:28px 24px;">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:24px;">
            Hello <strong>${recipientName}</strong>,
          </p>
          <p style="margin:0 0 24px 0;font-size:14px;color:#4b5563;line-height:22px;">
            Your order has been placed successfully! Below is your complete order summary, shipping details, and cost breakdown.
          </p>

          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="font-size:13px;color:#64748b;padding:4px 0;">Order ID:</td>
                <td style="font-size:14px;font-weight:700;color:#0f172a;text-align:right;padding:4px 0;letter-spacing:0.5px;">${orderId}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:4px 0;">Customer Email:</td>
                <td style="font-size:13px;font-weight:600;color:#0f172a;text-align:right;padding:4px 0;">${normalizedTo}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:4px 0;">Payment Method:</td>
                <td style="font-size:13px;font-weight:600;color:#0f172a;text-align:right;padding:4px 0;">${methodLabel}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:4px 0;">Shipping Method:</td>
                <td style="font-size:13px;font-weight:600;color:#0f172a;text-align:right;padding:4px 0;">${shippingMethodLabel}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:4px 0;">Status:</td>
                <td style="font-size:13px;font-weight:600;color:#10b981;text-align:right;padding:4px 0;">Confirmed</td>
              </tr>
            </table>
          </div>

          <h3 style="margin:0 0 12px 0;font-size:15px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:8px;">
            Order Summary
          </h3>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            ${
              itemsHtmlCards ||
              '<tr><td style="padding:12px 0;color:#6b7280;">No items found</td></tr>'
            }
          </table>

          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:24px;">
            <div style="font-weight:700;font-size:14px;color:#111827;margin-bottom:8px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
              Cost Summary
            </div>
            <table style="width:100%;border-collapse:collapse;">
              ${originalPriceRowHtml}
              <tr>
                <td style="padding:5px 0;color:#374151;font-size:14px;font-weight:600;">Subtotal:</td>
                <td style="padding:5px 0;text-align:right;color:#111827;font-size:14px;font-weight:600;">${formatAmt(
                  subtotalAfterDiscountNum
                )}</td>
              </tr>
              <tr>
                <td style="padding:5px 0;color:#6b7280;font-size:14px;">${shippingRowLabelHtml}:</td>
                <td style="padding:5px 0;text-align:right;color:${
                  shipCostNum > 0 ? "#111827" : "#059669"
                };font-weight:600;font-size:14px;">${shippingCostDisplay}</td>
              </tr>
              <tr>
                <td style="padding:5px 0;color:#6b7280;font-size:14px;">${taxLabelHtml}:</td>
                <td style="padding:5px 0;text-align:right;color:#111827;font-weight:600;font-size:14px;">${formatAmt(taxNum)}</td>
              </tr>
              ${
                otherNum !== 0
                  ? `<tr><td style="padding:5px 0;color:#6b7280;font-size:14px;">Duties &amp; other charges:</td><td style="padding:5px 0;text-align:right;color:#111827;font-weight:600;font-size:14px;">${formatAmt(otherNum)}</td></tr>`
                  : ""
              }
              <tr>
                <td style="padding:10px 0 0 0;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">Total (${currency}):</td>
                <td style="padding:10px 0 0 0;text-align:right;font-size:18px;font-weight:800;color:#111827;border-top:1px solid #e5e7eb;">${formatAmt(
                  finalTotalNum
                )}</td>
              </tr>
              ${totalSavingsHtml}
            </table>
          </div>

          <h3 style="margin:0 0 8px 0;font-size:15px;color:#111827;">
            Delivery Address
          </h3>
          <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;font-size:13px;line-height:20px;color:#4b5563;margin-bottom:16px;">
            <strong style="color:#111827;">${recipientName}</strong><br />
            ${shipping.address1 ? `${shipping.address1}<br />` : ""}
            ${shipping.address2 ? `${shipping.address2}<br />` : ""}
            ${shipping.city ? `${shipping.city}` : ""}${
    shipping.province ? `, ${shipping.province}` : ""
  }${shipping.zip ? ` - ${shipping.zip}` : ""}<br />
            ${shipping.country || "India"}${
    shipping.phone
      ? `<br /><span style="color:#6b7280;">Phone: ${shipping.phone}</span>`
      : ""
  }<br />
            <span style="color:#6b7280;">Email: ${normalizedTo}</span>
          </div>

          <h3 style="margin:0 0 8px 0;font-size:15px;color:#111827;">
            Billing Address
          </h3>
          <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;font-size:13px;line-height:20px;color:#4b5563;">
            ${billingParts}
          </div>
        </div>

        <div style="background:#f3f4f6;padding:16px 24px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;">
          Thank you for shopping with <strong>${store}</strong>.<br />
          If you have any questions or need to track your package, chat with our AI agent anytime!
        </div>
      </div>
    </body>
    </html>
  `;

  const message = {
    from: `"${store}" <${from}>`,
    to: normalizedTo,
    subject: `🎉 Order Confirmed! ${orderId} - ${store}`,
    text: textBody,
    html: htmlBody,
  };
  try {
    const info = await transport.sendMail(message);
    console.log(
      `[email] Order confirmation sent to ${redact(normalizedTo)} for ${orderId} (MessageId: ${info.messageId})`
    );
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error("[email] sendOrderConfirmationEmail error:", error.message);
    // the order is placed: a passing mail failure must not lose its confirmation
    const queued = await emailOutbox().keep({ kind: "order_confirmation", shop: shopName, message, error }).catch(() => false);
    return { ok: false, error: error.message, ...(queued ? { queued: true } : {}) };
  }
}