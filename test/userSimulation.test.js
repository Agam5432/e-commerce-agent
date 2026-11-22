import crypto from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = crypto;
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { clearStoreProductCache } from "../src/tools/shopifyService.js";
import ecommerce from "../src/industries/ecommerce.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const SHOP = "simulation-store.myshopify.com";
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;

StoreIntegration.findOne = () => ({
  select: async () => ({
    accessTokenEncrypted: encryptToken("test-token"),
    accessTokenExpiresAt: new Date(Date.now() + 3600000),
  }),
});

let nextId = 100;
function makeVariant(title, price = "49.00", quantity = 8) {
  const parts = String(title || "Default Title").split(/\s*\/\s*/);
  const selectedOptions = [];
  for (const p of parts) {
    if (/^(?:XXS|XS|S|M|L|XL|XXL)$/i.test(p)) {
      selectedOptions.push({ name: "Size", value: p });
    } else if (p !== "Default Title") {
      selectedOptions.push({ name: "Color", value: p });
    }
  }
  return {
    id: `gid://shopify/ProductVariant/${++nextId}`,
    title,
    selectedOptions,
    price: String(price),
    compareAtPrice: null,
    inventoryQuantity: quantity,
    inventoryPolicy: "DENY",
    inventoryItem: { tracked: true },
  };
}

function makeProduct(title, description, price, variants, { productType = "Clothing", tags = [] } = {}) {
  return {
    id: `gid://shopify/Product/${++nextId}`,
    title,
    handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description,
    productType,
    tags,
    status: "ACTIVE",
    onlineStoreUrl: `https://${SHOP}/products/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    publishedAt: "2026-01-01T00:00:00Z",
    priceRangeV2: { minVariantPrice: { amount: String(price), currencyCode: "USD" } },
    variants: { edges: variants.map((node) => ({ node })) },
  };
}

const catalogFixtures = [
  makeProduct(
    "Savannah Maxi Dress",
    "When motherhood bogs you down, you deserve to feel like the goddess that you are. And nothing better to feel good than a classic striped maxi dress.",
    "49.00",
    [makeVariant("Default Title", "49.00")],
    { productType: "Dresses", tags: ["women", "dress", "maxi", "maternity", "comfort"] }
  ),
  makeProduct(
    "Women's Teal Printed Cotton Kurti",
    "Straight-cut cotton kurti with a printed yoke, three-quarter sleeves and side slits.",
    "799.00",
    [
      makeVariant("XS", "799.00"),
      makeVariant("S", "799.00"),
      makeVariant("M", "799.00"),
      makeVariant("L", "799.00"),
    ],
    { productType: "Ethnic Wear", tags: ["women", "kurti", "cotton"] }
  ),
  makeProduct(
    "Analog Wrist Watch - Rose Gold",
    "Minimal stainless-steel analog watch with a 3-year warranty.",
    "1999.00",
    [makeVariant("Default Title", "1999.00")],
    { productType: "Watches", tags: ["women", "watch", "rose gold"] }
  ),
  makeProduct(
    "UV400 Aviator Sunglasses",
    "Polarized aviator sunglasses with metal frame and UV400 protection.",
    "599.00",
    [makeVariant("Gold", "599.00"), makeVariant("Black", "599.00")],
    { productType: "Accessories", tags: ["unisex", "sunglasses", "aviator"] }
  ),
  makeProduct(
    "Men's Beige Linen Shirt",
    "Breathable pure linen button-down shirt crafted for effortless summer comfort.",
    "1099.00",
    [makeVariant("M / Beige", "1099.00"), makeVariant("L / Beige", "1099.00")],
    { productType: "Shirts", tags: ["men", "shirt", "linen", "summer"] }
  ),
  makeProduct(
    "Men's Navy Blue Polo T-Shirt",
    "Soft piqué cotton polo t-shirt with a classic collar.",
    "599.00",
    [makeVariant("M / Navy", "599.00"), makeVariant("L / Navy", "599.00")],
    { productType: "T-Shirts", tags: ["men", "t-shirt", "polo"] }
  ),
];

globalThis.fetch = async (url, options) => {
  const { query } = JSON.parse(options.body);
  if (/ListProducts|SearchProducts/.test(query)) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: { products: { edges: catalogFixtures.map((node) => ({ node })) } },
      }),
    };
  }
  return { ok: true, status: 200, json: async () => ({ data: {} }) };
};

after(() => {
  clearStoreProductCache(SHOP);
  StoreIntegration.findOne = originalFind;
  globalThis.fetch = originalFetch;
});

test("1. Exact user query (English): 8-month pregnant wife comfort dress returns ONLY dresses (no watch, no sunglasses, no kurti) with warm shop-owner reply and clean single-line bullet", async () => {
  clearStoreProductCache(SHOP);
  const userMessage =
    "actually my wife is 8 month pregnant and i m looking for dress for her comfort so do you have that ?";

  // Test even when LLM passes noisy multi-category keywords to get_recommendations
  const session = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-preg-en-${crypto.randomUUID()}`,
      userMessage,
      inferredGender: "women",
      replyLanguage: "en",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );

  await session.handlers.get_recommendations({
    keywords: ["dress", "kurti", "watch", "sunglasses"],
    gender: "women",
  });

  const out = session.result();
  const titles = out.products.map((p) => p.title);

  assert.deepEqual(titles, ["Savannah Maxi Dress"]);
  assert.ok(!titles.includes("Analog Wrist Watch - Rose Gold"));
  assert.ok(!titles.includes("UV400 Aviator Sunglasses"));
  assert.ok(!titles.includes("Women's Teal Printed Cotton Kurti"));

  // Must NOT use the old robotic hardcoded lines or split the description into an orphan "- And nothing better..." bullet
  assert.doesNotMatch(out.fallbackSpeech, /Let's find something thoughtful that suits their taste/i);
  assert.doesNotMatch(out.fallbackSpeech, /Here are the products/i);
  assert.doesNotMatch(out.fallbackSpeech, /\n[-•]\s*And nothing better to feel good/i);
  assert.match(out.fallbackSpeech, /congratulations/i);
  assert.match(out.fallbackSpeech, /8th month|comfort|soft|breathable|flowy/i);
  assert.match(out.fallbackSpeech, /Savannah Maxi Dress/);
});

