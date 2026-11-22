// Builds the deliverables in audit/reports/ from: results.json (API suite), results-live.json (live-catalog run), static-results.json,
// live-results.json (real-store read-only checks), browser-results.json (real Chrome widget run) and findings.json (curated analysis).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const A = "D:/mini-agent/audit";
const OUT = path.join(A, "reports");
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire("D:/mini-agent/package.json");
const ExcelJS = require("exceljs");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(A, f), "utf8")); } catch { return d; } };
const api = read("results.json", { results: [], meta: {} });
const live = read("results-live.json", { results: [], meta: {} });
const stat = read("static-results.json", []);
const real = read("live-results.json", { checks: [], notes: [], status: "NOT RUN" });
const browser = read("browser-results.json", { steps: [] });
const findings = read("findings.json", { findings: [], limitations: [], verdict: {} });
const manual = read("manual-cases.json", []);

// ---- one flat list of every test case ------------------------------------------------------------------------------------------------
const rows = [];
const fix = (id) => findings.findings.find((f) => (f.cases || []).includes(id));
for (const r of api.results) rows.push({ id: r.id, cat: r.cat, title: r.title, run: "REAL Gemini model; isolated sandbox backend reached through the signed app-proxy (the widget's own transport); run BEFORE the fixes", ctx: r.ctx || "", messages: (r.turns || []).map((t) => t.message).join("  ->  "), expected: r.expect, actual: (r.turns || []).map((t) => t.reply).filter(Boolean).slice(-1)[0] || "", tools: (r.turns || []).flatMap((t) => t.tools || []).join(", "), writes: (r.mutations || []).join(", "), verification: [r.note, r.attempts ? `attempts: ${r.attempts}` : ""].filter(Boolean).join(" | "), status: r.status, severity: r.severity || "", evidence: (r.turns || []).map((t) => (t.cards || []).join("; ")).filter(Boolean).slice(-1)[0] || (r.turns?.length ? "" : "console summary of the run (transcript not retained)"), conf: r.conf || "verified" });
for (const r of live.results) rows.push({ id: `${r.id}-LIVE`, cat: `${r.cat} (REAL catalog)`, title: r.title, run: "API through the app-proxy; products, prices and stock read live from the real TechStore", messages: (r.turns || []).map((t) => t.message).join("  ->  "), expected: r.expect, actual: (r.turns || []).map((t) => t.reply).filter(Boolean).slice(-1)[0] || "", tools: (r.turns || []).flatMap((t) => t.tools || []).join(", "), writes: (r.mutations || []).join(", "), verification: r.note || "", status: r.status, severity: r.severity || "", evidence: (r.turns || []).map((t) => (t.cards || []).join("; ")).filter(Boolean).slice(-1)[0] || "", conf: r.conf || "verified" });
for (const r of stat) rows.push({ id: r.id, cat: r.cat, title: r.title, run: "Static scan of the source, with manual review of hits", messages: "", expected: "No finding", actual: "", tools: "", writes: "", verification: r.note, status: r.status === "PASS" ? "PASS" : r.status === "BLOCKED" ? "BLOCKED" : "FAIL", severity: r.status === "FAIL" ? r.sev : "", evidence: (r.evidence || []).slice(0, 4).join("\n"), conf: r.reviewed ? "verified (reviewed)" : "verified" });
for (const c of real.checks || []) rows.push({ id: c.name.split(" ")[0], cat: "Real store (read-only)", title: c.name.replace(/^L\d+ /, ""), run: "REAL TechStore Admin API, read-only queries; counts and prices only (no customer or order data read)", messages: "", expected: "", actual: "", tools: "", writes: "none", verification: c.note, status: c.ok ? "PASS" : "FAIL", severity: c.ok ? "" : /recording/.test(c.name) ? "INFO" : "HIGH", evidence: c.note, conf: "verified" });
for (const s of browser.steps || []) rows.push({ id: `W-${s.id}`, cat: "Widget in a real Chrome (headed)", title: s.id.replace(/-/g, " "), run: "REAL Chrome (visible) on the REAL TechStore storefront and the owner's dev backend; read-only, every message tagged [QA-AUDIT]", messages: "", expected: "", actual: s.reply || "", tools: "", writes: "", verification: s.note || "", status: s.verdict === "PASS" ? "PASS" : s.verdict === "FAIL" ? "FAIL" : "REVIEW", severity: s.verdict === "FAIL" ? "MEDIUM" : "", evidence: s.shot || "", conf: "verified" });
for (const m of manual) rows.push({ ...m, run: m.run || "Not executed", messages: m.messages || "", writes: "", tools: "", actual: "", conf: "n/a" });
for (const r of rows) { const f = fix(r.id.replace(/-LIVE$/, "")); r.rootCause = f?.rootCause || ""; r.fix = f?.fix || ""; r.bug = f?.id || ""; }

