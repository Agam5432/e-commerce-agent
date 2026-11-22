// Delivery address, the Shopify-priced order review, tax, shipping method and placing the order.
// Tool handlers of the shopping session (see createSession in ../../ecommerce.js), moved here unchanged:
// what they share with the session comes in `ctx`; values the session changes are read through it.
// Tools: set_shipping_address, mark_checkout_ready, get_tax_details, set_shipping_method, place_order.
import { checkoutFailureFacts, checkoutFailureMessage, checkoutFailureReason } from "../../../services/checkoutMessages.js";
import { contactProblemMessage, contactProblems, validateEmail } from "../../../services/contactValidation.js";
import { chatRefFor } from "../../../services/conversationLog.js";
import { deduplicateAddress, mergeShippingAddress, validContactPhone } from "../../../services/shippingAddressService.js";
import { breakdownRows, prepaidDiscountInput } from "../../../services/shopifyOrderService.js";
import * as shopifyService from "../../../tools/shopifyService.js";
import { computeOrderPricing, previewQuoteKey, quoteNotes, withQuoteTimeout } from "../pricing.js";
import { formatPriceLabel } from "../replies.js";
import { EMAIL_WAIT_MS } from "../shared.js";
import crypto from "node:crypto";

// "wahi pehle wala address", "same address as last time", "पिछला पता"
export const REUSE_ADDRESS_WORDS = /\b(?:same|previous|earlier|last|old|pichhl\w*|pichl\w*|pehle\s+(?:wala|wali|wale|vala)|pehle\s+ka|purana|purane|wahi|vahi|wohi)\b|पिछल|पहले\s+वाल|वही/i;