test("2. Pregnant wife comfort dress via search_products (Hinglish) also returns ONLY Savannah Maxi Dress and speaks like a warm shop owner", async () => {
  clearStoreProductCache(SHOP);
  const userMessage =
    "meri wife 8 month pregnant hai aur mujhe unke comfort ke liye dress chahiye, kya aapke paas hai?";

  const session = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-preg-hi-${crypto.randomUUID()}`,
      userMessage,
      inferredGender: "women",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );

  await session.handlers.search_products({ searchTerm: "dress for comfort", gender: "women" });
  const out = session.result();
  const titles = out.products.map((p) => p.title);

  assert.deepEqual(titles, ["Savannah Maxi Dress"]);
  assert.match(out.fallbackSpeech, /badhai|8th month|comfort|soft|flowy/i);
  assert.doesNotMatch(out.fallbackSpeech, /Wrist Watch|Sunglasses/i);
});

test("3. Follow-up 'ye kaisa lagega unpe?' / 'how will this look?' praises the choice like a real shop owner and explains fabric & comfort without dumping random products", async () => {
  const clientId = `sim-praise-${crypto.randomUUID()}`;
  const turn1Msg = "actually my wife is 8 month pregnant and i m looking for dress for her comfort so do you have that ?";

  const session1 = ecommerce.createSession(
    SHOP,
    {
      clientId,
      userMessage: turn1Msg,
      inferredGender: "women",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await session1.handlers.get_recommendations({ keywords: ["dress"], gender: "women" });
  const turn1Out = session1.result();

  // Turn 2: User asks "ye kaisa lagega unpe? acha lagega kya?"
  const turn2Msg = "ye kaisa lagega unpe? acha lagega kya?";
  const session2 = ecommerce.createSession(
    SHOP,
    {
      clientId,
      userMessage: turn2Msg,
      history: [
        { role: "user", content: turn1Msg },
        { role: "assistant", content: turn1Out.fallbackSpeech },
      ],
      inferredGender: "women",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );

  const handled = await session2.routeKnownIntent();
  const turn2Out = session2.result();

  assert.equal(handled, true);
  assert.deepEqual(turn2Out.products.map((p) => p.title), ["Savannah Maxi Dress"]);
  assert.match(turn2Out.fallbackSpeech, /Savannah Maxi Dress/);
  assert.match(turn2Out.fallbackSpeech, /khoobsurat|graceful|soft|aaram|comfortable/i);
  assert.doesNotMatch(turn2Out.fallbackSpeech, /Watch|Sunglasses|Kurti/i);
});

test("4. Specific category queries (Kurti, Watch, Sunglasses, Men's Shirt) strictly return ONLY the requested category", async () => {
  // 4A: Kurti request
  const sKurti = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-kurti-${crypto.randomUUID()}`,
      userMessage: "wife ke liye comfortable cotton kurti dikhao",
      inferredGender: "women",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await sKurti.handlers.get_recommendations({
    keywords: ["kurti", "watch", "sunglasses"],
    gender: "women",
  });
  assert.deepEqual(sKurti.result().products.map((p) => p.title), [
    "Women's Teal Printed Cotton Kurti",
  ]);

  // 4B: Watch request
  const sWatch = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-watch-${crypto.randomUUID()}`,
      userMessage: "show me a rose gold watch for my wife",
      inferredGender: "women",
      replyLanguage: "en",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await sWatch.handlers.get_recommendations({
    keywords: ["watch", "dress", "sunglasses"],
    gender: "women",
  });
  assert.deepEqual(sWatch.result().products.map((p) => p.title), [
    "Analog Wrist Watch - Rose Gold",
  ]);

  // 4C: Sunglasses request
  const sSun = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-sun-${crypto.randomUUID()}`,
      userMessage: "do you have aviator sunglasses?",
      replyLanguage: "en",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await sSun.handlers.search_products({ searchTerm: "aviator sunglasses" });
  assert.deepEqual(sSun.result().products.map((p) => p.title), ["UV400 Aviator Sunglasses"]);

  // 4D: Men's Shirt request (must not return T-shirts or Watches)
  const sShirt = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-shirt-${crypto.randomUUID()}`,
      userMessage: "show me a comfortable men's shirt for summer",
      inferredGender: "men",
      replyLanguage: "en",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await sShirt.handlers.get_recommendations({
    keywords: ["shirt", "t-shirt", "watch"],
    gender: "men",
  });
  assert.deepEqual(sShirt.result().products.map((p) => p.title), ["Men's Beige Linen Shirt"]);
});

test("5. Category rejection & switch ('maxi dress nahi chahiye, kurti dikhao') excludes dress and shows only kurti", async () => {
  const sRej = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-rej-${crypto.randomUUID()}`,
      userMessage: "maxi dress nahi chahiye, unke liye koi cotton kurti dikhao",
      inferredGender: "women",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await sRej.handlers.get_recommendations({
    keywords: ["dress", "kurti", "watch"],
    gender: "women",
  });
  assert.deepEqual(sRej.result().products.map((p) => p.title), [
    "Women's Teal Printed Cotton Kurti",
  ]);
});

