/*
 * sample-data.js — shared deterministic-ish sample dataset.
 *
 * Used in two places:
 *   1. The proxy server (CommonJS `require`) when a live API call fails.
 *   2. The browser, if it cannot even reach the proxy.
 *
 * Output is already in the SAME normalized shape the proxy emits for live
 * data, so the frontend treats sample and live data identically.
 *
 * Dates are generated RELATIVE to "now" each time, so shipment ages always
 * look realistic regardless of when the dashboard is opened.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SampleData = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Small seeded PRNG so the dataset is stable within a run but varied.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const COURIERS = ["Delhivery", "Bluedart", "Xpressbees", "Ekart", "DTDC", "Shadowfax"];

  // Three products, each with four pack variants. Prices reflect "actual
  // selling price" with light per-order noise so averages aren't round.
  const CATALOG = [
    { product: "Radiance Glow Serum", productId: "p-glow", base: 599 },
    { product: "Beard Growth Oil", productId: "p-beard", base: 449 },
    { product: "Biotin Hair Kit", productId: "p-hair", base: 899 },
  ];
  const VARIANTS = [
    { variant: "Single", mult: 1.0 },
    { variant: "Pack of 2", mult: 1.85 },
    { variant: "Pack of 3", mult: 2.6 },
    { variant: "Pack of 4", mult: 3.2 },
  ];
  const STATES = ["Maharashtra", "Delhi", "Karnataka", "Uttar Pradesh", "Tamil Nadu", "Gujarat", "West Bengal", "Rajasthan", "Telangana", "Kerala"];
  const ZONES = ["1", "2", "3", "4", "5"];
  const NDR_REASONS = ["Customer not available", "Customer refused delivery", "Incorrect address", "Phone not reachable", "Asked to deliver later", "Payment not ready (COD)", "Out of delivery area"];

  // Status generator weighted by shipment age. Older shipments have mostly
  // resolved; younger ones are still moving.
  function pickStatus(rng, ageDays) {
    const r = rng();
    if (ageDays >= 15) {
      // Settled-ish: delivered, returned, or lost.
      if (r < 0.66) return "Delivered";
      if (r < 0.9) return "RTO Delivered";
      if (r < 0.95) return "RTO In Transit";
      if (r < 0.98) return "Lost";
      return "In Transit";
    }
    if (ageDays >= 5) {
      if (r < 0.5) return "Delivered";
      if (r < 0.62) return "Out For Delivery";
      if (r < 0.78) return "In Transit";
      if (r < 0.9) return "RTO In Transit";
      if (r < 0.96) return "Undelivered";
      return "RTO Delivered";
    }
    // Fresh
    if (r < 0.2) return "Delivered";
    if (r < 0.35) return "Out For Delivery";
    if (r < 0.75) return "In Transit";
    if (r < 0.85) return "Pickup Scheduled";
    if (r < 0.95) return "Pending";
    return "Cancelled";
  }

  function generate(seed) {
    const rng = mulberry32(seed || 20260619);
    const now = Date.now();
    const DAY = 86400000;
    const shipments = [];
    const orders = [];
    const N = 560;

    for (let i = 0; i < N; i++) {
      // Spread creation over the last ~75 days, denser recently (enough history
      // for the previous-period comparisons on every card).
      const ageDays = Math.floor(Math.pow(rng(), 1.4) * 75);
      const createdAt = new Date(now - ageDays * DAY - Math.floor(rng() * DAY)).toISOString();
      const orderNumber = String(2001 + i);

      const cat = CATALOG[Math.floor(rng() * CATALOG.length)];
      const v = VARIANTS[Math.floor(rng() * VARIANTS.length)];
      const qty = 1;
      // Actual selling price: base * variant multiplier, with discount noise.
      const unitPrice = Math.round(cat.base * v.mult * (0.9 + rng() * 0.15));

      // ~62% COD for a typical Indian D2C brand.
      const paymentType = rng() < 0.62 ? "cod" : "prepaid";
      // Risk tag (as it would appear in Shopify order tags): mostly low.
      const rr = rng();
      const risk = rr < 0.6 ? "low" : rr < 0.85 ? "high" : "very_high";
      const status = pickStatus(rng, ageDays);

      // Unconfirmed COD orders may never get an AWB.
      const hasAwb = !/pending|cancelled|pickup scheduled/i.test(status) &&
        !(paymentType === "cod" && rng() < 0.12);
      const awb = hasAwb ? "NB" + (100000000 + Math.floor(rng() * 899999999)) : "";

      // Delivery attempts. Crucially, parcels still IN TRANSIT (or pending /
      // pickup scheduled) have had ZERO delivery attempts — they haven't reached
      // the out-for-delivery stage yet. Only delivered / RTO / undelivered /
      // out-for-delivery shipments have attempts > 0.
      let attempts = 0;
      if (/rto|undelivered|exception/i.test(status)) attempts = 2 + Math.floor(rng() * 2);
      else if (/delivered/i.test(status)) attempts = 1 + (rng() < 0.3 ? 1 : 0);
      else if (/out for delivery/i.test(status)) attempts = 1;

      // Shipment booked 0–1 day after the order; pickup 0–4 days after the order.
      const dispatched = hasAwb;
      const shipmentDate = dispatched ? new Date(new Date(createdAt).getTime() + Math.floor(rng() * 2) * DAY).toISOString() : "";
      const pickupDate = dispatched ? new Date(new Date(createdAt).getTime() + Math.floor(rng() * 5) * DAY).toISOString() : "";
      shipments.push({
        id: "S" + i,
        orderNumber,
        awb,
        courier: hasAwb ? COURIERS[Math.floor(rng() * COURIERS.length)] : "",
        zone: ZONES[Math.floor(rng() * ZONES.length)],
        attempts,
        paymentType,
        risk,
        amount: unitPrice * qty,
        status,
        dispatched,
        state: STATES[Math.floor(rng() * STATES.length)],
        ndrReason: /undelivered|rto|exception/i.test(status) && rng() < 0.85 ? NDR_REASONS[Math.floor(rng() * NDR_REASONS.length)] : "",
        ndrDate: shipmentDate,
        orderDate: createdAt,
        shipmentDate,
        pickupDate,
        createdAt,
      });

      orders.push({
        orderNumber,
        createdAt,
        paymentType,
        risk,
        lineItems: [
          {
            product: cat.product,
            productId: cat.productId,
            variant: v.variant,
            variantId: cat.productId + "-" + v.variant.replace(/\s+/g, "").toLowerCase(),
            unitPrice,
            quantity: qty,
          },
        ],
      });
    }

    return {
      brand: "Demo D2C Store (sample data)",
      shipments,
      orders,
      source: "sample",
      asOf: new Date(now).toISOString(),
    };
  }

  return { generate };
});
