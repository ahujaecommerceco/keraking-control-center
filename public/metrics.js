/*
 * metrics.js — delivery-intelligence math (browser global `Metrics`).
 *
 * All COD metrics are computed at the ORDER level (not per shipment), because
 * one order can produce several fulfillments/shipments and counting shipments
 * double-counts. Computed in the browser so manual overrides recompute live.
 *
 * Each of the three cards has an EDITABLE age window [min..max] days old
 * (auto-set defaults in DEFAULT_WINDOWS, changeable in the UI) and is also
 * computed for the immediately-preceding equal-length period for comparison.
 *
 * METRICS CURRENTLY SHOWN
 * -----------------------
 *  COD share  (default 0–7 days)
 *     Of orders placed in the window, the share that are COD vs prepaid.
 *     Order-level. Cancelled orders excluded.
 *
 *  COD confirmation  (default 7–14 days)
 *     COD orders dispatched ÷ all COD orders in the window. Orders still open
 *     (placed, not shipped, not cancelled) are flagged in the detail.
 *
 *  COD FAD rate  (default 5–30 days, COD only) + breakdown by risk
 *     = delivered ÷ (delivered + RTO + exception + any other COD order with
 *       attempts > 0).  Orders never attempted (0 attempts) are excluded.
 *     Broken down by risk tag: low / high / very_high. Also shows Predicted.
 *
 * (Closed rate and Shipment Multiple are intentionally not shown.)
 */