export function checkoutHandlers(ctx) {
  const { actions, billingRelationshipIntent, confirmsOrder, context, ensureShippingRates, findShippingRate, handlers, history, historyCustomer, isHindi, isVerifiedLoggedIn, lang, llmMode, localSession, paymentChoice, prepaidOffer, quoteOrder, safeGet, safeUpsert, sendConfirmation, storeCurrency, storeId, submitOrder, userMessage, wantsOrderPreview } = ctx;
  return {

    set_shipping_address: async (args = {}) => {
      const session = await safeGet();
      // "wahi pehle wala address", "same address as last time": the address of this chat's last order, as the shopper typed it then.
      // Only when this message brings no address of its own (a real run said "I'll use your earlier details" and then asked for all of them again).
      const reuseWords = REUSE_ADDRESS_WORDS;
      const ownAddressNow = /\d{5,6}|\b(?:road|street|lane|nagar|sector|colony|flat|house|apartment|marg)\b/i.test(userMessage);
      const lastAssistantText = String([...history].reverse().find((turn) => turn.role === "assistant")?.content || "");
      const yesToReuse = /^\s*(?:yes|yeah|yep|ok|okay|sure|haan|han|ha|ji|bilkul|theek|thik|हाँ|हां|जी)\b/i.test(userMessage) && reuseWords.test(lastAssistantText);
      if (session.lastOrderShipping?.address1 && (reuseWords.test(userMessage) || yesToReuse) && !ownAddressNow && !session.shipping?.address1) {
        const reused = { ...session.lastOrderShipping };
        session.shipping = reused;
        await safeUpsert({ shipping: reused, shippingSource: "previous_order", shippingConfirmed: true, shippingNeedsUpdate: false, guestDetailsClearedAfterOrder: false, step: "billing_inquiry", customer: { ...session.customer, name: reused.name, phone: reused.phone, email: reused.email } });
        args = { ...reused, ...Object.fromEntries(Object.entries(args || {}).filter(([, v]) => v)) };
      }
      if (billingRelationshipIntent(userMessage) === "different")
        await handlers.request_billing_update();
      const update = mergeShippingAddress(session.shipping || {}, args, {
        message: userMessage,
        history,
        customer: { ...context.customer, ...session.customer },
      });
      const address = update.address;
      await safeUpsert({
        shipping: address,
        shippingSource: "checkout",
        guestDetailsClearedAfterOrder: false,
        shippingNeedsUpdate: update.missing.length > 0 || update.invalid.length > 0,
        shippingConfirmed: update.missing.length === 0 && update.invalid.length === 0,
        step: update.missing.length || update.invalid.length ? "address" : "billing_inquiry",
        ...(session.billingConfirmed && session.billingSameAsShipping
          ? { billing: { ...address } }
          : {}),
        customer: {
          ...session.customer,
          name: address.name,
          phone: address.phone,
          email: address.email,
        },
      });
      actions.push({ type: "set_shipping_address", address });
      if (update.missing.length || update.invalid.length) {
        const labels = {
          name: "full name",
          address1: "street address",
          city: "city",
          province: "state",
          zip: "postal code",
          country: "country",
          email: "email address",
          phone: "complete phone number",
        };
        ctx.fallbackSpeech = `${isHindi ? "Details save kar li hain. Bas apna" : "I've saved the details you provided. Please confirm your"} **${update.missing.map((f) => labels[f]).join(", ")}**.${update.missing.includes("phone") && address.phone ? (isHindi ? " Phone number adhura lag raha hai; main koi digit guess nahi karungi." : " The phone number appears incomplete; I haven't added any digits.") : ""}`;
        const contactIssues = contactProblems({
          email: address.email,
          phone: address.phone,
          country: address.countryCode || address.country,
        });
        if (contactIssues.length) {
          const others = update.missing.filter((f) => f !== "email" && f !== "phone");
          ctx.fallbackSpeech =
            contactProblemMessage(contactIssues, isHindi) +
            (others.length
              ? ` ${isHindi ? "Saath mein ye bhi chahiye:" : "I also need your"} **${others.map((f) => labels[f]).join(", ")}**.`
              : "");
        }
        return {
          status: "incomplete_address",
          missingFields: update.missing,
          invalidFields: update.invalid.map((p) => p.field),
          savedPartial: address,
        };
      }
      const summary = [
        address.name,
        address.address1,
        address.address2,
        address.city,
        address.province,
        address.zip,
        address.country,
      ]
        .filter(Boolean)
        .join(", ");
      const sameBilling =
        billingRelationshipIntent(
          userMessage,
          [...history].reverse().find((turn) => turn.role === "assistant")
            ?.content,
        ) === "same";
      if (
        sameBilling ||
        (session.billingConfirmed && session.billingSameAsShipping)
      ) {
        await safeUpsert({
          billing: { ...address },
          billingConfirmed: true,
          billingSameAsShipping: true,
        });
        const result = await handlers.mark_checkout_ready();
        ctx.fallbackSpeech = `${isHindi ? "Delivery address update kar diya:" : "Delivery address updated:"} **${summary}**.\n${ctx.fallbackSpeech}`;
        return result;
      }
      ctx.fallbackSpeech = `${isHindi ? "Delivery address save kar diya:" : "I've saved your delivery address:"} **${summary}**.\n${isHindi ? "Kya billing address bhi yahi hai, ya alag address chahiye?" : "Is your billing address the same, or would you like to use a different one?"}`;
      return { status: "ok", address, next_step: "ask_billing" };
    },

    // The ONE order preview. It is a card (items, address, shipping, Shopify-calculated tax and
    // payable total); the chat text stays short. It is not repeated unless the shopper changes
    // something that changes the numbers or asks to see it again (`force`).
    mark_checkout_ready: async (opts = {}) => {
      let session = await safeGet();
      const cart = context.cart || {};
      if (!cart.items?.length) return handlers.get_cart();
      await ensureShippingRates(session);
      session = await safeGet();
      const pricing = computeOrderPricing(cart, session, storeCurrency);
      const shipping = deduplicateAddress(session.shipping || {});
      const billing =
        session.billingSameAsShipping !== false ? shipping : session.billing;
      const validAddress = Boolean(
        shipping.address1 &&
        shipping.city &&
        shipping.zip &&
        shipping.name &&
        !session.shippingNeedsUpdate &&
        !session.billingNeedsUpdate &&
        validateEmail(shipping.email || session.customer?.email).ok &&
        validContactPhone(
          shipping.phone,
          shipping.countryCode || shipping.country,
        ) && Boolean(shipping.phone),
      );
      const email = shipping.email || session.customer?.email || "";
      // Once the shopper has chosen online payment, the prepaid discount is part of the quote.
      const payMethodNow = session.selectedPaymentMethod || "";
      const prepaidOfferNow = payMethodNow === "prepaid" ? await prepaidOffer(storeId, pricing.discountedSubtotal).catch(() => null) : null;
      const prepaidInputNow = prepaidDiscountInput(prepaidOfferNow);
      const quoteKey = previewQuoteKey({ cart, shipping, billing: session.billingSameAsShipping !== false ? shipping : deduplicateAddress(session.billing || {}), session, pricing, prepaid: prepaidInputNow });
      let quote =
        session.orderQuote?.status === "review_required"
          ? session.orderQuote
          : session.orderQuote?.status === "preview" && session.orderQuote.key === quoteKey
            ? session.orderQuote
            : null;
      if (!quote && validAddress) {
        try {
          const calculated = await withQuoteTimeout(quoteOrder(storeId, {
            items: cart.items,
            shipping: session.shipping,
            billing,
            billingSameAsShipping: session.billingSameAsShipping !== false,
            email,
            shippingMethod: pricing.shippingMethod,
            shippingRate: pricing.shippingRate,
            appliedDiscount: pricing.appliedDiscount,
            currency: pricing.currency,
            countryCode: context.cart?.country || "",
            shopCurrency: context.storeCurrency || "",
            paymentMethod: payMethodNow,
            prepaidOffer: prepaidOfferNow,
          }));
          if (calculated && Number.isFinite(Number(calculated.total))) {
            quote = { status: "preview", key: quoteKey, shown: false, ...calculated };
            await safeUpsert({ orderQuote: quote });
          }
        } catch (error) {
          console.error("[checkout] Shopify quote failed:", String(error.message).slice(0, 500));
        }
      }
      const total = quote?.total ?? pricing.totalAfterCoupon;
      const tax = quote?.tax;
      const currency = quote?.currency || pricing.currency;
      const discounts = quote?.discountAmount ?? pricing.couponDiscountAmount;
      const shipCostVal = quote?.shippingCost ?? pricing.shippingCost;
      const selectedPayLabel =
        session.selectedPaymentMethod === "cod"
          ? "Cash on Delivery"
          : session.selectedPaymentMethod === "prepaid"
            ? "Online Payment"
            : "";
      await safeUpsert({
        step: session.billingNeedsUpdate
          ? "billing_inquiry"
          : validAddress
            ? "ready"
            : "address",
        finalTotal: total,
        lastCartSnapshot: cart,
      });

      // Same preview already on screen and nothing changed: do not show it again.
      const lastAssistantText =
        [...history].reverse().find((turn) => turn.role === "assistant")?.content || "";
      const asksToSeeAgain =
        opts.force ||
        wantsOrderPreview(userMessage, lastAssistantText) ||
        /\b(?:review|preview|summary|recap)\b/i.test(userMessage);
      const cardThisTurn = actions.some((a) => a.type === "checkout_ready");
      const alreadyShown =
        Boolean(quote?.shown) && quote.key === quoteKey && !asksToSeeAgain && !cardThisTurn;
      const wantsCard = validAddress && !session.billingNeedsUpdate && !alreadyShown;

      if (wantsCard || !validAddress) {
        // Never two previews in one turn: a later call replaces an earlier card.
        for (let i = actions.length - 1; i >= 0; i--)
          if (actions[i].type === "checkout_ready") actions.splice(i, 1);
        actions.push({
          type: "checkout_ready",
          cart,
          items: cart.items,
          shipping,
          billing,
          billingSameAsShipping: session.billingSameAsShipping !== false,
          email,
          shippingMethod: pricing.shippingMethod,
            shippingRate: pricing.shippingRate,
          shippingCost: shipCostVal,
          originalTotal: quote ? Number(((quote.subtotal || 0) + (quote.discountAmount || 0)).toFixed(2)) : pricing.rawSubtotal,
          discountedSubtotal: quote?.subtotal ?? pricing.discountedSubtotal,
          discountAmount: discounts,
          breakdown: quote ? breakdownRows(quote).rows : null,
          unitemizedTax: quote?.unitemizedTax || 0,
          priceNotice: quote?.priceDiffersFromStorefront ? { shopifySubtotal: quote.subtotal, storefrontSubtotal: quote.storefrontSubtotal } : null,
          paymentMethod: payMethodNow || null,
          appliedDiscount: pricing.appliedDiscount,
          total,
          tax: tax ?? null,
          taxLines: quote?.taxLines || [],
          taxesIncluded: Boolean(quote?.taxesIncluded),
          otherCharges: quote?.otherCharges || 0,
          currency,
          ready: validAddress,
        });
        if (quote?.status === "preview" && wantsCard)
          await safeUpsert({ orderQuote: { ...quote, shown: true } });
      }

      const totalLabel = formatPriceLabel(total, currency);
      // Shopify's tax figure can include duties it did not itemize. The note names only the itemized tax and says so
      // for the rest, the same split the final order shows, so the total never changes its story between steps.
      const unitemized = Number(quote?.unitemizedTax) > 0 ? Number(quote.unitemizedTax) : 0;
      const extraTax = Number((unitemized + (Number(quote?.otherCharges) > 0 ? Number(quote.otherCharges) : 0)).toFixed(2));
      const itemizedTax = tax != null ? Number((Number(tax) - unitemized).toFixed(2)) : null;
      const taxNote =
        tax != null
          ? isHindi
            ? ` (tax ${formatPriceLabel(itemizedTax, currency)} ke saath${extraTax ? `, aur Shopify ka joda hua ${formatPriceLabel(extraTax, currency)} duty/tax` : ""})`
            : ` including ${formatPriceLabel(itemizedTax, currency)} tax${extraTax ? ` and ${formatPriceLabel(extraTax, currency)} of other duties Shopify added` : ""}`
          : "";
      ctx.fallbackSpeech = session.billingNeedsUpdate
        ? isHindi
          ? "Order se pehle poora billing address bata do."
          : "Please share your full billing address before ordering."
        : !validAddress
          ? isHindi
            ? "Order se pehle delivery/contact ki missing details confirm kar do."
            : "Please confirm the missing delivery/contact details before ordering."
          : session.selectedPaymentMethod
            ? isHindi
              ? `Tumhara payable total **${totalLabel}**${taxNote} hai, payment **${selectedPayLabel}**. Kya order place kar doon?`
              : `Your payable total is **${totalLabel}**${taxNote}, paying by **${selectedPayLabel}**. Shall I place the order?`
            : isHindi
              ? `Order preview upar hai. Payable total **${totalLabel}**${taxNote} hai. **Cash on Delivery** chahoge ya **online payment**?`
              : `Your order preview is above, payable total **${totalLabel}**${taxNote}. Would you like **Cash on Delivery** or **online payment**?`;
      if (validAddress && !session.billingNeedsUpdate) ctx.fallbackSpeech += quoteNotes(quote, isHindi, shipping.country || shipping.countryCode || "");
      return {
        status: validAddress ? "ok" : "incomplete_address",
        step: session.billingNeedsUpdate
          ? "billing_inquiry"
          : validAddress
            ? "review"
            : "address",
        item_count: cart.items.length,
        items: cart.items,
        originalSubtotal: pricing.rawSubtotal,
        appliedCoupon: pricing.appliedDiscount,
        discountAmount: discounts,
        shippingMethod: pricing.shippingMethod,
            shippingRate: pricing.shippingRate,
        shippingCost: shipCostVal,
        tax: tax ?? null,
        total,
        currency,
        shipping,
        billing,
        email,
        phone: shipping.phone || session.customer?.phone || "",
        selectedPaymentMethod: session.selectedPaymentMethod || null,
        orderReviewText: ctx.fallbackSpeech,
        breakdown: quote ? breakdownRows(quote) : null,
        previewShownAsCard: wantsCard || alreadyShown,
      };
    },

    // Answers any tax question from the numbers Shopify itself calculated for this checkout.
    get_tax_details: async () => {
      const session = await safeGet();
      const cart = context.cart || {};
      if (!cart.items?.length) {
        ctx.fallbackSpeech = isHindi
          ? "Abhi koi checkout khula nahi hai. Agar kisi placed order ka tax poochh rahe ho to order number bata do, main uski details dekh leti hoon."
          : "There is no open checkout right now. If you mean an order you already placed, tell me its order number and I'll look up its details.";
        return {
          status: "cart_empty",
          note: "No checkout is open (the cart is empty, for example right after an order was placed). Do NOT say an address is missing or not saved. If the shopper means an order that was already placed, use the order number from this chat and call get_order_details for it; otherwise say there is no open checkout and offer to help find something.",
        };
      }
      let quote = ["preview", "review_required"].includes(session.orderQuote?.status) ? session.orderQuote : null;
      const shipping = deduplicateAddress(session.shipping || {});
      if (quote?.status === "preview") {
        // A stored quote only counts while it still matches the cart, address, shipping and payment choice.
        const p0 = computeOrderPricing(cart, session, storeCurrency);
        const o0 = session.selectedPaymentMethod === "prepaid" ? await prepaidOffer(storeId, p0.discountedSubtotal).catch(() => null) : null;
        const b0 = session.billingSameAsShipping !== false ? shipping : deduplicateAddress(session.billing || {});
        if (quote.key !== previewQuoteKey({ cart, shipping, billing: b0, session, pricing: p0, prepaid: prepaidDiscountInput(o0) })) quote = null;
      }
      if (!quote && shipping.address1 && shipping.city && shipping.zip && shipping.name) {
        const pricing = computeOrderPricing(cart, session, storeCurrency);
        const billing = session.billingSameAsShipping !== false ? shipping : session.billing;
        const offerNow = session.selectedPaymentMethod === "prepaid" ? await prepaidOffer(storeId, pricing.discountedSubtotal).catch(() => null) : null;
        try {
          const calculated = await withQuoteTimeout(quoteOrder(storeId, {
            items: cart.items,
            shipping: session.shipping,
            billing,
            billingSameAsShipping: session.billingSameAsShipping !== false,
            email: shipping.email || session.customer?.email || "",
            shippingMethod: pricing.shippingMethod,
            shippingRate: pricing.shippingRate,
            appliedDiscount: pricing.appliedDiscount,
            currency: pricing.currency,
            countryCode: context.cart?.country || "",
            shopCurrency: context.storeCurrency || "",
            paymentMethod: session.selectedPaymentMethod || "",
            prepaidOffer: offerNow,
          }));
          quote = { status: "preview", key: previewQuoteKey({ cart, shipping, billing: session.billingSameAsShipping !== false ? shipping : deduplicateAddress(session.billing || {}), session, pricing, prepaid: prepaidDiscountInput(offerNow) }), shown: false, ...calculated };
        } catch (error) {
          console.error("[checkout] Shopify tax quote failed:", String(error.message).slice(0, 500));
        }
      }
      if (!quote) {
        ctx.fallbackSpeech = isHindi
          ? "Tax delivery address par depend karta hai. Delivery address bata do, phir Shopify se exact tax nikaal ke bata dungi."
          : "Tax depends on the delivery address. Share it and I'll get the exact tax Shopify calculates.";
        return { status: "address_needed", note: "Tax is calculated by Shopify from the delivery address. No address yet, so no tax figure exists." };
      }
      const destination = [shipping.city, shipping.province, shipping.country].filter(Boolean).join(", ");
      const table = breakdownRows(quote);
      const money = (v) => formatPriceLabel(Math.abs(v), quote.currency);
      const arithmetic = table.rows
        .map((r, i) => `${i === 0 ? "" : r.amount < 0 ? "- " : "+ "}${money(r.amount)} (${r.label})`)
        .join(" ") + ` = ${money(table.total)}`;
      return {
        status: "ok",
        currency: quote.currency,
        paymentMethod: session.selectedPaymentMethod || null,
        rows: table.rows.map((r) => ({ label: r.label, amount: r.amount, formatted: (r.amount < 0 ? "-" : "") + money(r.amount) })),
        arithmetic,
        rowsAddUpToTotal: table.reconciles,
        itemsSubtotalAfterDiscounts: quote.subtotal,
        discountAmount: quote.discountAmount,
        shippingCost: quote.shippingCost,
        totalTax: quote.tax,
        taxLines: quote.taxLines || [],
        itemizedTax: quote.itemizedTax,
        taxNotItemizedByShopify: quote.unitemizedTax || 0,
        impliedTaxPercentOfOrder: quote.impliedTaxRatePercent,
        taxLooksHigherThanListedRate: Boolean(quote.taxLooksUnusual),
        taxesIncludedInPrices: Boolean(quote.taxesIncluded),
        otherChargesInTotal: quote.otherCharges || 0,
        payableTotal: quote.total,
        storefrontCartSubtotal: quote.storefrontSubtotal ?? null,
        shopifyPricesItemsDifferentlyThanStorefront: Boolean(quote.priceDiffersFromStorefront),
        taxedForDestination: destination,
        instruction_for_ai:
          "Answer ONLY from `rows`, `arithmetic` and the fields above; never compute, estimate or 'correct' a number yourself, and never subtract one figure from another to invent a new one. Each row is a real Shopify figure and the rows add up to payableTotal. If the shopper expects a different total, show them the arithmetic row by row and say which row differs from what they expected. Never call an amount 'shipping' unless the Shipping row says so, and never give a reason for a figure that is not in this data. If taxNotItemizedByShopify > 0, say plainly that Shopify added that extra tax/duty without itemizing it and the store owner can explain it. If taxLooksHigherThanListedRate is true, say the tax is about impliedTaxPercentOfOrder% of the order, higher than the listed rate, and offer to let the shopper decide whether to continue. If shopifyPricesItemsDifferentlyThanStorefront is true, say Shopify prices the items at itemsSubtotalAfterDiscounts for this destination while the storefront cart showed storefrontCartSubtotal. Say Shopify calculates tax from the store's tax settings for the delivery address.",
      };
    },

    set_shipping_method: async (args) => {
      let session = await safeGet();
      if (!session?.shipping?.address1) return handlers.get_shipping_options();
      const rates = await ensureShippingRates(session);
      session = await safeGet();
      const wanted = String(args?.shippingRate || args?.shippingMethod || "").trim();
      const rate = findShippingRate(rates, wanted);
      if (!rate) {
        ctx.fallbackSpeech = isHindi
          ? `Ye shipping option is address ke liye available nahi hai. Available: ${rates.map((r) => r.title).join(", ") || "koi nahi"}.`
          : `That shipping option isn't available for this address. Available: ${rates.map((r) => r.title).join(", ") || "none"}.`;
        return { status: "not_found", requested: wanted, available: rates.map((r) => r.title) };
      }
      const chosenMethod = rate.title;
      const cart = context.cart || {};
      session.shippingRate = rate;
      localSession.shippingRate = rate;
      session.shippingMethod = chosenMethod;
      localSession.shippingMethod = chosenMethod;

      const pricing = computeOrderPricing(cart, session, storeCurrency);
      const cur = pricing.currency;
      const baseTotal = pricing.totalAfterCoupon;
      const offer = await prepaidOffer(storeId, baseTotal);

      await safeUpsert({
        shippingMethod: chosenMethod,
        shippingRate: rate,
        shippingCost: pricing.shippingCost,
        step: session?.shipping?.address1 ? "ready" : "address",
        discountAmount: pricing.couponDiscountAmount,
        finalTotal: baseTotal,
      });

      if (session?.shipping?.address1 && actions.length < 8) {
        actions.push({
          type: "checkout_ready",
          cart,
          shipping: session.shipping,
          billing: session.billing || session.shipping,
          billingSameAsShipping: Boolean(session.billingSameAsShipping ?? true),
          email: session.shipping.email || session.customer?.email || "",
          shippingMethod: chosenMethod,
          shippingCost: pricing.shippingCost,
          shippingLabel: pricing.shippingLabel,
          originalTotal: pricing.rawSubtotal,
          discountedSubtotal: pricing.discountedSubtotal,
          total: baseTotal,
          discountAmount: pricing.couponDiscountAmount,
          totalSavings: pricing.totalSavings,
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

      const origStr = formatPriceLabel(pricing.rawSubtotal, cur);
      const subStr = formatPriceLabel(pricing.discountedSubtotal, cur);
      const shipStr =
        pricing.shippingCost > 0
          ? formatPriceLabel(pricing.shippingCost, cur)
          : "FREE";
      const totalStr = formatPriceLabel(baseTotal, cur);
      const discStr = formatPriceLabel(pricing.couponDiscountAmount, cur);

      const breakdownHi =
        pricing.hasCoupon && pricing.couponDiscountAmount > 0
          ? `• Original Price: **${origStr}**\n• Discount (**${pricing.appliedDiscount.code}**): **-${discStr}**\n• Subtotal: **${subStr}**\n• Shipping (${chosenMethod}): **${shipStr}**\n• **Final Total: ${totalStr}** (Total Savings: **${discStr}**)`
          : `• Subtotal: **${subStr}**\n• Shipping (${chosenMethod}): **${shipStr}**\n• **Final Total: ${totalStr}**`;

      const breakdownEn =
        pricing.hasCoupon && pricing.couponDiscountAmount > 0
          ? `• Original Price: **${origStr}**\n• Discount (**${pricing.appliedDiscount.code}**): **-${discStr}**\n• Subtotal: **${subStr}**\n• Shipping (${chosenMethod}): **${shipStr}**\n• **Final Total: ${totalStr}** (Total Savings: **${discStr}**)`
          : `• Subtotal: **${subStr}**\n• Shipping (${chosenMethod}): **${shipStr}**\n• **Final Total: ${totalStr}**`;

      ctx.fallbackSpeech = isHindi
        ? `Done dost! Maine **${pricing.shippingLabel}** select kar diya hai.\n${breakdownHi}\n\nBatao yaar, ab payment kaise karna chahoge — **Cash on Delivery (COD)** ya **Prepaid (Online payment)**?`
        : `Done! I've selected **${pricing.shippingLabel}** for your order.\n${breakdownEn}\n\nHow would you like to pay — **Cash on Delivery (COD)** or **Prepaid (Online payment)**?`;

      return {
        status: "ok",
        shippingMethod: chosenMethod,
        shippingCost: pricing.shippingCost,
        shippingLabel: pricing.shippingLabel,
        originalSubtotal: pricing.rawSubtotal,
        discountedSubtotal: pricing.discountedSubtotal,
        discountAmount: pricing.couponDiscountAmount,
        total: baseTotal,
        formattedTotal: totalStr,
        currency: cur,
      };
    },

    place_order: async (args = {}) => {
      const session = await safeGet();
      if (billingRelationshipIntent(userMessage) === "different")
        return handlers.request_billing_update();
      const explicitChoice = paymentChoice(userMessage);
      if (explicitChoice) {
        session.selectedPaymentMethod = explicitChoice;
        await safeUpsert({ selectedPaymentMethod: explicitChoice });
      }
      const cart = context.cart;
      if (!cart?.items?.length) {
        if (session.lastOrderResult?.shopifyOrderId && session.lastOrderResult?.orderName) {
          const prev = session.lastOrderResult;
          const prevOrderId = prev.orderName;
          const prevTotal = formatPriceLabel(prev.total, prev.currency || storeCurrency);
          ctx.fallbackSpeech = isHindi
            ? `Tumhara order **${prevOrderId}** pehle hi Shopify mein successfully place ho chuka hai (Total: **${prevTotal}**)!`
            : `Your order **${prevOrderId}** has already been confirmed in Shopify (Total: **${prevTotal}**)!`;
          return { ...prev, orderId: prevOrderId, replayed: true };
        }
        ctx.fallbackSpeech = isHindi
          ? "Cart khali hai. Pehle product add karo."
          : "Your cart is empty. Add a product first.";
        return { status: "empty_cart" };
      }
      const cartKey = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            token: cart.token || "",
            items: cart.items
              .map((item) => [
                String(item.variant_id || item.variantId || item.id || "")
                  .split("/")
                  .pop(),
                Number(item.quantity),
                Number(item.original_price ?? item.price),
              ])
              .sort((a, b) => a[0].localeCompare(b[0])),
          }),
        )
        .digest("hex");
      const isReplayedOrder =
        session.lastOrderCartKey === cartKey &&
        Boolean(session.lastOrderResult?.shopifyOrderId);
      if (isReplayedOrder && !session?.shipping?.address1 && session.lastOrderResult?.shipping) {
        session.shipping = session.lastOrderResult.shipping;
        session.billing = session.lastOrderResult.billing || session.lastOrderResult.shipping;
      }
      if (
        !session?.shipping?.address1 ||
        !session?.shipping?.city ||
        session.shippingNeedsUpdate ||
        !validContactPhone(
          session.shipping.phone,
          session.shipping.countryCode || session.shipping.country,
        )
      ) {
        ctx.fallbackSpeech = isHindi
          ? "Order se pehle delivery address aur complete phone number confirm karo."
          : "Please confirm the complete delivery address and phone number before ordering.";
        const cp = contactProblems({
          email: session.shipping?.email || session.customer?.email,
          phone: session.shipping?.phone,
          country: session.shipping?.countryCode || session.shipping?.country,
        });
        if (cp.length) ctx.fallbackSpeech = contactProblemMessage(cp, isHindi);
        return { status: "missing_address" };
      }
      {
        // Email and phone are mandatory and must be valid; never place an order without them.
        const cp = contactProblems({
          email: session.shipping?.email || session.customer?.email,
          phone: session.shipping?.phone,
          country: session.shipping?.countryCode || session.shipping?.country,
        });
        if (cp.length) {
          ctx.fallbackSpeech = contactProblemMessage(cp, isHindi);
          return { status: "invalid_contact", problems: cp.map((p) => p.field) };
        }
      }
      if (
        session.billingNeedsUpdate ||
        (session.billingSameAsShipping === false &&
          (!session.billing?.address1 ||
            !session.billing?.city ||
            !session.billing?.zip))
      ) {
        ctx.fallbackSpeech = isHindi
          ? "Order se pehle tumhara alag billing address complete kar lete hain. Poora billing address bata do."
          : "Let's finish your separate billing address before ordering. Please share the full billing address.";
        return { status: "missing_billing_address" };
      }
      const lastAssistantMsg =
        [...(history || [])].reverse().find((h) => h.role === "assistant" && h.content)?.content || "";
      let assistantImpliedPayment = "";
      if (
        !llmMode &&
        !/\b(?:cod|cash\s+on\s+delivery)\b.*\b(?:or|ya)\b.*\b(?:online|prepaid)\b|\b(?:online|prepaid)\b.*\b(?:or|ya)\b.*\b(?:cod|cash\s+on\s+delivery)\b/i.test(
          lastAssistantMsg,
        )
      ) {
        if (/\b(?:cash\s+on\s+delivery|cod)\b/i.test(lastAssistantMsg)) {
          assistantImpliedPayment = "cod";
        } else if (/\b(?:online\s+payment|prepaid)\b/i.test(lastAssistantMsg)) {
          assistantImpliedPayment = "prepaid";
        }
      }
      const effectiveStep =
        session.step === "cart" && session.shipping?.address1 && (session.billing?.address1 || session.billingSameAsShipping !== false)
          ? "ready"
          : session.step;
      let paymentMethod =
        explicitChoice ||
        session.selectedPaymentMethod ||
        (confirmsOrder(userMessage, effectiveStep) ? assistantImpliedPayment : "");
      if (!paymentMethod && session.orderQuote?.status === "review_required")
        paymentMethod = "cod";
      if (paymentMethod && paymentMethod !== session.selectedPaymentMethod) {
        session.selectedPaymentMethod = paymentMethod;
        await safeUpsert({ selectedPaymentMethod: paymentMethod });
      }
      if (!confirmsOrder(userMessage, effectiveStep)) {
        if (paymentMethod === "cod" || paymentMethod === "prepaid") {
          const pricingNow = computeOrderPricing(cart, session, storeCurrency);
          const offerNow =
            paymentMethod === "prepaid"
              ? await prepaidOffer(storeId, pricingNow.discountedSubtotal).catch(() => null)
              : null;
          const shipNow = deduplicateAddress(session.shipping || {});
          const keyNow = previewQuoteKey({
            cart,
            shipping: shipNow,
            billing: session.billingSameAsShipping !== false ? shipNow : deduplicateAddress(session.billing || {}),
            session,
            pricing: pricingNow,
            prepaid: prepaidDiscountInput(offerNow),
          });
          const quotedTotal =
            session.orderQuote?.status === "preview" && session.orderQuote.key === keyNow
              ? Number(session.orderQuote.total)
              : null;
          const discounted = paymentMethod === "prepaid" && offerNow?.hasDiscount;
          const knownTotal =
            quotedTotal ?? (discounted ? offerNow.prepaidTotal : pricingNow.totalAfterCoupon);
          const beforeTax = quotedTotal == null;
          const methodLabel = paymentMethod === "cod" ? "Cash on Delivery" : "Online Payment";
          const totalLabelNow = formatPriceLabel(knownTotal, pricingNow.currency);
          ctx.fallbackSpeech = isHindi
            ? `Theek hai, **${methodLabel}** select kar liya. ${discounted ? "Prepaid discount ke baad " : ""}Payable total **${totalLabelNow}**${beforeTax ? " (tax se pehle)" : " (tax ke saath)"}. ${paymentMethod === "cod" ? "Order place kar doon?" : "Payment link bana doon?"}`
            : `Got it, **${methodLabel}** it is. ${discounted ? "With the prepaid discount, the" : "The"} payable total is **${totalLabelNow}**${beforeTax ? " before tax" : " including tax"}. ${paymentMethod === "cod" ? "Shall I place the order?" : "Shall I create the payment link?"}`;
          return { status: "confirmation_required", selectedPaymentMethod: paymentMethod, payableTotal: knownTotal };
        }
        ctx.fallbackSpeech = isHindi
          ? "Kya is order ko confirm karoon? Cash on Delivery (COD) ya online payment bata do."
          : "Shall I confirm this order? Let me know whether you'd like Cash on Delivery (COD) or online payment.";
        return { status: "confirmation_required" };
      }
      if (!["cod", "prepaid"].includes(paymentMethod)) {
        ctx.fallbackSpeech = isHindi
          ? "Cash on Delivery (COD) ya online payment, kaunsa chahiye?"
          : "Would you like Cash on Delivery (COD) or online payment?";
        return { status: "payment_method_required" };
      }
      {
        const rates = await ensureShippingRates(session);
        // Switching the rate at the moment of ordering changes the total, so it is honoured only when
        // the shopper's own words name that Shopify rate (rate titles are store data, not a word list).
        const candidate = args.shippingMethod ? findShippingRate(rates, args.shippingMethod) : null;
        const override =
          candidate && (shopifyService.keywordsNamedByShopper?.([candidate.title], userMessage) || []).length > 0
            ? candidate
            : null;
        if (override && override.handle !== session.shippingRate?.handle) {
          session.shippingRate = override;
          session.shippingMethod = override.title;
          await safeUpsert({ shippingRate: override, shippingMethod: override.title, shippingCost: override.price });
        } else {
          Object.assign(session, await safeGet());
        }
      }
      const pricing = computeOrderPricing(cart, session, storeCurrency);
      const email = String(
        session.shipping.email ||
          session.customer?.email ||
          context.customer?.email ||
          historyCustomer.email ||
          "",
      ).trim();
      const billing =
        session.billingSameAsShipping !== false
          ? session.shipping
          : session.billing;
      const confirmingQuote = confirmsOrder(userMessage, effectiveStep);
      // The total Shopify already calculated for the (single) preview. Using it as the expected
      // total means a matching draft goes straight through instead of asking for another review.
      const previewShipping = deduplicateAddress(session.shipping || {});
      const prepaidOfferForOrder =
        paymentMethod === "prepaid"
          ? await prepaidOffer(storeId, pricing.discountedSubtotal).catch(() => null)
          : null;
      const previewKeyNow = previewQuoteKey({
        cart,
        shipping: previewShipping,
        billing: session.billingSameAsShipping !== false ? previewShipping : deduplicateAddress(session.billing || {}),
        session,
        pricing,
        prepaid: prepaidDiscountInput(prepaidOfferForOrder),
      });
      const previewTotalForOrder =
        session.orderQuote?.status === "preview" && session.orderQuote.key === previewKeyNow
          ? Number(session.orderQuote.total)
          : null;
      let created = isReplayedOrder
        ? { ...session.lastOrderResult, replayed: true }
        : null;
      try {
        if (!created) {
          const offer = prepaidOfferForOrder;
          created = await submitOrder(storeId, {
            items: cart.items,
            shipping: session.shipping,
            billing,
            billingSameAsShipping: session.billingSameAsShipping !== false,
            email,
            paymentMethod,
            shippingMethod: pricing.shippingMethod,
            shippingRate: pricing.shippingRate,
            appliedDiscount: pricing.appliedDiscount,
            prepaidOffer: offer?.hasDiscount ? offer : undefined,
            finalTotal: previewTotalForOrder ?? pricing.totalAfterCoupon,
            currency: pricing.currency,
            countryCode: context.cart?.country || "",
            shopCurrency: context.storeCurrency || "",
            customerId: context.verifiedCustomerId || null,
            clientId: context.clientId,
            chatRef: chatRefFor(storeId, context.clientId),
            cartToken: cart.token,
            checkoutAttemptId: session.checkoutAttemptId,
            acceptedQuoteKey: confirmingQuote
              ? session.orderQuote?.quoteKey
              : undefined,
            customerNotes: args.customerNotes,
          });
        }
      } catch (error) {
        console.error("[place_order] Shopify checkout failed:", {
          code: error.code || error.name,
          shop: storeId,
          message: String(error.message).slice(0, 1000),
          uncertain: Boolean(error.uncertain),
        });
        ctx.fallbackSpeech = checkoutFailureMessage(error, lang);
        const reason = checkoutFailureReason(error);
        return {
          status: "error",
          shopifyOrderCreated: false,
          reason,
          facts: checkoutFailureFacts(reason),
          instruction_for_ai: "The order was NOT placed. Explain these facts to the customer warmly in your own words and say what happens next. Never say the order was placed.",
          verified_reply_facts: ctx.fallbackSpeech,
        };
      }
      if (created.status === "review_required") {
        // Safety net only: Shopify's order total differs from the quote the shopper already saw.
        // No second preview card; say what changed and ask once.
        await safeUpsert({
          orderQuote: created,
          step: "review",
          selectedPaymentMethod: paymentMethod,
        });
        const total = formatPriceLabel(created.total, created.currency);
        const before = previewTotalForOrder ?? pricing.totalAfterCoupon;
        const taxPart = created.tax > 0 ? ` (tax ${formatPriceLabel(created.tax, created.currency)} included)` : "";
        ctx.fallbackSpeech = isHindi
          ? `Shopify ne final total **${total}**${taxPart} nikala hai, jo pehle ke **${formatPriceLabel(before, created.currency)}** se alag hai. Is total par Cash on Delivery order confirm karoon?`
          : `Shopify's final total is **${total}**${taxPart}, which differs from the **${formatPriceLabel(before, created.currency)}** shown earlier. Shall I place the Cash on Delivery order at this total?`;
        return created;
      }
      if (created.status === "payment_required") {
        await safeUpsert({ paymentUrl: created.checkoutUrl, step: "ready" });
        actions.push({
          type: "checkout_redirect",
          url: created.checkoutUrl,
          checkoutUrl: created.checkoutUrl,
          paymentRequired: true,
        });
        // Name the discount for what it is: the shopper's code (CHAT20), the store's prepaid offer, or both. A real run called a
        // CHAT20 saving a "prepaid discount" (2026-11-21).
        const codeName = String(pricing.appliedDiscount?.code || "").trim();
        const prepaidApplied = Boolean(prepaidOfferForOrder?.hasDiscount);
        const discLabel = codeName && prepaidApplied
          ? (isHindi ? `${codeName} aur prepaid discount` : `${codeName} and prepaid discount`)
          : codeName
            ? (isHindi ? `${codeName} discount` : `${codeName} discount`)
            : prepaidApplied ? (isHindi ? "prepaid discount" : "prepaid discount") : (isHindi ? "discount" : "discount");
        const discNote =
          created.discountAmount > 0
            ? isHindi
              ? ` (${discLabel} **-${formatPriceLabel(created.discountAmount, created.currency)}** lag chuka hai${created.tax > 0 ? `, total me tax aur duties ${formatPriceLabel(Number(created.tax) + (Number(created.otherCharges) || 0), created.currency)} shamil hain` : ""})`
              : ` (${discLabel} of **-${formatPriceLabel(created.discountAmount, created.currency)}** applied${created.tax > 0 ? `; the total includes ${formatPriceLabel(Number(created.tax) + (Number(created.otherCharges) || 0), created.currency)} of tax and duties` : ""})`
            : "";
        const where = isVerifiedLoggedIn
          ? (isHindi ? "Shopify aur tumhare account mein" : "in Shopify and your account")
          : (isHindi ? "Shopify mein aur confirmation email par" : "in Shopify and in your confirmation email");
        ctx.fallbackSpeech = isHindi
          ? `Online payment ke liye Shopify ka secure link kholo: [Pay ${formatPriceLabel(created.total, created.currency)}](${created.checkoutUrl})${discNote}. Payment complete hone par order ${where} dikhega.`
          : `Complete payment through Shopify: [Pay ${formatPriceLabel(created.total, created.currency)}](${created.checkoutUrl})${discNote}. Your order will appear ${where} after payment.`;
        return created;
      }
      if (
        !created.shopifyOrderCreated ||
        !created.shopifyOrderId ||
        !created.orderName
      ) {
        ctx.fallbackSpeech = isHindi
          ? "Shopify ka order response abhi confirm nahi hua. Cart save hai. Dobara order dene se pehle thoda wait karke check karo."
          : "Shopify has not confirmed this checkout yet. Your cart is saved. Wait and check the order status before submitting again.";
        return created;
      }
      const orderId = created.orderName;
      paymentMethod = created.paymentMethod || paymentMethod;
      const confirmedShippingMethod =
        created.shippingMethod || pricing.shippingMethod;
      const confirmedShipping = session.shipping;
      const confirmedBilling = billing;
      await safeUpsert({
        step: "cart",
        orderId,
        shopifyOrderId: created.shopifyOrderId,
        orderQuote: null,
        lastOrderCartKey: cartKey,
        lastOrderResult: {
          ...created,
          paymentMethod,
          shippingMethod: confirmedShippingMethod,
          shipping: confirmedShipping,
          billing: confirmedBilling,
        },
        paymentMethod: null,
        selectedPaymentMethod: null,
        paymentUrl: null,
        appliedDiscount: null,
        discountAmount: 0,
        discountClearedAfterOrder: true,
        finalTotal: null,
        shippingMethod: "standard",
        shippingCost: 0,
        ...(isVerifiedLoggedIn
          ? {}
          : {
              // kept apart (not used on its own): the next order in this chat can reuse it when the shopper says so
              lastOrderShipping: confirmedShipping?.address1 ? { ...confirmedShipping } : null,
              shipping: null,
              billing: null,
              billingSameAsShipping: null,
              shippingConfirmed: false,
              billingConfirmed: false,
              shippingNeedsUpdate: false,
              billingNeedsUpdate: false,
              shippingSource: null,
              customer: null,
              guestDetailsClearedAfterOrder: true,
            }),
      });
      let emailSent = false;
      let emailPending = false;
      if (!created.replayed) {
        // The order is already in Shopify. The email must not hold the reply up: wait a short moment
        // for the mail server, and if it is slower the reply says the email is on its way and the
        // real result is logged when it arrives.
        const mailJob = Promise.resolve()
          .then(() => sendConfirmation({
            to: email,
            orderId,
            paymentMethod,
            shippingMethod: confirmedShippingMethod,
            shippingCost: created.shippingCost,
            tax: created.tax,
            taxLines: created.taxLines || [],
            otherCharges: created.otherCharges || 0,
            total: created.total,
            originalTotal: pricing.rawSubtotal,
            discountedSubtotal: created.subtotal ?? pricing.rawSubtotal - created.discountAmount,
            currency: created.currency,
            items: cart.items,
            shipping: confirmedShipping,
            billing: confirmedBilling,
            billingSameAsShipping: session.billingSameAsShipping !== false,
            discountCode: pricing.appliedDiscount?.code || "",
            discountAmount: created.discountAmount,
            discountPercent:
              pricing.rawSubtotal > 0
                ? (created.discountAmount / pricing.rawSubtotal) * 100
                : 0,
            shopName: storeId,
          }))
          .then((mail) => ({ ok: Boolean(mail?.ok), error: mail?.error }))
          .catch((mailError) => ({ ok: false, error: String(mailError?.message || mailError).slice(0, 200) }));
        const reportMail = (result) => {
          if (!result.ok) console.warn(`[email] order confirmation for ${orderId} NOT sent: ${result.error || "unknown reason"}`);
        };
        let waitTimer;
        const first = await Promise.race([
          mailJob,
          new Promise((resolve) => { waitTimer = setTimeout(() => resolve(null), EMAIL_WAIT_MS); }),
        ]);
        clearTimeout(waitTimer);
        if (first) {
          emailSent = first.ok;
          reportMail(first);
        } else {
          emailPending = true;
          mailJob.then(reportMail);
        }
      } else {
        console.log(`[email] order ${orderId} was already placed (repeat request): confirmation not sent again.`);
      }
      actions.push({
        type: "order_placed",
        ...created,
        orderId,
        paymentMethod,
        shippingMethod: confirmedShippingMethod,
        shipping: confirmedShipping,
        billing: confirmedBilling,
        recipientEmail: email,
        emailSent,
        emailPending,
        cart,
      });
      actions.push({ type: "clear_cart", afterOrder: true, silent: true });
      const emailNote = emailSent
        ? isHindi
          ? ` Confirmation email **${email}** par bhej di hai.`
          : ` A confirmation email was sent to **${email}**.`
        : emailPending
          ? isHindi
            ? ` Confirmation email **${email}** par bheji ja rahi hai.`
            : ` A confirmation email is on its way to **${email}**.`
          : "";
      const paymentNote =
        paymentMethod === "cod"
          ? isHindi
            ? "Delivery par payment karna hai (Cash on Delivery)."
            : "Payable on delivery (Cash on Delivery)."
          : created.financialStatus === "PAID"
            ? isHindi
              ? "Online payment Shopify ne confirm kar diya hai."
              : "Shopify has confirmed your online payment."
            : isHindi
              ? "Payment abhi pending hai."
              : "Payment is still pending.";
      // The Order Placed card carries items, address and the full breakdown, so the text is short.
      // Every number comes from the Shopify order itself (same values as the card and the email).
      const orderTotalLabel = formatPriceLabel(created.total, created.currency);
      // Everything in the total is named: the tax AND the duties/other charges Shopify added (a real confirmation said "including ₹8,673.3
      // tax" while ₹6,285 of duties were also in the total, 2026-11-21). Same split as the Order Placed card and the email.
      const orderUnitemized = Number(created.unitemizedTax) > 0 ? Number(created.unitemizedTax) : 0;
      const orderExtra = Number((orderUnitemized + (Number(created.otherCharges) > 0 ? Number(created.otherCharges) : 0)).toFixed(2));
      const orderItemizedTax = Number((Number(created.tax || 0) - orderUnitemized).toFixed(2));
      const orderTaxNote =
        Number(created.tax) > 0 || orderExtra > 0
          ? isHindi
            ? ` (tax ${formatPriceLabel(orderItemizedTax, created.currency)}${orderExtra ? ` aur ${formatPriceLabel(orderExtra, created.currency)} duties/other charges jo Shopify ne jode` : ""} ke saath)`
            : ` including ${formatPriceLabel(orderItemizedTax, created.currency)} tax${orderExtra ? ` and ${formatPriceLabel(orderExtra, created.currency)} of duties/other charges Shopify added` : ""}`
          : "";
      ctx.fallbackSpeech = isHindi
        ? `Tumhara order **${orderId}** Shopify mein place ho gaya hai! Total **${orderTotalLabel}**${orderTaxNote}. ${paymentNote}${emailNote}`
        : `Your order **${orderId}** is confirmed in Shopify! Total **${orderTotalLabel}**${orderTaxNote}. ${paymentNote}${emailNote}`;
      return {
        ...created,
        orderId,
        emailSent,
        orderConfirmationText: ctx.fallbackSpeech,
      };
    },
  };
}
