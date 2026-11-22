// The page Shopify opens inside the admin. It is one static HTML file; the only thing filled in is the
// app's public key (App Bridge reads it to sign the session token the dashboard sends to /admin/api).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = fileURLToPath(new URL("./shell.html", import.meta.url));
const PLACEHOLDER = "%%SHOPIFY_API_KEY%%";

const escapeAttribute = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @returns {() => string} renders the page for the current environment (the key is read on each call).
 * The page file is read once in production; elsewhere it is read on every call, so editing it needs no restart.
 */
export function createShell({ template = null, key = () => process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || "" } = {}) {
  let cached = template;
  const load = () => {
    if (cached !== null) return cached;
    const text = readFileSync(TEMPLATE_PATH, "utf8");
    if (!text.includes(PLACEHOLDER)) throw new Error("The admin page template has no API key placeholder.");
    if (process.env.NODE_ENV === "production") cached = text;
    return text;
  };
  if (template !== null && !template.includes(PLACEHOLDER)) throw new Error("The admin page template has no API key placeholder.");
  load();
  return () => load().split(PLACEHOLDER).join(escapeAttribute(key()));
}

export const renderShell = createShell();
