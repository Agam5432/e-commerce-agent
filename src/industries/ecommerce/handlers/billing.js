// Sign-in stand-ins and the billing address.
// Tool handlers of the shopping session (see createSession in ../../ecommerce.js), moved here unchanged:
// what they share with the session comes in `ctx`; values the session changes are read through it.
// Tools: request_login, request_manual_login, send_login_otp, verify_login_otp, set_billing_same_as_shipping, request_billing_update, set_billing_address.
import { contactProblemMessage, contactProblems } from "../../../services/contactValidation.js";
import { deduplicateAddress, mergeShippingAddress, validContactPhone } from "../../../services/shippingAddressService.js";
import { computeOrderPricing } from "../pricing.js";
import { formatPriceLabel } from "../replies.js";

export function billingHandlers(ctx) {
  const { actions, billingRelationshipIntent, context, handlers, history, isHindi, llmMode, prepaidOffer, safeGet, safeUpsert, storeCurrency, storeId, userMessage } = ctx;
  return {

    request_login: async () => ({ status: "ok" }),
    request_manual_login: async () => ({
      status: "ok",
      loginUrl: "/account/login",
    }),
    send_login_otp: async () => ({ status: "ok" }),
    verify_login_otp: async () => ({ status: "ok" }),
    set_billing_same_as_shipping: async () => {
      const session = await safeGet();
      const intent = billingRelationshipIntent(
        userMessage,
        [...history].reverse().find((turn) => turn.role === "assistant")
          ?.content,
      );
      // The model chose this tool itself; only a clear "no / different" or a question overrides it.
      const modelChoseSame =
        llmMode ||
        (intent === "" &&
        !/[?]/.test(userMessage) &&
        !/\b(?:no|nope|not|nahi|nahin|nhi|mat|different|alag)\b/i.test(userMessage));
      if (intent !== "same" && !modelChoseSame) {
        if (intent === "different") return handlers.request_billing_update();
        if (intent === "question") return handlers.get_checkout_details();
        ctx.fallbackSpeech = isHindi
          ? "Kya billing ke liye bhi delivery address hi use karoon?"
          : "Would you like to use your delivery address for billing too?";
        return { status: "confirmation_required" };
      }
      if (
        !session.shipping?.address1 ||
        session.shippingNeedsUpdate ||
        !validContactPhone(
          session.shipping.phone,
          session.shipping.countryCode || session.shipping.country,
        )
      ) {
        ctx.fallbackSpeech = isHindi
          ? "Pehle delivery address aur complete phone number confirm kar do."
          : "Please confirm the complete delivery address and phone number first.";
        const cp = contactProblems({
          email: session.shipping?.email || session.customer?.email,
          phone: session.shipping?.phone,
          country: session.shipping?.countryCode || session.shipping?.country,
        });
        if (cp.length) ctx.fallbackSpeech = contactProblemMessage(cp, isHindi);
        return { status: "incomplete_address" };
      }
      await safeUpsert({
        billing: deduplicateAddress(session.shipping),
        billingSameAsShipping: true,
        billingConfirmed: true,
        billingNeedsUpdate: false,
        shippingConfirmed: true,
      });
      actions.push({
        type: "set_billing_address",
        address: deduplicateAddress(session.shipping),
        sameAsShipping: true,
      });
      return handlers.mark_checkout_ready();
    },

    request_billing_update: async () => {
      await safeUpsert({
        billingSameAsShipping: false,
        billingConfirmed: false,
        billingNeedsUpdate: true,
        step: "billing_inquiry",
      });
      ctx.fallbackSpeech = isHindi
        ? "Theek hai, billing ke liye alag address use karenge. Poora billing address bata do."
        : "Of course, we'll use a separate billing address. Please share the full billing address you'd like to use.";
      return { status: "billing_address_update_required" };
    },
    set_billing_address: async (args = {}) => {
      const session = await safeGet();
      const update = mergeShippingAddress(
        session.billing || {
          country: session.shipping?.country,
          email: session.shipping?.email,
        },
        args,
        {
          message: userMessage,
          history,
          customer: { ...session.customer, ...session.shipping },
        },
      );
      const billingAddress = update.address;
      const missing = update.missing.filter(
        (field) =>
          field !== "email" && !(field === "phone" && !billingAddress.phone),
      );
      if (missing.length) {
        ctx.fallbackSpeech = `Please confirm your billing ${missing.join(", ")} before completing the order.`;
        return { status: "incomplete_billing_address", missingFields: missing };
      }
      const {
        name: resolvedName,
        address1,
        address2,
        city,
        province,
        zip,
      } = billingAddress;

      const cart = context.cart || {};
      const pricing = computeOrderPricing(cart, session, storeCurrency);
      const cur = pricing.currency;
      const baseTotal = pricing.totalAfterCoupon;
      const offer = await prepaidOffer(storeId, baseTotal);

      await safeUpsert({
        billing: billingAddress,
        billingSameAsShipping: false,
        billingConfirmed: true,
        billingNeedsUpdate: false,
        step: "ready",
        discountAmount: pricing.couponDiscountAmount,
        finalTotal: baseTotal,
        hasPrepaidDiscount: offer.hasDiscount,
        prepaidDiscountPercent: offer.discountPercent || 0,
        prepaidDiscountAmount: offer.discountAmount || 0,
        prepaidTotal: offer.prepaidTotal,
      });

      if (actions.length < 8) {
        actions.push({
          type: "set_billing_address",
          address: billingAddress,
          sameAsShipping: false,
        });
        actions.push({
          type: "checkout_ready",
          cart,
          shipping: session.shipping || billingAddress,
          billing: billingAddress,
          billingSameAsShipping: false,
          email: session.shipping?.email || session.customer?.email || "",
          originalTotal: pricing.rawSubtotal,
          total: baseTotal,
          discountAmount: pricing.couponDiscountAmount,
          appliedDiscount: pricing.appliedDiscount,
          hasPrepaidDiscount: offer.hasDiscount,
          discountTitle: offer.title,
          discountCode: offer.code,
          prepaidDiscountPercent: offer.discountPercent,
          prepaidDiscountAmount: offer.discountAmount,
          prepaidTotal: offer.prepaidTotal,
          currency: cur,
        });
      }

      const subStr = formatPriceLabel(pricing.rawSubtotal, cur);
      const totalStr = formatPriceLabel(baseTotal, cur);
      const couponDiscStr = formatPriceLabel(pricing.couponDiscountAmount, cur);
      const prepaidStr = formatPriceLabel(offer.prepaidTotal, cur);
      const prepaidDiscStr = formatPriceLabel(offer.discountAmount, cur);
      const billSummary = [
        resolvedName,
        address1,
        address2,
        city,
        province,
        zip,
      ]
        .filter(Boolean)
        .join(", ");

      const pricingBlockHi =
        pricing.hasCoupon && pricing.couponDiscountAmount > 0
          ? `• Cart Subtotal: **${subStr}**\n• Coupon Applied (**${pricing.appliedDiscount.code}** · ${pricing.couponPercent}% OFF): **-${couponDiscStr}**\n• **Final Payable Total: ${totalStr}**`
          : `• **Order Total: ${totalStr}**`;

      const pricingBlockEn =
        pricing.hasCoupon && pricing.couponDiscountAmount > 0
          ? `• Cart Subtotal: **${subStr}**\n• Coupon Applied (**${pricing.appliedDiscount.code}** · ${pricing.couponPercent}% OFF): **-${couponDiscStr}**\n• **Final Payable Total: ${totalStr}**`
          : `• **Order Total: ${totalStr}**`;

      if (offer.hasDiscount) {
        const label =
          offer.discountPercent > 0
            ? `${offer.discountPercent}% discount`
            : `${prepaidDiscStr} discount`;
        ctx.fallbackSpeech = isHindi
          ? `All set dost! Maine tumhara alag Billing Address bhi save kar liya hai: **${billSummary}**.\n${pricingBlockHi}\n\nBatao, payment kaise karna chahoge: **Cash on Delivery (COD)** ya **Prepaid (Online payment)**?\n *Prepaid Offer:* Online payment karne par instant **${label}** (${prepaidDiscStr} off) mil raha hai — Prepaid total sirf **${prepaidStr}** hoga!`
          : `All set! I've saved your billing address: **${billSummary}**.\n${pricingBlockEn}\n\nHow would you like to pay: **Cash on Delivery (COD)** or **Prepaid (Online payment)**?\n *Prepaid Offer:* Save **${label}** (${prepaidDiscStr} off) with online payment — your Prepaid total is just **${prepaidStr}**!`;
      } else {
        ctx.fallbackSpeech = isHindi
          ? `All set dost! Maine tumhara alag Billing Address bhi save kar liya hai: **${billSummary}**.\n${pricingBlockHi}\n\nBatao yaar, payment kaise karna chahoge — **Cash on Delivery (COD)** ya **Prepaid (Online payment)**?`
          : `All set! I've saved your billing address: **${billSummary}**.\n${pricingBlockEn}\n\nHow would you like to pay — **Cash on Delivery (COD)** or **Prepaid (Online payment)**?`;
      }

      return {
        status: "ok",
        billingSameAsShipping: false,
        billing: billingAddress,
        shipping: session.shipping,
        originalSubtotal: pricing.rawSubtotal,
        total: baseTotal,
        appliedCoupon: pricing.appliedDiscount,
      };
    },
  };
}
