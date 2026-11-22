# Second-store installation and isolation test plan (Pillar 6)

Status: BLOCKED until a second development store is installed with this app. Code-level isolation is covered by automated tests (see the end); nothing here is real multi-store evidence yet.

## What the owner has to do (one time)
1. In the Shopify Partner dashboard create a second development store (for example `techstore-two`), with its own products (at least 3 products that do NOT exist in TechStore, plus 1 product with the same title as one in TechStore but another price), one customer with a different e-mail, and one test order.
2. Turn on the Bogus Gateway (Settings > Payments > test mode) and the storefront password as for TechStore; note the password.
3. Install the app on that store through the app's install link on the current tunnel (OAuth), and add the app embed / widget to its theme exactly as on TechStore. No `shopify app deploy`/release is needed for the install itself if the dev app is already distributed to the Partner organisation; if the Partner dashboard asks for a new app version, that is a release and needs the owner's approval.
4. Tell me the store domain and the storefront password.

## What I run once it is installed (all through the real widget unless noted)
| # | Test | Expected | Evidence to keep |
|---|------|----------|------------------|
| 1 | `StoreIntegration` rows: two active stores, different encrypted tokens | each shop resolves its own token | DB listing with token fields redacted |
| 2 | Ask store B for a product that exists only in A ("Samsung Galaxy A55") | "not sold here"; no card from A | chat transcript + card list |
| 3 | Ask store A for a product that exists only in B | same, reversed | transcript |
| 4 | Same-titled product with different price | each store shows its OWN price, its own currency | transcript vs each Shopify admin |
| 5 | Offers: ask "what discounts do you have" on both | only that store's discount codes | transcript vs Shopify discounts |
| 6 | Cart + checkout quote on B, then on A, same browser | each quote from its own Shopify (`draftOrderCalculate` per shop) | quote JSON |
| 7 | Place one COD test order on B | order exists only in B's admin; the analytics Event has `shop = B` | admin order + Event row |
| 8 | Order lookup: customer verified for A asks for B's order number | refused / not found | transcript |
| 9 | OTP session for A reused against B | rejected | transcript + server log |
| 10 | Same `clientId` (same browser) chatting on A then B | histories, carts, checkout memory and shown-products ledgers are separate | DB: `Conversation`, checkout memory keyed by `shop:clientId` |
| 11 | Voice token / call from A used on B | rejected | log |
| 12 | Admin dashboard of A | counts and revenue of A only; B's orders absent | screenshots |
| 13 | Uninstall webhook for B | only B switches off | `StoreIntegration` rows |
| 14 | Privacy erase for a B customer | A's records of the same e-mail untouched | DB counts |

## Code-level checks already automated (not a substitute)
`test/` contains isolation tests for caches, checkout memory, discounts, order lookup ownership, reasons, analytics events and privacy erase; the earlier audit counted 10 multi-store tests with a SIMULATED second store. They stay green (1270 tests).
