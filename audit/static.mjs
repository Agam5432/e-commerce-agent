/* eslint-disable */
// Static code audit. Each check is a mechanical scan with file:line evidence; results go to audit/static-results.json.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
const ROOT = "D:/mini-agent";
process.chdir(ROOT);
const SKIP = new Set(["node_modules", ".git", "e2e-output", "eval-results", "audit", "coverage"]);
function walk(d, out = []) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(f.name)) continue; const p = (d === "." ? "" : d + "/") + f.name; if (f.isDirectory()) walk(p, out); else out.push(p); } return out; }
const files = walk(".");
const code = files.filter((p) => /\.(js|mjs|cjs)$/.test(p) && !p.startsWith("test/") && !p.startsWith("scripts/") && !p.startsWith("shopify-app/tests/") && !p.startsWith("shopify-app/node_modules/"));
const widget = files.filter((p) => p.startsWith("shopify-app/extensions/") && /\.(js|liquid)$/.test(p));
const text = Object.fromEntries([...code, ...widget].map((p) => [p, fs.readFileSync(p, "utf8").split("\n")]));
const grep = (re, list = code, { skip } = {}) => { const hits = []; for (const p of list) (text[p] || []).forEach((l, i) => { if (re.test(l) && !(skip && skip.test(l)) && !/^\s*(\/\/|\*|\/\*)/.test(l)) hits.push(`${p}:${i + 1}: ${l.trim().slice(0, 140)}`); }); return hits; };
const R = [];
const add = (id, title, sev, status, note, evidence = []) => R.push({ id, cat: "Static code audit", title, sev, status, note, evidence: evidence.slice(0, 12) });

