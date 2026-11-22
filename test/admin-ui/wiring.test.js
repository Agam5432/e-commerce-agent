// The dashboard is built from template strings, so a button can name an action nobody registered and nothing complains
// until someone clicks it. This checks, from the source, that every named action and every screen exists.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../src/public/admin/", import.meta.url));
const files = ["app.js", "support.js", ...readdirSync(path.join(root, "screens")).map((f) => `screens/${f}`)];
const source = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(root, f), "utf8")]));
const all = Object.values(source).join("\n");

test("every data-action in a screen is registered", () => {
  const used = new Set([...all.matchAll(/data-action="([a-z][a-z-]*)"/g)].map((m) => m[1]));
  // registered one by one, or in a loop over a list of names
  const registered = new Set([...all.matchAll(/actions\['([a-z-]+)'\]\s*=/g)].map((m) => m[1]));
  for (const m of all.matchAll(/for \(const id of \[([^\]]+)\]\) \{\s*actions\[`([a-z-]+)-\$\{id\}`\]/g)) {
    for (const id of m[1].match(/'([a-z]+)'/g)) registered.add(`${m[2]}-${id.replace(/'/g, "")}`);
  }
  for (const m of all.matchAll(/'((?:settings|qa|support)-[a-z-]+)':/g)) registered.add(m[1]);
  const missing = [...used].filter((name) => !registered.has(name));
  assert.deepEqual(missing, []);
});

test("every screen of the sidebar is registered", () => {
  const core = readFileSync(path.join(root, "core.js"), "utf8");
  const nav = [...core.slice(core.indexOf("export const NAV"), core.indexOf("];")).matchAll(/\{id: '([a-z]+)', label:/g)].map((m) => m[1]);
  assert.ok(nav.length >= 9);
  for (const id of nav) assert.ok(all.includes(`screens.${id} =`), `no screen for ${id}`);
});

test("every page the app imports exists", () => {
  for (const f of files) {
    for (const m of source[f].matchAll(/from '(\.[^']+)'/g)) assert.ok(existsSync(path.resolve(path.dirname(path.join(root, f)), m[1])), `${f} imports ${m[1]}`);
  }
});

test("the widest list the dashboard asks for is accepted by the server (at most 366 days)", async () => {
  const { wideRange } = await import("../../src/public/admin/core.js");
  const { parseRange } = await import("../../src/admin/stats.js");
  const r = wideRange();
  const parsed = parseRange(r, "UTC");
  assert.ok(parsed.days <= 366 && parsed.days >= 360, `${parsed.days} days`);
});
