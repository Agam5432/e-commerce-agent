// The Shopify permissions the app asks for, and the reason for each: the list Shopify's app review
// asks about. Each entry names the code that needs it (test/shopifyScopes.test.js checks the code is
// really there), so a scope cannot stay requested after its last use is removed. Must match
// [access_scopes] in the app's shopify.app.ai-commerce-agent.toml.
export const SHOPIFY_SCOPES = [
  { scope: "read_products", why: "Search the catalog and show real products, prices and variants in the chat.", file: "src/tools/shopify/search.js", uses: /\bproducts\s*\(/ },
  { scope: "read_inventory", why: "Say whether a size or colour is in stock before suggesting it.", file: "src/tools/shopify/products.js", uses: /inventoryQuantity/ },
  { scope: "read_locations", why: "Give the store's pickup address when the owner allows it.", file: "src/tools/shopify/catalog.js", uses: /\blocations\s*\(/ },
  { scope: "read_customers", why: "Recognise a signed-in shopper (name, saved address) from Shopify's signed customer id.", file: "src/services/shopifyCustomerService.js", uses: /\bcustomer\s*\(id:/ },
  { scope: "write_customers", why: "Create the customer record for a guest who places an order in the chat.", file: "src/services/shopifyOrderService.js", uses: /customerCreate/ },
  { scope: "read_orders", why: "Answer \"where is my order?\" after the shopper verifies their email, and count orders that came from a chat.", file: "src/services/shopifyOrderLookupService.js", uses: /\borders\s*\(/ },
  { scope: "write_orders", why: "Cancel an unshipped order when its verified owner asks in the chat.", file: "src/services/shopifyOrderLookupService.js", uses: /orderCancel/ },
  { scope: "read_draft_orders", why: "Read back the draft order the chat created, to confirm totals.", file: "src/services/shopifyOrderService.js", uses: /draftOrderCalculate/ },
  { scope: "write_draft_orders", why: "Place the shopper's order from the chat: draft, price check with Shopify, complete.", file: "src/services/shopifyOrderService.js", uses: /draftOrderCreate[\s\S]*draftOrderComplete|draftOrderComplete[\s\S]*draftOrderCreate/ },
  { scope: "read_discounts", why: "Mention and apply only real, active discount codes.", file: "src/tools/shopify/offers.js", uses: /discountNodes/ },
  { scope: "read_legal_policies", why: "Quote the store's own refund, shipping and privacy policies.", file: "src/tools/shopify/policies.js", uses: /shopPolicies/ },
];

export const DEFAULT_SCOPES = SHOPIFY_SCOPES.map((s) => s.scope).join(",");