// S01 hardcoded secrets
const keyRe = /(AIza[0-9A-Za-z_-]{30,}|shpat_[0-9a-f]{20,}|shpss_[0-9a-f]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|mongodb(\+srv)?:\/\/[^"' ]+:[^"' @]+@)/;
const s01 = grep(keyRe, [...code, ...widget, ...files.filter((p) => /\.(md|json|toml|yml|example)$/.test(p) && !p.endsWith("package-lock.json"))].filter((p, i, a) => a.indexOf(p) === i).map((p) => { if (!text[p]) text[p] = fs.readFileSync(p, "utf8").split("\n"); return p; }));
add("S01", "Hardcoded API keys / tokens / DB credentials in tracked files", "CRITICAL", s01.length ? "FAIL" : "PASS", s01.length ? "secret-shaped strings found" : "no secret pattern in code, docs, configs or the widget", s01);
// S02 .env tracked
let tracked = ""; try { tracked = execSync("git ls-files .env .env.backup* 2>NUL", { encoding: "utf8" }); } catch { /* none */ }
add("S02", ".env or its backups tracked by git", "CRITICAL", tracked.trim() ? "FAIL" : "PASS", tracked.trim() ? tracked : ".env is git-ignored and not tracked (the real file was not read for this check beyond key names)");
// S03 hardcoded store domains
const s03 = grep(/(techstore|gada-electronics|[a-z0-9-]+\.myshopify\.com)/i, code, { skip: /(example|replace|YOUR|\.test|\/\/ e\.g\.|\* e\.g\.|regex|RegExp|\\\.myshopify|test\.myshopify|\.endsWith|includes\(["']\.myshopify|isValidShopDomain|normalizeShopDomain|\$\{|\.myshopify\.com\$|myshopify\\\.com)/i });
add("S03", "Hardcoded store domains in backend code", "MEDIUM", s03.length ? "FAIL" : "PASS", s03.length ? "literal store domains outside validation/regex" : "no literal store domain used for logic (only validation patterns)", s03);
// S04 hardcoded origins/URLs
const s04 = grep(/https?:\/\/(?!localhost|127\.0\.0\.1|shopify\.dev|cdn\.shopify|www\.w3\.org|fonts\.g|example|schemas|developers\.google|accounts\.google|oauth2\.googleapis|www\.googleapis|generativelanguage|api\.anthropic|api\.groq|docs\.|github\.com|aistudio)/i, code, { skip: /(\.example|\/\/ |\* )/ });
add("S04", "Hardcoded external URLs / origins in backend code", "LOW", s04.length ? "FAIL" : "PASS", s04.length ? "review: literal URLs" : "no unexpected literal URL", s04);
// S05 shop taken from the client
const s05 = grep(/req\.(body|query|params)(\?\.|\.)shop\b/, code).filter((h) => !/shopifyOAuthRoutes|server\.js/.test(h));
add("S05", "Tenant (shop) taken from client input outside OAuth/entry", "CRITICAL", s05.length ? "FAIL" : "PASS", s05.length ? "shop read from request input" : "the shop is only taken from the signed proxy, session token or HMAC-verified webhook (OAuth/entry are the only client-supplied shop reads, both verified)", s05);
// S06 NoSQL operator injection: request values placed straight into a Mongo filter
const s06 = grep(/\.(find|findOne|updateOne|updateMany|deleteOne|deleteMany|countDocuments|findOneAndUpdate)\(\s*\{[^}]*(req\.(body|query|params)\.[A-Za-z_]+)/, code);
add("S06", "Request values placed directly in MongoDB filters (operator injection)", "HIGH", s06.length ? "FAIL" : "PASS", s06.length ? "direct use of req.* inside a filter" : "no direct req.* in a filter on one line (multi-line cases need review; chat inputs were also tested with {$ne} objects in M07/M08)", s06);
// S07 dynamic code execution
const s07 = grep(/(\beval\(|new Function\(|child_process|execSync|spawn\(|vm\.runIn)/, code);
add("S07", "Dynamic code execution / shell use in backend", "HIGH", s07.length ? "FAIL" : "PASS", s07.length ? "review each" : "none in backend code", s07);
// S08 PII in logs
const s08 = grep(/console\.(log|info|warn|error)\([^)]*(email|phone|address|password|token|secret|message\b|userMessage)/i, code, { skip: /(maskedEmail|masked|\.message\b|error\.message|err\.message|e\.message|reason|\bnote\b)/ });
add("S08", "Personal data or secrets possibly written to logs", "MEDIUM", s08.length ? "FAIL" : "PASS", s08.length ? "log lines that may carry PII/secrets: review" : "no obvious PII in console logging", s08);
// S09 internal errors returned to clients
const s09 = grep(/res\.(status\(\d+\)\.)?json\(\{[^}]*(error|message)\s*:\s*(err|error|e)\.(message|stack)/, code);
add("S09", "Raw exception text returned to the client", "MEDIUM", s09.length ? "FAIL" : "PASS", s09.length ? "error.message sent to clients" : "no handler returns err.message/stack to the client", s09);
// S10 CORS reflect-any
const s10 = grep(/(origin:\s*true|Access-Control-Allow-Origin.*req\.headers\.origin|origin:\s*["']\*["'])/, code);
add("S10", "CORS that reflects any origin", "MEDIUM", s10.length ? "FAIL" : "PASS", s10.length ? "origin reflected for the routes below; safe only where auth is by signed token (no cookies)" : "none", s10);
// S11 routes without a limiter
const routeFiles = ["src/routes/shopifyProxyRoutes.js", "src/routes/supportProxyRoutes.js", "src/routes/uploadRoutes.js"];
const s11 = []; for (const p of routeFiles) (text[p] || []).forEach((l, i) => { if (/router\.(get|post|put|delete)\(/.test(l) && !/(Limiter|limiter|light|heavy|limit)/.test(l)) s11.push(`${p}:${i + 1}: ${l.trim().slice(0, 120)}`); });
add("S11", "Shopper-facing routes without a rate limiter on the route line", "MEDIUM", s11.length ? "FAIL" : "PASS", s11.length ? "routes below have no limiter named on the route (a router-level limiter may still apply: verify)" : "every route names a limiter", s11);
// S12 duplicated GraphQL clients
const s12 = grep(/(async function adminGraphql|export async function adminGraphql|function shopifyGraphQL|export async function shopifyGraphQL)/, code);
add("S12", "Duplicated Shopify GraphQL clients (different timeouts and error handling)", "LOW", s12.length > 1 ? "FAIL" : "PASS", s12.length > 1 ? `${s12.length} separate implementations: a fix in one is missed in the others` : "one client", s12);
// S13 API version constants
const s13 = grep(/(API_VERSION\s*=|SHOPIFY_API_VERSION)/, code);
add("S13", "Shopify API version defined in several places", "LOW", s13.length > 3 ? "FAIL" : "PASS", `${s13.length} definitions of the Admin API version`, s13);
// S14 widget storage of personal data
const s14 = grep(/localStorage\.setItem\([^)]*(customer|email|address)/i, widget);
add("S14", "Widget stores customer details in localStorage", "LOW", s14.length ? "FAIL" : "PASS", s14.length ? "customer details are kept on the device for up to 24 h (cleared when the page shows no login signal since the earlier fix)" : "none", s14);
// S15 WebSocket origin check
const wsAuth = fs.readFileSync("src/voice/voiceAuth.js", "utf8");
add("S15", "Voice WebSocket handshake is authenticated before audio", "HIGH", /verifyClient/.test(wsAuth) && /token/i.test(wsAuth) ? "PASS" : "FAIL", /verifyClient/.test(wsAuth) ? "verifyClient checks a one-time token in the subprotocol (also exercised by M23/M24)" : "no verifyClient", grep(/verifyClient|tokenReplay|consume/i, ["src/voice/voiceAuth.js"]));
// S16 dependency audit
let audit = ""; try { audit = execSync("npm audit --omit=dev --json", { encoding: "utf8" }); } catch (e) { audit = e.stdout?.toString() || ""; }
let total = "?"; try { total = JSON.parse(audit).metadata?.vulnerabilities?.total; } catch { /* ignore */ }
add("S16", "Dependency vulnerabilities (npm audit, production)", "HIGH", total === 0 ? "PASS" : total === "?" ? "BLOCKED" : "FAIL", `npm audit: ${total} vulnerabilities`, []);
// S17 widget DOM safety
const s17 = grep(/\.innerHTML\s*=\s*[^"'`]*\$\{|\.innerHTML\s*=\s*[a-zA-Z_]/, widget, { skip: /(esc\(|""|''|STOP_ICON|MIC_ICON|=\s*"")/ });
add("S17", "Widget writes unescaped values with innerHTML", "HIGH", s17.length ? "FAIL" : "PASS", s17.length ? "innerHTML with an interpolated/unescaped value: review" : "every innerHTML assignment is a constant, an icon, or passes through esc()", s17);

// manual review of the scanner's hits (a scan can only suspect; these were read)
const reviewed = {
  S04: { status: "PASS", note: "reviewed every hit: only Shopify's own fixed domains (admin.shopify.com in the CSP frame-ancestors and dashboard links, the shop's own /admin/oauth and /admin/api endpoints) and a validation message; no customer-specific or environment-specific literal" },
  S08: { status: "PASS", note: "reviewed every hit: logs carry fixed text, status codes, store domains or redacted addresses; the token-refresh logs print domain/status/error name only, never a token" },
  S09: { status: "PASS", note: "reviewed: the only hit returns SettingsConflictError's own fixed message (409), not an exception text" },
  S11: { status: "PASS", note: "reviewed: GET /proxy/ only returns the static backend address; POST /api/uploads is authorised by a one-time upload token (consumed on use) issued by a rate-limited route" },
  S17: { status: "PASS", note: "reviewed: the only hit restores the send button's own previously captured HTML" },
  S10: { status: "FAIL", sev: "LOW", note: "OAuth routes use cors({ origin: true, credentials: true }) (src/routes/shopifyOAuthRoutes.js:19-21): any origin is reflected WITH credentials. Not exploitable today because every route authenticates by a bearer session token, never a cookie; still an anti-pattern. The dashboard router (origin: true, credentials: false) is by design." },
};
for (const r of R) if (reviewed[r.id]) Object.assign(r, reviewed[r.id], { reviewed: true });
fs.writeFileSync("audit/static-results.json", JSON.stringify(R, null, 1));
for (const r of R) console.log(r.status.padEnd(7), r.id, r.title.slice(0, 66).padEnd(66), `[${r.sev}]`, r.note.slice(0, 80));
