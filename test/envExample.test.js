// .env.example stays the complete, current list of settings: every setting the code reads is in it,
// and nothing in it is a setting the code no longer reads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// set by the test runner itself, not a setting
const INTERNAL = new Set(["NODE_TEST_CONTEXT"]);
// still read only to warn that it is no longer used
const RETIRED = new Set(["EXPRESS_SHIPPING_COST"]);

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "public" || name === "node_modules") continue;
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".js")) out.push(path);
  }
  return out;
}

const PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]+)/g,
  /\benv\.([A-Z][A-Z0-9_]+)/g,
  /\benv\[\s*["']([A-Z][A-Z0-9_]+)/g,
  /envCount\(\s*["']([A-Z][A-Z0-9_]+)/g,
  /envNumber\(\s*(?:env\s*,\s*)?["']([A-Z][A-Z0-9_]+)/g,
  /isSet\(env,\s*["']([A-Z][A-Z0-9_]+)/g,
];

function settingsInCode() {
  const text = [join(root, "server.js"), ...sources(join(root, "src"))].map((f) => readFileSync(f, "utf8")).join("\n");
  const names = new Set();
  for (const re of PATTERNS) for (const m of text.matchAll(re)) names.add(m[1]);
  return names;
}

const documented = new Set([...readFileSync(join(root, ".env.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

test("every setting the code reads is in .env.example", () => {
  const missing = [...settingsInCode()].filter((n) => !documented.has(n) && !INTERNAL.has(n) && !RETIRED.has(n)).sort();
  assert.deepEqual(missing, [], `add these to .env.example: ${missing.join(", ")}`);
});

test("nothing in .env.example is a setting the code no longer reads", () => {
  const used = settingsInCode();
  const stale = [...documented].filter((n) => !used.has(n)).sort();
  assert.deepEqual(stale, [], `remove these from .env.example: ${stale.join(", ")}`);
});

test(".env is never committed, and secrets in .env.example are empty", () => {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^\.env$/m);
  const example = readFileSync(join(root, ".env.example"), "utf8");
  for (const secret of ["SHOPIFY_CLIENT_SECRET", "SHOPIFY_TOKEN_ENCRYPTION_KEY", "OTP_HMAC_SECRET", "ANALYTICS_HMAC_SECRET", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "EMAIL_APP_PASSWORD"]) {
    assert.match(example, new RegExp(`^${secret}=$`, "m"), `${secret} must be empty in the example`);
  }
});