(function (root) {
  const DAY = 86400000;
  const W = { FAD_MIN: 5, FAD_MAX: 30, SPLIT: 7, CONFIRM: 7, CONFIRM_SCAN_DAYS: 90 };

  // Windows are now actual FROM/TO calendar dates ("YYYY-MM-DD"), interpreted in
  // the user's local timezone, so counts reconcile with what they see in Shopify.
  const isoDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function defaultWindows(now) {
    now = now || Date.now();
    const d = (n) => isoDay(now - n * DAY);
    return {
      split:   { from: d(6),  to: d(0) },  // COD share — last 7 days
      confirm: { from: d(13), to: d(7) },  // COD confirmation — last settled week
      fad:     { from: d(30), to: d(5) },  // COD FAD — orders 5–30 days old
    };
  }

  function ageDays(s, now) { return (now - new Date(s.createdAt).getTime()) / DAY; }

  // ---- status classification (substring match; robust to label drift) ----
  function classify(s) {
    const t = (s.status || "").toLowerCase();
    const rto = /rto|return/.test(t);
    const deliveredWord = /deliver/.test(t);
    return {
      cancelled: /cancel/.test(t),
      rto,
      exception: !rto && !deliveredWord && /exception|lost|damage|undeliver|ndr/.test(t),
      delivered: deliveredWord && !rto,
      shipped: !!s.awb && !/pending|cancel/.test(t),
    };
  }

  function predictOutcome(s, now) {
    const c = classify(s);
    const a = ageDays(s, now);
    if (c.delivered) return { label: "Delivered", kind: "good" };
    if (c.rto) return { label: /deliver/i.test(s.status) ? "RTO (returned)" : "RTO likely", kind: "bad" };
    if (c.exception) return { label: "Exception", kind: "bad" };
    if (c.cancelled) return { label: "Cancelled", kind: "muted" };
    if (/out for delivery/i.test(s.status)) return { label: "Likely delivered", kind: "good" };
    if (a > W.FAD_MAX) return { label: "Stuck → RTO risk", kind: "bad" };
    if (a > 10) return { label: "Delayed", kind: "warn" };
    if (!s.awb) return { label: "Awaiting dispatch", kind: "muted" };
    return { label: "In transit", kind: "warn" };
  }

  // Canonicalize courier names so "delhivery" and "Delhivery" are one bucket.
  const COURIER_MAP = {
    delhivery: "Delhivery", bluedart: "Bluedart", bluedartexpress: "Bluedart",
    xpressbees: "Xpressbees", ekart: "Ekart", dtdc: "DTDC", shadowfax: "Shadowfax",
    ecomexpress: "Ecom Express", ecom: "Ecom Express", amazon: "Amazon",
    amazonshipping: "Amazon", indiapost: "India Post", shiprocket: "Shiprocket",
  };
  function normalizeCourier(name) {
    const raw = String(name || "").trim();
    if (!raw) return "Unknown";
    const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (COURIER_MAP[key]) return COURIER_MAP[key];
    return raw.replace(/\s+/g, " ").split(" ")
      .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ");
  }

  function dominantLine(o) {
    if (!o || !o.lineItems || !o.lineItems.length) return null;
    return o.lineItems.slice().sort((a, b) => b.quantity * b.unitPrice - a.quantity * a.unitPrice)[0];
  }

  // ---- enrich shipments with product/variant (used by the shipment log) ----
  function enrich(shipments, orders) {
    const byNum = new Map();
    for (const o of orders) byNum.set(String(o.orderNumber), o);
    return shipments.map((s) => {
      const dom = dominantLine(byNum.get(String(s.orderNumber)));
      return Object.assign({}, s, {
        product: dom ? dom.product : "Unmatched",
        productId: dom ? dom.productId : "_unmatched",
        variant: dom ? dom.variant : "Unmatched",
        variantId: dom ? dom.variantId : "_unmatched",
      });
    });
  }

  // ---- order-level records (one per order) with status rollup ----
  function buildOrderRecords(shipments, orders, now) {
    now = now || Date.now();
    const grouped = new Map();
    for (const s of shipments) {
      const k = String(s.orderNumber);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(s);
    }
    return orders.map((o) => {
      const ships = grouped.get(String(o.orderNumber)) || [];
      const cls = ships.map(classify);
      const delivered = cls.some((c) => c.delivered);
      const rto = !delivered && cls.some((c) => c.rto);
      const exception = !delivered && !rto && cls.some((c) => c.exception);
      const cancelled = !delivered && !rto && !exception && ships.length > 0 && cls.every((c) => c.cancelled);
      const attempts = ships.reduce((a, s) => a + (Number(s.attempts) || 0), 0);
      // Dispatched = a fulfillment exists (booked), regardless of whether the
      // tracking number has synced to Shopify. Falls back to AWB for safety.
      const shipped = ships.some((s) => s.dispatched || !!s.awb);
      // Projected to deliver = already delivered, or a still-open shipment whose
      // predicted outcome is good (likely delivered / out for delivery).
      const predictedDeliver = delivered || ships.some((s) => predictOutcome(s, now).kind === "good");
      // Earliest shipment-creation date among this order's shipments (used as the
      // FAD window date). Empty if the order was never booked/shipped.
      const shipTimes = ships.map((s) => s.shipmentDate).filter(Boolean).map((d) => new Date(d).getTime());
      const shipmentDate = shipTimes.length ? new Date(Math.min(...shipTimes)).toISOString() : "";
      const dom = dominantLine(o);
      return {
        orderNumber: String(o.orderNumber),
        createdAt: o.createdAt,
        shipmentDate,
        paymentType: o.paymentType || "prepaid",
        risk: o.risk || "untagged",
        product: dom ? dom.product : "Unmatched",
        productId: dom ? dom.productId : "_unmatched",
        variant: dom ? dom.variant : "Unmatched",
        variantId: dom ? dom.variantId : "_unmatched",
        delivered, rto, exception, cancelled, attempts, shipped, predictedDeliver,
        // "open" = a COD order still awaiting dispatch (not shipped/closed)
        open: !delivered && !rto && !exception && !cancelled && !shipped,
      };
    });
  }

  function buildCatalog(orders) {
    const products = new Map();
    for (const o of orders) {
      for (const li of o.lineItems || []) {
        if (!products.has(li.productId)) products.set(li.productId, { productId: li.productId, product: li.product, variants: new Map() });
        const p = products.get(li.productId);
        if (!p.variants.has(li.variantId)) p.variants.set(li.variantId, { variantId: li.variantId, variant: li.variant, prices: [] });
        p.variants.get(li.variantId).prices.push(li.unitPrice);
      }
    }
    return [...products.values()].map((p) => ({
      productId: p.productId, product: p.product,
      variants: [...p.variants.values()].map((v) => ({
        variantId: v.variantId, variant: v.variant,
        avgPrice: v.prices.length ? v.prices.reduce((a, b) => a + b, 0) / v.prices.length : 0,
        orderCount: v.prices.length,
      })),
    }));
  }

  function applyScope(recs, scope) {
    if (!scope || scope.level === "blended") return recs;
    if (scope.level === "product") return recs.filter((r) => r.productId === scope.productId);
    if (scope.level === "variant") return recs.filter((r) => r.variantId === scope.variantId);
    return recs;
  }
  function pct(n, d) { return d > 0 ? n / d : null; }

  // ---- COD FAD rate (COD only) ----
  // FAD = delivered ÷ (delivered + RTO + any other shipment with delivery
  // attempts > 0). "Any other" = not delivered, not RTO, but it HAS been out for
  // delivery at least once (status may read in-transit / exception / etc.) — we
  // treat it as an RTO. Cancelled and not-yet-attempted (0-attempt) shipments
  // are excluded from the denominator entirely.
  function codFadOn(recs) {
    const eligible = recs.filter((r) => !r.cancelled && (r.delivered || r.rto || r.attempts > 0));
    const delivered = eligible.filter((r) => r.delivered).length;
    const rto = eligible.filter((r) => r.rto).length;
    const others = eligible.length - delivered - rto; // attempted, not delivered/RTO → counted as RTO
    return { rate: pct(delivered, eligible.length), delivered, denom: eligible.length, rto, others };
  }

  // Bounds of a FROM/TO date window, in local time (inclusive of the full TO day).
  function winBounds(win) {
    const a = new Date(win.from + "T00:00:00").getTime();
    const b = new Date(win.to + "T23:59:59.999").getTime();
    return [a, b];
  }
  function inWindow(recs, win, field) {
    const [a, b] = winBounds(win);
    const f = field || "createdAt";
    return recs.filter((r) => { const v = r[f]; if (!v) return false; const t = new Date(v).getTime(); return t >= a && t <= b; });
  }
  // The immediately-preceding period of the same length (for comparison).
  function prevWindow(win) {
    const [a, b] = winBounds(win);
    const dur = b - a;
    return { from: isoDay(a - dur - DAY), to: isoDay(a - DAY) };
  }

  // ---- COD FAD over a window (by SHIPMENT-creation date), with risk breakdown ----
  function computeFadWin(orderRecs, scope, now, win) {
    const cod = inWindow(applyScope(orderRecs, scope).filter((r) => r.paymentType === "cod"), win, "shipmentDate");
    const overall = codFadOn(cod);
    const byRisk = {};
    for (const risk of ["low", "high", "very_high"]) byRisk[risk] = codFadOn(cod.filter((r) => r.risk === risk));
    return Object.assign(overall, { byRisk, win });
  }

  // ---- COD share over a window (ALL placed orders, incl. cancelled) ----
  function computeSplitWin(orderRecs, scope, now, win) {
    const pool = inWindow(applyScope(orderRecs, scope), win);
    const cod = pool.filter((r) => r.paymentType === "cod").length;
    const prepaid = pool.filter((r) => r.paymentType === "prepaid").length;
    return { codShare: pct(cod, pool.length), prepaidShare: pct(prepaid, pool.length), cod, prepaid, total: pool.length, win };
  }

  // ---- COD confirmation over a window (dispatched ÷ all COD; open/cancelled flagged) ----
  function computeConfirmWin(orderRecs, scope, now, win) {
    const cod = inWindow(applyScope(orderRecs, scope).filter((r) => r.paymentType === "cod"), win);
    const shipped = cod.filter((r) => r.shipped).length;
    const open = cod.filter((r) => r.open).length;
    const cancelled = cod.filter((r) => r.cancelled).length;
    return { rate: pct(shipped, cod.length), shipped, open, cancelled, total: cod.length, win };
  }

  // Run a windowed metric for both the current window and the previous
  // equal-length period; returns { cur, prev, win }.
  function withPrev(fn, orderRecs, scope, now, win) {
    return { cur: fn(orderRecs, scope, now, win), prev: fn(orderRecs, scope, now, prevWindow(win)), win };
  }

  // ---- flexible delivery breakdown by courier × risk × payment × pickup-delay ----
  // Pickup delay is its OWN control-group dimension (not an average): each
  // shipment is "yes" if (pickup − order) > 2 days, else "no" ("unknown" if no
  // pickup scan yet). filters = { courier, risk, payment, delay } — "all"/"" = no
  // filter on that dimension. Rows are every distinct combination present.
  function delayFlag(s) {
    if (!s.pickupDate || !s.orderDate) return "unknown";
    return (new Date(s.pickupDate).getTime() - new Date(s.orderDate).getTime()) / DAY > 2 ? "yes" : "no";
  }
  function deliveryBreakdown(enrichedShipments, scope, now, filters) {
    now = now || Date.now();
    filters = filters || {};
    const f = (k) => (filters[k] && filters[k] !== "all" ? filters[k] : null);
    const fC = f("courier"), fR = f("risk"), fP = f("payment"), fD = f("delay");

    let pool = applyScope(enrichedShipments, scope).filter((s) => !!s.awb || s.dispatched);
    pool = pool.map((s) => Object.assign({}, s, { courier: normalizeCourier(s.courier) || "Unknown", risk: s.risk || "untagged", delay: delayFlag(s) }));
    if (fC) pool = pool.filter((s) => s.courier === fC);
    if (fR) pool = pool.filter((s) => s.risk === fR);
    if (fP) pool = pool.filter((s) => s.paymentType === fP);
    if (fD) pool = pool.filter((s) => s.delay === fD);

    const groups = new Map();
    for (const s of pool) {
      const key = `${s.courier}|||${s.risk}|||${s.paymentType}|||${s.delay}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const rowFor = (ships) => {
      // Same FAD rule as the COD card: delivered ÷ (delivered + RTO + attempted).
      const fadSet = ships.filter((s) => { const a = ageDays(s, now); return a >= W.FAD_MIN && a <= W.FAD_MAX; })
        .filter((s) => { const c = classify(s); return !c.cancelled && (c.delivered || c.rto || s.attempts > 0); });
      const fadDelivered = fadSet.filter((s) => classify(s).delivered).length;
      return {
        orders: ships.length,
        fadRate: pct(fadDelivered, fadSet.length), fadDenom: fadSet.length,
      };
    };

    const rows = [...groups.entries()].map(([key, ships]) => {
      const [courier, risk, payment, delay] = key.split("|||");
      return Object.assign({ courier, risk, payment, delay }, rowFor(ships));
    }).sort((a, b) => b.orders - a.orders);
    const total = Object.assign({ courier: "All", risk: "—", payment: "—", delay: "—" }, rowFor(pool));

    const opts = { courier: new Set(), risk: new Set(), payment: new Set(), delay: new Set() };
    applyScope(enrichedShipments, scope).filter((s) => !!s.awb || s.dispatched).forEach((s) => {
      opts.courier.add(normalizeCourier(s.courier) || "Unknown");
      opts.risk.add(s.risk || "untagged");
      opts.payment.add(s.paymentType);
      opts.delay.add(delayFlag(s));
    });
    return { rows, total, options: { courier: [...opts.courier].sort(), risk: [...opts.risk].sort(), payment: [...opts.payment].sort(), delay: [...opts.delay].sort() } };
  }

  // ===================================================================== *
  //  PERFORMANCE ENGINE — one breakdown by any dimension, with shared filters
  //  (payment, risk, product, variant, courier, shipment-date range).
  //  Works on enriched shipments. FAD uses the COD-card rule on the group.
  // ===================================================================== *
  function fadOnShips(ships) {
    const elig = ships.filter((s) => { const c = classify(s); return !c.cancelled && (c.delivered || c.rto || s.attempts > 0); });
    const delivered = elig.filter((s) => classify(s).delivered).length;
    const rto = elig.filter((s) => classify(s).rto).length;
    return { delivered, fadDenom: elig.length, rto, others: elig.length - delivered - rto, fadRate: pct(delivered, elig.length) };
  }
  function applyPerfFilters(ships, f) {
    f = f || {};
    let out = ships.filter((s) => s.dispatched || s.awb); // shipments only
    if (f.payment && f.payment !== "all") out = out.filter((s) => s.paymentType === f.payment);
    if (f.risk && f.risk !== "all") out = out.filter((s) => (s.risk || "untagged") === f.risk);
    if (f.product && f.product !== "all") out = out.filter((s) => s.productId === f.product);
    if (f.variant && f.variant !== "all") out = out.filter((s) => s.variantId === f.variant);
    if (f.courier && f.courier !== "all") out = out.filter((s) => (normalizeCourier(s.courier) || "Unknown") === f.courier);
    if (f.from || f.to) {
      const [a, b] = winBounds({ from: f.from || "1970-01-01", to: f.to || "2999-12-31" });
      out = out.filter((s) => { if (!s.shipmentDate) return false; const t = new Date(s.shipmentDate).getTime(); return t >= a && t <= b; });
    }
    return out;
  }
  function perfGroupKey(s, groupBy) {
    switch (groupBy) {
      case "day": return (s.shipmentDate || "").slice(0, 10) || "—";
      case "state": return s.state || "Unknown";
      case "zone": return s.zone ? "Zone " + s.zone : "Unknown";
      case "product": return s.product || "Unmatched";
      case "variant": return (s.product || "?") + " · " + (s.variant || "?");
      case "courier": return normalizeCourier(s.courier) || "Unknown";
      default: return "All";
    }
  }
  function performanceBreakdown(ships, groupBy, filters) {
    const pool = applyPerfFilters(ships, filters);
    const g = new Map();
    for (const s of pool) { const k = perfGroupKey(s, groupBy); if (!g.has(k)) g.set(k, []); g.get(k).push(s); }
    const rows = [...g.entries()].map(([key, arr]) => Object.assign({ key, total: arr.length }, fadOnShips(arr)));
    if (groupBy === "day") rows.sort((a, b) => (a.key < b.key ? 1 : -1));
    else rows.sort((a, b) => b.total - a.total);
    const total = Object.assign({ key: "All", total: pool.length }, fadOnShips(pool));
    return { rows, total };
  }
  // Strip dates / "reschedule to X" / stray numbers so the same underlying
  // reason groups into one row instead of one row per reschedule date.
  function cleanNdrReason(s) {
    let r = String(s || "").trim();
    r = r.replace(/\([^)]*\)/g, " ");                                  // parenthetical (usually a date)
    r = r.replace(/reschedul\w*[^,;|]*/ig, "reschedule requested");    // collapse "reschedule to <date>"
    r = r.replace(/\b\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?\b/g, " ");      // 20-06-2026 etc.
    r = r.replace(/\b\d{1,2}(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/ig, " ");
    r = r.replace(/\b\d{1,2}:\d{2}\b/g, " ");                          // times
    r = r.replace(/\b\d+\b/g, " ");                                    // stray numbers
    r = r.replace(/\s+/g, " ").replace(/^[\s\-–:|,]+|[\s\-–:|,]+$/g, "").trim();
    if (!r) return "Undelivered (no reason given)";
    return r.charAt(0).toUpperCase() + r.slice(1);
  }
  function ndrBreakdown(ships, filters) {
    const pool = applyPerfFilters(ships, filters).filter((s) => s.ndrReason);
    const g = new Map(); // lowercased clean key -> { reason, count }
    for (const s of pool) {
      const clean = cleanNdrReason(s.ndrReason);
      const key = clean.toLowerCase();
      if (!g.has(key)) g.set(key, { reason: clean, count: 0 });
      g.get(key).count++;
    }
    const rows = [...g.values()].sort((a, b) => b.count - a.count);
    return { rows, total: pool.length };
  }
  function perfOptions(ships) {
    const payment = new Set(), risk = new Set(), courier = new Set(), product = new Map(), variant = new Map();
    ships.forEach((s) => {
      payment.add(s.paymentType); risk.add(s.risk || "untagged");
      const c = normalizeCourier(s.courier) || ""; if (c) courier.add(c);
      if (s.productId) product.set(s.productId, s.product);
      if (s.variantId) variant.set(s.variantId, (s.product || "") + " · " + (s.variant || ""));
    });
    return {
      payment: [...payment].sort(), risk: [...risk].sort(), courier: [...courier].sort(),
      product: [...product.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
      variant: [...variant.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    };
  }

  function computeAll(orderRecs, scope, now, windows) {
    now = now || Date.now();
    const dw = defaultWindows(now);
    const w = {
      split: (windows && windows.split) || dw.split,
      confirm: (windows && windows.confirm) || dw.confirm,
      fad: (windows && windows.fad) || dw.fad,
    };
    return {
      scopeCount: applyScope(orderRecs, scope).length,
      split: withPrev(computeSplitWin, orderRecs, scope, now, w.split),
      codConfirm: withPrev(computeConfirmWin, orderRecs, scope, now, w.confirm),
      codFad: withPrev(computeFadWin, orderRecs, scope, now, w.fad),
    };
  }

  root.Metrics = {
    W, defaultWindows, ageDays, classify, predictOutcome, dominantLine,
    enrich, buildOrderRecords, buildCatalog, applyScope, normalizeCourier,
    computeFadWin, computeSplitWin, computeConfirmWin, prevWindow, deliveryBreakdown, computeAll,
    performanceBreakdown, ndrBreakdown, perfOptions,
  };
})(typeof self !== "undefined" ? self : this);