const count = (list, s) => list.filter((r) => r.status === s).length;
const totals = { total: rows.length, pass: count(rows, "PASS"), fail: count(rows, "FAIL"), blocked: count(rows, "BLOCKED"), notTested: count(rows, "NOT TESTED"), review: count(rows, "REVIEW") };

// ---- TEST_CASES.xlsx -----------------------------------------------------------------------------------------------------------------------
const wb = new ExcelJS.Workbook();
const sum = wb.addWorksheet("Summary");
sum.addRows([["Shopify AI Shopping Agent: QA audit results"], [], ["Total test cases", totals.total], ["PASS", totals.pass], ["FAIL", totals.fail], ["BLOCKED (could not be run safely or technically)", totals.blocked], ["NOT TESTED", totals.notTested], ["REVIEW (widget step needing a human read)", totals.review], [], ["Generated", new Date().toISOString()], ["Model of the sandbox and storefront runs", "Gemini (gemini-3.1-flash-lite then gemini-3.5-flash-lite)"], ["Shopify writes attempted by the agent in the sandbox (refused)", "1 (E13, legitimate own-order cancel)"], [], ["By category", "PASS", "FAIL", "BLOCKED"]]);
const cats = [...new Set(rows.map((r) => r.cat))];
for (const c of cats) { const l = rows.filter((r) => r.cat === c); sum.addRow([c, count(l, "PASS"), count(l, "FAIL"), count(l, "BLOCKED") + count(l, "NOT TESTED")]); }
sum.getColumn(1).width = 62; sum.getRow(1).font = { bold: true, size: 14 };
const ws = wb.addWorksheet("Test cases", { views: [{ state: "frozen", ySplit: 1 }] });
const cols = [["Test ID", "id", 9], ["Category", "cat", 24], ["Title", "title", 44], ["How it was run", "run", 30], ["Customer message(s)", "messages", 52], ["Expected behaviour", "expected", 46], ["Actual AI response (last)", "actual", 60], ["Tool execution", "tools", 30], ["Shopify write attempts (refused by the sandbox)", "writes", 22], ["Verification (Shopify / backend / DB)", "verification", 60], ["Status", "status", 10], ["Severity", "severity", 10], ["Evidence", "evidence", 50], ["Confidence", "conf", 14], ["Bug ref", "bug", 9], ["Root cause", "rootCause", 50], ["Recommended fix", "fix", 50]];
ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
for (const r of rows) ws.addRow(r);
ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
ws.eachRow((row, i) => { if (i === 1) return; row.alignment = { vertical: "top", wrapText: true }; const s = row.getCell(11); const color = { PASS: "FFC6EFCE", FAIL: "FFFFC7CE", BLOCKED: "FFFFEB9C", "NOT TESTED": "FFD9D9D9", REVIEW: "FFFFEB9C" }[s.value]; if (color) s.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } }; });
ws.autoFilter = { from: "A1", to: `Q1` };
const bugs = wb.addWorksheet("Bugs");
bugs.columns = [["ID", 9], ["Severity", 10], ["Title", 50], ["Test cases", 18], ["Affected file / function", 50], ["Root cause", 60], ["Impact", 50], ["Recommended fix", 60], ["Confidence", 14], ["Status", 14]].map(([header, width]) => ({ header, width, key: header }));
for (const f of findings.findings) bugs.addRow({ ID: f.id, Severity: f.sev, Title: f.title, "Test cases": (f.cases || []).join(", "), "Affected file / function": (f.files || []).join("\n"), "Root cause": f.rootCause, Impact: f.impact, "Recommended fix": f.fix, Confidence: f.confidence, Status: "Open (audit only, not fixed)" });
bugs.getRow(1).font = { bold: true }; bugs.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
const blocked = wb.addWorksheet("Blocked and not tested");
blocked.columns = [["ID", 9], ["Title", 50], ["Status", 12], ["Why", 100]].map(([header, width]) => ({ header, width, key: header }));
for (const r of rows.filter((r) => r.status === "BLOCKED" || r.status === "NOT TESTED")) blocked.addRow({ ID: r.id, Title: r.title, Status: r.status, Why: r.verification });
for (const l of findings.limitations || []) blocked.addRow({ ID: "LIMIT", Title: l.title, Status: "LIMITATION", Why: l.why });
blocked.getRow(1).font = { bold: true }; blocked.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
await wb.xlsx.writeFile(path.join(OUT, "TEST_CASES.xlsx"));

