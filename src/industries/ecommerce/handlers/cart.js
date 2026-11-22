// The cart: add, read, change and clear.
// Tool handlers of the shopping session (see createSession in ../../ecommerce.js), moved here unchanged:
// what they share with the session comes in `ctx`; values the session changes are read through it.
// Tools: add_to_cart, get_website_product_count, clear_cart, get_cart, update_cart_item.
import { didUserSpecifyVariantInMessage } from "../historyHints.js";
import { addRequested } from "../addRequest.js";
import { computeOrderPricing, readCheckoutMemory, writeCheckoutMemory } from "../pricing.js";
import { cleanHumanOptionsList, formatPriceLabel } from "../replies.js";
import { IMPLAUSIBLE_CART_QUANTITY, variantStockLimit } from "../../../tools/shopify/cart.js";
import { SIZE_ALIASES, assessDiscountOnCart, getCachedCatalogSummary, getCatalogSummary, getWebsiteProductCount, resolveCartItem, tokenMatchesTitle, variantTokens } from "../shared.js";

export function cartHandlers(ctx) {
  const { MAX_CART_ACTIONS, actions, addIntent, addedItemsThisTurn, context, handlers, history, isHindi, llmMode, loadDiscounts, localSession, needsVariantItemsThisTurn, orderJustPlacedReply, rebuildMultiAddFallbackSpeech, rememberForCards, safeGet, safeUpsert, storeCurrency, storeId, userMessage } = ctx;
  return {

    add_to_cart: async (args) => {
      // The cart changes only when the shopper asked for it: said so in this message ("add", "I'll take", "chahiye", "cart"...) or answers an
      // offer to add made in the previous reply ("yes", "black", "the second"). A message that only narrows a search ("black one", "size L" after
      // a list) is not a purchase: the AI once put a watch and a T-shirt in the cart on those words (real storefront, 2026-11-17).
      if (llmMode && String(userMessage || "").trim() && !addRequested(userMessage, history)) {
        return { status: "not_requested", note: "The customer has not asked to add anything to the cart: they are still choosing. Do NOT add; answer what they said (narrow the options, show the product) and ask which one they want in the cart." };
      }
      // "make it 3", "change it to 3", "only 2 please" sets the quantity of a line that is already in the cart: that is update_cart_item, never an add
      // (a real run answered "your cart already has all 20" when the shopper wanted to go DOWN from 20 to 3).
      if (llmMode && (context.cart?.items || []).length > 0 && /\b(?:make\s+(?:it|that)|change\s+(?:it|that)?\s*to|set\s+(?:it|that)?\s*to|update\s+(?:it|that)?\s*to|reduce\s+(?:it|that)?\s*to|only)\s+\d+\b/i.test(String(userMessage || ""))) {
        return { status: "not_requested", note: "The customer wants to SET the quantity of an item already in the cart. Call update_cart_item with that exact quantity (not add_to_cart)." };
      }
      let targetProductName = String(args.productName || "").trim();
      if (
        (!targetProductName ||
          /^[$₹]?\d+/.test(targetProductName) ||
          /^ability/i.test(targetProductName)) &&
        addIntent.productName
      ) {
        targetProductName = addIntent.productName;
      }
      const numericPriceMatch = targetProductName.match(
        /^[$₹]?\s*(\d{2,5})(?:\.\d{1,2})?$/,
      );
      if (numericPriceMatch) {
        const wantedNum = Number(numericPriceMatch[1]);
        const memList =
          readCheckoutMemory(storeId, context.clientId)?.lastShownProducts ||
          [];
        const exactMem = memList.find(
          (p) => Math.round(Number(p.price)) === Math.round(wantedNum),
        );
        if (exactMem?.title) {
          targetProductName = exactMem.title;
        } else {
          const summary =
            getCachedCatalogSummary?.(storeId) ||
            (await getCatalogSummary(storeId));
          const exactCat = (summary?.products || []).find(
            (p) => Math.round(Number(p.price)) === Math.round(wantedNum),
          );
          if (exactCat?.title) {
            targetProductName = exactCat.title;
          } else if (memList.length > 0 && memList[0]?.title) {
            targetProductName = memList[0].title;
          }
        }
      }

      // "add it again": no product named, or the one just taken out of the cart -> its title and option come back from memory.
      const removedBefore = readCheckoutMemory(storeId, context.clientId)?.recentlyRemoved || [];
      const asKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      let restoredVariant = "";
      if (removedBefore.length) {
        const named = removedBefore.find((e) => targetProductName && (asKey(e.title).includes(asKey(targetProductName)) || asKey(targetProductName).includes(asKey(e.title))));
        const chosen = named || (!targetProductName ? removedBefore[0] : null);
        if (chosen) {
          if (!targetProductName) targetProductName = chosen.title;
          restoredVariant = chosen.variant || "";
        }
      }

      let verifiedVariantName = String(args.variantName || "").trim();
      if (addIntent.variantName && !verifiedVariantName) {
        verifiedVariantName = addIntent.variantName;
      } else if (
        verifiedVariantName &&
        !didUserSpecifyVariantInMessage(
          userMessage,
          verifiedVariantName,
          targetProductName,
        )
      ) {
        verifiedVariantName = "";
      }
      if (!verifiedVariantName && restoredVariant) verifiedVariantName = restoredVariant;

      const preferredFromConversation =
        readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || [];
      const item = await resolveCartItem(storeId, {
        productName: targetProductName,
        variantName: verifiedVariantName,
        quantity: args.quantity,
        preferredProducts: preferredFromConversation,
      });

      if (item.status !== "ok") {
        if (item.product) {
          rememberForCards([item.product]);
        } else if (Array.isArray(item.products) && item.products.length > 0) {
          rememberForCards(item.products);
        }

        if (item.status === "needs_variant" && Array.isArray(item.options)) {
          const parsedOpts = cleanHumanOptionsList(item.options);
          const optListStr = parsedOpts.values.join(", ");
          const priceStr = item.product
            ? formatPriceLabel(item.product.price, item.product.currency)
            : "";

          needsVariantItemsThisTurn.push({
            title: item.title,
            priceStr,
            label: parsedOpts.label,
            optListStr,
          });

          ctx.fallbackSpeech = isHindi
            ? `Bilkul dost! **${item.title}**${
                priceStr ? ` (${priceStr})` : ""
              } cart mein add karne ke liye ready hai — bas mujhe bata do ki **${optListStr}** mein se kaunsa ${
                parsedOpts.label
              } add karoon?`
            : `I'd love to add **${item.title}**${
                priceStr ? ` (${priceStr})` : ""
              } to your cart! It comes in ${parsedOpts.label}s **${optListStr}** — which ${
                parsedOpts.label
              } should I grab for you?`;

          rebuildMultiAddFallbackSpeech();
        } else if (item.status === "ambiguous" && Array.isArray(item.options)) {
          ctx.fallbackSpeech = isHindi
            ? `Dost, is naam se milte-julte yeh options mile hain: **${item.options.join(
                "**, **",
              )}**. Batao inmein se kaunsa cart mein daaloon?`
            : `I found a few close matches: **${item.options.join(
                "**, **",
              )}**. Which one of these should I add to your cart?`;
        } else if (item.status === "quantity_unclear" && item.nonPositive) {
          ctx.fallbackSpeech = isHindi
            ? `Quantity kam se kam 1 honi chahiye. **${item.title}** ke liye kitne piece chahiye? (Cart se hatana ho toh bol dijiye "remove".)`
            : `A quantity has to be at least 1. How many of **${item.title}** would you like? (To take something out of the cart, just ask me to remove it.)`;
        } else if (item.status === "quantity_unclear") {
          ctx.fallbackSpeech = isHindi
            ? `**${item.title}** ke liye ${item.requestedQuantity} piece? Kya aap sach mein itne chahte hain? Kripya exact quantity bata dijiye.`
            : `Just to be sure: did you really want ${item.requestedQuantity} of **${item.title}**? Please tell me the exact quantity.`;
        } else if (item.status === "out_of_stock") {
          const liveInStock = (item.options || [])
            .filter(Boolean)
            .slice(0, 8)
            .join(", ");
          ctx.fallbackSpeech = isHindi
            ? liveInStock
              ? `**${item.title || targetProductName}** ka **${item.variant || verifiedVariantName || "yeh option"}** abhi stock mein nahi hai. Available: **${liveInStock}**.`
              : `**${item.title || targetProductName}** filhal out of stock hai.`
            : liveInStock
              ? `**${item.title || targetProductName}** in **${item.variant || verifiedVariantName || "that option"}** is out of stock. Available: **${liveInStock}**.`
              : `**${item.title || targetProductName}** is currently out of stock.`;
        } else {
          ctx.fallbackSpeech = isHindi
            ? `Yaar, mujhe **${targetProductName}** abhi stock mein nahi mila. Kya main isse milte-julte options dikhaoon?`
            : `I couldn't find **${targetProductName}** in stock right now. Want me to show you some similar options?`;
        }
        return {
          status: item.status,
          title: item.title || item.product?.title || targetProductName,
          requestedVariant: verifiedVariantName || undefined,
          options: item.options,
          variants:
            item.product && Array.isArray(item.product.variants)
              ? item.product.variants.map((v) => ({
                  name: v.title,
                  inStock: v.sellable !== false,
                }))
              : undefined,
          note:
            item.status === "needs_variant"
              ? "Ask which option (size/colour) they want, listing the options."
              : item.status === "out_of_stock"
                ? "The requested option is sold out. Say so and tell them which options are in stock."
                : "Could not add this. Explain simply and offer the closest real alternative or a question.",
        };
      }

      // What can really be added: Shopify's cart takes at most the option's stock IN TOTAL, counting what is already in the cart.
      // The browser adds what we ask for and nothing tells us afterwards, so the number said to the shopper is fixed HERE.
      const inCart = (context.cart?.items || [])
        .filter((line) => String(line.variant_id) === String(item.variantId))
        .reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
      const room = item.availableQuantity == null ? null : Math.max(0, item.availableQuantity - inCart);
      const addQuantity = room == null ? item.quantity : Math.min(item.quantity, room);
      const displayTitleForLimit = item.variantTitle ? `${item.title} (${item.variantTitle})` : item.title;
      if (addQuantity <= 0) {
        ctx.fallbackSpeech = isHindi
          ? `**${displayTitleForLimit}** ki saari available quantity (${item.availableQuantity}) pehle se aapke cart mein hai, isliye aur add nahi kar sakta.`
          : `Your cart already has all ${item.availableQuantity} of **${displayTitleForLimit}** that are available, so I can't add more.`;
        return {
          status: "at_stock_limit",
          title: item.title,
          variant: item.variantTitle,
          availableQuantity: item.availableQuantity,
          alreadyInCart: inCart,
          note: "Nothing was added. The reason is real stock: say that all available units are already in the cart. Do not invent any other limit.",
        };
      }
      item.quantity = addQuantity;

      if (actions.length < MAX_CART_ACTIONS) {
        actions.push({
          type: "add_to_cart",
          variantId: item.variantId,
          quantity: item.quantity,
          title: item.variantTitle
            ? `${item.title} (${item.variantTitle})`
            : item.title,
        });
      }

      const priceStr = formatPriceLabel(item.price, item.currency);
      const label = item.variantTitle
        ? `${item.title} (${item.variantTitle})`
        : item.title;
      addedItemsThisTurn.push({ label, priceStr });

      ctx.fallbackSpeech = isHindi
        ? `Done yaar! Maine **${label}**${
            priceStr ? ` (${priceStr})` : ""
          } tumhare cart mein add kar diya hai! Batao, aage kuch aur dekhna hai ya ab checkout karein?`
        : `Done! I've added **${label}**${
            priceStr ? ` (${priceStr})` : ""
          } to your cart! Would you like to head to checkout or keep browsing?`;

      rebuildMultiAddFallbackSpeech();

      // The shopper asked for more than can be bought: the reply says so with the real numbers. The model once answered "Done! I've added ..." for 1000
      // mice while the cart held 20 (real widget, 2026-11-17), so this wording is sent as it is.
      const capped = Number(item.requestedQuantity) > Number(item.quantity) && addedItemsThisTurn.length === 1;
      if (capped) {
        ctx.fallbackSpeech = isHindi
          ? `Aapne ${item.requestedQuantity} maange the, par **${label}** ke sirf ${item.availableQuantity} available hain${inCart ? ` (${inCart} cart mein pehle se)` : ""}, isliye ${item.quantity} add kiye. Checkout karein ya aur dekhein?`
          : `You asked for ${item.requestedQuantity}, but only ${item.availableQuantity} of **${label}** are available${inCart ? ` (${inCart} already in your cart)` : ""}, so I added ${item.quantity}. Would you like to head to checkout or keep browsing?`;
      }

      return {
        ...(capped ? { verbatim: true } : {}),
        status: "ok",
        title: item.title,
        variant: item.variantTitle,
        quantity: item.quantity,
        price: item.price,
        currency: item.currency,
        requestedQuantity: item.requestedQuantity,
        ...(item.requestedQuantity > item.quantity
          ? { note: `The customer asked for ${item.requestedQuantity}, but only ${item.availableQuantity} of this option are available${inCart ? ` (${inCart} already in the cart)` : ""}, so ${item.quantity} were added: that is all that can be bought right now. Say exactly that, with that real reason. Never mention any other maximum or reason.` }
          : {}),
      };
    },

    get_website_product_count: async () => {
      const res = await getWebsiteProductCount(storeId);
      ctx.fallbackSpeech = isHindi
        ? `Hamare store par abhi **${res.productCount}** active products available hain dost!`
        : `We currently have **${res.productCount}** active products in our store!`;
      return res;
    },

    clear_cart: async () => {
      const cart = context.cart;
      const count = cart?.item_count ?? cart?.items?.length ?? 0;
      if (!count) {
        const done = await orderJustPlacedReply();
        if (done) return done;
        ctx.fallbackSpeech = isHindi
          ? "Tumhara cart toh pehle se hi khali hai dost! Batao aaj kya naya explore karein?"
          : "Your cart is already empty, my friend! What should we look for today?";
        return { status: "empty_cart", note: "Cart is already empty." };
      }
      localSession.appliedDiscount = null;
      localSession.discountAmount = 0;
      localSession.finalTotal = null;
      localSession.discountClearedAfterOrder = true;
      await safeUpsert({
        step: "cart",
        appliedDiscount: null,
        discountAmount: 0,
        finalTotal: null,
        discountClearedAfterOrder: true,
      });
      if (actions.length < 8) {
        actions.push({ type: "clear_cart" });
      }
      ctx.fallbackSpeech = isHindi
        ? "Done dost! Maine tumhare cart se saare items hata kar cart bilkul khali kar diya hai."
        : "All done! I've cleared out all items from your cart.";
      return {
        status: "ok",
        removed_estimate: count,
      };
    },

    get_cart: async () => {
      if (
        /\b(?:to\s+check\s*out|proceed\s+to\s+check\s*out|let'?s\s+check\s*out|ready\s+to\s+check\s*out|check\s*out\s+now|checkout\s+karo|checkout\s+karte)\b/i.test(
          userMessage,
        ) &&
        !/\b(?:how\s+many|what|kitne|kya)\b/i.test(userMessage)
      ) {
        return handlers.begin_checkout();
      }
      const cart = context.cart;
      if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
        const done = await orderJustPlacedReply();
        if (done) return done;
      }
      if (!cart || !Array.isArray(cart.items)) {
        ctx.fallbackSpeech = isHindi
          ? "Abhi tumhara cart khali hai dost. Batao kya badhiya dikhaoon?"
          : "Your cart is empty right now. What can I help you find?";
        return {
          status: "unavailable",
          items: [],
          item_count: 0,
        };
      }
      if (actions.length < 8) {
        actions.push({ type: "show_cart", cart });
      }
      const count = cart.item_count ?? cart.items.length;
      if (count === 0) {
        ctx.fallbackSpeech = isHindi
          ? "Abhi tumhare cart mein koi item nahi hai yaar. Chalo kuch accha sa pasand karte hain!"
          : "Your cart is currently empty. Let's find something awesome for you!";
      } else {
        const session = await safeGet();
        const pricing = computeOrderPricing(cart, session, storeCurrency);
        const cur = pricing.currency;
        const itemLines = cart.items
          .slice(0, 8)
          .map((it, idx) => {
            const v =
              it.variant_title && it.variant_title !== "Default Title"
                ? ` (${it.variant_title})`
                : "";
            const p =
              it.line_price != null
                ? formatPriceLabel(Number(it.line_price) / 100, cur)
                : "";
            return `${idx + 1}. **${it.title}${v}** (Qty ${it.quantity || 1})${p ? ` — ${p}` : ""}`;
          })
          .join("\n");
        const subStr = formatPriceLabel(pricing.rawSubtotal, cur);
        const finalStr = formatPriceLabel(pricing.totalAfterCoupon, cur);
        const discStr = formatPriceLabel(pricing.couponDiscountAmount, cur);

        const totalBlockHi =
          pricing.hasCoupon && pricing.couponDiscountAmount > 0
            ? `Subtotal: ${subStr} | Coupon (**${pricing.appliedDiscount.code}**): -${discStr} | **Final Total: ${finalStr}**`
            : `Total: **${subStr}**`;
        const totalBlockEn =
          pricing.hasCoupon && pricing.couponDiscountAmount > 0
            ? `Subtotal: ${subStr} | Coupon (**${pricing.appliedDiscount.code}**): -${discStr} | **Final Total: ${finalStr}**`
            : `Total: **${subStr}**`;

        ctx.fallbackSpeech = isHindi
          ? `Dekho dost, tumhare cart mein abhi yeh ${count} शानदार item${count > 1 ? "s" : ""} hain (${totalBlockHi}):\n${itemLines}\nBatao, ab checkout ki taraf badhein?`
          : `Here's what you have in your cart right now — ${count} great item${count > 1 ? "s" : ""} (${totalBlockEn}):\n${itemLines}\nReady to head to checkout?`;
      }
      return {
        status: "ok",
        item_count: count,
        total_price: cart.total_price,
        currency: cart.currency || cart.currency_code || "USD",
        items: (cart.items || []).map((item) => ({
          title: item.title,
          variant_title: item.variant_title,
          quantity: item.quantity,
          line_price: item.line_price ?? item.final_line_price,
          product_id: item.product_id,
          variant_id: item.variant_id,
          key: item.key || null,
        })),
      };
    },

    update_cart_item: async (args) => {
      const cart = context.cart;
      if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
        const done = await orderJustPlacedReply();
        if (done) return done;
        ctx.fallbackSpeech = isHindi
          ? "Tumhara cart abhi khali hai dost, toh update karne ke liye koi item nahi hai."
          : "Your cart is currently empty, so there's nothing to remove or update.";
        return { status: "empty_cart" };
      }

      const productName = String(args.productName || "")
        .replace(/\([^)]*\)\s*$/, "")
        .trim()
        .toLowerCase();
      const variantName = String(args.variantName || "")
        .trim()
        .toLowerCase();
      // "add one more" / "another one": addQuantity is how many MORE; the final quantity is the line's current one plus that.
      const addMore = Number.parseInt(args.addQuantity, 10);
      const wantsMore = Number.isFinite(addMore) && addMore > 0;
      let quantity = Number.parseInt(args.quantity, 10);
      // "add minus 3", "add -2", "add 0 more": not a change the cart can make. Asked about, never turned into removing the line.
      const said = String(context.userMessage || "");
      const askedNegative = /\b(?:minus|negative)\b|(?:^|[\s(])-\s?\d/i.test(said);
      // quantity 0 means "take it out": only when the shopper said so. "add 0" or "make it 0 more" is not a request to remove the line.
      const askedRemoval = /\b(?:remove|delete|take\s+(?:it\s+)?(?:out|off)|clear|drop|discard|get rid|hata\w*|nikal\w*|htao)\b|हटा|निकाल/i.test(said);
      const rawAdd = Number.parseInt(args.addQuantity, 10);
      if ((Number.isFinite(rawAdd) && rawAdd <= 0) || (quantity === 0 && (askedNegative || !askedRemoval)) || (Number.isFinite(quantity) && quantity < 0)) {
        ctx.fallbackSpeech = isHindi
          ? "Quantity negative ya zero nahi ho sakti. Cart mein final kitni quantity chahiye? Item hatana ho toh bol dijiye \"remove\"."
          : "I can't add a negative or zero amount. What should the final quantity be? If you want the item taken out, just ask me to remove it.";
        return { status: "quantity_unclear", nonPositive: true, requestedQuantity: Number.isFinite(rawAdd) ? rawAdd : quantity };
      }
      if (!wantsMore && (!Number.isFinite(quantity) || quantity < 0)) {
        return { status: "error", note: "Need a non-negative quantity." };
      }
      // "add 2 Running Sneakers" is a NEW product, not a request to change a line already in the cart: when the message names none of the cart's
      // items and points at none of them ("it", "one more"), the quantity of a cart line is left alone (the AI once raised the phone to 2).
      if ((wantsMore || quantity > 0) && /\badd\b/i.test(said)) {
        const saidWords = new Set(said.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
        const namesCartLine = cart.items.some((item) => String(item.title || item.product_title || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.length > 3 && saidWords.has(w)));
        const pointsAtOne = /\b(?:it|that|this|them|those|these|same|another|more|again|also|aur|ek\s+aur)\b/i.test(said);
        if (!namesCartLine && !pointsAtOne) {
          return { status: "not_requested", note: "The customer named a product that is not a line of the cart: do NOT change any cart line. Use add_to_cart for that product." };
        }
      }
      // no invented maximum: the only limit is the option's real stock, applied below once the cart line is known

      function variantLooseMatch(variantTitle, wanted) {
        if (!wanted || wanted === "default title") return true;
        const titleToks = new Set(variantTokens(variantTitle));
        const wantedToks = variantTokens(wanted);
        if (wantedToks.length === 0) return true;
        if (wantedToks.every((t) => tokenMatchesTitle(t, titleToks)))
          return true;
        const v = String(variantTitle || "").toLowerCase();
        if (
          wanted.length >= 4 &&
          !SIZE_ALIASES[wanted] &&
          (v.includes(wanted) || wanted.includes(v))
        ) {
          return true;
        }
        return false;
      }

      function titleHit(item) {
        const title = String(item.title || "").toLowerCase();
        if (!productName) return true;
        if (title.includes(productName) || productName.includes(title))
          return true;
        const words = productName.split(/\s+/).filter((w) => w.length > 2);
        return words.length > 0 && words.every((w) => title.includes(w));
      }

      let matches = cart.items.filter(
        (item) =>
          titleHit(item) && variantLooseMatch(item.variant_title, variantName),
      );

      if (matches.length === 0) {
        const byTitle = cart.items.filter((item) => titleHit(item));
        if ((quantity === 0 || !variantName) && byTitle.length === 1) {
          matches = byTitle;
        }
      }

      if (matches.length === 0) {
        ctx.fallbackSpeech = isHindi
          ? `Yaar, mujhe tumhare cart mein **${args.productName}** nahi mila.`
          : `I couldn't find **${args.productName}** in your cart.`;
        return { status: "not_found" };
      }
      if (matches.length > 1 && !variantName) {
        return {
          status: "needs_variant",
          options: matches.map((item) => ({
            title: item.title,
            variant_title: item.variant_title,
            quantity: item.quantity,
          })),
        };
      }

      const item = matches[0];
      const target = wantsMore ? Math.max(Number(item.quantity) || 0, 0) + addMore : quantity;
      const stockLimit = target > 0 ? await variantStockLimit(storeId, item.product_id, item.variant_id) : null;
      if (stockLimit == null && target > IMPLAUSIBLE_CART_QUANTITY) {
        ctx.fallbackSpeech = isHindi
          ? `Kya aap sach mein ${target} piece chahte hain? Kripya exact quantity bata dijiye.`
          : `Did you really want ${target}? Please tell me the exact quantity.`;
        return { status: "quantity_unclear", requestedQuantity: target };
      }
      quantity = stockLimit == null ? target : Math.min(target, stockLimit);
      const cappedByStock = stockLimit != null && target > stockLimit;
      const variantId =
        item.variant_id != null ? String(item.variant_id) : null;
      const lineKey = item.key ? String(item.key) : null;
      const displayTitle =
        item.variant_title && item.variant_title !== "Default Title"
          ? `${item.title} (${item.variant_title})`
          : item.title;

      if (actions.length < 8) {
        actions.push({
          type: "update_cart",
          variantId,
          key: lineKey,
          quantity,
          title: displayTitle,
          previousQuantity: item.quantity,
        });
      }

      if (cappedByStock && quantity === Number(item.quantity)) {
        ctx.fallbackSpeech = isHindi
          ? `**${displayTitle}** ki saari available quantity (${quantity}) pehle se aapke cart mein hai.`
          : `Your cart already has all ${quantity} of **${displayTitle}** that are available.`;
      } else if (cappedByStock) {
        ctx.fallbackSpeech = isHindi
          ? `Sirf ${stockLimit} available hain, isliye maine **${displayTitle}** ki quantity ${quantity} kar di hai.`
          : `Only ${stockLimit} of **${displayTitle}** are available, so I've set it to ${quantity}.`;
      } else ctx.fallbackSpeech =
        quantity === 0
          ? isHindi
            ? `Done dost! Maine **${displayTitle}** tumhare cart se hata diya hai.`
            : `Done! I've removed **${displayTitle}** from your cart.`
          : isHindi
            ? `Done dost! Maine **${displayTitle}** ki quantity update karke ${quantity} kar di hai.`
            : `Done! I've updated **${displayTitle}** to quantity ${quantity}.`;

      // A line taken out of the cart is remembered (title and the option it had), so "add it again" / "the same one" needs no
      // second question about its colour or size.
      if (quantity === 0 && context.clientId) {
        const earlier = readCheckoutMemory(storeId, context.clientId)?.recentlyRemoved || [];
        const entry = { title: item.title, variant: item.variant_title && item.variant_title !== "Default Title" ? item.variant_title : "", at: Date.now() };
        writeCheckoutMemory(storeId, context.clientId, {
          recentlyRemoved: [entry, ...earlier.filter((e) => !(e.title === entry.title && e.variant === entry.variant))].slice(0, 5),
        });
      }

      // A code that was applied can stop applying after the change (FREESHIPPING2026 needs 3 items; the cart went from 3 to 2). It is taken off now and
      // the shopper is told, instead of keeping a saving Shopify will not give (real widget, 2026-11-17: "$413" shown, Shopify's total was $433).
      let discountDropped = null;
      try {
        const session = await safeGet();
        const applied = session?.appliedDiscount;
        if (applied?.code && typeof loadDiscounts === "function") {
          const def = (await loadDiscounts(storeId)).find((d) => d.code && String(d.code).toUpperCase() === String(applied.code).toUpperCase());
          if (def) {
            const lines = (context.cart?.items || []).map((i) => ((i === item || (item.variant_id != null && String(i.variant_id) === String(item.variant_id))) ? { ...i, quantity, line_price: Number(i.price) * quantity, final_line_price: Number(i.price) * quantity } : i)).filter((i) => Number(i.quantity) > 0);
            const cartAfter = { ...context.cart, items: lines, item_count: lines.reduce((n, i) => n + Number(i.quantity || 0), 0), total_price: lines.reduce((n, i) => n + Number(i.final_line_price ?? i.line_price ?? 0), 0) };
            const check = await assessDiscountOnCart(storeId, cartAfter, def);
            if (!check.eligible) {
              await safeUpsert({ appliedDiscount: null, discountAmount: 0 });
              localSession.appliedDiscount = null;
              discountDropped = { code: applied.code, conditions: check.conditions };
              ctx.fallbackSpeech = (ctx.fallbackSpeech || "") + (isHindi
                ? ` Ab cart mein ${applied.code} ki shart poori nahi hoti (${(check.conditions || []).join("; ")}), isliye wo code hata diya.`
                : ` Your cart no longer qualifies for ${applied.code} (it ${(check.conditions || []).join("; ")}), so I took that code off.`);
            }
          }
        }
      } catch (error) { console.warn("[cart] could not re-check the applied code:", String(error?.message || error).slice(0, 120)); }

      return {
        ...(discountDropped ? { discountRemoved: discountDropped, note: "The applied discount code no longer applies to this cart and was removed: tell the customer that, with its condition." } : {}),
        status: "ok",
        title: item.title,
        variant: item.variant_title,
        previousQuantity: item.quantity,
        quantity,
        ...(cappedByStock
          ? { requestedQuantity: target, availableQuantity: stockLimit, note: `The customer asked for ${target}, but only ${stockLimit} are available, so the quantity is ${quantity}. Say exactly that. Never mention any other maximum or reason.` }
          : {}),
      };
    },
  };
}
