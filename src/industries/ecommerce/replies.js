// Wording helpers for product replies, comparisons and the fallback when no AI is available, and product cards.
// Part of the e-commerce industry module (see ../ecommerce.js); moved here unchanged.
import { formatMoney } from "../../utils/money.js";
import * as shopifyService from "../../tools/shopifyService.js";
import { SIZE_ALIASES, compactProduct, extractKeyFeatures } from "./shared.js";

function formatPriceLabel(price, currency) {
  return formatMoney(price, currency);
}

function cleanHumanOptionsList(options = []) {
  const sizes = [];
  const others = [];
  for (const raw of options) {
    const parts = String(raw || "")
      .split(/\s*\/\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const lower = p.toLowerCase();
      if (SIZE_ALIASES[lower] || /^\d{2}$/.test(lower)) {
        if (!sizes.includes(p.toUpperCase())) sizes.push(p.toUpperCase());
      } else if (!others.includes(p)) {
        others.push(p);
      }
    }
  }
  if (sizes.length > 0) return { label: "size", values: sizes };
  if (others.length > 0) return { label: "option", values: others };
  return { label: "option", values: options };
}

export function isOpinionOrPraiseQuestion(userMessage = "") {
  const lower = String(userMessage || "")
    .toLowerCase()
    .trim();
  if (!lower) return false;
  if (
    /\b(ya|or|vs\.?|versus|compare|between|dono\s+mein\s+se|inmein\s+se)\b/i.test(
      lower,
    )
  ) {
    return false;
  }
  return /\b(?:kaisa\s+lagega|kaisi\s+lagegi|ksa\s+lgega|ksi\s+lgegi|kaisa\s+lgega|kaisi\s+lgegi|acha\s+lagega|achi\s+lagegi|accha\s+lagega|acchi\s+lagegi|acha\s+lgega|suit\s+karega|suit\s+karegi|jachega|jachegi|unpe\s+kaisa|uspe\s+kaisa|mujhpe\s+kaisa|mere\s+upar\s+kaisa|wife\s+pe\s+kaisa|girlfriend\s+pe\s+kaisa|comfortable\s+rahega|comfortable\s+rahegi|comfort\s+rahega|sahi\s+rahega\s+kya|kaisa\s+dikhega|kaisi\s+dikhegi|how\s+will\s+(?:this|it|that|the\s+\w+)\s+look|how\s+would\s+(?:this|it|that|the\s+\w+)\s+look|how\s+does\s+(?:this|it|that)\s+look|will\s+(?:this|it|that)\s+look\s+(?:good|nice|great)|would\s+(?:this|it|that)\s+look\s+(?:good|nice|great)|will\s+(?:this|it)\s+suit|does\s+(?:this|it)\s+suit|is\s+(?:this|it)\s+comfortable)\b|कैसा\s+लगेगा|कैसी\s+लगेगी|अच्छा\s+लगेगा|सूट\s+करेगा/i.test(
    lower,
  );
}

function hasAlreadyCongratulated(history = []) {
  return (history || []).some(
    (h) =>
      h.role === "assistant" &&
      /\b(congratulations|congrats|badhai|heartfelt|best\s+wishes)\b/i.test(
        String(h.content || ""),
      ),
  );
}

