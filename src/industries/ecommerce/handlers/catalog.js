// Catalog, product and store questions, shipping options and the reply language.
// Tool handlers of the shopping session (see createSession in ../../ecommerce.js), moved here unchanged:
// what they share with the session comes in `ctx`; values the session changes are read through it.
// Tools: get_shipping_options, list_categories, get_checkout_details, request_shipping_update, evaluate_product_look, search_products, get_product_details, compare_products, check_variant_availability, get_recommendations, get_store_info, set_reply_language.
import { travelReason } from "../../../services/conversationProfile.js";
import { deduplicateAddress } from "../../../services/shippingAddressService.js";
import { splitProductAsks } from "../../../tools/productMatch.js";
import * as shopifyService from "../../../tools/shopifyService.js";
import { readCheckoutMemory, writeCheckoutMemory } from "../pricing.js";
import { storeTypesForNeed } from "../needMatch.js";
import { parsePriceSort, parseSearchTerm } from "../../../tools/shopify/words.js";
import { comparedNames, isComparisonRequest } from "../../../services/compareIntent.js";
import { agentNameFor, buildComparisonChecklist, buildConversationalReply, buildFriendlyProductsFallback, buildShopOwnerComparisonReply, buildShopOwnerPraiseReply, comparisonToolPayload, formatPriceLabel, isOpinionOrPraiseQuestion } from "../replies.js";
import { DEFAULT_RECOMMENDATIONS, GENERIC_RECOMMENDATION_WORDS, getCachedCatalogSummary, MAX_CARDS, MAX_RECOMMENDATIONS, checkVariantAvailability, compactProduct, compareProducts, extractRequestedCategories, filterProductsByVariantHints, getProductDetails, getStoreInfo, listCategories, matchesRequestedCategory, parseSearchFilters, recommendProducts, searchShopifyProducts, searchShopifyProductsMany } from "../shared.js";

// The longest search term a ready-made reply repeats back as the item's name.
// How a list of found products is worded is the model's job; this only fixes the shape so every reply reads the same way.
const SEVERAL_PRODUCTS_NOTE =
  "Lead with the one that fits this customer best and one short true reason from its details. Then 2-3 of the others as bullet points, one per line (the customer is choosing: do not show only one when several fit, unless they asked about one specific product) (- **Product Name** (Price): one feature, sizes or colours if they matter). Use your own words, not a fixed opening or closing line.";
const MAX_ECHOED_QUERY_CHARS = 40;
const MAX_ECHOED_QUERY_WORDS = 5;
/**
 * The search term when it is short enough to be an item's name, else "". A whole sentence passed as the search term (the
 * shopper's full message, or an instruction they typed) is never repeated back in bold as if it were a product.
 */
