function minorAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

// Both the full Ajax cart and the storefront widget's compact cart use minor
// units. The compact payload omits unit prices but retains integer line totals.
// Recover units from those totals, never from the magnitude of a dollar price.
// The cart comes from the browser: its text is kept to one plain, short line per field, so a crafted
// item name cannot carry line breaks or pages of text into the AI's prompt. Prices are re-checked
// with Shopify before any order is placed.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function plain(value, depth = 0) {
  if (typeof value === "string") return value.replace(CONTROL, " ").replace(/\s{2,}/g, " ").slice(0, 300);
  if (depth > 3 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => plain(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [k, plain(v, depth + 1)]));
}

export function normalizeCartSnapshot(rawCart) {
  if (!rawCart || typeof rawCart !== "object" || !Array.isArray(rawCart.items)) return null;
  const cart = { ...plain(rawCart), items: rawCart.items.slice(0, 100).map((item) => plain(item)) };
  const items = cart.items.map(item => {
    const quantity = Number(item.quantity);
    const validQuantity = Number.isSafeInteger(quantity) && quantity > 0;
    let price = minorAmount(item.original_price) ?? minorAmount(item.price);
    const originalLine = minorAmount(item.original_line_price) ?? minorAmount(item.line_price) ?? minorAmount(item.final_line_price);
    if (price === null && validQuantity && originalLine !== null && originalLine % quantity === 0) price = originalLine / quantity;
    const originalLinePrice = price !== null && validQuantity ? price * quantity : originalLine;
    const linePrice = minorAmount(item.final_line_price ?? item.line_price) ?? originalLinePrice;
    return { ...item, quantity, price, original_price: price,
      original_line_price: originalLinePrice, line_price: linePrice, final_line_price: linePrice };
  });
  const complete = items.every(item => item.price !== null && Number.isSafeInteger(item.quantity) && item.quantity > 0);
  const originalTotal = complete ? items.reduce((sum, item) => sum + item.original_line_price, 0) : null;
  const computedTotal = complete ? items.reduce((sum, item) => sum + item.line_price, 0) : null;
  return { ...cart, items, currency: cart.currency || cart.currency_code || "USD",
    item_count: items.reduce((sum, item) => sum + (Number.isSafeInteger(item.quantity) ? item.quantity : 0), 0),
    original_total_price: originalTotal,
    total_price: computedTotal,
    pricingComplete: complete,
  };
}

export function requireCartPricing(cart) {
  if (cart?.items?.length && cart.pricingComplete === false) {
    throw new Error("Cart prices are missing. Refresh your cart so I can show the correct order total.");
  }
}
