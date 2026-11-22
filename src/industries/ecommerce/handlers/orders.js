// Existing orders: email check, details, list, preview cards and cancellation.
// Tool handlers of the shopping session (see createSession in ../../ecommerce.js), moved here unchanged:
// what they share with the session comes in `ctx`; values the session changes are read through it.
// Tools: send_order_otp, verify_order_otp, get_order_details, list_my_orders, show_preview, request_order_cancellation, confirm_order_cancellation, cancel_order.
import mongoose from "mongoose";
import { buildOrderPreview, cancellability, isPaidOrder, orderBelongsTo, parseOrderNumber, projectOrder, summarizeOrders } from "../../../services/shopifyOrderLookupService.js";
import { recordEvent } from "../../../services/conversationLog.js";
import Event from "../../../models/Event.js";
import Conversation from "../../../models/Conversation.js";

/** Event type that keeps the customer's own words for why an order was cancelled (shown in the owner's dashboard). */
export const CANCEL_REASON_EVENT = "order_cancel_reason";
const squash = (text) => String(text || "").replace(/\s+/g, " ").trim();
const plain = (text) => squash(text).toLowerCase().replace(/[.,!?;:"'`।]+/g, "").trim();
/** True when `part` is something the customer actually wrote in `message` (so a reason is never invented). */
const saidIn = (message, part) => {
  const p = plain(part);
  return p.length >= 2 && plain(message).includes(p);
};

export function ordersHandlers(ctx) {
  const { actions, context, handlers, isHindi, looksLikeYesNo, notCancellableReply, orderAuth, orderLookup, orderReply, orderWho, resolveOrderTarget, storeId, userMessage } = ctx;
  // A reason the customer already gave (this message or an earlier one), in their own words; "" when there is none.
  const customerReason = (candidate) => {
    const text = squash(candidate).slice(0, 300);
    return text.length >= 2 && !looksLikeYesNo(text) && saidIn(context.userMessage, text) ? text : "";
  };
  // The customer's last message after the one that started this cancellation, when it is a plain yes (and not the current message,
  // which is the reason). "" when there is none, or it was a no. Needs the request message in the history: no guessing from older chat.
  const AFFIRMATIVE = /^\s*(?:yes|yeah|yep|yup|ok|okay|sure|haan|han|ha|haa|ji|theek hai|thik hai|confirm|confirmed)\b/i;
  const NEGATIVE = /\b(?:no|nope|nahi|nahin|nhi|na|don't|dont|do not|stop|leave it|keep it)\b/i;
  const confirmingYes = (pending) => {
    const now = squash(context.userMessage);
    const users = (Array.isArray(context.history) ? context.history : []).filter((m) => m?.role === "user").map((m) => squash(m.content));
    const startedAt = users.lastIndexOf(squash(pending.message));
    if (startedAt < 0) return "";
    const last = users.slice(startedAt + 1).filter((t) => t && t !== now).pop() || "";
    return AFFIRMATIVE.test(last) && !NEGATIVE.test(last) ? last : "";
  };
  // Keeps the reason against this store's order. Separate from the order's own event, so Shopify's cancel webhook
  // (which carries only a coarse reason such as "customer") can never overwrite or blank it. Never blocks the cancel.
  const rememberCancelReason = async (order, reason, cancelStatus) => {
    try {
      const props = { orderName: String(order.name), reason, via: "ai_assistant", cancelStatus };
      const dedupeKey = `cancelreason:${order.name}`;
      // tied to this chat's conversation (when it exists), so it is also erased with that customer's chats
      const chat = context.chatRef && mongoose.connection?.readyState === 1
        ? await Conversation.findOne({ shop: storeId, chatRef: context.chatRef }, { _id: 1 }).lean().catch(() => null)
        : null;
      const created = await recordEvent({ shop: storeId, type: CANCEL_REASON_EVENT, dedupeKey, conversationId: chat?._id || null, chatRef: context.chatRef || null, props });
      if (!created && mongoose.connection?.readyState === 1) {
        await Event.updateOne({ shop: storeId, type: CANCEL_REASON_EVENT, dedupeKey }, { $set: { props, at: new Date() } });
      }
    } catch (error) {
      console.warn("[order-cancel] could not keep the reason:", String(error?.message || error).slice(0, 160));
    }
  };
  return {

    // ---------------------------------------------------------------------------------------------
    // Secure order status / order details.
    //  - Logged-in Shopify customer (verifiedCustomerId): no OTP, orders are matched by customer id.
    //  - Guest: email -> 6-digit OTP -> verified email; only orders placed with that email are shown.
    // Every fact returned comes from Shopify; only the requested detail groups are exposed.
    // ---------------------------------------------------------------------------------------------
    send_order_otp: async (args = {}) => {
      const reply = (status, extra, instruction, en, hi) => {
        ctx.fallbackSpeech = isHindi ? hi : en;
        return { status, ...extra, instruction_for_ai: instruction };
      };
      const requested = String(args.email || "").trim();
      if (!requested && !context.verifiedCustomerId && (await orderAuth.getVerifiedEmail({ shop: storeId, clientId: context.clientId }))) {
        return reply(
          "already_verified", {},
          "The customer is already verified, so NO code is needed. Ask for the order number if you do not have it, then call get_order_details.",
          "You're already verified. Please share your order number.",
          "Aap pehle se verify ho. Apna order number bata do.",
        );
      }
      if (context.verifiedCustomerId && !requested) {
        return reply(
          "already_logged_in", {},
          "The customer is logged in to their account, so NO verification code is needed. Ask them for the order number and then call get_order_details.",
          "You're logged in, so no OTP is needed. Please share your order number.",
          "Aap logged in ho, isliye OTP ki zaroorat nahi hai. Apna order number bata do.",
        );
      }
      const res = await orderAuth.requestOtp({
        shop: storeId,
        clientId: context.clientId,
        email: requested || undefined,
        shopName: context.storeProfile?.storeName || storeId,
      });
      switch (res.status) {
        case "email_required":
          return reply("email_required", {}, "Ask the customer for the email address used on the order.",
            "Please share the email address used for the order.", "Order ke liye jo email use kiya tha woh bata do.");
        case "invalid_email":
          return reply("invalid_email", { reason: res.reason },
            "That email is not valid. Tell the customer it is not a valid email address and ask them to share the correct one. Nothing was sent.",
            "That email doesn't look valid. Please share a correct email address.",
            "Yeh email valid nahi lag raha. Sahi email address dobara bata do.");
        case "email_unavailable":
          return reply("email_unavailable", {},
            "Email verification is not available right now. Apologise briefly and suggest they log in to their account or contact the store.",
            "I can't send a verification code right now. Please log in to your account or contact the store.",
            "Abhi verification code nahi bhej pa rahi. Please apne account mein login karo ya store se contact karo.");
        case "cooldown":
          return reply("cooldown", { secondsLeft: res.secondsLeft },
            `A code was sent a moment ago. Ask the customer to wait about ${res.secondsLeft} seconds, check inbox and spam, and ask for a resend only if it still has not arrived.`,
            `A code was just sent. Please wait ${res.secondsLeft} seconds and check your inbox or spam.`,
            `Code abhi bheja hai. ${res.secondsLeft} second ruko aur inbox ya spam check karo.`);
        case "rate_limited":
          return reply("rate_limited", {},
            "Too many codes were requested. Ask the customer to try again after some time, or log in to their account.",
            "Too many codes were requested. Please try again after a while.",
            "Bahut saare codes request ho gaye. Thodi der baad dobara try karo.");
        case "send_failed":
          return reply("send_failed", {},
            "The email could not be sent. Apologise, ask them to double-check the email address and try again.",
            "I couldn't send the email. Please check the address and try again.",
            "Email nahi ja paya. Address check karke dobara try karo.");
        default:
          return reply("otp_sent", { maskedEmail: res.maskedEmail, digits: res.digits, expiresInMinutes: res.expiresInMinutes },
            `A ${res.digits}-digit verification code was emailed to ${res.maskedEmail}. Tell the customer to check inbox (and spam) and type the ${res.digits}-digit code here; it expires in ${res.expiresInMinutes} minutes. NEVER say, guess or repeat the code.`,
            `I've sent a ${res.digits}-digit code to ${res.maskedEmail}. Please enter it here.`,
            `Maine ${res.maskedEmail} par ${res.digits} digit ka code bheja hai. Woh yahan bata do.`);
      }
    },

    verify_order_otp: async (args = {}) => {
      const reply = (status, extra, instruction, en, hi) => {
        ctx.fallbackSpeech = isHindi ? hi : en;
        return { status, ...extra, instruction_for_ai: instruction };
      };
      const res = await orderAuth.verifyOtp({ shop: storeId, clientId: context.clientId, code: args.code });
      switch (res.status) {
        case "no_otp_pending":
          return reply("no_otp_pending", {},
            "No verification code is pending. Ask for the email used on the order so you can send one.",
            "No code is pending. Please share your email so I can send one.",
            "Abhi koi code pending nahi hai. Apna email bata do, main bhej deti hu.");
        case "otp_invalidated":
        case "expired":
          return reply(res.status, {},
            "This code is no longer valid (it was cancelled by an earlier wrong attempt or it expired). Tell the customer plainly that the code is not valid any more and ask whether they want a new code sent. If they say yes, call send_order_otp WITHOUT an email.",
            "That code isn't valid any more. Would you like me to resend a new one?",
            "Yeh code ab valid nahi hai. Kya main naya code resend kar doon?");
        case "invalid_format":
          return reply("invalid_format", { enteredDigits: res.enteredDigits, expectedDigits: res.expectedDigits },
            `The code must be exactly ${res.expectedDigits} digits but the customer gave ${res.enteredDigits}. Tell them it is invalid because it is not ${res.expectedDigits} digits and ask them to enter the full ${res.expectedDigits}-digit code. The code itself is still valid.`,
            `That's not valid: the code must be exactly ${res.expectedDigits} digits. Please try again.`,
            `Yeh valid nahi hai, code poore ${res.expectedDigits} digit ka hota hai. Dobara bata do.`);
        case "wrong_otp":
          return reply("wrong_otp", {},
            "The code is WRONG and that code has now been cancelled and can never work again. Tell the customer the OTP is incorrect and ask if they want a new code sent. If they say yes, call send_order_otp WITHOUT an email.",
            "That OTP is incorrect, and it can't be used again. Should I send you a new one?",
            "Yeh OTP galat hai aur ab dobara kaam nahi karega. Kya main naya OTP bhej doon?");
        default:
          return reply("verified", { maskedEmail: res.maskedEmail },
            `Verification successful for ${res.maskedEmail}. Tell the customer they are verified. If they asked how many orders they placed or for their past orders, call list_my_orders now. If they have not given the order number yet, ask for it; if they already gave it earlier in this chat, call get_order_details right away with only the detail they asked for.`,
            "You're verified. Please share your order number.",
            "Aap verify ho gaye. Ab apna order number bata do.");
      }
    },

    get_order_details: async (args = {}) => {
      const reply = (status, extra, instruction, en, hi) => {
        ctx.fallbackSpeech = isHindi ? hi : en;
        return { status, ...extra, instruction_for_ai: instruction };
      };
      const customerGid = context.verifiedCustomerId || null;
      const verifiedEmail = await orderAuth.getVerifiedEmail({ shop: storeId, clientId: context.clientId });
      if (!customerGid && !verifiedEmail) {
        return reply("verification_required", {},
          "The customer is NOT verified yet, so you must not share any order information. Explain that you can help but first need to verify them: ask for the email address used on the order, then call send_order_otp with it.",
          "I can help with that, but first I need to verify you. Please share the email used on the order and I'll send a code.",
          "Main help kar dungi, par pehle aapko verify karna hoga. Order mein jo email use kiya tha woh bata do, main code bhejungi.");
      }
      const gaveNumber = args.orderNumber != null && String(args.orderNumber).trim() !== "";
      const orderNumber = gaveNumber
        ? parseOrderNumber(args.orderNumber)
        : (await orderAuth.getLastOrder?.({ shop: storeId, clientId: context.clientId })) || "";
      if (!orderNumber) {
        return reply("need_order_number", {},
          "Ask the customer for their order number (it looks like #1001, shown in their order confirmation).",
          "Please share your order number (like #1001).",
          "Apna order number bata do (jaise #1001).");
      }
      let order = null;
      try {
        order = await orderLookup.findOrder(storeId, orderNumber);
      } catch (err) {
        console.error("[order-lookup] Shopify lookup failed:", err?.message || err);
        return reply("unavailable", {},
          "Order lookup is temporarily unavailable. Apologise briefly and ask them to try again in a moment or contact the store. Do not invent any order information.",
          "I couldn't fetch the order right now. Please try again in a moment.",
          "Abhi order fetch nahi ho paya. Thodi der baad dobara try karo.");
      }
      if (!order || !orderBelongsTo(order, { customerGid, verifiedEmail })) {
        return reply("not_found", { orderNumber, canVerifyOtherEmail: Boolean(customerGid) },
          `No order ${orderNumber} was found for this verified customer. Do NOT say whether such an order exists for anyone else and share nothing about it. Ask them to re-check the order number${customerGid ? ", and offer to verify a different email by code if the order was placed with another email" : ""}.`,
          `I couldn't find order ${orderNumber} for your account. Please check the number.`,
          `Mujhe order ${orderNumber} aapke account mein nahi mila. Number ek baar check kar lo.`);
      }
      await orderAuth.setLastOrder?.({ shop: storeId, clientId: context.clientId, orderNumber });
      const view = projectOrder(order, args.fields);
      const d = view.details;
      ctx.fallbackSpeech = isHindi
        ? `Order ${view.orderName} ki detail mil gayi hai${d.fulfillmentStatus ? `, delivery status: ${d.fulfillmentStatus}` : ""}${d.paymentStatus ? `, payment: ${d.paymentStatus}` : ""}.`
        : `I found order ${view.orderName}${d.fulfillmentStatus ? `; delivery status: ${d.fulfillmentStatus}` : ""}${d.paymentStatus ? `; payment: ${d.paymentStatus}` : ""}.`;
      return {
        status: "ok",
        ...view,
        instruction_for_ai:
          "Use ONLY the facts inside `details` (the groups listed in `shown`). Explain them in simple, friendly words in the customer's language. Do NOT add any other order detail (the groups in `notShown`) unless the customer asks for it next. If they asked for one thing (for example just the status), answer only that one thing. If a value is missing or null, say it is not available instead of guessing. Keep it short and offer more help at most once.",
      };
    },

    // The verified shopper's own orders: counts and the latest few. Same identity rule as order details.
    list_my_orders: async () => {
      const customerGid = context.verifiedCustomerId || null;
      const verifiedEmail = await orderAuth.getVerifiedEmail({ shop: storeId, clientId: context.clientId });
      if (!customerGid && !verifiedEmail) {
        ctx.fallbackSpeech = isHindi
          ? "Main bata dungi, par pehle aapko verify karna hoga. Order mein jo email use kiya tha woh bata do, main code bhejungi."
          : "I can check that, but first I need to verify you. Please share the email you used for your orders and I'll send a code.";
        return {
          status: "verification_required",
          instruction_for_ai: "The customer is NOT verified, so share no order information. Ask for the email used on their orders, then call send_order_otp with it. After verify_order_otp succeeds, call list_my_orders again.",
        };
      }
      let found;
      try {
        found = await orderLookup.listOrders(storeId, { customerGid, verifiedEmail });
      } catch (err) {
        console.error("[order-lookup] Shopify order list failed:", err?.message || err);
        ctx.fallbackSpeech = isHindi ? "Abhi orders fetch nahi ho paye. Thodi der baad dobara try karo." : "I couldn't fetch your orders right now. Please try again in a moment.";
        return { status: "unavailable", instruction_for_ai: "Order lookup is temporarily unavailable. Apologise briefly and ask them to try again shortly. Do not guess any number." };
      }
      const summary = summarizeOrders(found.orders, { timezone: found.timezone });
      if (summary.recentOrders[0]?.orderName) await orderAuth.setLastOrder?.({ shop: storeId, clientId: context.clientId, orderNumber: summary.recentOrders[0].orderName });
      const c = summary.counts;
      ctx.fallbackSpeech = isHindi
        ? `Aapne aaj ${c.today} order kiye hain, aur pichhle 30 din mein ${c.last30Days}.`
        : `You placed ${c.today} order${c.today === 1 ? "" : "s"} today and ${c.last30Days} in the last 30 days.`;
      return {
        status: "ok",
        ...summary,
        coverage: found.hasMore
          ? "Only the latest orders were counted; there are more older ones. Say 'at least' for totals."
          : "Counts cover the orders Shopify shares with this store (usually the last 60 days). For 'ever' questions say it is for the recent period, not a lifetime total.",
        instruction_for_ai:
          "Answer only what they asked (e.g. today's count) from `counts` and `recentOrders`, in their language. `today`, `last7Days`, `last30Days` and `total` do not include cancelled orders (`cancelled` is separate). Never invent orders or numbers.",
      };
    },

    // ---------------------------------------------------------------------------------------------
    // Order cancellation: (1) request -> show details & ask "are you sure?"  (2) customer says yes
    // -> ask the reason  (3) customer gives the reason -> cancel in Shopify.
    // The steps are enforced HERE: each one needs the previous step AND a new customer message, so
    // the model cannot skip the confirmation or invent a reason. Only unfulfilled orders can be cancelled.
    // ---------------------------------------------------------------------------------------------
    // Generic preview: the model decides (from meaning, in any language) WHAT the customer wants to see.
    show_preview: async (args = {}) => {
      const kind = String(args.kind || "").toLowerCase().trim();
      // "show me again what you found" is about PRODUCTS, not the cart: with an empty cart and no word about the cart, an order or a total in the
      // message, the model once answered "your cart is empty, nothing to preview" (real storefront, 2026-11-17).
      if (kind === "cart" && userMessage && !/\b(?:cart|basket|bag|trolley|order|checkout|total|summary|preview|review|bill|kart|tokri)\b/i.test(String(userMessage)) && ((context?.cart?.items || []).length === 0 || /\b(?:again|found|showed|those|them|options|dobara|phir\s+se|fir\s+se|wapas)\b/i.test(String(userMessage)))) {
        return { status: "not_requested", instruction_for_ai: "The customer did not ask about the cart (it is empty): they want to see the products from this conversation again. Name those products in your reply (their cards are shown with it) or call search_products again. Never say there is nothing to preview." };
      }
      if (kind === "cart") return handlers.get_cart();
      if (kind === "checkout") return handlers.mark_checkout_ready({ force: true });
      if (kind !== "order") {
        return {
          status: "needs_clarification",
          instruction_for_ai:
            "You could not tell what the customer wants previewed. Ask ONE short question: do they want to see their current cart / the order review before placing an order, or an order they already placed (then ask for the order number)? Do not guess.",
        };
      }
      const target = await resolveOrderTarget(args.orderNumber);
      if (target.error) return target.error;
      const { order, orderNumber } = target;
      await orderAuth.setLastOrder({ ...orderWho, orderNumber });
      const preview = buildOrderPreview(order, args.fields && args.fields.length ? args.fields : ["all"]);
      if (actions.length < 8) actions.push({ type: "preview", preview });
      ctx.fallbackSpeech = isHindi
        ? `Ye raha ${order.name} ka preview.`
        : `Here is the preview of ${order.name}.`;
      return {
        status: "ok",
        orderName: order.name,
        previewShown: true,
        instruction_for_ai:
          "The preview card with the order details is ALREADY shown to the customer. Do not list every detail again in text. Reply in 1-2 friendly sentences (for example the current status) and ask if they need anything else.",
      };
    },

    request_order_cancellation: async (args = {}) => {
      const target = await resolveOrderTarget(args.orderNumber);
      if (target.error) return target.error;
      const { order, orderNumber } = target;
      const can = cancellability(order);
      if (!can.ok) {
        await orderAuth.clearPendingCancel(orderWho);
        return notCancellableReply(order, can);
      }
      await orderAuth.setLastOrder({ ...orderWho, orderNumber });
      // One question, once: a cancellation already in progress for this order is never restarted or asked again.
      const existing = await orderAuth.getPendingCancel(orderWho);
      if (existing && existing.orderNumber === orderNumber) {
        if (existing.stage === "awaiting_reason") {
          return existing.reason
            ? orderReply("reason_known", { orderName: existing.orderName, reason: existing.reason },
              `The customer already confirmed and already gave their reason: "${existing.reason}". Do NOT ask anything again. Call cancel_order now with exactly that reason.`,
              "Cancelling now.", "Cancel kar raha hoon.")
            : orderReply("reason_needed", { orderName: existing.orderName },
              "The customer already confirmed. Do not ask for confirmation again. Ask once for the reason for cancelling, or if their latest message already is the reason, call cancel_order with it.",
              "Please tell me the reason for cancelling.", "Cancel karne ka reason bata do.");
        }
        return orderReply("confirmation_pending", { orderName: existing.orderName },
          "The confirmation question for this order was already asked. If the customer's latest message answers it (yes or no), call confirm_order_cancellation now. Otherwise ask it once and wait.",
          `Are you sure you want to cancel order ${existing.orderName}? Please reply yes or no.`,
          `Kya aap order ${existing.orderName} cancel karna chahte hain? Haan ya na bata do.`);
      }
      const earlyReason = customerReason(args.reason);
      await orderAuth.setPendingCancel({
        ...orderWho,
        pending: { orderNumber, orderName: order.name, stage: "awaiting_confirmation", message: context.userMessage || "", ...(earlyReason ? { reason: earlyReason } : {}) },
      });
      const view = projectOrder(order, ["status", "items", "total", "payment"]);
      return orderReply("confirmation_needed", { ...view, refundWillBeIssued: isPaidOrder(order) },
        `Do NOT cancel yet. Ask the customer clearly: are you sure you want to cancel order ${order.name}? Show the order id and these details from the result: items (name, variant, quantity), total and payment method${isPaidOrder(order) ? ", and mention the paid amount will be refunded to the original payment method" : ""}. Then wait for their yes or no in their NEXT message.`,
        `Are you sure you want to cancel order ${order.name}? Please reply yes or no.`,
        `Kya aap pakka order ${order.name} cancel karna chahte ho? Haan ya na bata do.`);
    },

    confirm_order_cancellation: async (args = {}) => {
      const pending = await orderAuth.getPendingCancel(orderWho);
      if (!pending) {
        return orderReply("no_cancellation_pending", {},
          "There is no cancellation in progress. If the customer wants to cancel an order, start with request_order_cancellation.",
          "There's no cancellation in progress. Tell me which order you want to cancel.",
          "Abhi koi cancellation chal nahi raha. Bata do kaunsa order cancel karna hai.");
      }
      // They changed their mind after saying yes (before the reason or the cancel): it stops here, nothing is cancelled.
      if (pending.stage !== "awaiting_confirmation" && args.confirmed === false) {
        await orderAuth.clearPendingCancel(orderWho);
        return orderReply("cancellation_declined", { orderName: pending.orderName },
          `The customer changed their mind. Nothing was cancelled: tell them order ${pending.orderName} stays as it is and ask if they need anything else.`,
          `Okay, order ${pending.orderName} stays as it is.`, `Theek hai, order ${pending.orderName} jaisa hai waisa hi rahega.`);
      }
      if (pending.stage !== "awaiting_confirmation") {
        return orderReply("reason_needed", { orderName: pending.orderName },
          "The customer already confirmed. Ask for their reason for cancelling (do not ask for confirmation again).",
          "Please tell me the reason for cancelling.", "Cancel karne ka reason bata do.");
      }
      if (pending.message === (context.userMessage || "")) {
        return orderReply("wait_for_customer", {},
          "Do not continue in the same message. Ask the confirmation question and wait for the customer's reply.",
          "Please reply yes or no.", "Haan ya na bata do.");
      }
      if (args.confirmed !== true) {
        await orderAuth.clearPendingCancel(orderWho);
        return orderReply("cancellation_declined", { orderName: pending.orderName },
          `The customer does not want to cancel. Tell them order ${pending.orderName} stays as it is and ask if they need anything else.`,
          `Okay, order ${pending.orderName} stays as it is.`, `Theek hai, order ${pending.orderName} jaisa hai waisa hi rahega.`);
      }
      // The reason may already be known: given with the cancel request, or in this very "yes" message.
      const known = pending.reason || customerReason(args.reason);
      await orderAuth.setPendingCancel({ ...orderWho, pending: { ...pending, stage: "awaiting_reason", message: context.userMessage || "", ...(known ? { reason: known } : {}) } });
      if (known) {
        return orderReply("reason_known", { orderName: pending.orderName, reason: known },
          `The customer confirmed and already gave their reason: "${known}". Do NOT ask for confirmation or a reason again. Call cancel_order now with exactly that reason.`,
          "Cancelling now.", "Cancel kar raha hoon.");
      }
      return orderReply("reason_needed", { orderName: pending.orderName },
        `The customer confirmed. Now ask them why they want to cancel order ${pending.orderName} (their reason). Wait for their answer in their NEXT message; do not cancel yet.`,
        "Understood. May I know the reason for cancelling?", "Theek hai. Cancel karne ka reason bata sakte ho?");
    },

    cancel_order: async (args = {}) => {
      let pending = await orderAuth.getPendingCancel(orderWho);
      if (!pending) {
        return orderReply("no_cancellation_pending", {},
          "There is no confirmed cancellation. Start with request_order_cancellation and get their confirmation first.",
          "There's no confirmed cancellation. Tell me which order you want to cancel.",
          "Koi confirmed cancellation nahi hai. Bata do kaunsa order cancel karna hai.");
      }
      // The customer may already have said yes to "are you sure?" while the model skipped confirm_order_cancellation (it went
      // straight to asking for the reason). A yes given AFTER the request message, and not a no, counts: never ask again.
      if (pending.stage === "awaiting_confirmation") {
        const yes = confirmingYes(pending);
        if (yes) {
          pending = { ...pending, stage: "awaiting_reason", message: yes };
          await orderAuth.setPendingCancel({ ...orderWho, pending });
        }
      }
      if (pending.stage !== "awaiting_reason") {
        return orderReply("confirmation_missing", { orderName: pending.orderName },
          `The customer has not confirmed yet. Ask: are you sure you want to cancel order ${pending.orderName}? and wait for yes.`,
          "Please confirm first: do you want to cancel the order?", "Pehle confirm karo: kya order cancel karna hai?");
      }
      // Same message as the "yes" is fine only when the reason was really said in it (or earlier); otherwise wait.
      if (pending.message === (context.userMessage || "") && !pending.reason) {
        return orderReply("wait_for_customer", {},
          "Do not continue in the same message. Ask for the reason and wait for the customer's reply.",
          "Please tell me the reason first.", "Pehle reason bata do.");
      }
      // The customer's own words, never a rewrite: the model's wording only if it is part of what they wrote, else their message.
      const said = squash(context.userMessage).slice(0, 300);
      const reason = pending.reason || (saidIn(context.userMessage, args.reason) ? squash(args.reason).slice(0, 300) : said);
      if (reason.length < 2 || looksLikeYesNo(reason)) {
        return orderReply("reason_needed", { orderName: pending.orderName },
          "A real reason is needed. Ask the customer again for the reason for cancelling (in their own words). Never make one up.",
          "I need the reason for cancelling, please.", "Cancel karne ka reason zaroor bata do.");
      }
      // Re-check everything at the moment of cancelling (it may have shipped, or verification may have expired).
      const target = await resolveOrderTarget(pending.orderNumber);
      if (target.error) return target.error;
      const can = cancellability(target.order);
      if (!can.ok) {
        await orderAuth.clearPendingCancel(orderWho);
        return notCancellableReply(target.order, can);
      }
      const paid = isPaidOrder(target.order);
      const result = await orderLookup.cancelOrder(storeId, target.order, {
        reason,
        refund: paid,
        notifyCustomer: process.env.NOTIFY_CUSTOMER_ON_CANCEL !== "false",
      });
      await orderAuth.clearPendingCancel(orderWho);
      const name = target.order.name;
      if (["cancelled", "processing", "unconfirmed"].includes(result.status)) await rememberCancelReason(target.order, reason, result.status);
      // The order stops counting as an order/revenue as soon as Shopify says it is cancelled, whether or not the orders/cancelled webhook is
      // subscribed on this store (the same update runs again, harmlessly, when that webhook arrives).
      if (result.status === "cancelled") {
        try {
          await Event.updateOne(
            { shop: storeId, type: "order_placed", dedupeKey: `order:${target.order.name}`, "props.cancelledAt": { $exists: false } },
            { $set: { "props.cancelledAt": new Date(Date.parse(result.order?.cancelledAt) || Date.now()), "props.cancelReason": "customer" } },
          );
        } catch (error) { console.warn("[order-cancel] could not mark the analytics event:", String(error?.message || error).slice(0, 120)); }
      }
      if (result.status === "cancelled") {
        return orderReply("cancelled", { orderName: name, reason, refundWillBeIssued: paid },
          `Order ${name} is now cancelled. Confirm this to the customer in a warm, short way${paid ? " and say the paid amount will be refunded to the original payment method (do not promise a specific time)" : ""}. Offer further help once.`,
          `Order ${name} has been cancelled.`, `Order ${name} cancel ho gaya hai.`);
      }
      if (result.status === "processing" || result.status === "unconfirmed") {
        return orderReply("cancellation_processing", { orderName: name },
          `The cancellation request for ${name} was submitted but Shopify has not finished it yet. Say it is being processed and they can check the order status in a minute. Do NOT claim it is already cancelled.`,
          `Your cancellation for ${name} is being processed. Please check in a minute.`,
          `${name} ka cancellation process ho raha hai. Ek minute baad status check kar lo.`);
      }
      console.error("[order-cancel] failed:", result.message);
      return orderReply("cancel_failed", { orderName: name },
        `The order could not be cancelled right now. Apologise, do not claim it is cancelled, and suggest they contact the store. Do not invent a reason.`,
        `I couldn't cancel ${name} right now. Please contact the store.`,
        `${name} abhi cancel nahi ho paya. Please store se contact karo.`);
    },
  };
}