test("6. Add-to-cart size prompt and size selection flow works cleanly", async () => {
  const clientId = `sim-cart-${crypto.randomUUID()}`;

  // Step 1: User says "add Women's Teal Printed Cotton Kurti to my cart" without specifying a size
  const s1 = ecommerce.createSession(
    SHOP,
    {
      clientId,
      userMessage: "add Women's Teal Printed Cotton Kurti to my cart",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  const res1 = await s1.handlers.add_to_cart({
    productName: "Women's Teal Printed Cotton Kurti",
    variantName: "M", // Even if LLM guesses "M", didUserSpecifyVariantInMessage strips it!
    quantity: 1,
  });
  assert.equal(res1.status, "needs_variant");
  assert.equal(s1.result().actions.length, 0);
  assert.match(s1.result().fallbackSpeech, /XS, S, M, L/);

  // Step 2: User replies with size "M"
  const s2 = ecommerce.createSession(
    SHOP,
    {
      clientId,
      userMessage: "M",
      history: [
        { role: "user", content: "add Women's Teal Printed Cotton Kurti to my cart" },
        { role: "assistant", content: s1.result().fallbackSpeech },
      ],
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await s2.autoRecoverProducts();
  assert.equal(s2.result().actions.length, 1);
  assert.equal(s2.result().actions[0].type, "add_to_cart");
  assert.match(s2.result().actions[0].title, /Women's Teal Printed Cotton Kurti \(M\)/);
});

test("7. Opinion question on a specific named item ('Men's Beige Linen Shirt mujhpe kaisa lagega?') praises the linen weave and lists sizes", async () => {
  const s = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-shirt-praise-${crypto.randomUUID()}`,
      userMessage: "Men's Beige Linen Shirt mujhpe kaisa lagega?",
      inferredGender: "men",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  const routed = await s.routeKnownIntent();
  assert.equal(routed, true);
  assert.deepEqual(s.result().products.map((p) => p.title), ["Men's Beige Linen Shirt"]);
  assert.match(s.result().fallbackSpeech, /Men's Beige Linen Shirt/);
  assert.match(s.result().fallbackSpeech, /linen|smart|classy/i);
  assert.match(s.result().fallbackSpeech, /M, L/);
});

test("8. Skin-tone styling request returns the matching shirt with its colour facts for the AI to explain", async () => {
  const s = ecommerce.createSession(
    SHOP,
    {
      clientId: `sim-tone-${crypto.randomUUID()}`,
      userMessage: "meri skin tone wheatish hai, mujhe apne liye shirt dikhao",
      inferredGender: "men",
      replyLanguage: "hinglish",
    },
    { loadCheckout: async () => null, saveCheckout: async () => null }
  );
  await s.handlers.get_recommendations({
    keywords: ["shirt"],
    gender: "men",
    skinTone: "wheatish",
  });
  assert.deepEqual(s.result().products.map((p) => p.title), ["Men's Beige Linen Shirt"]);
  // Why a shade flatters a complexion is explained by the AI from these product facts; there is no
  // hardcoded styling sentence.
  const out = await s.handlers.get_recommendations({ keywords: ["shirt"], gender: "men" });
  assert.match(JSON.stringify(out), /Beige/);
});

test("9. Chit-chat turns where the model calls no tool produce 0 product cards (no hardcoded classifier)", async () => {
  for (const msg of [
    "heyy kya haal chal",
    "what can you do",
    "bidi milegi kya",
    "okay",
  ]) {
    const s = ecommerce.createSession(
      SHOP,
      {
        clientId: `sim-conv-${crypto.randomUUID()}`,
        userMessage: msg,
        replyLanguage: "hinglish",
      },
      { loadCheckout: async () => null, saveCheckout: async () => null }
    );
    assert.equal(s.result().products.length, 0, `Should return 0 products for: ${msg}`);
  }
});