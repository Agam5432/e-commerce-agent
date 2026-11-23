// Builds the standalone storefront into storefront/dist:
//  - the chat widget block (a Shopify Liquid file) is rendered once for a guest visitor, so the website
//    shows the exact same Orbi chat as the Shopify theme;
//  - the widget's own scripts/styles are copied next to the page, so there is a single source of truth.
// Run by Render as the build command of the static site: node storefront/build.mjs
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const widgetDir = join(here, "..", "shopify-app", "extensions", "ai-chat-widget");
const dist = join(here, "dist");

const SHOP_DOMAIN = process.env.STOREFRONT_SHOP || "techstore-3qkasoly.myshopify.com";
const SHOP_NAME = process.env.STOREFRONT_NAME || "TechStore";
const BACKEND = (process.env.STOREFRONT_BACKEND_URL || "https://techstore-agent.onrender.com").replace(/\/+$/, "");

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Liquid, for a visitor who is not logged in: every `if customer…` chain takes its `else` branch (or nothing). */
export function renderGuest(liquid) {
  const tokenRe = /{%-?\s*(if|elsif|else|endif)\b([^%]*)-?%}/g;
  let out = "";
  let last = 0;
  const stack = []; // each open if: true while we are inside its else branch
  const visible = () => stack.every((inElse) => inElse);
  let m;
  while ((m = tokenRe.exec(liquid))) {
    if (visible()) out += liquid.slice(last, m.index);
    last = m.index + m[0].length;
    const kind = m[1];
    if (kind === "if") stack.push(false);
    else if (kind === "else") stack[stack.length - 1] = true;
    else if (kind === "endif") stack.pop();
    // elsif: condition is false for a guest, stay out of that branch
  }
  if (visible()) out += liquid.slice(last);
  return out;
}

export function buildWidgetMarkup(liquid) {
  let html = liquid.replace(/{%\s*schema\s*%}[\s\S]*?{%\s*endschema\s*%}/, "");
  html = html.replace(/{{\s*'([^']+)'\s*\|\s*asset_url\s*}}/g, "widget/$1");
  html = html.replace(/{{\s*'([^']+)'\s*\|\s*asset_url\s*\|\s*stylesheet_tag\s*}}/g, '<link rel="stylesheet" href="widget/$1">');
  html = renderGuest(html);
  html = html
    .replace(/{{\s*block\.id\s*}}/g, "shop")
    .replace(/{{\s*shop\.permanent_domain\s*\|\s*json\s*}}/g, JSON.stringify(SHOP_DOMAIN))
    .replace(/{{\s*shop\.permanent_domain\s*}}/g, SHOP_DOMAIN)
    .replace(/{{\s*shop\.name\s*\|\s*escape\s*}}/g, escapeHtml(SHOP_NAME))
    .replace(/{{\s*block\.settings\.api_url\s*\|\s*escape\s*}}/g, escapeHtml(BACKEND))
    .replace(/{{\s*block\.settings\.fallback_greeting\s*\|\s*escape\s*}}/g, "")
    .replace(/{{\s*routes\.cart_url\s*}}/g, "#cart")
    .replace(/{{\s*customer\.[^}]*}}/g, "");
  const left = html.match(/{{[^}]*}}|{%[^%]*%}/g);
  if (left) throw new Error(`Unrendered Liquid left in the widget markup: ${left.slice(0, 3).join(" | ")}`);
  return html;
}

export function build() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, "widget"), { recursive: true });
  for (const f of ["ai-chat-widget.js", "ai-chat-widget.css", "ai-chat-widget-support.js", "ai-chat-widget-support.css", "thumbs-up.png"]) {
    cpSync(join(widgetDir, "assets", f), join(dist, "widget", f));
  }
  for (const f of ["styles.css", "shim.js", "look.js", "app.js"]) cpSync(join(here, "src", f), join(dist, f));
  // optional one-off files (e.g. a product import CSV) published under /import/
  if (existsSync(join(here, "src", "import"))) cpSync(join(here, "src", "import"), join(dist, "import"), { recursive: true });
  const widget = buildWidgetMarkup(readFileSync(join(widgetDir, "blocks", "ai_chat_widget.liquid"), "utf8"));
  const page = readFileSync(join(here, "src", "index.html"), "utf8")
    .replace(/__SHOP_NAME__/g, escapeHtml(SHOP_NAME))
    .replace(/__BACKEND__/g, escapeHtml(BACKEND))
    .replace("<!--ORBI_WIDGET-->", widget);
  writeFileSync(join(dist, "index.html"), page);
  if (!existsSync(join(dist, "index.html"))) throw new Error("build failed");
  console.log(`storefront built: ${dist} (shop ${SHOP_DOMAIN}, backend ${BACKEND})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();
