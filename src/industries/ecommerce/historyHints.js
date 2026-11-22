// What earlier messages already say: excluded words, contact details given, the variant asked for, an add-to-cart intent.
// Part of the e-commerce industry module (see ../ecommerce.js); moved here unchanged.
import { sliceHistoryAfterLastOrder } from "../../services/shippingAddressService.js";
import { readCheckoutMemory } from "./pricing.js";
import { SIZE_ALIASES, getCachedCatalogSummary, normalizeSearchTypos, tokenMatchesTitle, variantTokens } from "./shared.js";

function extractExcludedKeywordsFromMessage(text = "") {
  const raw = String(text || "").toLowerCase();
  const excluded = [];

  const clauses = raw
    .split(
      /[,;.!?।]+|\b(?:but|instead|rather|lekin|par|balki|i'?m\s+looking\s+for|i\s+want|mujhe\s+chahiye|unke\s+liye|uske\s+liye|mere\s+liye)\b/i,
    )
    .map((c) => c.trim())
    .filter(Boolean);

  const negationRe =
    /\b(nahi|nahin|nhi|no|not|mat|thodi|hato|hata|without|except|leave|skip|don'?t\s+want)\b|नहीं|थोड़ी|मत|हटा/;

  for (const clause of clauses) {
    if (!negationRe.test(clause)) continue;
    if (/maxi|मैक्सी/.test(clause)) excluded.push("maxi");
    if (/dress|ड्रेस/.test(clause)) excluded.push("dress");
    if (/bra|ब्रा/.test(clause)) excluded.push("bra");
    if (/t[\s-]*shirt|tshirt|टीशर्ट/.test(clause)) excluded.push("t-shirt");
    else if (/\bshirt|शर्ट/.test(clause)) excluded.push("shirt");
    if (/kurti|कुर्ती/.test(clause)) excluded.push("kurti");
    if (/watch|घड़ी|वॉच/.test(clause)) excluded.push("watch");
    if (/bag|backpack|बैग/.test(clause)) excluded.push("bag");
    if (/shoe|जूते|जूता/.test(clause)) excluded.push("shoe");
  }

  return [...new Set(excluded)];
}

function extractCustomerDetailsFromHistory(history = [], userMessage = "") {
  const activeHistory = sliceHistoryAfterLastOrder(history);
  const userTexts = [
    ...(activeHistory || [])
      .filter((h) => h.role === "user")
      .map((h) => String(h.content || "")),
    String(userMessage || ""),
  ];

  let phone = "";
  let name = "";
  let email = "";
  let street = "";

  for (const text of userTexts) {
    const phoneContext = text.match(
      /(?:phone|number|mobile|contact|call|is|:)?\s*(\+?91[\s.-]*)?([6-9]\d{2,5}[\s.,-]*\d{3,7})/gi,
    );
    if (phoneContext) {
      for (const rawMatch of phoneContext) {
        const digits = rawMatch
          .replace(/\D+/g, "")
          .replace(/^91(?=\d{10}$)/, "");
        if (/^[6-9]\d{9}$/.test(digits) && digits !== "9876543210") {
          phone = digits;
        }
      }
    }

    const emailMatch = text.match(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    );
    if (emailMatch) {
      email = emailMatch[0].toLowerCase().trim();
    }

    const nameMatch = text.match(
      /\b(?:my\s+(?:full\s+)?name\s+is|call\s+me|mera\s+naam)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i,
    );
    if (nameMatch && nameMatch[1]) {
      const candidate = nameMatch[1]
        .replace(
          /\b(?:and|phone|number|email|address|is|my|hai|h|hoon|hu)\b.*$/i,
          "",
        )
        .trim();
      if (
        candidate.length >= 2 &&
        !/^(?:looking|searching|asking|fine|good|okay)$/i.test(candidate)
      ) {
        name = candidate;
      }
    }

    const streetMatch = text.match(
      /\b(?:shipping\s+address\s+is|address\s+is)\s+([^,.]+(?:\s+by\s+\d+|\s*\/\s*\d+)?[^,.]*)/i,
    );
    if (streetMatch && streetMatch[1]) {
      const cand = streetMatch[1]
        .replace(/\b(?:city\s+is|state\s+is|pin\s*code\s+is).*$/i, "")
        .trim();
      if (cand.length >= 3) {
        street = cand;
      }
    }
  }

  return { phone, name, email, street };
}

function didUserSpecifyVariantInMessage(
  userMessage = "",
  variantName = "",
  productTitle = "",
) {
  const wanted = String(variantName || "")
    .trim()
    .toLowerCase();
  if (!wanted || wanted === "default title") return false;

  const cleanMsg = String(userMessage || "")
    .toLowerCase()
    .replace(/['’]s\b/g, "s");

  const vToks = variantTokens(wanted);
  if (vToks.length === 0) return false;

  const sizeToks = vToks.filter(
    (t) => Boolean(SIZE_ALIASES[t]) || /^\d{2}$/.test(t),
  );
  const msgToks = new Set(variantTokens(cleanMsg));

  if (sizeToks.length > 0) {
    return sizeToks.every((s) => tokenMatchesTitle(s, msgToks));
  }

  // Strip words that belong to the product's own title so a color word in the product title
  // is not misidentified as an explicit variant selection unless repeated outside the title.
  let msgWithoutTitle = cleanMsg;
  const cleanTitle = String(productTitle || "")
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .trim();
  if (cleanTitle) {
    msgWithoutTitle = msgWithoutTitle.replace(cleanTitle, " ");
    for (const w of cleanTitle.split(/\s+/).filter((tok) => tok.length >= 4)) {
      msgWithoutTitle = msgWithoutTitle.replace(new RegExp(`\\b${w}\\b`, "i"), " ");
    }
  }
  const strippedMsgToks = new Set(variantTokens(msgWithoutTitle));

  return vToks.some((t) => tokenMatchesTitle(t, strippedMsgToks));
}

function resolveAddIntentFromContext(
  userMessage = "",
  history = [],
  storeId = "",
  clientId = "",
) {
  const raw = String(userMessage || "").trim();
  const lower = raw.toLowerCase();

  if (
    /\b(?:ability|capable|capability|can\s+you\s+add|do\s+you\s+add|you\s+have\s+(?:the\s+)?ability|i\s+am\s+saying|asking\s+if|how\s+(?:do\s+i|to)\s+add)\b/i.test(
      lower,
    )
  ) {
    return { isAddIntent: false };
  }

  const memProducts =
    readCheckoutMemory(storeId, clientId)?.lastShownProducts || [];

  const isNotFoundErrorMsg = (msg = "") =>
    /couldn'?t\s+find|don'?t\s+have|out\s+of\s+stock|nahi\s+mila|stock\s+mein\s+nahi/i.test(
      String(msg || ""),
    );

  const lastAssistant =
    [...(history || [])]
      .reverse()
      .find((h) => h.role === "assistant" && h.content)?.content || "";

  const askedForVariant =
    /which\s+(?:size|colour|color|option)|konsa\s+(?:size|option|colour|color)|kaunsa\s+(?:size|option|colour|color)|sizes?\s+available|available\s+in\s+sizes?/i.test(
      lastAssistant,
    );

  const standaloneSizeMatch = lower.match(
    /^(?:size\s+|option\s+)?(xxs|xs|s|m|l|xl|xxl|2xl|3xl|small|medium|large|extra\s+small|extra\s+large|28|30|32|34|36|38|silver|black|blue|teal|gold|rose\s+gold)(?:\s+(?:size|please|kar\s*do|add\s*kar\s*do|wala))?$/i,
  );

  if (askedForVariant && standaloneSizeMatch) {
    const chosenVariant = standaloneSizeMatch[1].trim();
    const boldMatches = [...lastAssistant.matchAll(/\*\*([^*]+)\*\*/g)].map(
      (m) => m[1].trim(),
    );
    const productCandidate = boldMatches.find(
      (b) =>
        b.length > 4 &&
        !/^(?:xs|s|m|l|xl|xxl|total|chat\d+|freeshipping)/i.test(b),
    );
    if (productCandidate) {
      return {
        isAddIntent: true,
        productName: productCandidate.replace(/\([^)]*\)\s*$/, "").trim(),
        variantName: chosenVariant,
      };
    }
  }

  const askedToAddSingleProduct =
    /would\s+you\s+like\s+me\s+to\s+add|so\s+i\s+can\s+add|should\s+i\s+add|kya\s+main\s+(?:isse\s+|abhi\s+)?(?:aapke\s+|tumhare\s+)?cart\s+mein\s+add\s+kar\s+doon|cart\s+mein\s+add\s+kar\s+doon/i.test(
      lastAssistant,
    );
  const isAffirmativeOnly =
    /^(?:yes|yeah|yep|sure|ok|okay|please|yes\s*,?\s*please|haan|han|ji|bilkul|add\s+it|kar\s+do|add\s+kar\s+do)[.!]*$/i.test(
      lower,
    );

  if (askedToAddSingleProduct && isAffirmativeOnly) {
    const boldMatches = [...lastAssistant.matchAll(/\*\*([^*]+)\*\*/g)].map(
      (m) => m[1].trim(),
    );
    const productCandidate = boldMatches.find(
      (b) =>
        b.length > 4 &&
        !/^(?:size\s+)?(?:xxs|xs|s|m|l|xl|xxl|total|chat\d+|freeshipping)$/i.test(
          b,
        ),
    );
    if (productCandidate) {
      return {
        isAddIntent: true,
        productName: productCandidate.replace(/\([^)]*\)\s*$/, "").trim(),
        variantName: "",
      };
    }
  }

  const isExplicitAdd =
    /\b(?:add|put)\b.*\b(?:cart|product|item|one|kurti|saree|shirt|t-?shirt|oxford|linen|flannel|watch|bottle|bag|backpack|jeans|shorts|jacket|dress)\b/i.test(
      lower,
    ) ||
    /^(?:yo\s*[,.]?\s*|hey\s*[,.]?\s*|okay\s*[,.]?\s*|now\s+|please\s+|do\s+one\s+thing\s+)*(?:add|health)\s+(?:this|that|the|it|men'?s|women'?s)\b/i.test(
      lower,
    ) ||
    /\b(?:add|health)\s+(?:this|that|the|it)\b/i.test(lower) ||
    /\bnow\s+add\b|\bdo\s+one\s+thing\s+add\b/i.test(lower) ||
    /\b(?:cart\s+mein\s+(?:add|daal)|isko\s+add|ye\s+wala\s+add)\b/i.test(
      lower,
    );

  if (!isExplicitAdd) return { isAddIntent: false };

  let explicitSize = "";
  const sizeInCmd = lower.match(
    /\b(?:size\s+(xxs|xs|s|m|l|xl|xxl|small|medium|large|28|30|32|34|36)|(xxs|xs|small|medium|large|xl|xxl)\s+size)\b/i,
  );
  if (sizeInCmd) {
    explicitSize = (sizeInCmd[1] || sizeInCmd[2] || "").trim();
  }

  const priceMatch = lower.match(
    /(?:\$|₹|rs\.?\s*|price\s*|is\s*|this\s+|the\s+)(\d{2,5})(?:\.\d{1,2})?\b/,
  );
  if (priceMatch) {
    const wantedPrice = Number(priceMatch[1]);
    const byMemPrice = memProducts.find(
      (p) => Math.round(Number(p.price)) === Math.round(wantedPrice),
    );
    if (byMemPrice) {
      return {
        isAddIntent: true,
        productName: byMemPrice.title,
        variantName: explicitSize,
      };
    }
    for (let i = (history || []).length - 1; i >= 0; i--) {
      const msg = history[i]?.content || "";
      if (isNotFoundErrorMsg(msg)) continue;
      const re = /\*\*([^*]+)\*\*\s*\((?:[$₹]|Rs\.?\s*)?(\d+(?:\.\d+)?)\)/gi;
      let m;
      while ((m = re.exec(msg)) !== null) {
        if (Math.round(Number(m[2])) === Math.round(wantedPrice)) {
          return {
            isAddIntent: true,
            productName: m[1].replace(/\([^)]*\)\s*$/, "").trim(),
            variantName: explicitSize,
          };
        }
      }
    }
    const cached = getCachedCatalogSummary?.(storeId);
    if (cached && Array.isArray(cached.products)) {
      const byPrice = cached.products.find(
        (p) => Math.round(Number(p.price)) === Math.round(wantedPrice),
      );
      if (byPrice) {
        return {
          isAddIntent: true,
          productName: byPrice.title,
          variantName: explicitSize,
        };
      }
    }
  }

  if (
    /\b(?:add|health)\s+(?:this|that|it)(?:\s+product|\s+item|\s+one)?\b/i.test(
      lower,
    ) &&
    !/\b(?:kurti|saree|shirt|oxford|linen|flannel|watch|bottle|bag|backpack|jeans|jacket|dress|sunglasses)\b/i.test(
      lower,
    )
  ) {
    if (memProducts.length === 1 && memProducts[0]?.title) {
      return {
        isAddIntent: true,
        productName: memProducts[0].title,
        variantName: explicitSize,
      };
    }
    for (let i = (history || []).length - 1; i >= 0; i--) {
      const msg = history[i]?.content || "";
      if (isNotFoundErrorMsg(msg)) continue;
      const matches = [...msg.matchAll(/\*\*([^*]+)\*\*/g)]
        .map((m) => m[1].trim())
        .filter(
          (title) =>
            title.length > 4 &&
            !/^(?:xs|s|m|l|xl|xxl|coverage|return|claim|total|chat\d+|ability|orbi)/i.test(
              title,
            ),
        );
      if (matches.length >= 1) {
        return {
          isAddIntent: true,
          productName: matches[0].replace(/\([^)]*\)\s*$/, "").trim(),
          variantName: explicitSize,
        };
      }
    }
    if (memProducts.length > 0 && memProducts[0]?.title) {
      return {
        isAddIntent: true,
        productName: memProducts[0].title,
        variantName: explicitSize,
      };
    }
  }

  const cleanedName = normalizeSearchTypos(raw)
    .replace(
      /\b(?:yo|hey|okay|ok|please|now|do\s+one\s+thing|i\s+am\s+saying|you\s+have|ability|products?|items?|one|add|health|put|this|that|the|into|in|to|my|cart|which\s+is)\b/gi,
      " ",
    )
    .replace(/[$₹]\s*\d+(?:\.\d+)?/g, " ")
    .replace(/[^a-zA-Z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleanedName.length >= 3) {
    const qWords = cleanedName
      .toLowerCase()
      .replace(/['’]s\b/g, "s")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && w !== "classic");

    for (let i = (history || []).length - 1; i >= 0; i--) {
      const msg = history[i]?.content || "";
      const candidates = [...msg.matchAll(/\*\*([^*]+)\*\*/g)]
        .map((m) => m[1].replace(/\([^)]*\)\s*$/, "").trim())
        .filter((t) => t.length > 4);
      for (const cand of candidates) {
        const candLower = cand.toLowerCase().replace(/['’]s\b/g, "s");
        const matchedCount = qWords.filter((w) => candLower.includes(w)).length;
        if (qWords.length > 0 && matchedCount >= Math.min(2, qWords.length)) {
          return {
            isAddIntent: true,
            productName: cand,
            variantName: explicitSize,
          };
        }
      }
    }

    return {
      isAddIntent: true,
      productName: cleanedName,
      variantName: explicitSize,
    };
  }

  return { isAddIntent: false };
}

export { extractExcludedKeywordsFromMessage, extractCustomerDetailsFromHistory, didUserSpecifyVariantInMessage, resolveAddIntentFromContext };
