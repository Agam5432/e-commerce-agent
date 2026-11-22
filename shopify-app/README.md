# Orbi AI – Shopify app

Storefront shopping assistant (chat + voice) and the merchant dashboard. The backend is in the same repository, at the repository root (`../server.js`, `../src`); this folder is the Shopify app (`shopify-app/`).

| Part | Folder | What it is |
| --- | --- | --- |
| Storefront widget | `extensions/ai-chat-widget` | Theme app extension: `blocks/ai_chat_widget.liquid`, `assets/ai-chat-widget.css`, `assets/ai-chat-widget.js`. Talks to the backend through the app proxy `/apps/ai-agent/*`; photos/videos/PDFs go straight to the backend with a short-lived token. |
| Merchant dashboard | `src/public/admin` (repository root) | Embedded (iframe) app opened from Shopify admin: overview, chats (with customer attachments), orders, customers, agent settings. Served by the backend at the app URL; there is no admin extension in this project, so the old `extensions/app-home` UI extension must not exist or it takes over the app's home page. |

## Develop

```bash
npm install
npm run dev        # shopify app dev
npm run deploy     # shopify app deploy
```

Widget browser tests (Playwright): see `tests/widget/README.md`.

Dashboard tests live at the repository root: `npm test` (`test/admin-ui` and `test/admin`).

## Configuration

* `shopify.app.ai-commerce-agent.toml` – scopes, webhooks, app proxy (`/apps/ai-agent` → backend `/proxy`). There is one app. For production set `application_url`, `redirect_urls` and `[app_proxy] url` to the production `APP_URL` and run `npm run deploy` from this folder; `shopify app dev` swaps in a tunnel URL for local work and does not need these edited back and forth. The scopes here must equal `src/config/shopifyScopes.js` (a root test checks it).
* The theme block asks the merchant for the backend URL (`api_url`) and an optional fallback greeting that is shown only when the AI cannot be reached.
