/* Lets the unchanged Orbi chat widget run on a website that is not a Shopify theme.
 *  1. "/apps/ai-agent/*"  ->  the backend's public gateway  (<backend>/public/*)
 *  2. Shopify's Ajax cart ("/cart.js", "/cart/add.js", ...)  ->  a cart kept in this browser (localStorage),
 *     priced from the catalog the backend serves. The order itself is still placed by the backend with Shopify.
 * Loaded before the widget, so the widget's fetch() calls go through here. */
(function () {
  "use strict";
  var BACKEND = (document.documentElement.getAttribute("data-backend") || "").replace(/\/+$/, "");
  var CART_KEY = "ts_cart_v1";
  var realFetch = window.fetch.bind(window);

  window.Shopify = window.Shopify || {};
  window.Shopify.routes = { root: "/" };
  window.Shopify.currency = { active: "INR" };
  window.Shopify.country = "IN";

  var TS = (window.TS = { backend: BACKEND, catalog: null, index: null });
  TS.catalogPromise = realFetch(BACKEND + "/public/products")
    .then(function (r) {
      if (!r.ok) throw new Error("catalog " + r.status);
      return r.json();
    })
    .then(function (data) {
      var index = {};
      (data.products || []).forEach(function (p) {
        p.variants.forEach(function (v) { index[v.id] = { product: p, variant: v }; });
      });
      TS.catalog = data;
      TS.index = index;
      if (data.currency) window.Shopify.currency.active = data.currency;
      return data;
    });

  function readState() {
    try {
      var s = JSON.parse(localStorage.getItem(CART_KEY) || "null");
      if (s && Array.isArray(s.items)) return s;
    } catch (e) {}
    return { token: "ts" + Math.random().toString(36).slice(2, 12), items: [] };
  }
  function writeState(s) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(s)); } catch (e) {}
  }
  var state = readState();
  function cents(price) { return Math.round(Number(price || 0) * 100); }

  function cartJson() {
    var currency = (TS.catalog && TS.catalog.currency) || "INR";
    var items = [];
    state.items.forEach(function (line) {
      var hit = TS.index && TS.index[line.variantId];
      if (!hit) return;
      var p = hit.product, v = hit.variant;
      var unit = cents(v.price);
      var onlyDefault = p.variants.length === 1 && /^default title$/i.test(v.title);
      items.push({
        id: Number(v.id), key: String(v.id), variant_id: Number(v.id), product_id: Number(p.id),
        quantity: line.qty, title: onlyDefault ? p.title : p.title + " - " + v.title,
        product_title: p.title, variant_title: onlyDefault ? null : v.title,
        price: unit, original_price: unit, final_price: unit,
        line_price: unit * line.qty, original_line_price: unit * line.qty, final_line_price: unit * line.qty,
        image: v.image || p.image || null, url: "/#product-" + p.handle, handle: p.handle, vendor: p.vendor,
        product_has_only_default_variant: onlyDefault, requires_shipping: true,
      });
    });
    var total = items.reduce(function (n, i) { return n + i.line_price; }, 0);
    return {
      token: state.token, note: "", attributes: {}, currency: currency,
      item_count: items.reduce(function (n, i) { return n + i.quantity; }, 0),
      items: items, original_total_price: total, total_price: total, total_discount: 0,
      items_subtotal_price: total, requires_shipping: true,
    };
  }

  function emit() { try { window.dispatchEvent(new CustomEvent("ts:cart", { detail: cartJson() })); } catch (e) {} }
  function json(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } });
  }
  function line(variantId) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].variantId === String(variantId)) return state.items[i];
    return null;
  }
  function setQty(variantId, qty) {
    qty = Math.max(0, Math.min(99, Math.floor(Number(qty) || 0)));
    var l = line(variantId);
    if (!qty) state.items = state.items.filter(function (x) { return x.variantId !== String(variantId); });
    else if (l) l.qty = qty;
    else state.items.push({ variantId: String(variantId), qty: qty });
  }
  TS.cart = {
    get: cartJson,
    add: function (variantId, qty) {
      return TS.catalogPromise.then(function () {
        if (!TS.index[variantId]) throw new Error("Product not found");
        if (!TS.index[variantId].variant.inStock) throw new Error("Sold out");
        var l = line(variantId);
        setQty(variantId, (l ? l.qty : 0) + (qty || 1));
        writeState(state); emit();
        return cartJson();
      });
    },
    set: function (variantId, qty) { setQty(variantId, qty); writeState(state); emit(); return cartJson(); },
    clear: function () { state.items = []; writeState(state); emit(); },
  };
  window.addEventListener("storage", function (e) { if (e.key === CART_KEY) { state = readState(); emit(); } });

  function parseBody(init) {
    try { return init && typeof init.body === "string" ? JSON.parse(init.body) : {}; } catch (e) { return {}; }
  }

  function handleCart(path, init) {
    var body = parseBody(init);
    return TS.catalogPromise.then(function () {
      if (path === "/cart.js") return json(cartJson());
      if (path === "/cart/clear.js") { TS.cart.clear(); return json(cartJson()); }
      if (path === "/cart/add.js") {
        var items = Array.isArray(body.items) ? body.items : [body];
        var chain = Promise.resolve();
        items.forEach(function (it) { chain = chain.then(function () { return TS.cart.add(String(it.id), Number(it.quantity) || 1); }); });
        return chain.then(function () { return json({ items: cartJson().items }); }, function (err) {
          return json({ status: 422, message: "Cart Error", description: err.message }, 422);
        });
      }
      if (path === "/cart/change.js") {
        var key = body.id != null ? String(body.id) : state.items[(Number(body.line) || 1) - 1] && state.items[(Number(body.line) || 1) - 1].variantId;
        if (key) TS.cart.set(key, Number(body.quantity));
        return json(cartJson());
      }
      if (path === "/cart/update.js") {
        var updates = body.updates || {};
        Object.keys(updates).forEach(function (k) { setQty(k, Number(updates[k])); });
        writeState(state); emit();
        return json(cartJson());
      }
      return json({ message: "Not found" }, 404);
    });
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    if (typeof url === "string") {
      var path;
      try { path = new URL(url, location.href).pathname; } catch (e) { path = ""; }
      var sameSite = url.charAt(0) === "/" || url.indexOf(location.origin) === 0;
      if (sameSite && /^\/cart(\/(add|change|update|clear))?\.js$/.test(path)) return handleCart(path, init);
      if (sameSite && path.indexOf("/apps/ai-agent") === 0) {
        var rest = path.slice("/apps/ai-agent".length);
        var target = BACKEND + "/public" + (rest === "" ? "/" : rest) + (url.indexOf("?") > -1 ? url.slice(url.indexOf("?")) : "");
        var clean = Object.assign({}, init || {});
        delete clean.credentials;
        return realFetch(target, clean);
      }
    }
    return realFetch(input, init);
  };
})();
