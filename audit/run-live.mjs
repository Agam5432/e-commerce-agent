// Live-catalog run: the real TechStore catalog/prices/stock (read-only), fake orders/customers, blocked writes.
//   node audit/live-readonly.mjs   (refreshes audit/live-catalog.json; needs a valid access token)
//   node audit/run-live.mjs --only=A01,A02,...
process.env.QA_LIVE = "1";
process.env.QA_PORT = "4731";
process.env.QA_RESULTS = new URL("./results-live.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await import("./run.mjs");