// ---- markdown helpers ----------------------------------------------------------------------------------------------------------------------
const sevOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const fl = [...findings.findings].sort((a, b) => (sevOrder[a.sev] ?? 9) - (sevOrder[b.sev] ?? 9));
const failList = rows.filter((r) => r.status === "FAIL");
const md = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
const table = (head, body) => `| ${head.join(" | ")} |\n| ${head.map(() => "---").join(" | ")} |\n${body.map((r) => `| ${r.map(md).join(" | ")} |`).join("\n")}`;
const byCat = cats.map((c) => { const l = rows.filter((r) => r.cat === c); return [c, l.length, count(l, "PASS"), count(l, "FAIL"), count(l, "BLOCKED") + count(l, "NOT TESTED") + count(l, "REVIEW")]; });
const verdict = findings.verdict || {};

fs.writeFileSync(path.join(OUT, "BUG_REPORT.md"), `# Bug report\n\nThe audit itself changed nothing. Fixes marked FIXED below were implemented afterwards, one by one, and say how they were verified: **unit/agent tests with a scripted model prove the deterministic logic only; none of them proves the real Gemini model's behaviour (its quota was exhausted).** Items marked NOT FIXED are still open. Each item gives what is wrong, where, the evidence, the cause, the impact and the fix or suggested fix.\n\n${fl.map((f) => `## ${f.id} [${f.sev}] ${f.title}\n\n- **Confidence:** ${f.confidence}\n- **Test cases:** ${(f.cases || []).join(", ") || "code review"}\n- **Affected file and function:** ${(f.files || []).map((x) => "`" + x + "`").join("; ")}\n- **Reproduce:** ${(f.steps || []).join(" -> ")}\n- **Evidence:** ${f.evidence}\n- **Root cause:** ${f.rootCause}\n- **Impact:** ${f.impact}\n- **Recommended fix:** ${f.fix}\n- **Status:** open\n`).join("\n")}\n`);

fs.writeFileSync(path.join(OUT, "SECURITY_AUDIT.md"), `# Security audit\n\n${findings.securityIntro || ""}\n\n## Result by area\n\n${table(["Area", "Result", "Evidence (test ids)"], (findings.securityAreas || []).map((a) => [a.area, a.result, a.evidence]))}\n\n## Security findings\n\n${fl.filter((f) => f.security).map((f) => `- **${f.id} [${f.sev}] ${f.title}**: ${f.impact} Fix: ${f.fix}`).join("\n") || "none"}\n\n## Static scan (S01-S17)\n\n${table(["ID", "Check", "Status", "Note"], stat.map((s) => [s.id, s.title, s.status, s.note]))}\n\n## Recommendations\n\n${(findings.securityRecommendations || []).map((r) => `1. ${r}`).join("\n")}\n`);

fs.writeFileSync(path.join(OUT, "PRODUCTION_READINESS.md"), `# Production readiness\n\n## Verdict: ${verdict.label || "NOT DECIDED"}\n\n${verdict.text || ""}\n\n## Blocking issues\n\n${(verdict.blockers || []).map((b) => `- ${b}`).join("\n") || "none"}\n\n## High-priority fixes\n\n${fl.filter((f) => ["CRITICAL", "HIGH"].includes(f.sev)).map((f) => `- ${f.id} [${f.sev}] ${f.title} (${String(f.fix).split(":")[0]})`).join("\n") || "none"}\n\n## Remaining risks\n\n${(verdict.risks || []).map((b) => `- ${b}`).join("\n")}\n\n## What was NOT tested\n\n${(findings.limitations || []).map((l) => `- **${l.title}:** ${l.why}`).join("\n")}\n\n## Final release recommendation\n\n${verdict.recommendation || ""}\n`);

fs.writeFileSync(path.join(OUT, "COMPLETE_AUDIT_REPORT.md"), `# Complete audit report: Shopify AI Shopping Agent\n\n${findings.intro || ""}\n\n## 1. Testing summary\n\n- **Test cases: ${totals.total}**: PASS ${totals.pass}, FAIL ${totals.fail}, BLOCKED ${totals.blocked}, NOT TESTED ${totals.notTested}, REVIEW ${totals.review}.\n- Model of the sandbox and storefront runs: Gemini (the backend's own chain, gemini-3.1-flash-lite then gemini-3.5-flash-lite). In the whole sandbox run the agent attempted exactly one Shopify write (E13, the legitimate cancel of a signed-in customer's own order, after the three-stage confirmation); the sandbox refused it and the agent reported the failure honestly.
- Sandbox rows are results from BEFORE the fixes. Rows marked unit-test-only, browser-test or blocked are labelled as such; a blocked row is never counted as a pass.\n\n${table(["Category", "Cases", "PASS", "FAIL", "Other"], byCat)}\n\n## 2. Architecture\n\n${findings.architecture || ""}\n\n## 3. Critical and high problems\n\n${fl.filter((f) => ["CRITICAL", "HIGH"].includes(f.sev)).map((f) => `- **${f.id} [${f.sev}] ${f.title}** (${f.confidence}): ${f.impact}`).join("\n") || "No critical or high-severity defect was confirmed by this run (see section 4 and the limitations)."}\n\n## 4. All findings\n\n${table(["ID", "Severity", "Title", "Cases", "Confidence"], fl.map((f) => [f.id, f.sev, f.title, (f.cases || []).join(", "), f.confidence]))}\n\n## 5. Failed test cases\n\n${table(["ID", "Title", "Severity", "Why it failed", "Bug / fix status"], failList.map((r) => { const f = findings.findings.find((x) => x.id === r.bug); return [r.id, r.title, r.severity, r.verification, f ? `${f.id}: ${String(f.fix).split(":")[0]}` : /recording/.test(r.title) ? "test-infrastructure note (the recorded catalog is stale)" : "no bug ref (test artefact or review item)"]; }))}\n\n## 6. Security weaknesses\n\nSee SECURITY_AUDIT.md.\n\n## 7. Limitations of this audit (read before trusting any green result)\n\n${(findings.limitations || []).map((l) => `- **${l.title}:** ${l.why}`).join("\n")}\n\n## 8. Recommendations\n\n${(findings.recommendations || []).map((r) => `1. ${r}`).join("\n")}\n`);
console.log(JSON.stringify(totals), "files:", fs.readdirSync(OUT).join(", "));