function analyzeProductForConversation(product) {
  const title = product?.title || "Product";
  const priceStr = formatPriceLabel(product?.price, product?.currency);
  const rawDesc = String(product?.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const blob =
    `${title} ${rawDesc} ${product?.productType || ""} ${(product?.tags || []).join(" ")}`.toLowerCase();

  const sellableSizes = [];
  const outOfStockSizes = [];
  const otherOptions = [];

  for (const v of product?.variants || []) {
    if (!v?.title || v.title === "Default Title") continue;
    const parts = String(v.title)
      .split(/\s*\/\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    let sizeFound = "";
    for (const p of parts) {
      const lower = p.toLowerCase();
      if (SIZE_ALIASES[lower] || /^\d{2}$/.test(lower)) {
        sizeFound = p.toUpperCase();
      } else if (v.sellable && !otherOptions.includes(p)) {
        otherOptions.push(p);
      }
    }
    if (sizeFound) {
      if (v.sellable) {
        if (!sellableSizes.includes(sizeFound)) sellableSizes.push(sizeFound);
      } else {
        if (
          !outOfStockSizes.includes(sizeFound) &&
          !sellableSizes.includes(sizeFound)
        ) {
          outOfStockSizes.push(sizeFound);
        }
      }
    }
  }

  const cleanOos = outOfStockSizes.filter((s) => !sellableSizes.includes(s));

  let stockTextEn = "in stock and ready to ship";
  let stockTextHi = "stock mein ready hai";
  if (sellableSizes.length === 1 && cleanOos.length > 0) {
    stockTextEn = `currently available only in **Size ${sellableSizes[0]}** (${cleanOos.join(", ")} sold out)`;
    stockTextHi = `abhi sirf **Size ${sellableSizes[0]}** mein in stock hai (${cleanOos.join(", ")} sold out hain)`;
  } else if (sellableSizes.length > 1) {
    stockTextEn = `available in sizes **${sellableSizes.join(", ")}**`;
    stockTextHi = `sizes **${sellableSizes.join(", ")}** mein available hai`;
  } else if (sellableSizes.length === 1) {
    stockTextEn = `available in **Size ${sellableSizes[0]}**`;
    stockTextHi = `**Size ${sellableSizes[0]}** mein available hai`;
  } else if (otherOptions.length > 0) {
    stockTextEn = `available in **${otherOptions.join(", ")}**`;
    stockTextHi = `**${otherOptions.join(", ")}** options mein available hai`;
  }

  const blendMatch = rawDesc.match(
    /(\d+%\s*[a-z]+(?:\s*(?:and|&|,)\s*\d+%\s*[a-z]+)+(?:\s*blend)?)/i,
  );
  const hasStretch =
    /\b(elastane|spandex|lycra|stretch|stretchable|changing\s+body)\b/i.test(
      blob,
    );
  const isFitted = /\bfitted\b/i.test(blob);
  const isFlowy =
    /\b(flowy|drapes\s+beautifully|relaxed|loose|breezy|tie\s+waist)\b/i.test(
      blob,
    );

  let fabricEn = "";
  let fabricHi = "";
  if (blendMatch) {
    const b = blendMatch[1].replace(/\s+and\s+/i, " & ");
    fabricEn = `a soft, breathable ${b}${hasStretch && !/stretch/i.test(b) ? " with gentle stretch" : ""}`;
    fabricHi = `soft aur breathable ${b}${hasStretch ? " (stretchable comfort)" : ""}`;
  } else if (/\blinen\b/.test(blob)) {
    fabricEn = "a lightweight, breathable pure linen weave";
    fabricHi = "halka aur breathable pure linen fabric";
  } else if (/\bpiqu[eé]\s+cotton\b/.test(blob)) {
    fabricEn = "soft, breathable piqué cotton fabric";
    fabricHi = "soft aur breathable piqué cotton fabric";
  } else if (/\bcotton\b/.test(blob)) {
    fabricEn = "soft, breathable cotton fabric";
    fabricHi = "soft aur breathable cotton fabric";
  } else if (/\b(rayon|viscose)\b/.test(blob)) {
    fabricEn = "a soft, breathable rayon blend";
    fabricHi = "soft aur breathable rayon fabric";
  } else if (/\b(silk|banarasi)\b/.test(blob)) {
    fabricEn = "a rich, graceful weave";
    fabricHi = "rich aur graceful weave";
  } else if (/\bstainless[\s-]*steel\b/.test(blob)) {
    fabricEn = "a minimalist stainless-steel build";
    fabricHi = "minimalist stainless-steel finish";
  } else if (/\b(polarized|uv400)\b/.test(blob)) {
    fabricEn = "polarized UV400 lenses with a sleek metal frame";
    fabricHi = "polarized UV400 protection aur sleek metal frame";
  }

  let fitEn = "";
  let fitHi = "";
  if (/changing\s+body/i.test(blob) || (hasStretch && isFlowy)) {
    fitEn =
      "a flowy maternity drape that adapts gently to a growing bump with zero tightness";
    fitHi =
      "flowy maternity drape jo growing baby bump ke hisaab se bina kisi tightness ke aaram se fit hota hai";
  } else if (
    /\b(floor[\s-]*length|maxi)\b/i.test(blob) &&
    /\bslits?\b/i.test(blob)
  ) {
    fitEn = `a floor-length ${/striped/i.test(blob) ? "classic striped " : ""}maxi cut with knee-high side slits for airflow and a bump-flattering look${isFitted ? " (with a slightly more fitted silhouette)" : ""}`;
    fitHi = `floor-length ${/striped/i.test(blob) ? "classic striped " : ""}maxi cut aur knee-high side slits jo baby bump par bahut jachta hai aur chalne-phirne mein airy rehta hai${isFitted ? " (bas iska cut thoda fitted hai)" : ""}`;
  } else if (/\bmidi\b/i.test(blob) && /\btie[\s-]*waist\b/i.test(blob)) {
    fitEn =
      "a flowy floral midi cut with a V-neck and an adjustable tie waist that sits comfortably above the bump";
    fitHi =
      "flowy floral midi cut, V-neck aur adjustable tie-waist jo tummy ke upar aaram se set ho jata hai";
  } else if (/\bfitted\s+bodice\b/i.test(blob)) {
    fitEn = "a classic A-line flared skirt with a more fitted bodice";
    fitHi = "classic A-line flared skirt aur fitted bodice";
  } else if (/\bstraight[\s-]*cut\b/i.test(blob) && /\bkurti\b/i.test(blob)) {
    fitEn =
      "a comfortable straight-cut silhouette with a printed yoke, 3/4 sleeves, and side slits";
    fitHi =
      "comfortable straight-cut fit jismein printed yoke, 3/4 sleeves aur side slits hain";
  } else {
    const feats = extractKeyFeatures(product, 2).filter(
      (f) => !/^available in/i.test(f),
    );
    fitEn = feats[0]
      ? feats[0].charAt(0).toLowerCase() + feats[0].slice(1)
      : "a comfortable, flattering fit";
    fitHi = feats[0] || "comfortable aur smart fit";
  }

  return {
    title,
    priceStr,
    sellableSizes,
    outOfStockSizes: cleanOos,
    otherOptions,
    stockTextEn,
    stockTextHi,
    fabricEn,
    fabricHi,
    fitEn,
    fitHi,
    hasStretch,
    isFitted,
    isFlowy,
  };
}

function buildFriendlyProductBullet(product, index = null) {
  const priceStr = formatPriceLabel(product.price, product.currency);
  const features = extractKeyFeatures(product, 3).filter(
    (f) =>
      !/^category:/i.test(String(f).trim()) &&
      !/sample\s+product\s+for\s+demo/i.test(String(f).trim()),
  );
  const featText =
    features.length > 0
      ? features.slice(0, 2).join(" — ")
      : "In stock and ready to ship";
  const cleanFeat = String(featText)
    .replace(/\.\s*$/, "")
    .trim();
  const prefix = index != null ? `${index}.` : "-";
  return `${prefix} **${product.title}**${priceStr ? ` (${priceStr})` : ""}: ${cleanFeat}.`;
}

function describeFabricAndAppeal(
  product,
  isHindi = false,
  isPregnancy = false,
) {
  const a = analyzeProductForConversation(product);
  if (isPregnancy || a.hasStretch || a.isFlowy) {
    if (a.fabricHi && a.fitHi && isHindi) {
      return `${a.fabricHi} aur ${a.fitHi}`;
    }
    if (a.fabricEn && a.fitEn && !isHindi) {
      return `${a.fabricEn} with ${a.fitEn}`;
    }
  }
  const blob =
    `${product?.title || ""} ${product?.description || ""} ${product?.category || ""}`.toLowerCase();
  if (/\bcotton\b/.test(blob)) {
    return isHindi
      ? "pure breathable cotton fabric skin par bilkul soft rehta hai aur poora din fresh aur comfortable feel deta hai"
      : "breathable cotton fabric feels super soft on the skin and keeps the fit comfortable and fresh all day";
  }
  if (/\blinen\b/.test(blob)) {
    return isHindi
      ? "airy linen weave pehenne mein ekdum halka, classy aur rich look deta hai"
      : "airy linen weave feels lightweight, breathable, and effortlessly classy";
  }
  if (/\b(saree|banarasi|silk)\b/.test(blob)) {
    return isHindi
      ? "rich weave aur graceful drape har occasion par ekdum royal aur timeless look deta hai"
      : "rich weave and graceful drape create a timeless, elegant look";
  }
  if (/\bwatch\b/.test(blob)) {
    return isHindi
      ? "minimal sleek dial aur classy finish ethnic aur western dono outfits ke sath bahut jachta hai"
      : "sleek dial and refined finish pair beautifully with both casual and dressy outfits";
  }
  return isHindi
    ? `${a.fitHi} pehenne par bahut hi smart aur graceful look deta hai`
    : `${a.fitEn} gives a very flattering, polished look`;
}

// A product's own key points (never another product's). Used for the comparison cards and the fallback reply.
function comparisonOwnPoints(product, maxPoints = 5) {
  let points = [];
  try {
    points = extractKeyFeatures(product, maxPoints);
  } catch {
    points = [];
  }
  if (!points.length && Array.isArray(product?.features)) points = product.features;
  return points.map((f) => String(f || "").trim()).filter(Boolean).slice(0, maxPoints);
}

// Plain fallback used only when no model answer is available: each product with its own price and key
// points, no invented verdict. The normal comparison is written by the model from the same facts.
function buildShopOwnerComparisonReply(products, meta = {}) {
  const lang = meta.lang || "en";
  const isHindi = lang === "hi" || lang === "hinglish";
  const list = (Array.isArray(products) ? products : []).filter(Boolean).slice(0, 4);
  if (list.length < 2) {
    return list[0] ? buildShopOwnerSelectionReply(list[0], meta) : "";
  }
  const lines = list.map((p) => {
    const points = comparisonOwnPoints(p, 3);
    const price = Number.isFinite(Number(p.price)) ? ` (${formatPriceLabel(p.price, p.currency)})` : "";
    const detail = points.length
      ? points.join("; ")
      : isHindi
        ? "store ke data mein details limited hain"
        : "limited details in the store data";
    return `- **${p.title}**${price}: ${detail}.`;
  });
  const ask = isHindi
    ? "Aapke liye kya zyada zaroori hai — price, features ya use? Bata dijiye, main usi hisaab se ek suggest kar dunga."
    : "What matters most to you — price, features or how you'll use it? Tell me and I'll recommend one.";
  return `${lines.join("\n")}\n${ask}`;
}

function buildShopOwnerSelectionReply(product, meta = {}) {
  if (!product) return "";
  const lang = meta.lang || "en";
  const isHindi = lang === "hi" || lang === "hinglish";
  const a = analyzeProductForConversation(product);

  if (isHindi) {
    const highlightHi = a.fabricHi ? `${a.fabricHi} aur ${a.fitHi}` : a.fitHi;
    const stockPromptHi =
      a.sellableSizes.length === 1 && a.outOfStockSizes.length > 0
        ? `Bas ek chhoti si baat dhyan rakhiyega — ismein ${a.stockTextHi}. Agar unhe **Size ${a.sellableSizes[0]}** aata hai toh bataiye main abhi **${product.title}** aapke cart mein add kar doon, ya agar koi doosra size chahiye toh baaki options dekhein?`
        : a.sellableSizes.length > 1
          ? `Yeh ${a.stockTextHi}. Bataiye, inmein se kaunsa size aapke cart mein add kar doon?`
          : `Yeh ${a.stockTextHi}. Bataiye, kya main abhi **${product.title}** aapke cart mein add kar doon?`;

    return `Bahut hi badhiya choice hai! **${product.title}** (${a.priceStr}) unpe behad pyari lagegi — iska ${highlightHi} pehenne par bahut graceful aur comfortable rahega.\n\n${stockPromptHi}`;
  }

  const highlightEn = a.fabricEn ? `${a.fabricEn} with ${a.fitEn}` : a.fitEn;
  const stockPromptEn =
    a.sellableSizes.length === 1 && a.outOfStockSizes.length > 0
      ? `Just a quick heads-up before we lock it in: it is ${a.stockTextEn}. Would **Size ${a.sellableSizes[0]}** fit her so I can add **${product.title}** to your cart right now, or would you like to check one of the other dresses if she needs another size?`
      : a.sellableSizes.length > 1
        ? `It is ${a.stockTextEn}. Which size should I add to your cart for her?`
        : `It is ${a.stockTextEn}. Would you like me to add **${product.title}** to your cart right now?`;

  return `Great choice! **${product.title}** (${a.priceStr}) is a lovely pick — it features ${highlightEn}, so she'll feel comfortable and look graceful in it.\n\n${stockPromptEn}`;
}

function buildShopOwnerPraiseReply(product, meta = {}) {
  const lang = meta.lang || "en";
  const isHindi = lang === "hi" || lang === "hinglish";
  const combinedText =
    `${meta.userMessage || ""} ${(meta.history || []).map((h) => h?.content || "").join(" ")}`.toLowerCase();
  const isPregnancy =
    /\b(pregnant|pregnancy|maternity|motherhood|expecting|baby\s+bump|garbhwati|\d+\s*months?\s+pregnant)\b/i.test(
      combinedText,
    );
  const monthMatch = combinedText.match(
    /\b(\d+)\s*(?:th|st|nd|rd)?\s*months?\b/i,
  );
  const monthLabelEn = monthMatch
    ? `${monthMatch[1]}th month of pregnancy`
    : "pregnancy";
  const monthLabelHi = monthMatch
    ? `pregnancy ke ${monthMatch[1]}th month`
    : "pregnancy";
  const isForHer =
    isPregnancy ||
    /\b(wife|girlfriend|her|mother|mom|sister|bhabhi|unpe|uspe)\b|वाइफ|गर्लफ्रेंड/i.test(
      combinedText,
    );

  const a = analyzeProductForConversation(product);
  const alreadyShown = Boolean(meta.alreadyShown);
  const bulletBlock = alreadyShown
    ? ""
    : `\n${buildFriendlyProductBullet(product)}`;

  const sizeLineHi =
    a.sellableSizes.length > 1
      ? `Yeh **${a.sellableSizes.join(", ")}** sizes mein ready hai${isPregnancy ? " (pregnancy comfort ke liye regular ya ek size bada lena best rehta hai)" : ""}. Bataiye, kaunsa size cart mein lock kar doon?`
      : a.sellableSizes.length === 1 && a.outOfStockSizes.length > 0
        ? `Ismein ${a.stockTextHi} — agar **Size ${a.sellableSizes[0]}** fit aayega toh bataiye main abhi cart mein add kar doon?`
        : `Kaho toh main abhi **${product.title}** aapke cart mein add kar doon?`;

  const sizeLineEn =
    a.sellableSizes.length > 1
      ? `It's available in sizes **${a.sellableSizes.join(", ")}**${isPregnancy ? " (her regular size or one size up works great for extra maternity ease)" : ""}. Which size should I add to your cart?`
      : a.sellableSizes.length === 1 && a.outOfStockSizes.length > 0
        ? `It is ${a.stockTextEn} — if **Size ${a.sellableSizes[0]}** works for her, would you like me to add it to your cart right now?`
        : `Would you like me to add **${product.title}** to your cart right now?`;

  const appeal = describeFabricAndAppeal(product, isHindi, isPregnancy);

  if (isPregnancy) {
    return isHindi
      ? `Yakeen maniye, **${product.title}**${a.priceStr ? ` (${a.priceStr})` : ""} unpe bahut hi khoobsurat aur graceful lagegi! ${monthLabelHi} mein sabse zaroori cheez hoti hai ki kapda bilkul chubhe nahi aur poora aaram mile — iska ${appeal}. Woh jab isse pehnengi toh unhe bahut halka, confident aur special feel hoga!${bulletBlock}\n${sizeLineHi}`
      : `Honestly, **${product.title}**${a.priceStr ? ` (${a.priceStr})` : ""} is going to look wonderful and so graceful on her! In the ${monthLabelEn}, comfort comes first — its ${appeal}, so she'll feel completely relaxed, light, and radiant all day long.${bulletBlock}\n${sizeLineEn}`;
  }

  if (isForHer) {
    return isHindi
      ? `Sach bataun toh aapki choice kamaal ki hai — **${product.title}**${a.priceStr ? ` (${a.priceStr})` : ""} unpe bahut hi pyari aur classy lagegi! Iska ${appeal}, toh pehenne ke baad look aur comfort dono ekdum top-notch aayega.${bulletBlock}\n${sizeLineHi}`
      : `You've picked a fantastic piece — **${product.title}**${a.priceStr ? ` (${a.priceStr})` : ""} is going to look so flattering and graceful on her! Its ${appeal}, making it a piece she'll genuinely love wearing.${bulletBlock}\n${sizeLineEn}`;
  }

  return isHindi
    ? `Bahut hi shandaar pasand hai aapki! **${product.title}**${a.priceStr ? ` (${a.priceStr})` : ""} pehenne par ekdum smart aur classy lagega, kyunki iska ${appeal}.${bulletBlock}\n${sizeLineHi}`
    : `You have a great eye! **${product.title}**${a.priceStr ? ` (${a.priceStr})` : ""} will look super sharp and flattering on you — its ${appeal}.${bulletBlock}\n${sizeLineEn}`;
}

function buildFriendlyProductsFallback(products, lang = "en", meta = {}) {
  if (!Array.isArray(products) || products.length === 0) return "";
  const isHindi = lang === "hi" || lang === "hinglish";
  const userMessage = String(meta.userMessage || "");
  const history = Array.isArray(meta.history) ? meta.history : [];
  const combinedText = `${userMessage} ${history.map((h) => h?.content || "").join(" ")}`.toLowerCase();
  const isPregnancy = /\b(pregnant|pregnancy|maternity|motherhood|expecting|baby\s+bump|garbhwati|\d+\s*months?\s+pregnant)\b/i.test(combinedText);
  const monthMatch = combinedText.match(/\b(\d+)\s*(?:th|st|nd|rd)?\s*months?\b/i);
  const monthLabelEn = monthMatch ? `${monthMatch[1]}th month` : "maternity";
  const monthLabelHi = monthMatch ? `${monthMatch[1]}th month` : "maternity";

  const listSlice = products.slice(0, 8);
  const useNumbering = listSlice.length > 1;
  const bullets = listSlice
    .map((p, idx) => buildFriendlyProductBullet(p, useNumbering ? idx + 1 : null))
    .join("\n");

  if (isPregnancy) {
    const congratsAlready = hasAlreadyCongratulated(history);
    const leadEn = congratsAlready
      ? `For her ${monthLabelEn} comfort, here are our softest, most breathable options:`
      : `Heartfelt congratulations to you both! In the ${monthLabelEn}, soft, breathable, flowy comfort comes first — here are our best picks from the store:`;
    const leadHi = congratsAlready
      ? `${monthLabelHi} comfort ke liye hamare sabse soft aur breathable options yeh rahe:`
      : `Aap dono ko dil se bahut-bahut badhai! ${monthLabelHi} mein soft, breathable aur flowy comfort sabse zaroori hota hai — yeh rahe sabse best options:`;
    const askEn = "Which of these would you like to check sizes for or add to your cart?";
    const askHi = "Bataiye, inmein se kaunsa size check karein ya cart mein add karoon?";
    return `${isHindi ? leadHi : leadEn}\n${bullets}\n${isHindi ? askHi : askEn}`;
  }

  const leadEn = `Here are the best options available in our store right now:`;
  const leadHi = `Hamare store mein abhi yeh sabse badhiya options available hain:`;
  return `${isHindi ? leadHi : leadEn}\n${bullets}\n${isHindi ? "Bataiye, inmein se kaunsa option ya size dekhna chahoge?" : "Which of these would you like to explore or add to your cart?"}`;
}

// The assistant's name: the store owner's choice, else the default.
const DEFAULT_AGENT_NAME = process.env.AGENT_NAME || "Orbi";
function agentNameFor(context = {}) {
  return context.settings?.persona?.name || DEFAULT_AGENT_NAME;
}

function buildConversationalReply(convTurn, lang = "en", customerName = "", agentName = DEFAULT_AGENT_NAME) {
  const hindi = lang === "hi" || lang === "hinglish";
  const name = customerName ? `, ${customerName}` : "";
  if (convTurn.type === "capabilities" && convTurn.subtype === "cart_ability")
    return hindi
      ? `Haan${name}, product aur size/color bata do. Main available option cart mein add karne, quantity badalne aur checkout mein help kar sakti hoon. Kya add karein?`
      : `Yes${name}, tell me the product and size or color. I can help add an available option, change quantities and guide you through checkout. What would you like to add?`;
  if (convTurn.type === "capabilities")
    return hindi
      ? `Main ${agentName} hoon${name}, tumhari AI shopping companion. Tumhare taste aur budget se match karte products, thoughtful gifts, valid offers aur checkout mein help kar sakti hoon. Aaj kya dhoondh rahe hain?`
      : `I'm ${agentName}${name}, your AI shopping companion. I can help find products and thoughtful gifts that fit your taste and budget, check valid offers, and guide you through checkout. What do you have in mind today?`;
  if (convTurn.type === "categories_list")
    return hindi
      ? "Store ki current categories check kar lete hain. Kis tarah ki shopping karni hai?"
      : "Let's check the store's current categories. What kind of shopping do you have in mind?";
  if (convTurn.type === "restricted_item")
    return hindi
      ? `Is item ka option mere paas nahi hai${name}. Tum aur kya dekhna chahenge?`
      : `I don't have an option for that item${name}. What else would you like to explore?`;
  if (convTurn.subtype === "ack")
    return hindi
      ? `Theek hai${name}, jab help chahiye bas bata dena.`
      : `Sounds good${name}. I'm here whenever you need a hand.`;
  if (convTurn.subtype === "chitchat")
    return hindi
      ? `Namaste${name}! Main bilkul badhiya hoon — hamare store par aapka swagat hai! Bataiye, aaj aapke liye ya kisi khaas ke liye kya dikhaoon?`
      : `Hey there${name}! I'm doing great — welcome to our store! What can I help you find today?`;
  return "";
}

function toCard(product) {
  // The variant a card shows is the cheapest one that can be bought: its price is the product's "from" price, the same
  // number the reply is given (see cheapestPrice in words.js).
  const sellable = (product.variants || []).filter((candidate) => candidate.sellable);
  const variant =
    sellable.reduce((best, candidate) => (best == null || Number(candidate.price) < Number(best.price) ? candidate : best), null) ||
    product.variants?.[0];
  const resolvedImage =
    product.image ||
    variant?.image ||
    product.variants?.find((candidate) => candidate.image)?.image ||
    null;

  const card = {
    id: product.id,
    title: product.title,
    handle: product.handle,
    description: product.description,
    features:
      Array.isArray(product.features) && product.features.length > 0
        ? product.features
        : extractKeyFeatures(product, 3),
    fitReason: product.stylistNote || product.fitReason || undefined,
    image: resolvedImage,
    imageAlt: product.imageAlt || product.title,
    price: variant?.price ?? product.price ?? null,
    compareAtPrice: variant?.compareAtPrice ?? null,
    currency: product.currency || "",
    // Cards go to the browser: exact stock only when it is low ("Only 3 left"), never the full count.
    inventoryQuantity: variant?.inventoryQuantity == null ? null : variant.inventoryQuantity <= 0 ? 0 : shopifyService.visibleStockCount(variant.inventoryQuantity),
    inventoryPolicy: variant?.inventoryPolicy ?? null,
    variantId: variant?.id ? String(variant.id).split("/").pop() : null,
    onlineStoreUrl: product.url,
    variants:
      product.variants?.length > 1
        ? product.variants.map((candidate) => ({
            id: String(candidate.id).split("/").pop(),
            title: candidate.title,
            price: candidate.price,
            compareAtPrice: candidate.compareAtPrice,
            quantity: candidate.inventoryQuantity == null ? null : candidate.inventoryQuantity <= 0 ? 0 : shopifyService.visibleStockCount(candidate.inventoryQuantity),
            available: candidate.sellable,
          }))
        : undefined,
  };

  if (product.cardMode === "comparison" || product.comparisonMode) {
    card.cardMode = "comparison";
    card.comparisonMode = true;
  }
  if (Array.isArray(product.comparisonPoints) && product.comparisonPoints.length) {
    card.comparisonPoints = product.comparisonPoints;
  }
  return card;
}

/**
 * Comparison cards: every product lists only the points it actually has. Nothing is shown for features
 * the other product has, so there are no "missing" marks.
 */
function buildComparisonChecklist(products, maxPoints = 5) {
  return (Array.isArray(products) ? products : []).filter(Boolean).map((p) => {
    const own = comparisonOwnPoints(p, maxPoints);
    return {
      ...p,
      cardMode: "comparison",
      comparisonMode: true,
      features: own.length ? own : p.features,
      comparisonPoints: own.map((label) => ({ label, present: true })),
    };
  });
}

// What the model gets when comparing: the facts for each product plus an instruction to write a real
// head-to-head comparison itself (nothing is pre-written here).
const COMPARISON_NOTE =
  "The customer wants these products compared. Write the comparison yourself, in the customer's language, using ONLY the facts in `products` (price, features, description, options, stock) - never invent specs. Format: one short sentence per product saying what the customer gets with it, contrasting the real differences (for example: with A you get ..., with B you get ...). If the products are different kinds of items, say so plainly and say who each one suits. End with one clear recommendation and one short follow-up question, about 60 words in all because the customer hears it. The cards already list each product's own points, so do not just say to look at the cards.";

function comparisonToolPayload(cards) {
  return {
    products: cards.map((p) => ({
      ...compactProduct(p, { brief: false, includeCardFields: true }),
      features: p.features,
      cardMode: "comparison",
      comparisonMode: true,
      comparisonPoints: p.comparisonPoints || [],
    })),
    note: COMPARISON_NOTE,
  };
}

export { formatPriceLabel, cleanHumanOptionsList, hasAlreadyCongratulated, analyzeProductForConversation, buildFriendlyProductBullet, describeFabricAndAppeal, comparisonOwnPoints, buildShopOwnerComparisonReply, buildShopOwnerSelectionReply, buildShopOwnerPraiseReply, buildFriendlyProductsFallback, agentNameFor, buildConversationalReply, toCard, buildComparisonChecklist, comparisonToolPayload, DEFAULT_AGENT_NAME, COMPARISON_NOTE };