export function echoableQuery(query) {
  const text = String(query || "").replace(/[*_`<>[\]]/g, "").replace(/\s+/g, " ").trim();
  return text.length <= MAX_ECHOED_QUERY_CHARS && text.split(" ").length <= MAX_ECHOED_QUERY_WORDS ? text : "";
}

export function catalogHandlers(ctx) {
  const { LANGUAGE_CHOICE_CODES, WIDEN_SEARCH_NOTE, addIntent, autoExcluded, billingRelationshipIntent, context, convTurn, customerFirstName, defaultGender, ensureShippingRates, evaluateShoppingDiscoveryNeed, foundProducts, handleConversationalFollowUp, handlers, history, isHindi, lang, llmMode, normalizeGenderArg, rememberForCards, resolveVerifiedSelfGender, safeGet, safeUpsert, seenProductIds, seenProductTitles, storeCurrency, storeId, travelRequest, turnSeed, userMessage } = ctx;
  // The word found nothing: ask which of THIS store's own product types fit what the shopper meant (see needMatch.js),
  // and list the in-stock items of those types.
  async function productsForNeed(term, maxPrice) {
    // a few real product titles per type, so the model can tell that "Home & Kitchen" holds a water bottle
    const byCategory = getCachedCatalogSummary?.(storeId)?.categoryMap || {};
    const examples = {};
    for (const label of context.catalogCategories || []) {
      const key = shopifyService.inferRequestedCategory?.(label, storeId) || "";
      if (key && Array.isArray(byCategory[key])) examples[label] = byCategory[key].slice(0, 3);
    }
    const labels = await storeTypesForNeed({ message: userMessage, term, types: context.catalogCategories || [], examples, ask: context.askModel });
    const keys = labels.map((label) => shopifyService.inferRequestedCategory?.(label, storeId) || "").filter(Boolean);
    if (keys.length === 0) return { labels: [], products: [] };
    const products = await recommendProducts(storeId, {
      keywords: keys, strictCategories: keys, maxPrice: Number(maxPrice) > 0 ? Number(maxPrice) : null,
      gender: "", limit: 6, excludeProductIds: [], seenProductTitles: [], seed: 0, userQuery: "",
    });
    return { labels, products: (products || []).slice(0, 6) };
  }
  // Drop only the given products from the cards of this turn. Cards found by an earlier search in the same turn stay:
  // a later search that finds nothing must not wipe them.
  const forgetCards = (list) => { for (const p of list || []) foundProducts.delete(p.id || p.title); };
  const NEED_MATCH_NOTE = "The store has no item under the customer's own word, but these are what it sells for what they described (matched by meaning). Present them as the answer to their need, naming what they are; do not say they are exactly the word the customer used.";
  return {
    get_shipping_options: async () => {
      const session = await safeGet();
      if (!session?.shipping?.address1) {
        ctx.fallbackSpeech = isHindi
          ? "Delivery ka time aur charge dono delivery address par depend karte hain. Address bata do, main us address ke exact delivery options bata deti hoon."
          : "Delivery time and charges both depend on the delivery address. Share the address and I'll tell you the exact delivery options for it.";
        return { status: "needs_address", note: "Delivery time and charges both depend on the delivery address, and no address is saved yet. Answer what was asked: if the customer asked how long delivery takes, say the time depends on their address (do not talk only about charges), then ask for the address. Never quote a shipping fee or delivery date yourself." };
      }
      const rates = await ensureShippingRates(session);
      const fresh = await safeGet();
      if (!rates.length) {
        ctx.fallbackSpeech = isHindi
          ? "Is address ke liye store ne koi alag shipping option set nahi kiya hai."
          : "The store has no separate shipping options set up for this address.";
        return { status: "no_rates", rates: [], note: "Shopify returned no shipping rates for this address. Do not invent any fee." };
      }
      // "switch to Express" / "use the express one": the shopper names one of the rates and asks for it. The model sometimes lists the options again
      // instead of switching (real widget, 2026-11-17: "Standard is selected right now"), so the switch is made here.
      const wantedRate = rates.find((r) => r.title && new RegExp(`\\b${String(r.title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(userMessage || "")));
      if (wantedRate && wantedRate.handle !== (session.shippingRate?.handle || "") && /\b(?:switch|change|use|take|choose|select|go\s+with|want|instead|prefer|set|make\s+it)\b/i.test(String(userMessage || "")) && typeof handlers.set_shipping_method === "function") {
        return handlers.set_shipping_method({ shippingRate: wantedRate.title });
      }
      const cur = rates[0].currency || storeCurrency;
      const list = rates.map((r) => `• ${r.title}: ${r.price > 0 ? formatPriceLabel(r.price, r.currency || cur) : "FREE"}`).join("\n");
      const selected = fresh.shippingRate || rates[0];
      // Shopify prices its shipping rates in the store's own currency, while the order total can be in the shopper's market currency.
      const checkoutCurrency = String(fresh.orderQuote?.currency || context.cart?.currency || "").toUpperCase();
      const rateCurrency = String(cur || "").toUpperCase();
      const currencyDiffers = Boolean(checkoutCurrency && rateCurrency && checkoutCurrency !== rateCurrency);
      const currencyNote = currencyDiffers
        ? ` These shipping prices are in the store's currency (${rateCurrency}); the order total can be in ${checkoutCurrency}. Say this once so the two are not mixed up, and never convert between them yourself.`
        : "";
      ctx.fallbackSpeech = isHindi
        ? `Is address ke liye store ke shipping options:\n${list}\n${currencyDiffers ? `(Shipping ke daam store ki currency, ${rateCurrency}, mein hain.)\n` : ""}Abhi **${selected.title}** select hai. Badalna ho to bata do.`
        : `Here are the store's shipping options for this address:\n${list}\n**${selected.title}** is selected right now.${currencyDiffers ? ` (Shipping prices are in the store's currency, ${rateCurrency}.)` : ""} Tell me if you'd like to switch.`;
      return {
        status: "ok",
        rates: rates.map((r) => ({ title: r.title, price: r.price, formattedPrice: r.price > 0 ? formatPriceLabel(r.price, r.currency || cur) : "FREE" })),
        selected: selected.title,
        deliveryEstimate: null,
        note: "These are the store's own Shopify shipping rates. Delivery dates are not verified; never promise one." + currencyNote,
      };
    },
    list_categories: async () => {
      const categories = await listCategories(storeId);
      const names = categories
        .map((item) =>
          typeof item === "string"
            ? item
            : item.title || item.name || item.category,
        )
        .filter(Boolean);
      const bulletList = names.map((n, idx) => `${idx + 1}. **${n}**`).join("\n");
      ctx.fallbackSpeech = names.length
        ? `${isHindi ? "Hamare store mein yeh categories available hain:" : "Here are the categories available in our store:"}\n${bulletList}\n${isHindi ? "Bataiye, kis category mein dekhna chahoge?" : "Which category would you like to explore first?"}`
        : isHindi
          ? "Abhi catalog categories nahi mil rahi hain. Kis cheez ki shopping karni hai?"
          : "I couldn't load the categories just yet. What are you looking for today?";
      return { categories: names, note: ctx.fallbackSpeech };
    },
    get_checkout_details: async () => {
      const session = await safeGet();
      const shipping = deduplicateAddress(session.shipping || {});
      const billing = deduplicateAddress(
        session.billingSameAsShipping === true
          ? shipping
          : session.billing || {},
      );
      const wantsBilling =
        /\bbilling\b/i.test(userMessage) &&
        !/\b(?:shipping|delivery)\b/i.test(userMessage);
      const address = wantsBilling ? billing : shipping;
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
      ctx.fallbackSpeech = summary
        ? `${wantsBilling ? (isHindi ? "Tumhara current billing address:" : "Your current billing address:") : isHindi ? "Current checkout ka delivery address:" : "Your current checkout delivery address:"} **${summary}**.${!wantsBilling && session.shippingNeedsUpdate ? (isHindi ? " Iski update abhi complete nahi hui; missing contact/address details confirm karo." : " Your requested update is still incomplete; please confirm the missing contact/address details.") : ""}`
        : wantsBilling
          ? isHindi
            ? "Billing address abhi confirm nahi hua. Kya delivery address hi use karein?"
            : "Your billing address hasn't been confirmed yet. Would you like to use the delivery address?"
          : isHindi
            ? "Abhi delivery address save nahi hua. Apna address batao."
            : "No delivery address has been saved for this checkout yet. Please share it.";
      if (
        billingRelationshipIntent(userMessage) === "question" &&
        /\bsame\b/i.test(userMessage)
      ) {
        ctx.fallbackSpeech = session.billingNeedsUpdate
          ? isHindi
            ? "Tumne alag billing address manga hai; naya billing address abhi chahiye."
            : "You've requested a separate billing address; I still need the new billing details."
          : session.billingSameAsShipping === true
            ? isHindi
              ? "Haan, current checkout mein billing aur delivery address same hain."
              : "Yes, your current checkout uses the same address for billing and delivery."
            : session.billingSameAsShipping === false
              ? isHindi
                ? "Current checkout mein billing address alag hai."
                : "Your current checkout uses a separate billing address."
              : isHindi
                ? "Billing address abhi confirm nahi hua. Kya delivery address hi use karein?"
                : "Your billing address hasn't been confirmed yet. Would you like to use the delivery address?";
      }
      if (wantsBilling && session.billingNeedsUpdate)
        ctx.fallbackSpeech = isHindi
          ? "Tumhara naya billing address abhi complete karna hai. Poora billing address bata do."
          : "Your new billing address still needs to be completed. Please share the full billing address you'd like to use.";
      return {
        status: "ok",
        shipping,
        billing,
        step: session.step,
        shippingNeedsUpdate: session.shippingNeedsUpdate,
        source: session.shippingSource || "unknown",
      };
    },
    request_shipping_update: async () => {
      await safeUpsert({
        shippingNeedsUpdate: true,
        shippingConfirmed: false,
        step: "address",
      });
      ctx.fallbackSpeech = isHindi
        ? "Theek hai. Apna naya delivery address batao; main account ka purana address dobara use nahi karungi."
        : "Please share the new delivery address. I won't switch back to the old account address.";
      return { status: "address_update_required" };
    },
    evaluate_product_look: async (targetHint = "") => {
      const memList =
        readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || [];
      let candidateName = String(targetHint || "").trim();
      if (!candidateName) {
        const cleanedMsg = userMessage
          .replace(
            /\b(?:ye|yeh|wo|woh|this|that|it|one|unpe|uspe|mujhpe|mere|upar|wife|girlfriend|pe|par|kaisa|kaisi|ksa|ksi|lagega|lagegi|lgega|lgegi|acha|accha|achi|acchi|suit|karega|karegi|jachega|jachegi|how|will|would|does|look|good|nice|great|on|her|him|me|for|8|month|pregnant|pregnancy|comfortable|rahega|rahegi|kya|batao|bataiye|hai)\b/gi,
            " ",
          )
          .replace(/[^a-zA-Z0-9\s'-]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (cleanedMsg.length >= 3) {
          candidateName = cleanedMsg;
        }
      }
      if (!candidateName && memList.length > 0 && memList[0]?.title) {
        candidateName = memList[0].title;
      }
      if (!candidateName) {
        for (let i = (history || []).length - 1; i >= 0; i--) {
          const msg = history[i]?.content || "";
          const matches = [...msg.matchAll(/\*\*([^*]+)\*\*/g)]
            .map((m) => m[1].replace(/\([^)]*\)\s*$/, "").trim())
            .filter(
              (t) =>
                t.length > 4 &&
                !/^(?:total|subtotal|discount|shipping|delivery|billing|order)/i.test(
                  t,
                ),
            );
          if (matches.length > 0) {
            candidateName = matches[0];
            break;
          }
        }
      }
      if (!candidateName) return null;

      const details = await getProductDetails(storeId, candidateName);
      if (details?.product) {
        const p = details.product;
        const cardProduct = {
          id: p.id || p.title,
          handle: p.handle,
          title: p.title,
          category: p.category,
          price: p.price,
          currency: p.currency,
          description: p.description,
          features: p.features,
          image: p.image,
          imageAlt: p.imageAlt || p.title,
          url: p.url,
          variants:
            Array.isArray(p.variants) && p.variants.length > 0
              ? p.variants
              : (p.options || []).map((o, i) => ({
                  id: o.id || `opt-${i}`,
                  title: o.name,
                  price: o.price,
                  sellable: o.inStock,
                  tracked: o.unitsInStock != null,
                  inventoryQuantity: o.unitsInStock,
                })),
          matchConfidence: details.matchConfidence ?? 0.9,
        };
        const alreadyShownInHistory = history.some(
          (h) =>
            h.role === "assistant" &&
            String(h.content || "")
              .toLowerCase()
              .includes(String(cardProduct.title || "").toLowerCase()),
        );
        ctx.suppressCardsThisTurn = false;
        foundProducts.clear();
        rememberForCards([cardProduct]);
        ctx.fallbackSpeech = buildShopOwnerPraiseReply(cardProduct, {
          lang,
          userMessage,
          history,
          alreadyShown: alreadyShownInHistory,
        });
        return {
          status: "ok",
          mode: "shop_owner_praise",
          product: compactProduct(cardProduct, { brief: false }),
          note: "Customer asked about the product(s) above. Answer their actual question from these facts only (options are sizes/colours with stock).",
        };
      }
      return null;
    },

    search_products: async (args) => {
      // A model sometimes names the term field its own way ("searchItem", "query"): the word the shopper wants must not be lost.
      if (args && typeof args === "object" && !String(args.searchTerm ?? "").trim()) {
        const alias = ["searchItem", "search_term", "query", "item", "term", "keyword", "product"].map((k) => args[k]).find((v) => typeof v === "string" && v.trim());
        if (alias) args = { ...args, searchTerm: alias.trim() };
      }
      if (travelRequest)
        return handlers.get_recommendations({
          keywords: [],
          count: 6,
        });
      if (convTurn) {
        foundProducts.clear();
        const reply = buildConversationalReply(
          convTurn,
          lang,
          customerFirstName,
          agentNameFor(context),
        );
        if (reply) ctx.fallbackSpeech = reply;
        return {
          mode: "conversational_no_products",
          note: "Customer did not ask to see product cards. Reply conversationally without listing specific products.",
          products: [],
        };
      }

      const followUpInSearch = await handleConversationalFollowUp(
        Array.isArray(args.searchTerms) && args.searchTerms.length >= 2
          ? args.searchTerms
          : [],
      );
      if (followUpInSearch) return followUpInSearch;

      if (!llmMode && isOpinionOrPraiseQuestion(userMessage)) {
        const praised = await handlers.evaluate_product_look(
          args.searchTerm || "",
        );
        if (praised) return praised;
      }

      const discoveryNeedInSearch = evaluateShoppingDiscoveryNeed(args);
      if (discoveryNeedInSearch) return discoveryNeedInSearch;

      // "compare A and B": two named products go to compare_products (both cards and a head-to-head), never to a plain
      // search that would answer with look-alikes and accessories.
      if (llmMode && isComparisonRequest(userMessage)) {
        const names = comparedNames(userMessage, args.searchTerms);
        if (names.length >= 2) return handlers.compare_products({ productNames: names });
      }

      // Ordering words ("cheapest", "sabse mehnga") in the term or the message set the price order themselves, so the result
      // does not depend on the model remembering the sortBy argument; the words are not searched for in product text.
      // "and the most expensive one?" after a laptop search means the most expensive LAPTOP: with no category of its own, a price-order request
      // keeps the category of the shopper's last search (it used to search the whole store and answer with a coat).
      {
        const own = parsePriceSort(String(args.searchTerm ?? "")).term || String(args.searchTerm ?? "");
        const fromMessage = parsePriceSort(userMessage);
        const categoryWords = (text) => parseSearchTerm(text).words.filter((w) => !["one", "ones", "it", "thing", "things", "wala", "wali", "wale", "mehnga", "sasta"].includes(w));
        if (fromMessage.sort && categoryWords(own).length === 0 && categoryWords(fromMessage.term).length === 0) {
          let remembered = readCheckoutMemory(storeId, context.clientId)?.lastSearchTerm;
          // The first turn may have been answered from the pre-fetched matches without a search call, so nothing was remembered:
          // take the category words of the shopper's most recent earlier message that has some.
          if (!remembered) {
            for (let i = (history || []).length - 1; i >= 0 && !remembered; i--) {
              if (history[i]?.role !== "user") continue;
              const prior = parsePriceSort(String(history[i].content || "")).term || String(history[i].content || "");
              const words = categoryWords(prior);
              if (words.length) remembered = words.slice(0, 3).join(" ");
            }
          }
          if (remembered) args = { ...args, searchTerm: remembered };
        }
      }
      const termSort = parsePriceSort(String(args.searchTerm ?? ""));
      const messageSort = termSort.sort ? termSort : parsePriceSort(userMessage);
      const single = termSort.sort ? termSort.term : String(args.searchTerm ?? "").trim();
      if (single && parseSearchTerm(single).words.length > 0) writeCheckoutMemory(storeId, context.clientId, { lastSearchTerm: single });
      if (addIntent.isAddIntent) {
        return handlers.add_to_cart({
          productName: addIntent.productName || args.searchTerm || "",
          variantName: addIntent.variantName || "",
          quantity: 1,
        });
      }

      // A named type with nothing to buy ("Bags", one sold-out item) must not hide the store's related types that have stock
      // ("Laptop Bags", "School Bags"): the search already weighs those, so only types with stock narrow the result.
      let userRequestedCategories = extractRequestedCategories(userMessage, storeId).filter(
        (cat) =>
          shopifyService.categoryInStock?.(storeId, cat) !== 0 &&
          !autoExcluded.some(
            (ex) =>
              cat.includes(ex),
          ),
      );

      // The model may search the store's own name for what the shopper said ("portable charger" -> "power bank"). Its term then
      // names the category, not the shopper's words, so the results are held to that category.
      const termCategory = String(args.searchTerm ?? "").trim() ? shopifyService.inferRequestedCategory?.(String(args.searchTerm).trim(), storeId) || "" : "";
      if (termCategory && shopifyService.categoryInStock?.(storeId, termCategory) !== 0 && !userRequestedCategories.includes(termCategory) && !(Array.isArray(args.searchTerms) && args.searchTerms.length >= 2)) {
        userRequestedCategories = [termCategory];
      }

      let terms = (Array.isArray(args.searchTerms) ? args.searchTerms : [])
        .map((t) => String(t ?? "").trim())
        .filter(Boolean)
        .slice(0, 5);

      if (terms.length < 2 && single) {
        const splitFromSingle = splitProductAsks(single);
        if (splitFromSingle.length >= 2) {
          terms = splitFromSingle;
        }
      }
      if (userRequestedCategories.length >= 2 && terms.length < userRequestedCategories.length) {
        terms = [...userRequestedCategories];
      }

      if (userRequestedCategories.length === 1 && terms.length >= 2) {
        const targetCat = userRequestedCategories[0];
        const filteredTerms = terms.filter((t) => {
          const c = shopifyService.inferRequestedCategory?.(t, storeId) || "";
          return !c || c === targetCat;
        });
        // Both things the shopper named stay in the search ("shirt ya t-shirt"); only terms that point at another category are dropped.
        terms = filteredTerms;
      }

      const spoken = parseSearchFilters(userMessage);
      const argGender = normalizeGenderArg(args.gender);
      const verifiedSelfG = resolveVerifiedSelfGender(args);
      // who the shopper names in THIS message ("for my son", "boy") beats the gender saved earlier in the chat or the model's guess
      const namedNow = shopifyService.parseSearchTerm?.(userMessage)?.gender || "";
      // The saved chat gender only knows adults ("my son" is saved as men). When the model, which read the whole chat, says the
      // shopper is buying for a child, that wins over the saved value, so a 6 year old is never shown men's sizes.
      const forChild = argGender === "kids" ? "kids" : "";
      const resolvedG = namedNow || forChild || defaultGender || verifiedSelfG || argGender || "";
      const constraints = parseSearchFilters(userMessage, {
        gender: resolvedG,
        color: spoken.colors.join(" ") || args.color,
        size: spoken.sizes.join(" ") || args.size,
        maxPrice: args.maxPrice,
      });
      const genderHint = constraints.gender || resolvedG || "";
      const singleIsGenericOnly =
        !single ||
        single
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((w) => GENERIC_RECOMMENDATION_WORDS.has(w));

      const sortBy = args.sortBy === "price_low" || args.sortBy === "price_high" ? args.sortBy : messageSort.sort;
      // "1000 ke andar kya milega?": only a budget, no kind of product. The whole store is browsed within that budget (cheapest first),
      // never searched for the words "items under 1000" (no match) nor listed without the budget (a real run listed ₹4,700 dresses,
      // the budget check then removed all of them and the reply said nothing costs under ₹1,000 while a ₹900 mouse was in stock).
      const BUDGET_ONLY_WORDS = new Set(["under", "below", "less", "than", "within", "upto", "max", "budget", "andar", "tak", "kam", "neeche", "rupees", "rupaye", "rs", "inr", "usd", "dollars", "price", "range", "kya", "kuch", "koi", "mil", "milega", "sakta", "hazar", "thousand"]);
      const singleProductWords = parseSearchTerm(single).words.filter((w) => !/^\d/.test(w) && !BUDGET_ONLY_WORDS.has(w) && !GENERIC_RECOMMENDATION_WORDS.has(w));
      const budgetOnly = constraints.maxPrice || Number(args.maxPrice) > 0 ? (!single || singleProductWords.length === 0) : false;
      if (budgetOnly && userRequestedCategories.length === 0 && terms.length === 0) {
        return handlers.get_recommendations({
          keywords: [],
          gender: genderHint || undefined,
          maxPrice: constraints.maxPrice || Number(args.maxPrice),
          count: DEFAULT_RECOMMENDATIONS,
        });
      }
      if (
        !sortBy &&
        userRequestedCategories.length === 0 &&
        genderHint &&
        terms.length === 0 &&
        singleIsGenericOnly
      ) {
        return handlers.get_recommendations({
          keywords: [],
          gender: genderHint,
          maxPrice: constraints.maxPrice || args.maxPrice,
          count: DEFAULT_RECOMMENDATIONS,
        });
      }

      if (terms.length >= 2) {
        const groups = await searchShopifyProductsMany(storeId, terms, {
          defaultGender: genderHint,
        });
        const all = [];
        for (const group of groups) {
          // A group is held to the store category its own term names; a term that names no category ("shirt" next to the
          // category "t-shirt") is not cut down to the other term's category.
          const groupCategory = userRequestedCategories.length > 0 ? shopifyService.inferRequestedCategory?.(group.term, storeId) || "" : "";
          const validGroupProducts = groupCategory
            ? group.products.filter((p) => matchesRequestedCategory(p, groupCategory, userMessage))
            : group.products;
          rememberForCards(validGroupProducts);
          all.push(...validGroupProducts);
        }
        if (all.length > 0) {
          ctx.fallbackSpeech = buildFriendlyProductsFallback(all, lang, {
            userMessage,
            history,
          });
        }
        return {
          mode: "multi",
          groups: groups.map((group) => ({
            term: group.term,
            found: group.products.length,
            products: group.products
              .slice(0, 6)
              .map((product) => compactProduct(product, { brief: true })),
          })),
          products: all
            .slice(0, MAX_CARDS)
            .map((product) => compactProduct(product, { brief: true })),
          note: "List the matching products as bullet points, one per line (- **Product Name** (Price): feature & available sizes).",
        };
      }

      // "cheapest phone" with the model's sortBy but no item: the item is read from the shopper's words (the store's own type of
      // what they name), so only that item is ordered by price, not the whole catalog.
      let sortedItem = "";
      if (sortBy && !single && terms.length === 0 && userRequestedCategories.length === 0) {
        const named = await shopifyService.probeCatalog?.(storeId, userMessage, { limit: 40 }).catch(() => []);
        const counts = new Map();
        for (const p of named || []) if (p.productType) counts.set(p.productType, (counts.get(p.productType) || 0) + 1);
        sortedItem = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      }
      const baseTerm = single || terms[0] || userRequestedCategories[0] || sortedItem || "";
      const baseWords = new Set(baseTerm.toLowerCase().split(/\s+/).filter(Boolean));
      // A colour or size already written in the term is not added a second time ("black shirt" stays "black shirt").
      const query = [baseTerm, ...[...constraints.colors, ...constraints.sizes].filter((w) => !baseWords.has(String(w).toLowerCase()))]
        .filter(Boolean)
        .join(" ");
      let products = await searchShopifyProducts(storeId, query, {
        color: constraints.colors.join(" "),
        size: constraints.sizes.join(" "),
        maxPrice: constraints.maxPrice,
        sort: sortBy,
        defaultGender: genderHint,
        excludeProductIds: [...seenProductIds],
        seenProductTitles: [...seenProductTitles],
        seed: turnSeed,
      });
      // A real match that is sold out is not "the store does not carry it": remembered here so the answer can say so.
      const soldOutMatches = products
        .filter((p) => Array.isArray(p.variants) && p.variants.length > 0 && !p.variants.some((v) => v.sellable) && Number(p.matchConfidence ?? 1) >= 0.5)
        .slice(0, 3);
      // the shopper's own words can name a storage size ("256gb") that the search term left out
      products = filterProductsByVariantHints(products, query, { storageText: userMessage });

      if (
        userRequestedCategories.length === 1 &&
        products.length <= 1 &&
        !constraints.colors.length &&
        !constraints.sizes.length &&
        !constraints.maxPrice
      ) {
        const catKey = userRequestedCategories[0];
        const broader = await searchShopifyProducts(storeId, catKey, {
          defaultGender: genderHint,
          excludeProductIds: [...seenProductIds],
          seenProductTitles: [...seenProductTitles],
          seed: turnSeed,
        });
        for (const bp of broader) {
          if (
            matchesRequestedCategory(bp, catKey, userMessage) &&
            !products.some((existing) => existing.id === bp.id)
          ) {
            products.push(bp);
          }
        }
      }

      if (userRequestedCategories.length > 0) {
        // A product the owner filed under another type ("Boys Kids Wrist Watch" under "Gift") still belongs when its own
        // name says the category and the search matched it by name.
        const namesCategory = (p, cat) => {
          if (p?.matchKind !== "exact") return false;
          const title = String(p.title || "").toLowerCase();
          return String(cat).split(/[_\s]+/).map((w) => w.replace(/(?:es|s)$/, "")).some((w) => w.length >= 3 && title.includes(w));
        };
        products = products.filter((p) =>
          userRequestedCategories.some((cat) =>
            matchesRequestedCategory(p, cat, userMessage) || namesCategory(p, cat),
          ),
        );
      }
      const unseen = products.filter(
        (p) =>
          !seenProductIds.has(String(p.id)) &&
          !seenProductTitles.has(
            String(p.title || "")
              .toLowerCase()
              .trim(),
          ),
      );

      const wantsMoreOrDifferent =
        /\b(more|another|other|different|else|alava|alawa|aur\s+(?:dikhao|dikhaiye|options?|items?|products?)|or\s+kuch|kuch\s+(?:aur|or)|kch\s+(?:aur|or)|dusra|doosra|alag)\b/i.test(
          userMessage,
        );
      let top;
      if (wantsMoreOrDifferent) {
        top = unseen.slice(0, 8);
      } else if (unseen.length > 0) {
        top = [
          ...unseen,
          ...products.filter(
            (p) =>
              seenProductIds.has(String(p.id)) ||
              seenProductTitles.has(
                String(p.title || "")
                  .toLowerCase()
                  .trim(),
              ),
          ),
        ].slice(0, 8);
      } else if (products.length > 0) {
        top = products.slice(0, 8);
      } else {
        top = [];
      }
      const nothingNew =
        wantsMoreOrDifferent && top.length === 0 && products.length > 0;

      // what can be bought now comes first; a sold-out match never leads the list
      const sellableNow = (p) =>
        !Array.isArray(p?.variants) || p.variants.length === 0 || p.variants.some((v) => v.sellable);
      top = [...top.filter(sellableNow), ...top.filter((p) => !sellableNow(p))];

      rememberForCards(top);
      if (top.length > 0) {
        ctx.fallbackSpeech = buildFriendlyProductsFallback(top, lang, {
          userMessage,
          history,
        });
      } else {
        const named = echoableQuery(query);
        ctx.fallbackSpeech = isHindi
          ? `Abhi hamare store par ${named ? `**${named}**` : "yeh"} available nahi hai. Bataiye, main aapke liye aur kya check karoon?`
          : `We don't have ${named ? `**${named}**` : "that"} available in our store right now. What else can I check for you today?`;
        if (soldOutMatches.length > 0) {
          const names = soldOutMatches.map((p) => `**${p.title}**`).join(", ");
          ctx.fallbackSpeech = isHindi
            ? `${names} hamare store par hai, lekin abhi sold out hai. Bataiye, main aur kya check karoon?`
            : `${names} is sold out right now. What else can I check for you today?`;
        }
        if (nothingNew) {
          ctx.fallbackSpeech = isHindi
            ? `Is category mein jo bhi humare paas hai wo aapko pehle hi dikha diya hai.`
            : `That's everything we have in this category; I've already shown you all of it.`;
          return {
            status: "no_new_products",
            searchedFor: query,
            reason:
              "Every matching product has already been shown to this customer; the store has no other items for this request.",
            alreadyShown: products.slice(0, 6).map((p) => p.title),
            note: "Tell the customer plainly that this is all the store has for this request and ask what else they would like to look for. Do not dump a list of store categories.",
            products: [],
          };
        }
        const askedCats =
          userRequestedCategories.length > 0
            ? userRequestedCategories
            : [shopifyService.inferRequestedCategory?.(query, storeId) || ""].filter(
                Boolean,
              );
        let nearest = [];
        let cheapest = null;
        try {
          if (askedCats.length > 0) {
            const pool = await recommendProducts(storeId, {
              keywords: askedCats,
              strictCategories: askedCats,
              gender: genderHint,
              limit: 6,
              excludeProductIds: [],
              seenProductTitles: [],
              seed: 0,
              userQuery: "",
            });
            nearest = (pool || []).slice(0, 4);
            const priced = (pool || [])
              .filter((p) => Number(p.price) > 0)
              .sort((a, b) => Number(a.price) - Number(b.price));
            cheapest = priced[0] || null;
          }
        } catch {}
        // S19: a price limit that nothing meets is not "the store does not stock it". The same search without the limit says
        // whether the item exists; the cheapest of those is the honest answer ("it starts from ...").
        if (nearest.length === 0 && Number(constraints.maxPrice) > 0) {
          const withoutLimit = await searchShopifyProducts(storeId, query, {
            color: constraints.colors.join(" "),
            size: constraints.sizes.join(" "),
            sort: "price_low",
            defaultGender: genderHint,
            excludeProductIds: [],
            seenProductTitles: [],
            seed: turnSeed,
          }).catch(() => []);
          const priced = withoutLimit
            .filter((p) => sellableNow(p) && Number(p.price) > 0 && Number(p.matchConfidence ?? 1) >= 0.5)
            .sort((x, y) => Number(x.price) - Number(y.price));
          if (priced.length > 0) {
            nearest = priced.slice(0, 4);
            cheapest = priced[0];
          }
        }
        const overBudget =
          Number(constraints.maxPrice) > 0 &&
          nearest.length > 0 &&
          !nearest.some((p) => Number(p.price) <= Number(constraints.maxPrice));
        // a costlier item the reply offers by name gets its card (cardsForAnswer shows only the ones named)
        if (overBudget) rememberForCards(nearest);
        // the wording used when the model cannot answer must not say "we don't have it" about an item that only costs more
        if (overBudget && cheapest) {
          const from = formatPriceLabel(cheapest.price, cheapest.currency);
          ctx.fallbackSpeech = isHindi
            ? `Is budget mein abhi kuch nahi hai. Sabse kam daam wala **${cheapest.title}** ${from} ka hai. Dekhna chahenge?`
            : `Nothing fits that budget right now. The lowest priced one is **${cheapest.title}** at ${from}. Would you like to see it?`;
        }
        // The product exists but not in the size or colour asked for ("boys sneakers size 5" when they come in UK 10-13): show it with
        // the options it does have, instead of "we don't have it".
        if (nearest.length === 0 && (constraints.sizes.length > 0 || constraints.colors.length > 0)) {
          const optionWords = new Set([...constraints.sizes, ...constraints.colors].map((w) => String(w).toLowerCase()));
          const plainQuery = String(query || "").split(/\s+/).filter((w) => w && !optionWords.has(w.toLowerCase())).join(" ");
          if (plainQuery) {
            const withoutOption = await searchShopifyProducts(storeId, plainQuery, {
              defaultGender: genderHint,
              excludeProductIds: [],
              seenProductTitles: [],
              seed: turnSeed,
            }).catch(() => []);
            const sellable = withoutOption.filter(sellableNow).slice(0, 4);
            if (sellable.length > 0) {
              rememberForCards(sellable);
              return {
                status: "requested_option_unavailable",
                searchedFor: query,
                requestedSize: constraints.sizes.join(" ") || undefined,
                requestedColor: constraints.colors.join(" ") || undefined,
                products: sellable.map((product) => compactProduct(product, { brief: sellable.length !== 1 })),
                note: "These products exist but NOT in the size or colour the customer asked for. Say so plainly, tell them which sizes or colours each one does come in (see options), and offer those. Never say the product itself is unavailable.",
              };
            }
          }
        }
        if (nearest.length === 0) {
          const byNeed = await productsForNeed(query, constraints.maxPrice).catch(() => ({ labels: [], products: [] }));
          if (byNeed.products.length > 0) {
            rememberForCards(byNeed.products);
            return {
              status: "ok",
              mode: "need_match",
              searchedFor: query,
              matchedTypes: byNeed.labels,
              foundCount: byNeed.products.length,
              products: byNeed.products.map((product) => compactProduct(product, { brief: byNeed.products.length !== 1 })),
              note: NEED_MATCH_NOTE,
            };
          }
        }
        const stillNarrow = constraints.colors.length > 0 || constraints.sizes.length > 0 || Number(constraints.maxPrice) > 0;
        const widen =
          nearest.length === 0 && !stillNarrow
            ? shopifyService.otherCategoriesInStock?.(storeId, askedCats) || []
            : [];
        // what the shopper asked for and the store could not give: the owner sees it under Catalog insights
        if (nearest.length === 0) ctx.missedSearches?.push({ term: String(query || "").trim().slice(0, 80), soldOut: soldOutMatches.length > 0 });
        return {
          status:
            nearest.length > 0
              ? overBudget
                ? "over_budget"
                : "closest_alternatives"
              : "no_match",
          searchedFor: query,
          ...(widen.length > 0 ? { moreInStore: widen, moreNote: WIDEN_SEARCH_NOTE } : {}),
          requestedColor: constraints.colors.join(" ") || undefined,
          requestedSize: constraints.sizes.join(" ") || undefined,
          budget:
            Number(constraints.maxPrice) > 0
              ? Number(constraints.maxPrice)
              : undefined,
          ...(soldOutMatches.length > 0 && nearest.length === 0
            ? { soldOutMatches: soldOutMatches.map((p) => ({ title: p.title, formattedPrice: formatPriceLabel(p.price, p.currency) })) }
            : {}),
          reason: overBudget
            ? "Items exist in this category but none within the customer's budget."
            : soldOutMatches.length > 0 && nearest.length === 0
              ? "The store carries this item (see soldOutMatches) but it is SOLD OUT right now. Say it is sold out; never say the store does not carry it."
              : nearest.length > 0
              ? "The store has no item that exactly matches this request. The items listed under closestAlternatives are only the nearest in the same category, NOT what was asked for."
              : "The store does not stock this item.",
          closestAlternatives: nearest.map((p) =>
            compactProduct(p, { brief: true }),
          ),
          cheapestInCategory: cheapest
            ? {
                title: cheapest.title,
                formattedPrice: formatPriceLabel(
                  cheapest.price,
                  cheapest.currency,
                ),
              }
            : undefined,
          note: overBudget
            ? "The store HAS this item, but nothing within the customer's price limit. Say that plainly, name the lowest priced one (cheapestInCategory) with its price, and ask whether to look at it or at something else. Never say the store does not have the item."
            : "Say honestly that the exact item is not available in our store right now and ask what else they would like to explore. NEVER dump or recite a comma-separated list of store categories.",
          products: [],
        };
      }
      const brief = top.length !== 1;
      // The shopper's qualifier ("portable" in "portable charger", "baby" in "baby clothes") is in none of the products
      // found: they are the nearest of the same kind, not what was asked, and the store's other types may fit better.
      const qualifierUnmet =
        top.length > 0 && top.every((p) => Array.isArray(p.unmatchedQueryWords) && p.unmatchedQueryWords.length > 0);
      const allCategoryOnly =
        top.length > 0 && (top.every((p) => Boolean(p.notExactMatch)) || qualifierUnmet || top.every((p) => p.matchKind === "description"));
      const genderMismatchOnly = top.length > 0 && top.every((p) => Boolean(p.genderMismatch));
      // Only "same word, other kind of item" came back (a laptop for "laptop bag"): see if the store has what they meant.
      if (allCategoryOnly && !genderMismatchOnly) {
        const byNeed = await productsForNeed(query, constraints.maxPrice).catch(() => ({ labels: [], products: [] }));
        const otherKind = byNeed.products.filter((p) => !top.some((t) => t.category && t.category === p.category));
        if (otherKind.length > 0) {
          forgetCards(top);
          rememberForCards(otherKind);
          return {
            status: "ok",
            mode: "need_match",
            searchedFor: query,
            matchedTypes: byNeed.labels,
            foundCount: otherKind.length,
            products: otherKind.map((product) => compactProduct(product, { brief: otherKind.length !== 1 })),
            note: NEED_MATCH_NOTE,
          };
        }
      }
      // Nothing can be bought under this word and the shopper did not narrow it down: tell the model what
      // else the store really has (from this store's own categories) so it can widen the search itself.
      const narrowed = constraints.colors.length > 0 || constraints.sizes.length > 0 || Number(constraints.maxPrice) > 0;
      const buyableCount = top.filter(sellableNow).length;
      // The shopper said more than the word searched ("something to carry my laptop" searched as "laptop"): the word may
      // have found a different kind of item than the need. Items of the store's own types that fit the need are added.
      const wordsIn = (text) => (String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).length;
      let alsoByMeaning = [];
      let alsoTypes = [];
      // Only a message that says clearly more than the searched word (a need, not "show me watches") is worth the extra model question.
      if (!allCategoryOnly && !narrowed && wordsIn(userMessage) >= wordsIn(query) + 3) {
        const byNeed = await productsForNeed(query, constraints.maxPrice).catch(() => ({ labels: [], products: [] }));
        alsoByMeaning = byNeed.products.filter((p) => !top.some((t) => t.category && t.category === p.category)).slice(0, 6);
        alsoTypes = byNeed.labels;
        if (alsoByMeaning.length > 0) rememberForCards(alsoByMeaning);
      }
      const moreInStore =
        !narrowed && buyableCount === 0
          ? shopifyService.otherCategoriesInStock?.(storeId, top.map((p) => p.category).filter(Boolean)) || []
          : [];
      // The exact product the shopper named is in the store but sold out ("Wireless Bluetooth Earbuds"): say so first, then the
      // alternatives. A real run listed four other earbuds without a word about the one asked for (2026-11-21).
      const soldOutNamed = (() => {
        try {
          const summary = getCachedCatalogSummary?.(storeId);
          const key = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
          const q = key(query);
          if (!q || q.split(" ").length < 2) return "";
          const all = Array.isArray(summary?.allProducts) ? summary.allProducts : [];
          const hit = all.find((p) => key(p.title) === q || (key(p.title).includes(q) && q.length >= 8));
          if (!hit) return "";
          const sellable = top.some((t) => key(t.title) === key(hit.title));
          return sellable ? "" : hit.title;
        } catch { return ""; }
      })();
      return {
        status: allCategoryOnly ? "closest_alternatives" : "ok",
        mode: "single",
        searchedCategory: query,
        ...(soldOutNamed ? { requestedItemSoldOut: soldOutNamed, soldOutNote: `"${soldOutNamed}" is in this store but sold out right now. Say that first in one short line, then offer the products listed here as the alternatives.` } : {}),
        // "cheapest" / "most expensive": a ranked request, not a browse (the cards are the products the reply names)
        ...(sortBy ? { sortedBy: sortBy } : {}),
        foundCount: top.length,
        // said in words, so a small model does not answer "nothing under your budget" next to a product that costs less than it
        ...(!allCategoryOnly && Number(constraints.maxPrice) > 0 && top.every((p) => Number(p.price) <= Number(constraints.maxPrice))
          ? { budget: Number(constraints.maxPrice), withinBudget: "Every product listed here costs no more than the customer's limit." }
          : {}),
        ...(moreInStore.length > 0
          ? {
              inStockCount: buyableCount,
              moreInStore,
              moreNote: WIDEN_SEARCH_NOTE,
            }
          : {}),
        ...(allCategoryOnly
          ? {
              reason: genderMismatchOnly
                ? `The store has this item, but none of it is listed for "${top[0].requestedGender}". Say that plainly, then show these as what the store does have so the customer can decide.`
                : "No product matches every detail the customer asked for; these are the closest in the same category. Say that first, then present them as the nearest options.",
            }
          : {}),
        products: top.map((product) => compactProduct(product, { brief })),
        ...(alsoByMeaning.length > 0
          ? { alsoMatchesByMeaning: alsoByMeaning.map((product) => compactProduct(product, { brief: true })), matchedTypes: alsoTypes, alsoNote: "These are other items of the store's own that fit what the customer described, not just the word searched. Show the ones that serve the need first." }
          : {}),
        note:
          top.length > 1
            ? SEVERAL_PRODUCTS_NOTE
            : undefined,
      };
    },

    get_product_details: async (args) => {
      if (addIntent.isAddIntent) {
        return handlers.add_to_cart({
          productName: addIntent.productName || args.productName || "",
          variantName: addIntent.variantName || "",
          quantity: 1,
        });
      }

      const result = await getProductDetails(storeId, args.productName);
      if (result.product) {
        const p = result.product;
        const cardProduct = {
          id: p.id || p.title,
          handle: p.handle,
          title: p.title,
          category: p.category,
          price: p.price,
          currency: p.currency,
          description: p.description,
          features: p.features,
          image: p.image,
          imageAlt: p.imageAlt || p.title,
          url: p.url,
          variants:
            Array.isArray(p.variants) && p.variants.length > 0
              ? p.variants
              : (p.options || []).map((o, i) => ({
                  id: o.id || `opt-${i}`,
                  title: o.name,
                  price: o.price,
                  sellable: o.inStock,
                  tracked: o.unitsInStock != null,
                  inventoryQuantity: o.unitsInStock,
                })),
          matchConfidence: result.matchConfidence ?? 0.85,
        };
        rememberForCards([cardProduct]);

        ctx.fallbackSpeech = "";
      }
      return result;
    },

    compare_products: async (args) => {
      const names = Array.isArray(args.productNames) ? args.productNames : [];
      const followUpComp = await handleConversationalFollowUp(names);
      if (followUpComp) return followUpComp;

      const result = await compareProducts(storeId, names);
      const forCards = (result.items || [])
        .filter((item) => item.found && item.product)
        .map((item, index) => {
          const p = item.product;
          return {
            id: p.id || `${p.title}-${index}`,
            title: p.title,
            price: p.price,
            currency: p.currency,
            description: p.description,
            features: p.features,
            image: p.image || null,
            imageAlt: p.imageAlt || p.title || null,
            handle: p.handle,
            url: p.url,
            variants: Array.isArray(p.variants) ? p.variants : [],
            matchConfidence:
              p.matchConfidence != null ? p.matchConfidence : 0.85,
          };
        });
      if (forCards.length) {
        ctx.suppressCardsThisTurn = false;
        foundProducts.clear();
        const comparedCards = buildComparisonChecklist(forCards.slice(0, 4), 5);
        rememberForCards(comparedCards);
        ctx.fallbackSpeech = buildShopOwnerComparisonReply(comparedCards, {
          lang,
          userMessage,
          history,
        });
        // Prefer card payload with comparison checklist over raw tool items
        return {
          ...result,
          mode: "comparison",
          ...comparisonToolPayload(comparedCards),
        };
      }
      return result;
    },

    check_variant_availability: async (args) => {
      const res = await checkVariantAvailability(storeId, {
        productName: args.productName,
        variantName: args.variantName,
        quantity: args.quantity,
      });
      if (res.status === "ok") {
        if (res.product) {
          ctx.suppressCardsThisTurn = false;
          foundProducts.clear();
          rememberForCards([res.product]);
        }
        ctx.fallbackSpeech = res.available
          ? isHindi
            ? `Haan dost, खुशखबरी! **${res.title}**${
                res.requestedVariant ? ` (${res.requestedVariant})` : ""
              } abhi stock mein available hai. Kaho toh abhi cart mein add kar doon?`
            : `Good news! **${res.title}**${
                res.requestedVariant ? ` (${res.requestedVariant})` : ""
              } is in stock right now. Want me to add it to your cart?`
          : isHindi
            ? `Oh no yaar, **${res.title}**${
                res.requestedVariant ? ` (${res.requestedVariant})` : ""
              } filhal out of stock hai.`
            : `Aw, **${res.title}**${
                res.requestedVariant ? ` (${res.requestedVariant})` : ""
              } is currently out of stock.`;
      }
      return res;
    },

    get_recommendations: async (args) => {
      if (convTurn) {
        foundProducts.clear();
        const reply = buildConversationalReply(
          convTurn,
          lang,
          customerFirstName,
          agentNameFor(context),
        );
        if (reply) ctx.fallbackSpeech = reply;
        return {
          products: [],
          note: "Customer asked a conversational/meta question, not for product cards.",
        };
      }

      if (!travelRequest) {
        const followUpInRec = await handleConversationalFollowUp();
        if (followUpInRec) return followUpInRec;
        if (!llmMode && isOpinionOrPraiseQuestion(userMessage)) {
          const praised = await handlers.evaluate_product_look();
          if (praised) return praised;
        }
        const discoveryNeedInRec = evaluateShoppingDiscoveryNeed(args);
        if (discoveryNeedInRec) return discoveryNeedInRec;
      }

      if (addIntent.isAddIntent && addIntent.productName) {
        return handlers.add_to_cart({
          productName: addIntent.productName,
          variantName: addIntent.variantName || "",
          quantity: 1,
        });
      }

      const requested = Number.parseInt(args.count, 10);
      const explicitSmallCountMatch = userMessage.match(
        /\b([1-3])\s*(?:options?|products?|items?|shirts?|jeans|dresses?|kurtas?|kurtis?)\b/i,
      );
      const minRequestedCount = explicitSmallCountMatch
        ? Number(explicitSmallCountMatch[1])
        : DEFAULT_RECOMMENDATIONS;
      const limit = travelRequest
        ? 6
        : Math.min(
            Math.max(
              Number.isFinite(requested) ? requested : DEFAULT_RECOMMENDATIONS,
              minRequestedCount,
            ),
            MAX_RECOMMENDATIONS,
          );

      const rawKeywords = (
        Array.isArray(args.keywords)
          ? args.keywords
          : [args.keywords ?? args.keyword]
      )
        .map((word) => String(word ?? "").trim())
        .filter(Boolean);

      const explicitExcludes = Array.isArray(args.excludeKeywords)
        ? args.excludeKeywords.map((w) =>
            String(w || "")
              .toLowerCase()
              .trim(),
          )
        : [];
      const combinedExcludes = [
        ...new Set([...autoExcluded, ...explicitExcludes]),
      ];

      const userRequestedCategories = travelRequest
        ? []
        : extractRequestedCategories(userMessage, storeId).filter(
            (cat) =>
              shopifyService.categoryInStock?.(storeId, cat) !== 0 &&
              !combinedExcludes.some(
                (ex) =>
                  cat.includes(ex) ||
                  (cat === "dresses" && (ex === "dress" || ex === "maxi")),
              ),
          );

      let keywords = rawKeywords
        .filter(
          (kw) =>
            !combinedExcludes.some((ex) => ex && kw.toLowerCase().includes(ex)),
        )
        .filter((kw) => !GENERIC_RECOMMENDATION_WORDS.has(kw.toLowerCase()))
        .slice(0, 6);

      // If the shopper named some of these items themselves, show exactly those: the model's extra
      // keywords (e.g. "watch" added to a kurti request) are dropped. Data-driven: model args vs the
      // shopper's own words, no category lists.
      if (!travelRequest) {
        const named = shopifyService.keywordsNamedByShopper?.(keywords, userMessage) || [];
        if (named.length > 0 && named.length < keywords.length) keywords = named;
      }

      if (userRequestedCategories.length > 0 && !travelRequest) {
        const filteredKw = keywords.filter((kw) => {
          const kwCat = shopifyService.inferRequestedCategory?.(kw, storeId) || "";
          return kwCat && userRequestedCategories.includes(kwCat);
        });
        keywords = filteredKw.length > 0 ? filteredKw : userRequestedCategories;
      }

      const genderHint = travelRequest
        ? defaultGender || ""
        : defaultGender ||
          resolveVerifiedSelfGender(args) ||
          normalizeGenderArg(args.gender) ||
          "";
      // Nothing named ("kuch aur dikhao", "suggest something"): stay with what the shopper was just
      // looking at (the store categories named in the last few messages), before any other category.
      if (keywords.length === 0 && !travelRequest) {
        const recentText = (history || []).slice(-6).map((h) => h?.content || "").join(" ");
        const recentCategories = extractRequestedCategories(recentText, storeId).filter(
          (cat) => !combinedExcludes.some((ex) => ex && cat.includes(ex)),
        );
        if (recentCategories.length > 0) keywords = recentCategories.slice(0, 3);
      }
      // A budget with no product named looks at the whole catalog; pinning it to a few categories hid the cheap items.
      // No keyword given but the customer named something specific ("washing machine"): search for what they said instead
      // of showing the first few categories of the store, which would be unrelated items.
      if (keywords.length === 0 && !travelRequest && !(Number(args.maxPrice) > 0)) {
        const named = (shopifyService.parseSearchTerm?.(userMessage)?.words || []).filter((w) => !GENERIC_RECOMMENDATION_WORDS.has(String(w).toLowerCase()));
        if (named.length > 0) keywords = [named.join(" ")];
      }
      if (keywords.length === 0 && !(Number(args.maxPrice) > 0)) {
        const pool = (context.catalogCategories || [])
          .map((c) => String(c || "").trim())
          .filter(Boolean);
        if (pool.length > 0) {
          const shift = turnSeed % pool.length;
          keywords = [...pool.slice(shift), ...pool.slice(0, shift)].slice(0, 4);
        }
      }

      const effectiveUserQueryForRec = travelRequest ? "" : userMessage;

      const products = await recommendProducts(storeId, {
        keywords,
        excludeKeywords: combinedExcludes,
        excludeProductIds: [...seenProductIds],
        seenProductTitles: [...seenProductTitles],
        gender: genderHint,
        maxPrice: Number(args.maxPrice) > 0 ? Number(args.maxPrice) : null,
        limit,
        seed: travelRequest ? 0 : turnSeed,
        occasion: travelRequest ? "travel" : "",
        neutralOnly: travelRequest && !genderHint,
        userQuery: effectiveUserQueryForRec,
        strictCategories: travelRequest ? [] : userRequestedCategories,
      });

      const wasSeen = (p) =>
        seenProductIds.has(String(p.id)) ||
        seenProductTitles.has(
          String(p.title || "")
            .toLowerCase()
            .trim(),
        );
      const allAlreadySeen = products.length > 0 && products.every(wasSeen);
      const wantsMoreRec =
        /\b(more|another|other|different|else|aur\s+(?:dikhao|dikhaiye|options?|items?|products?)|kuch\s+(?:aur|or)|kch\s+(?:aur|or)|dusra|doosra|alag)\b/i.test(
          userMessage,
        );
      if (allAlreadySeen && wantsMoreRec) {
        return {
          status: "no_new_products",
          reason:
            "Every matching product was already shown to this customer; the store has nothing else for this request.",
          alreadyShown: products.slice(0, 6).map((p) => p.title),
          note: "Tell the customer plainly that this is everything available for this request and ask what else they would like to look for. Do not dump a list of store categories.",
          products: [],
        };
      }
      rememberForCards(products);

      if (products.length === 0) {
        const byNeed = await productsForNeed(keywords.join(" "), args.maxPrice).catch(() => ({ labels: [], products: [] }));
        if (byNeed.products.length > 0) {
          rememberForCards(byNeed.products);
          return {
            status: "ok",
            mode: "need_match",
            searchedFor: keywords,
            matchedTypes: byNeed.labels,
            products: byNeed.products.slice(0, limit).map((product) => compactProduct(product, { brief: true })),
            note: NEED_MATCH_NOTE,
          };
        }
        return {
          status: "no_match",
          searchedFor: keywords,
          reason:
            "Nothing in stock matched these keywords (and any budget/colour/size the customer gave).",
          note: "Say honestly that this item is not available in our store right now and ask what else they would like to explore. Never dump a comma-separated list of store categories.",
          products: [],
        };
      }

      if (travelRequest) {
        ctx.fallbackSpeech =
          `${isHindi ? "Journey aur poori trip ke liye alag-alag useful picks:" : "Useful picks for your journey and the rest of your trip:"}\n` +
          products
            .map(
              (product, idx) =>
                `${idx + 1}. **${product.title}** (${formatPriceLabel(product.price, product.currency)}): ${travelReason(product)}`,
            )
            .join("\n") +
          `\n${isHindi ? "Kaunse items dekhna ya cart mein add karna chahoge?" : "Which items would you like to explore or add to your cart?"}`;
      } else {
        ctx.fallbackSpeech = buildFriendlyProductsFallback(products, lang, {
          userMessage,
          history,
          });
      }

      return {
        status: "ok",
        requested: limit,
        found: products.length,
        genderApplied: genderHint || undefined,
        products: products.map((product) => ({
          ...compactProduct(product, { brief: false }),
          forKeyword: product.forKeyword || undefined,
        })),
        note:
          products.length > 1
            ? SEVERAL_PRODUCTS_NOTE
            : undefined,
      };
    },

    get_store_info: async () => {
      const info = await getStoreInfo(storeId);
      const loc = info.locations?.[0]?.address || "Online Store";
      ctx.fallbackSpeech = isHindi
        ? `Hamare store ka naam **${info.storeName || storeId}** hai (${loc}). Batao dost, aaj kya shopping karein?`
        : `Welcome to **${info.storeName || storeId}** (${loc})! What can I help you find today, my friend?`;
      return info;
    },

    // The model decides that the customer asked for a language; the choice travels back to the client
    // and is enforced on the next turns until the customer changes it.
    set_reply_language: async (args = {}) => {
      const code = LANGUAGE_CHOICE_CODES[String(args.language || "").toLowerCase()];
      if (code === undefined) return { status: "error", note: "language must be english, hindi, hinglish or auto" };
      ctx.languageChoice = code;
      return {
        status: "ok",
        languageChoice: code || "auto",
        instruction_for_ai: code
          ? "Saved. Reply in this language from now on, starting with this reply."
          : "Saved. Mirror the customer's own language again, starting with this reply.",
      };
    },
  };
}
