import test from "node:test";
import assert from "node:assert/strict";
import { createShell, renderShell } from "../../src/admin/shell.js";

test("the real page carries the app key App Bridge needs, and loads the dashboard", () => {
  const previous = process.env.SHOPIFY_CLIENT_ID;
  process.env.SHOPIFY_CLIENT_ID = "abc123";
  try {
    const page = renderShell();
    assert.match(page, /<meta name="shopify-api-key" content="abc123" \/>/);
    assert.match(page, /cdn\.shopify\.com\/shopifycloud\/app-bridge\.js/);
    assert.match(page, /<script type="module" src="\/admin\/app\.js">/);
    assert.match(page, /href="\/admin\/app\.css"/);
    assert.doesNotMatch(page, /%%/);
    // the dashboard ships its own styles and icons: no public CDN besides Shopify's App Bridge and the fonts
    assert.doesNotMatch(page, /cdn\.tailwindcss|unpkg\.com/);
    // the design's demo bar and sample store are gone
    assert.doesNotMatch(page, /Zaveri|App Bridge Session Verified|Growth Plan/);
  } finally {
    if (previous === undefined) delete process.env.SHOPIFY_CLIENT_ID;
    else process.env.SHOPIFY_CLIENT_ID = previous;
  }
});

test("the key is escaped so it can never break out of the attribute", () => {
  const render = createShell({ template: '<meta content="%%SHOPIFY_API_KEY%%">', key: () => '"><script>x</script>' });
  assert.equal(render(), '<meta content="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">');
});

test("the key is read on every render, so changing the environment needs no rebuild", () => {
  let key = "one";
  const render = createShell({ template: "%%SHOPIFY_API_KEY%% %%SHOPIFY_API_KEY%%", key: () => key });
  assert.equal(render(), "one one");
  key = "two";
  assert.equal(render(), "two two");
});

test("a template without the placeholder is refused at start-up, not discovered as a blank page", () => {
  assert.throws(() => createShell({ template: "<html></html>" }), /placeholder/);
});
