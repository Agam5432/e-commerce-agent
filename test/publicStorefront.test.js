// Standalone storefront: only the configured origin + shop are served; the site builds without leftover Liquid.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { storefrontOriginCheck } from "../src/http/storefrontCors.js";
import { publicStorefrontShop } from "../src/routes/shopifyProxyRoutes.js";

const ask = (check, origin) => new Promise((res, rej) => check(origin, (e, ok) => (e ? rej(e) : res(ok))));

test("PUBLIC_STOREFRONT_ORIGINS: exact https origins only", async () => {
  const check = storefrontOriginCheck({ isActive: async () => false, env: { NODE_ENV: "production", PUBLIC_STOREFRONT_ORIGINS: "https://techstore-shop.onrender.com, https://shop.example.in" } });
  assert.equal(await ask(check, "https://techstore-shop.onrender.com"), true);
  assert.equal(await ask(check, "https://shop.example.in"), true);
  assert.equal(await ask(check, "https://other.onrender.com"), false);
  assert.equal(await ask(check, "http://techstore-shop.onrender.com"), false);
});

test("publicStorefrontShop: unset or non-myshopify values are off", () => {
  assert.equal(publicStorefrontShop({}), "");
  assert.equal(publicStorefrontShop({ PUBLIC_STOREFRONT_SHOP: "evil.com" }), "");
  assert.equal(publicStorefrontShop({ PUBLIC_STOREFRONT_SHOP: "A.myshopify.com" }), "a.myshopify.com");
});

test("storefront build leaves no Liquid and points at the backend", () => {
  const out = mkdtempSync(path.join(tmpdir(), "sf-"));
  execFileSync("node", ["storefront/build.mjs"], { env: { ...process.env, STOREFRONT_OUT: out } });
  const dir = readdirSync(out).includes("index.html") ? out : "storefront/dist";
  const html = readFileSync(path.join(dir, "index.html"), "utf8");
  assert.ok(!/\{\{|\{%/.test(html));
  assert.ok(html.includes("https://techstore-agent.onrender.com"));
});
