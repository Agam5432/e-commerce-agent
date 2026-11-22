// Starting checkout, prepaid offers and discount codes, calls with the store team, warranty and policies.
// Tool handlers of the shopping session (see createSession in ../../ecommerce.js), moved here unchanged:
// what they share with the session comes in `ctx`; values the session changes are read through it.
// Tools: begin_checkout, check_prepaid_discount, get_discounts_and_offers, apply_discount_or_offer, get_call_slots, book_call, flag_for_owner, get_warranty_and_policy.
import { bookingEnabled, audioCallEnabled, liveSupportEnabled, recordingAllowed } from "../../../services/bookingSettings.js";
import { supportCapabilities } from "../../../services/supportService.js";
import { describeLocal } from "../../../services/bookingTime.js";
import { deduplicateAddress } from "../../../services/shippingAddressService.js";
import { computeOrderPricing, withQuoteTimeout } from "../pricing.js";
import { formatPriceLabel } from "../replies.js";
import { assessDiscountOnCart, getProductDiscountsAndOffers, getProductWarrantyAndPolicy } from "../shared.js";
import crypto from "node:crypto";
import { markHandoff, openComplaintForChat } from "../../../services/complaintService.js";

export function offersHandlers(ctx) {
  const { actions, bookings, context, markPersonRequest, ensureShippingRates, handlers, isHindi, lang, loadDiscounts, localSession, orderJustPlacedReply, paymentChoice, prepaidOffer, quoteOrder, safeGet, safeUpsert, storeCurrency, storeId, userMessage } = ctx;
  return {

    begin_checkout: async () => {
      const cart = context.cart;
      const count = cart?.item_count ?? cart?.items?.length ?? 0;
      if (!count) {
        const done = await orderJustPlacedReply();
        if (done) return done;
        ctx.fallbackSpeech = isHindi
          ? "Yaar, tumhara cart abhi khali hai! Pehle kuch pasandida items cart mein add kar lete hain."
          : "Your cart is currently empty! Let's add something you love before checking out.";
        return { status: "empty_cart" };
      }
      const session = await safeGet();
      if (
        !session.checkoutAttemptId ||
        (session.orderId && session.step === "cart")
      ) {
        await safeUpsert({
          checkoutAttemptId: crypto.randomUUID(),
          orderId: null,
          shopifyOrderId: null,
          orderQuote: null,
          paymentUrl: null,
          lastOrderCartKey: null,
          lastOrderResult: null,
        });
      }
      const pricing = computeOrderPricing(cart, session, storeCurrency);
      const isCustomerLoggedIn = Boolean(
        context.customerLoggedIn && context.customer,
      );

      if (isCustomerLoggedIn) {
        await safeUpsert({
          loggedIn: true,
          loginMethod: "shopify_customer",
          customer: {
            ...session.customer,
            id: context.customer.id,
            email: session.shipping?.email || context.customer.email,
            phone: session.shipping?.phone || context.customer.phone,
            name:
              session.shipping?.name ||
              context.customer.name ||
              context.customer.displayName,
          },
          lastCartSnapshot: cart,
        });
      }
      if (session.shippingNeedsUpdate) {
        ctx.fallbackSpeech = isHindi
          ? "Apna naya delivery address aur complete contact details batao; purana account address use nahi karungi."
          : "Please provide your updated delivery address and complete contact details. I'll use your checkout address instead of replacing it with the account default.";
        return { status: "address_update_required" };
      }

      const hasSavedShipping = Boolean(
        session?.shipping?.address1 && session?.shipping?.city,
      );
      const hasSavedBilling = Boolean(
        session?.billing?.address1 || session?.billingSameAsShipping,
      );

      if (hasSavedShipping) {
        const addrSummary = [
          session.shipping.name,
          session.shipping.address1,
          session.shipping.address2,
          session.shipping.city,
          session.shipping.province,
          session.shipping.zip,
        ]
          .filter(Boolean)
          .join(", ");

        if (hasSavedBilling) {
          const immediateChoice = paymentChoice(userMessage);
          await safeUpsert({
            step: "ready",
            ...(immediateChoice ? { selectedPaymentMethod: immediateChoice } : {}),
            lastCartSnapshot: cart,
          });
          // Always perform the full Order Review with every single detail via mark_checkout_ready!
          return handlers.mark_checkout_ready();
        } else {
          await safeUpsert({
            step: "billing_inquiry",
            lastCartSnapshot: cart,
          });

          ctx.fallbackSpeech = isHindi
            ? `Tumhara delivery address ( **${addrSummary}**) mere paas saved hai dost! Kya tumhara **Billing Address** bhi delivery address jaisa same hai, ya koi doosra billing address add karna chahoge?`
            : `I have your delivery address saved ( **${addrSummary}**)! Is your **Billing Address** the same as your delivery address, or would you like to add a different billing address?`;

          return {
            status: "shipping_saved_ask_billing",
            item_count: count,
            shipping: session.shipping,
          };
        }
      }

      await safeUpsert({
        loggedIn: false,
        loginMethod: "guest",
        step: "address",
        lastCartSnapshot: cart,
      });

      if (actions.length < 8) {
        actions.push({
          type: "begin_checkout",
          cart,
          loggedIn: false,
          originalTotal: pricing.rawSubtotal,
          total: pricing.totalAfterCoupon,
          discountAmount: pricing.couponDiscountAmount,
          appliedDiscount: pricing.appliedDiscount,
          currency: pricing.currency,
        });
      }

      ctx.fallbackSpeech = isHindi
        ? "Chalo dost, फटाफट checkout karte hain! Delivery ke liye bas mujhe apna **Full Name**, **Phone Number**, **Email Address** aur **Shipping Address** (Street, City, State aur PIN code) bata do."
        : "Awesome, let's get your order checked out! Just share your **Full Name**, **Phone Number**, **Email Address**, and **Shipping Address** (Street, City, State, and Postal Code).";

      return { status: "ok", item_count: count, loggedIn: false };
    },

    check_prepaid_discount: async (args = {}) => {
      let session = await safeGet();
      // Online payment was chosen in an EARLIER message and the shopper now just says yes ("yes create the payment link", "place the order"): that is the
      // confirmation, not another discount question. The model kept calling this tool again and then claimed a link it never made.
      if (session?.selectedPaymentMethod === "prepaid" && args?.apply !== false && context.checkout?.step !== "placed"
        && /\b(?:yes|yeah|yep|sure|ok|okay|haan|han|ji|place|create|link|confirm|proceed|go\s+ahead|kar\s*do|kardo)\b/i.test(userMessage || "")
        && !/\b(?:discount|coupon|code|offer|saving|cheaper)\b/i.test(userMessage || "")) {
        return handlers.place_order({ paymentMethod: "prepaid", customerConfirmed: true });
      }
      await ensureShippingRates(session);
      session = await safeGet();
      const cart = context.cart || {};
      const pricing = computeOrderPricing(cart, session, storeCurrency);
      const cur = pricing.currency;
      // The offer applies to the goods; tax and shipping are added by Shopify afterwards.
      const offer = await prepaidOffer(storeId, pricing.discountedSubtotal);
      const shipping = deduplicateAddress(session.shipping || {});
      const billing = session.billingSameAsShipping !== false ? shipping : session.billing;
      const haveAddress = Boolean(shipping.address1 && shipping.city && shipping.zip && shipping.name);
      const wantsApply =
        args?.apply === true ||
        /\b(?:apply|laga(?:o|do|na)?|lagao|use\s+it|add\s+it|set\s+it)\b/i.test(userMessage);

      // Both totals come from Shopify, with tax, so the shopper compares real payable amounts.
      let codQuote = null;
      let prepaidQuote = null;
      if (haveAddress && offer.hasDiscount) {
        const base = {
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
        };
        try {
          [codQuote, prepaidQuote] = await Promise.all([
            withQuoteTimeout(quoteOrder(storeId, { ...base, paymentMethod: "cod" })),
            withQuoteTimeout(quoteOrder(storeId, { ...base, paymentMethod: "prepaid", prepaidOffer: offer })),
          ]);
        } catch (error) {
          console.error("[checkout] prepaid comparison quote failed:", String(error.message).slice(0, 300));
          codQuote = prepaidQuote = null;
        }
      }
      const codTotal = codQuote?.total ?? pricing.totalAfterCoupon;
      const prepaidTotal = prepaidQuote?.total ?? offer.prepaidTotal;
      const saving = Number((codTotal - prepaidTotal).toFixed(2));
      const taxIncluded = Boolean(prepaidQuote && codQuote);
      const codStr = formatPriceLabel(codTotal, cur);
      const prepaidStr = formatPriceLabel(prepaidTotal, cur);
      const saveStr = formatPriceLabel(saving, cur);
      const label = offer.discountPercent > 0 ? `${offer.discountPercent}%` : formatPriceLabel(offer.discountAmount, cur);
      const taxWord = taxIncluded ? (isHindi ? " (tax ke saath)" : " (including tax)") : (isHindi ? " (tax se pehle)" : " (before tax)");

      if (offer.hasDiscount && wantsApply) {
        // The shopper wants it: choose Prepaid, so every later total and the payment link include it.
        await safeUpsert({ selectedPaymentMethod: "prepaid" });
        session.selectedPaymentMethod = "prepaid";
        const result = await handlers.mark_checkout_ready({ force: true });
        const tail = isHindi
          ? ` Prepaid select kar liya aur **${label}** discount lag gaya: payable total **${prepaidStr}**${taxWord} (COD par **${codStr}**). Payment link bana doon?`
          : ` I've selected Prepaid and applied the **${label}** discount: payable total **${prepaidStr}**${taxWord} (it's **${codStr}** with Cash on Delivery). Shall I create the payment link?`;
        ctx.fallbackSpeech = tail.trim();
        return { ...result, prepaidDiscountApplied: true, prepaidTotal, codTotal, saving, taxIncluded };
      }

      // The shopper chose online payment but there is no prepaid discount (none exists, or its minimum spend is not met): online payment is still
      // selected, and the question moves on to the payment link. Asking "which payment method?" again left the checkout in a loop (real widget, 2026-11-17).
      if (!offer.hasDiscount && wantsApply) {
        await safeUpsert({ selectedPaymentMethod: "prepaid" });
        session.selectedPaymentMethod = "prepaid";
        const result = await handlers.mark_checkout_ready({ force: true });
        const why = offer.source === "minimum_not_met" && offer.minimumSubtotal
          ? (isHindi ? ` (prepaid discount ke liye cart kam se kam ${offer.minimumSubtotal} ${offer.minimumCurrency || ""} ka hona chahiye)` : ` (the prepaid discount needs a cart of at least ${offer.minimumSubtotal} ${offer.minimumCurrency || ""})`)
          : "";
        ctx.fallbackSpeech = isHindi
          ? `Online payment select kar liya. Prepaid par koi alag discount nahi lag raha${why}, total **${codStr}** rahega. Payment link bana doon?`
          : `I've selected online payment. There's no prepaid discount on this cart${why}, so the total stays **${codStr}**. Shall I create the payment link?`;
        return { ...result, prepaidDiscountApplied: false, onlinePaymentSelected: true, prepaidTotal: codTotal, codTotal, saving: 0, taxIncluded };
      }

      if (offer.hasDiscount) {
        ctx.fallbackSpeech = isHindi
          ? `Haan! Online (Prepaid) payment par **${label} discount** active hai. Payable total${taxWord} Prepaid par **${prepaidStr}** hoga, COD par **${codStr}** — yaani **${saveStr}** ki bachat. Prepaid select kar doon?`
          : `Yes! There's an active **${label} prepaid discount**. Your payable total${taxWord} is **${prepaidStr}** with Prepaid versus **${codStr}** with Cash on Delivery, so you save **${saveStr}**. Shall I go with Prepaid?`;
      } else if (pricing.hasCoupon && pricing.couponDiscountAmount > 0) {
        ctx.fallbackSpeech = isHindi
          ? `Tumhara **${pricing.appliedDiscount.code}** coupon pehle se applied hai. Alag se koi extra prepaid discount abhi nahi hai, toh Prepaid aur COD dono par total **${codStr}** rahega. Kaunsa payment option lock karoon?`
          : `Your **${pricing.appliedDiscount.code}** coupon is already applied. There's no separate prepaid discount right now, so the total is **${codStr}** for both Prepaid and Cash on Delivery. Which payment method would you like?`;
      } else {
        ctx.fallbackSpeech = isHindi
          ? `Maine check kiya — filhal prepaid payment par koi alag discount active nahi hai. Total **${codStr}** rahega. Kaunsa payment option prefer karoge?`
          : `I checked — there's no prepaid discount active right now, so the total stays **${codStr}**. Which payment method would you prefer?`;
      }

      return {
        status: "ok",
        hasPrepaidDiscount: offer.hasDiscount,
        discountSource: offer.source,
        discountTitle: offer.title,
        discountCode: offer.code,
        prepaidDiscountPercent: offer.discountPercent,
        prepaidDiscountAmountOnItems: offer.discountAmount,
        originalSubtotal: pricing.rawSubtotal,
        appliedCoupon: pricing.appliedDiscount,
        couponDiscountAmount: pricing.couponDiscountAmount,
        codPayableTotal: codTotal,
        prepaidPayableTotal: prepaidTotal,
        youSave: saving,
        totalsIncludeTax: taxIncluded,
        currency: cur,
        instruction_for_ai:
          "Report codPayableTotal and prepaidPayableTotal exactly as given (they are real Shopify totals when totalsIncludeTax is true). Do NOT repeat a previous answer: if the shopper says they want the discount applied or chooses Prepaid, call check_prepaid_discount again with apply=true. The prepaid discount applies automatically once Prepaid is selected; there is no separate code for the shopper to enter.",
      };
    },

    get_discounts_and_offers: async (args) => {
      const res = await getProductDiscountsAndOffers(storeId, {
        productName: args?.productName || "",
        variantName: args?.variantName || "",
        cart: context.cart || null,
      });

      const offersList = res.offers || [];
      // A code is only offered when it works on THIS cart; one with a minimum or a narrow scope says so, and is never called store-wide.
      const offerLine = (o) => {
        const base = `• **${o.title}**: ${isHindi ? o.descriptionHi || o.description : o.description}${o.code ? ` (Promo Code: **${o.code}**)` : ""}`;
        const cond = Array.isArray(o.conditions) && o.conditions.length ? ` — ${o.eligibleForThisCart === false ? "not usable on your current cart: " : ""}it ${o.conditions.join("; ")}` : "";
        return base + cond;
      };
      const prod = res.product;
      const prodSale = prod?.saleDiscount;

      if (prod) {
        const prodPriceStr =
          prod.formattedPrice || formatPriceLabel(prod.price, prod.currency);
        if (prodSale && prodSale.hasDiscount) {
          const storeCoupons = offersList.filter(
            (o) => o.type !== "product_sale",
          );
          const extraLines = storeCoupons
            .map(
              (o) =>
                offerLine(o),
            )
            .join("\n");

          const optionLabel = prodSale.optionName ? ` (${prodSale.optionName})` : "";
          const variesNote = prodSale.saleVariesByOption
            ? isHindi
              ? " Doosre options par alag discount hai: kisi khaas option ke baare mein poochho."
              : " Other options are marked down by different amounts: ask me about a specific option for its exact saving."
            : "";
          ctx.fallbackSpeech = isHindi
            ? `Haan dost, खुशखबरी! **${prod.title}**${optionLabel} par abhi **${prodSale.discountPercent}% direct sale discount** chal raha hai — yeh MRP **${prodSale.formattedOriginalPrice}** se ghat kar sirf **${prodSale.formattedSalePrice}** mein mil raha hai!${variesNote}${
                extraLines
                  ? `\n\nAur सुनो, store par yeh extra coupons bhi active hain:\n${extraLines}\nBatao, kya main koi coupon code tumhare cart par apply kar doon?`
                  : ""
              }`
            : `Good news! **${prod.title}**${optionLabel} is currently on a **${prodSale.discountPercent}% direct sale** — down from **${prodSale.formattedOriginalPrice}** to **${prodSale.formattedSalePrice}** (saving you **${prodSale.formattedDiscount}**)!${variesNote}${
                extraLines
                  ? `\n\nPlus, we have these active promo offers:\n${extraLines}\nWould you like me to apply any of these coupon codes to your cart?`
                  : ""
              }`;
        } else if (offersList.length > 0) {
          const bulletLines = offersList
            .map(
              (o) =>
                offerLine(o),
            )
            .join("\n");
          const firstCodeOffer = offersList.find((o) => o.code && o.isEligibleNow !== false) || offersList.find((o) => o.isEligibleNow !== false) || null;
          const codePromptLabel = firstCodeOffer?.code ? `**${firstCodeOffer.code}**` : "a coupon";
          ctx.fallbackSpeech = isHindi
            ? `Dekho dost, **${prod.title}** (${prodPriceStr}) par alag se product markdown toh nahi hai, lekin tum apne cart par hamare yeh शानदार store coupons laga kar sidha discount pa sakte ho:\n${bulletLines}\n\nBatao yaar, kya main ${codePromptLabel} tumhare cart par abhi apply kar doon?`
            : `There isn't a separate markdown on **${prod.title}** (${prodPriceStr}) by itself, but you can use our active promo codes on your cart to save right away:\n${bulletLines}\n\nWould you like me to apply ${codePromptLabel} to your cart right now?`;
        } else {
          ctx.fallbackSpeech = isHindi
            ? `Maine check kiya dost — **${prod.title}** (${prodPriceStr}) par filhal koi extra discount ya coupon code active nahi hai; yeh pehle se hi hamare best price par hai.`
            : `I checked our store — there is currently no extra discount or coupon active on **${prod.title}** (${prodPriceStr}); it's already at our best price. Would you like to go ahead with your order?`;
        }
      } else if (offersList.length > 0) {
        const firstCodeOffer = offersList.find((o) => o.code && o.isEligibleNow !== false) || offersList.find((o) => o.isEligibleNow !== false) || null;
        const codePromptLabel = firstCodeOffer?.code ? `**${firstCodeOffer.code}**` : "one of these offers";
        const bulletLines = offersList
          .map(
            (o) =>
              offerLine(o),
          )
          .join("\n");
        ctx.fallbackSpeech = isHindi
          ? `Haan dost, bilkul! Abhi hamare store par yeh official discounts aur coupons active hain:\n${bulletLines}\n\nBatao, kya main tumhare cart par ${codePromptLabel} apply kar doon?`
          : `Yes! Here are the official discounts and promo codes active on our store right now:\n${bulletLines}\n\nWould you like me to apply ${codePromptLabel} to your cart right now?`;
      } else {
        ctx.fallbackSpeech = isHindi
          ? "Maine check kiya dost — filhal store par koi extra coupon code active nahi hai."
          : "I checked our store — there are currently no extra coupon codes active right now.";
      }

      return res;
    },

    apply_discount_or_offer: async (args) => {
      const session = await safeGet();
      const inputCode = String(args?.discountCode || "")
        .trim()
        .toUpperCase();
      const inputTitle = String(args?.offerTitle || "").trim();
      const cart = context.cart || {};
      const cur = cart?.currency || storeCurrency || ""; // never assumed: unknown means no symbol
      const totalNum =
        cart?.total_price != null ? Number(cart.total_price) / 100 : 0;

      const storeDiscounts = await loadDiscounts(storeId);

      let matched = null;
      if (inputCode) {
        matched = storeDiscounts.find(
          (d) => d.code && d.code.toUpperCase() === inputCode,
        );
      }
      // A code the customer typed exactly may be any active code (Shopify still checks who may use
      // it). Matching by name or by part of a code is limited to public offers, so a private code
      // (staff, influencer, one customer) can never be discovered by guessing words.
      if (!matched && inputTitle) {
        const titleLower = inputTitle.toLowerCase();
        matched = storeDiscounts.filter((d) => d.shareable !== false).find(
          (d) =>
            (d.title && d.title.toLowerCase().includes(titleLower)) ||
            (d.code && d.code.toLowerCase().includes(titleLower)) ||
            (d.summary && d.summary.toLowerCase().includes(titleLower)),
        );
      }

      let isPrepaidConfig = false;
      let configuredOffer = null;
      if (!matched) {
        configuredOffer = await prepaidOffer(storeId, totalNum);
        if (
          configuredOffer?.hasDiscount &&
          (inputCode === (configuredOffer.code || "").toUpperCase() ||
            inputTitle.toLowerCase().includes("prepaid") ||
            inputTitle.toLowerCase().includes("online"))
        ) {
          isPrepaidConfig = true;
        }
      }

      if (!matched && !isPrepaidConfig) {
        // A wrong code must never reveal the store's other (possibly private) codes.
        // Each public code says whether it really works on THIS cart (a minimum, or a code limited to a collection the cart's items are not in):
        // a real run offered "CHAT20 for 20% off this bag" after a wrong code, and then refused it because the bag is not in its collection (2026-11-22).
        const hasItems = Array.isArray(cart?.items) && cart.items.length > 0;
        const publicDiscounts = await Promise.all(storeDiscounts
          .filter((d) => d.shareable !== false)
          .map(async (d) => {
            const { title, code, summary, type, percentage, amount, isAutomatic, isFreeShipping } = d;
            const out = { title, code, summary, type, percentage, amount, isAutomatic, isFreeShipping };
            if (d.limitedTo) out.onlyFor = (d.scopeNames || []).slice(0, 5);
            if (!hasItems) return out;
            const assessed = await assessDiscountOnCart(storeId, cart, d).catch(() => null);
            if (!assessed || !assessed.scopeKnown) out.usableOnThisCart = "unknown";
            else out.usableOnThisCart = Boolean(assessed.eligible && (!d.limitedTo || assessed.eligibleSubtotal > 0));
            if (assessed?.conditions?.length) out.conditions = assessed.conditions;
            return out;
          }));
        const usable = publicDiscounts.filter((d) => !hasItems || d.usableOnThisCart === true);
        const activeCodes = usable.map((d) => d.code).filter(Boolean);
        const codeListStr =
          activeCodes.length > 0
            ? activeCodes.map((c) => `**${c}**`).join(", ")
            : isHindi ? "koi aisa nahi jo aapke cart par lage" : "none that works on your cart";

        ctx.fallbackSpeech = isHindi
          ? `Yaar, coupon code "${
              inputCode || inputTitle
            }" abhi active nahi hai. Hamare active store coupons hain: ${codeListStr}. Batao, inmein se kaunsa apply kar doon?`
          : `Hmm, the coupon code "${
              inputCode || inputTitle
            }" isn't active right now. Our active coupons are: ${codeListStr}. Which one of these should I apply for you?`;

        return {
          status: "invalid_code",
          activeDiscounts: publicDiscounts,
          note: "The code the customer gave does not exist. Offer another code only if its usableOnThisCart is true (or the cart is empty), and say what it covers (onlyFor) exactly as given; never say a code works on an item when usableOnThisCart is false or unknown.",
        };
      }

      let percent = 0;
      let discountAmount = 0;
      let resolvedCode = inputCode;
      let resolvedTitle = inputTitle;
      let isFreeShipping = false;
      // What the code really covers on THIS cart: a code with a minimum spend/quantity is refused when the cart is short of it, and a code limited
      // to a collection or to named products discounts only those lines (never the whole cart).
      let discountBase = totalNum;
      let scopeVariantIds = null;
      let coveredTitles = [];
      if (matched && !isPrepaidConfig) {
        const assessed = await assessDiscountOnCart(storeId, cart, matched).catch(() => null);
        const code = matched.code || matched.title;
        if (assessed && !assessed.eligible) {
          ctx.fallbackSpeech = isHindi
            ? `"${code}" abhi aapke cart par lagu nahi hota: ${assessed.conditions.join("; ")}.`
            : `The code ${code} can't be applied to this cart yet: ${assessed.conditions.join("; ")}.`;
          return { status: "not_eligible", verbatim: true, discountCode: code, conditions: assessed.conditions, note: "Tell the customer plainly that this code does not apply to their cart right now and why (the conditions). Do not say it was applied and do not quote a saving." };
        }
        if (assessed && !assessed.scopeKnown) {
          ctx.fallbackSpeech = `I couldn't check which items in your cart the code ${code} covers just now, so I haven't applied it. Please try again in a moment.`;
          return { status: "cannot_verify", discountCode: code, note: "Say you could not confirm which cart items this code covers, so it has not been applied. Never guess the saving." };
        }
        if (assessed && matched.limitedTo) {
          if (!(assessed.eligibleSubtotal > 0)) {
            const names = (matched.scopeNames || []).slice(0, 3).join(", ");
            ctx.fallbackSpeech = `The code ${code} only covers items in ${names || "a specific selection"}, and nothing in your cart is part of it.`;
            return { status: "not_eligible", discountCode: code, conditions: assessed.conditions, note: "None of the items in the cart is covered by this code. Say so; do not say it was applied." };
          }
          discountBase = assessed.eligibleSubtotal;
          scopeVariantIds = assessed.coveredVariantIds;
          coveredTitles = assessed.coveredTitles;
        }
        if (matched.amount > 0 && !matched.percentage && !matched.isFreeShipping) {
          const fixedCurrency = String(matched.currencyCode || "").toUpperCase();
          if (fixedCurrency && cur && fixedCurrency !== String(cur).toUpperCase()) {
            ctx.fallbackSpeech = `The code ${code} is a fixed amount in ${fixedCurrency}, which isn't converted to ${cur}, so I haven't applied it.`;
            return { status: "cannot_verify", discountCode: code, note: `This code is a fixed ${fixedCurrency} amount and the cart is in ${cur}; it is not converted, so it was not applied. Say so.` };
          }
        }
      }

      if (isPrepaidConfig && configuredOffer) {
        percent = configuredOffer.discountPercent || 0;
        discountAmount = configuredOffer.discountAmount || 0;
        resolvedCode = configuredOffer.code || "PREPAID";
        resolvedTitle = configuredOffer.title || "Prepaid Instant Discount";
      } else if (matched) {
        resolvedCode = matched.code || matched.title;
        resolvedTitle = matched.title || matched.code;
        isFreeShipping = Boolean(matched.isFreeShipping);

        if (!isFreeShipping) {
          if (matched.percentage > 0) {
            percent = matched.percentage;
            discountAmount = Number(((discountBase * percent) / 100).toFixed(2));
          } else if (matched.amount > 0) {
            discountAmount = Math.min(totalNum, matched.amount);
            percent =
              totalNum > 0 ? Math.round((discountAmount / totalNum) * 100) : 0;
          }
        }
      }

      const newTotal = Math.max(
        0,
        Number((totalNum - discountAmount).toFixed(2)),
      );
      const totalStr = formatPriceLabel(totalNum, cur);
      const discountStr = formatPriceLabel(discountAmount, cur);
      const newTotalStr = formatPriceLabel(newTotal, cur);

      const appliedDiscountObj = {
        code: resolvedCode,
        title: resolvedTitle,
        percent,
        amount: discountAmount,
        formattedDiscount: discountStr,
        isFreeShipping,
        // the cart lines a collection/product-limited code covers (null = the whole cart): the totals are worked out from these lines only
        ...(scopeVariantIds ? { scopeVariantIds, coveredTitles } : {}),
      };

      localSession.discountClearedAfterOrder = false;
      await safeUpsert({
        appliedDiscount: appliedDiscountObj,
        discountClearedAfterOrder: false,
        discountAmount,
        finalTotal: newTotal,
      });

      if (actions.length < 8) {
        actions.push({
          type: "apply_discount",
          discountCode: resolvedCode,
          discountTitle: resolvedTitle,
          discountPercent: percent,
          discountAmount,
          formattedDiscount: discountStr,
          originalTotal: totalNum,
          formattedOriginalTotal: totalStr,
          newTotal,
          formattedNewTotal: newTotalStr,
          currency: cur,
          isFreeShipping,
        });

        if (session?.shipping?.address1 && session?.shipping?.city) {
          actions.push({
            type: "checkout_ready",
            cart,
            shipping: session.shipping,
            billing: session.billing || session.shipping,
            billingSameAsShipping: Boolean(
              session.billingSameAsShipping ?? true,
            ),
            email: session.shipping.email || session.customer?.email || "",
            originalTotal: totalNum,
            total: newTotal,
            discountAmount,
            appliedDiscount: appliedDiscountObj,
            hasPrepaidDiscount: false,
            prepaidTotal: newTotal,
            currency: cur,
          });
        }
      }

      ctx.fallbackSpeech = isFreeShipping
        ? isHindi
          ? ` Yay! Maine tumhare order par coupon **${resolvedCode}** apply kar diya hai — ab tumhe is order par **Free Shipping** mil gayi hai dost!`
          : ` Yay! I've applied coupon **${resolvedCode}** — you now have **Free Shipping** on your order!`
        : isHindi
          ? ` Yay dost! Maine tumhare cart par coupon **${resolvedCode}** (${percent}% OFF) apply kar diya hai! Tumhari sidhi **${discountStr}** ki bachat ho gayi hai, aur ab tumhara naya payable total **${totalStr}** se ghat kar sirf **${newTotalStr}** reh gaya hai!`
          : ` Awesome! I've applied coupon **${resolvedCode}** (${percent}% OFF) to your cart! You just saved **${discountStr}**, bringing your final payable total down from **${totalStr}** to **${newTotalStr}**!`;

      return {
        status: "ok",
        discountCode: resolvedCode,
        discountTitle: resolvedTitle,
        discountPercent: percent,
        discountAmount,
        formattedDiscount: discountStr,
        originalTotal: totalNum,
        formattedOriginalTotal: totalStr,
        newTotal,
        formattedNewTotal: newTotalStr,
        currency: cur,
        isFreeShipping,
        ...(scopeVariantIds ? { appliesOnlyTo: coveredTitles, coveredSubtotal: formatPriceLabel(discountBase, cur), note: "The code discounts only the items listed in appliesOnlyTo; the rest of the cart is at full price. Say which items it covers." } : {}),
      };
    },

    get_call_slots: async (args = {}) => {
      if (!bookingEnabled(context.settings)) return { status: "disabled", note: "Call booking is not available at this store. Offer to flag the chat for the team instead (flag_for_owner)." };
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || "")) ? String(args.date) : "";
      const free = await bookings.listFreeSlots({ shop: storeId, settings: context.settings, limit: day ? 60 : 8, perDay: day ? 12 : 3 });
      const slots = (day ? free.slots.filter((x) => x.date === day) : free.slots).slice(0, 8);
      if (!slots.length) return { status: "no_slots", timezone: free.timezone, note: day ? "Nothing is free on that day. Offer to look at other days." : "No call times are free in the coming days. Say so, and offer flag_for_owner so the team gets back to them." };
      return { status: "ok", timezone: free.timezone, callMinutes: free.slotMinutes, slots: slots.map(({ start, local }) => ({ start, local })), note: "Offer two or three of these in the customer's own words. Use `start` exactly when booking." };
    },

    book_call: async (args = {}) => {
      if (!bookingEnabled(context.settings)) return { status: "disabled", note: "Call booking is not available at this store." };
      if (args.customerConfirmed !== true) return { status: "need_confirmation", note: "Ask the customer to agree to this exact time first." };
      const out = await bookings.createBooking({
        shop: storeId, settings: context.settings, chatRef: context.chatRef || "", language: lang,
        country: context.cart?.country || "", input: args,
      });
      if (out.status === "invalid") return { status: "invalid", problems: out.problems, note: "Tell the customer exactly which detail is missing or not valid (phone, email or time) and ask for it again. Do not guess or fix it yourself." };
      if (out.status === "slot_unavailable") return { status: "slot_unavailable", note: "That time is no longer free. Call get_call_slots and offer other times." };
      // this chat already has a callback: say when it is, never book a second one
      if (out.status === "already_booked") return { status: "already_booked", when: describeLocal(out.booking.startAt, out.booking.timezone), timezone: out.booking.timezone, note: "This customer already has a callback booked for that time (see when). Tell them so. If they want another time, they can move it in the chat window; do not book a second call." };
      if (out.status !== "booked" && out.status !== "confirmed") return { status: out.status || "failed", note: "The call could not be booked. Say so honestly and offer flag_for_owner." };
      const b = out.booking;
      actions.push({ type: "call_booked", bookingId: String(b._id), startAt: new Date(b.startAt).toISOString(), timezone: b.timezone, status: b.status });
      // a complaint this chat has records where it went
      if (context.chatRef) await markHandoff({ shop: storeId, chatRef: context.chatRef, status: "callback", bookingId: String(b._id) }).catch(() => {});
      const when = describeLocal(b.startAt, b.timezone);
      return out.status === "confirmed"
        ? { status: "confirmed", when, timezone: b.timezone, note: "The call is confirmed and a confirmation email is being sent. Tell the customer the time." }
        : { status: "booked", when, timezone: b.timezone, note: "The request is in. The store will confirm this time by email, so do not say it is final." };
    },

    // The shopper asked for a person. The BACKEND decides what is possible (is anyone on, is a callback offered); the AI never
    // says a person has joined: the chat window shows the recording choice and the connecting screen, and only a team member
    // accepting the call changes anything.
    request_human_support: async (args = {}) => {
      const reason = String(args.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
      markPersonRequest();
      const settings = context.settings || {};
      if (!liveSupportEnabled(settings) || !audioCallEnabled(settings)) {
        return {
          status: "not_offered",
          callbackAvailable: bookingEnabled(settings),
          note: bookingEnabled(settings)
            ? "This store does not offer instant calls with a person. Offer to book a call (get_call_slots) or to flag the chat for the team (flag_for_owner). Do not promise a person will join now."
            : "This store does not offer instant calls with a person. Call flag_for_owner and tell the customer the store team will follow up. Do not promise a time.",
        };
      }
      const caps = await supportCapabilities(storeId, settings);
      actions.push({ type: "human_support", reason, available: caps.representativesAvailable, allBusy: caps.allRepresentativesBusy, callbackAvailable: caps.callbackEnabled, recordingAvailable: recordingAllowed(settings) });
      // a complaint this chat has travels with the request: the person is not asked to hear it again
      const openComplaint = context.chatRef ? await openComplaintForChat(storeId, context.chatRef).catch(() => null) : null;
      if (openComplaint) actions[actions.length - 1].complaintRef = openComplaint.reference;
      return {
        status: "offered",
        representativesAvailable: caps.representativesAvailable,
        allRepresentativesBusy: caps.allRepresentativesBusy,
        callbackAvailable: caps.callbackEnabled,
        recordingAvailable: recordingAllowed(settings),
        note: "The chat window now asks the customer about saving the call and connects them (or offers to retry or book a callback). Say ONE short, warm line that you are trying to connect them with a support representative. Do NOT say a person has joined or that they are connected, do not give a wait time, and do not try to talk the customer out of it.",
      };
    },

    flag_for_owner: async (args = {}) => {
      const reason = String(args.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
      markPersonRequest();
      actions.push({ type: "flag_for_owner", reason });
      return { status: "ok", note: "The team has been alerted. Tell the customer the store team will follow up; do not promise a time." };
    },

    get_warranty_and_policy: async (args) => {
      const res = await getProductWarrantyAndPolicy(
        storeId,
        args?.productName || "",
        args?.topic || "",
      );
      const links = (res.policies || [])
        .filter((p) => p.url)
        .map((p) => `• ${p.title}: ${p.url}`)
        .join("\n");
      ctx.fallbackSpeech =
        res.status === "ok"
          ? isHindi
            ? `Store ki published policy ke hisaab se details yeh hain${res.productTitle ? ` (**${res.productTitle}**)` : ""}:${links ? `\n${links}` : ""}`
            : `Here is what the store has published${res.productTitle ? ` for **${res.productTitle}**` : ""}:${links ? `\n${links}` : ""}`
          : isHindi
            ? "Is store ne Shopify par ye policy publish nahi ki hai. Chaho to main store ka contact bata deti hoon."
            : "This store hasn't published that policy in Shopify. I can share the store's contact details if you like.";
      return res;
    },
  };
}
