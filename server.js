/*
 * server.js — zero-dependency local proxy + static server + Shopify OAuth.
 *
 * WHY THIS EXISTS (the CORS problem):
 * ----------------------------------
 * Browsers can't call api.nimbuspost.com or *.myshopify.com/admin/* directly
 * from a localhost page. The browser talks ONLY to this server (same origin =>
 * no CORS); this server makes the real outbound API calls server-side.
 *
 * DATA ARCHITECTURE:
 * ------------------
 * NimbusPost's API has NO "list all shipments" endpoint — it can only TRACK by
 * AWB. So Shopify is the backbone (orders, line items, AWBs from fulfillments,
 * payment type) and NimbusPost bulk-tracks those AWBs for live status. If
 * NimbusPost tracking fails we fall back to Shopify's own fulfillment status;
 * if Shopify fails entirely we fall back to sample data.
 *
 * SHOPIFY AUTH (2026):
 * --------------------
 * Shopify removed admin-created custom apps, so there is no permanent token to
 * paste. New apps are created in the Dev Dashboard and give a Client ID +
 * Client Secret; a standalone app like this obtains a token via the OAuth
 * authorization code grant. This server implements that flow:
 *   /auth/start    -> builds the Shopify authorize URL
 *   /auth/callback -> verifies HMAC, exchanges the code for an access token,
 *                     and persists it to .credentials.json
 *   /auth/status   -> reports whether we're connected
 *
 * Uses only Node built-ins. No `npm install`. Run: node server.js
 */

const http = require("http");
const fs = require("fs");
require("./loadenv.js"); // populate process.env from .env (before db/auth read it)
const path = require("path");
const crypto = require("crypto");
const SampleData = require("./public/sample-data.js");
const db = require("./db.js");
const auth = require("./auth.js");
const CallQueue = require("./calling/queue.js");

const PORT = process.env.PORT || 4317;
const PUBLIC_DIR = path.join(__dirname, "public");
const CRED_FILE = path.join(__dirname, ".credentials.json");

const NIMBUS_BASE = "https://api.nimbuspost.com/v1";
const SHOPIFY_API_VERSION = "2024-04";
const SHOPIFY_SCOPES = "read_orders,write_orders,read_products,read_fulfillments";
const UA = "DeliveryIntelligenceDashboard/1.0";
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`; // local default; hosted derives from request
// Public base URL (for Exotel call-status callbacks). Set PUBLIC_BASE in prod.
const PUBLIC_BASE = (process.env.PUBLIC_BASE || "https://keraking-control-center.onrender.com").replace(/\/$/, "");

// Optional password lock for public hosting (HTTP Basic Auth). If unset (local
// use), no auth is required.
const APP_PASSWORD = process.env.APP_PASSWORD || "";

// KeraKing default credentials (server-side only — never sent to the browser).
// Env vars win; otherwise these hardcoded defaults make the app work on any
// device with no setup. Fill SHOPIFY_SHOP / SHOPIFY_TOKEN to skip OAuth.
const KK = {
  nimbusEmail: process.env.NIMBUS_EMAIL || "ahujagodaddy+1+4242@gmail.com",
  nimbusPassword: process.env.NIMBUS_PASSWORD || "uli6xDQGqA",
  shopifyShop: process.env.SHOPIFY_SHOP || "vuu0g7-c1.myshopify.com",
  // Token stays out of source: read from the saved .credentials.json (local) or
  // the SHOPIFY_TOKEN env var (hosting). Never hardcoded here.
  shopifyToken: process.env.SHOPIFY_TOKEN || "",
};

// The app's public base URL, derived from the incoming request so OAuth works
// on whatever domain it's deployed to (localhost, *.onrender.com, etc.).
function publicBase(req) {
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0]
    || (req.socket && req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

const tokenCache = new Map();      // NimbusPost email -> { token, ts }
const oauthPending = new Map();     // state -> { shop, clientId, clientSecret, ts }

/* ------------------------------------------------------------------ *
 *  small helpers
 * ------------------------------------------------------------------ */

function toISO(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
async function errBody(res) {
  try { return ((await res.text()) || "").replace(/\s+/g, " ").slice(0, 240); } catch { return ""; }
}
function chunk(arr, n) {
  const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out;
}
function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")); } catch { return {}; }
}
function saveCreds(c) {
  try { fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2)); } catch (e) { console.error("cred save:", e.message); }
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
// Reads a body that may be JSON OR x-www-form-urlencoded (for external webhooks).
function readBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on("end", () => {
      const s = b.trim();
      if (!s) return resolve({});
      try { return resolve(JSON.parse(s)); } catch (_) {}
      try { return resolve(Object.fromEntries(new URLSearchParams(s))); } catch (_) {}
      resolve({});
    });
  });
}
function shopHost(shop) {
  let s = String(shop || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (s && !s.includes(".")) s += ".myshopify.com";
  return s.toLowerCase();
}

/* ------------------------------------------------------------------ *
 *  Shopify OAuth (authorization code grant)
 * ------------------------------------------------------------------ */

// Verify the HMAC Shopify appends to the callback to prove it's authentic.
function verifyShopifyHmac(urlObj, secret) {
  const params = new URLSearchParams(urlObj.search);
  const hmac = params.get("hmac");
  if (!hmac) return false;
  params.delete("hmac");
  params.delete("signature");
  const message = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
  } catch { return false; }
}

async function authStart(req, res) {
  const body = await readJson(req);
  const shop = shopHost(body.shop);
  const clientId = String(body.clientId || "").trim();
  const clientSecret = String(body.clientSecret || "").trim();
  if (!shop || !shop.endsWith(".myshopify.com") || !clientId || !clientSecret) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Need a valid *.myshopify.com domain, Client ID and Client Secret." }));
  }
  // Clean up stale pending entries.
  const now = Date.now();
  for (const [k, v] of oauthPending) if (now - v.ts > 10 * 60 * 1000) oauthPending.delete(k);

  const state = crypto.randomBytes(16).toString("hex");
  oauthPending.set(state, { shop, clientId, clientSecret, ts: now });

  const redirectUri = publicBase(req) + "/auth/callback";
  const authorizeUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ authorizeUrl }));
}

function authResultPage(ok, msg, extra) {
  const color = ok ? "#2fbf71" : "#e5564b";
  return `<!doctype html><meta charset="utf-8"><title>Shopify connection</title>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e7eaf0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="text-align:center;max-width:520px;padding:24px">
    <div style="font-size:46px">${ok ? "✓" : "✕"}</div>
    <h2 style="color:${color}">${ok ? "Shopify connected" : "Connection failed"}</h2>
    <p style="color:#8b93a3">${msg}</p>
    ${extra || ""}
    <a href="/" style="display:inline-block;margin-top:14px;background:#D4AF37;color:#1a1500;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Back to dashboard</a>
  </div></body>`;
}

async function authCallback(req, res, urlObj) {
  const q = urlObj.searchParams;
  const state = q.get("state");
  const code = q.get("code");
  const shop = shopHost(q.get("shop"));
  const pending = state && oauthPending.get(state);

  const fail = (m) => { res.writeHead(400, { "Content-Type": "text/html" }); res.end(authResultPage(false, m)); };

  if (!pending) return fail("Session expired or invalid state. Please click Connect Shopify again.");
  oauthPending.delete(state);
  if (shop !== pending.shop) return fail("Store mismatch in the callback.");
  if (!verifyShopifyHmac(urlObj, pending.clientSecret)) return fail("Could not verify the request signature (check the Client Secret).");
  if (!code) return fail("No authorization code returned by Shopify.");

  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify({ client_id: pending.clientId, client_secret: pending.clientSecret, code }),
    });
    if (!r.ok) return fail(`Token exchange failed (HTTP ${r.status}). ${await errBody(r)}`);
    const j = await r.json();
    if (!j.access_token) return fail("Shopify did not return an access token.");
    const creds = loadCreds();
    creds.shopify = { shop, accessToken: j.access_token, scope: j.scope || SHOPIFY_SCOPES, connectedAt: new Date().toISOString() };
    saveCreds(creds);
    const pin = `<div style="margin-top:18px;text-align:left;background:#1d1d1d;border:1px solid #34322c;border-radius:8px;padding:12px">
        <div style="color:#8b93a3;font-size:12px;margin-bottom:6px">Hosting? To stay connected after restarts, set these as environment variables on your host:</div>
        <div style="font-family:monospace;font-size:12px;color:#e7eaf0;word-break:break-all">SHOPIFY_SHOP=${shop}<br>SHOPIFY_TOKEN=${j.access_token}</div>
      </div>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(authResultPage(true, `Connected to ${shop}. You can return to the dashboard — it will now pull live data.`, pin));
  } catch (e) {
    fail("Token exchange error: " + e.message);
  }
}

function authStatus(req, res) {
  const s = loadCreds().shopify;
  const defConnected = !!(KK.shopifyToken && KK.shopifyShop);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    connected: !!(s && s.accessToken) || defConnected,
    shop: (s && s.shop) || KK.shopifyShop || null,
    scope: s ? s.scope : null,
    connectedAt: s ? s.connectedAt : (defConnected ? "via host config" : null),
  }));
}

function authDisconnect(req, res) {
  const creds = loadCreds();
  delete creds.shopify;
  saveCreds(creds);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/* ------------------------------------------------------------------ *
 *  NimbusPost — login + bulk tracking by AWB
 * ------------------------------------------------------------------ */

async function nimbusLogin(email, password) {
  const cached = tokenCache.get(email);
  if (cached && Date.now() - cached.ts < 50 * 60 * 1000) return cached.token;
  const res = await fetch(`${NIMBUS_BASE}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login HTTP ${res.status} — ${json.message || ""}`);
  let token = json && json.data;
  if (token && typeof token === "object") token = token.token || token.access_token;
  if (!token || typeof token !== "string") throw new Error("login rejected — " + (json.message || "no token"));
  tokenCache.set(email, { token, ts: Date.now() });
  return token;
}

function normalizeTrack(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pick = (...ks) => { for (const k of ks) if (entry[k] != null && entry[k] !== "") return entry[k]; };
  let status = pick("status", "current_status", "status_text", "order_status");
  if (!status && Array.isArray(entry.history) && entry.history.length) {
    const h = entry.history[entry.history.length - 1] || entry.history[0];
    status = h.status || h.status_text || h.message || h.activity;
  }
  // True pickup timestamp: the history event marking the courier pickup scan.
  // Excludes "pickup scheduled/assigned/pending" — those aren't an actual pickup.
  let pickupDate = "";
  if (Array.isArray(entry.history)) {
    for (const h of entry.history) {
      const txt = String(h.status || h.status_text || h.message || h.activity || "").toLowerCase();
      if (/pick.?ed.?up|pickup done|pickup complete|shipment picked|out for pickup done/.test(txt) &&
          !/schedul|pending|assign|await|generat/.test(txt)) {
        pickupDate = h.date || h.status_date || h.event_date || h.timestamp || h.event_time || h.time || h.datetime || "";
        if (pickupDate) break;
      }
    }
  }
  // NOTE: the NDR *reason* is NOT taken from tracking history — those events only
  // carry the status text ("Undelivered", "Delivery attempt failed"), not the
  // real disposition. The actual reason comes from the NDR List endpoint
  // (merged in later in handleData). Zone is not exposed by the NimbusPost API.
  return {
    status: String(status || "In Transit"),
    courier: String(pick("courier_name", "courier", "carrier") || ""),
    attempts: Number(pick("attempts", "ndr_attempts", "out_for_delivery_count")) || 0,
    zone: String(pick("zone", "delivery_zone", "zone_name", "zone_category") || ""),
    pickupDate: pickupDate || "",
    ndrReason: "",
  };
}

// NimbusPost NDR List — carries the actual non-delivery reason per AWB.
// Returns { awb: reason }. Best-effort: tolerates GET-paginated shapes.
async function nimbusNdrList(email, password) {
  const token = await nimbusLogin(email, password);
  const map = {};
  let firstAwbPrev = null;
  for (let page = 1; page <= 20; page++) {
    let res;
    try {
      res = await fetch(`${NIMBUS_BASE}/ndr?page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": UA },
      });
    } catch { break; }
    if (!res.ok) break;
    const json = await res.json().catch(() => ({}));
    let list = json && json.data;
    if (list && !Array.isArray(list) && Array.isArray(list.data)) list = list.data;
    if (!Array.isArray(list) || !list.length) break;
    const firstAwb = String(list[0].awb || list[0].awb_number || "");
    if (firstAwb && firstAwb === firstAwbPrev) break; // endpoint ignored ?page — stop
    firstAwbPrev = firstAwb;
    for (const e of list) {
      const awb = e.awb || e.awb_number || e.tracking_number;
      // Real NDR disposition/reason. NimbusPost's NDR data uses "action" for the
      // disposition (e.g. "future delivery"); fall back to reason fields.
      const reason = e.action || e.ndr_action || e.ndr_reason || e.reason || e.customer_remark ||
        e.remark || e.remarks || e.reason_code || e.ndr_reason_code;
      if (awb && reason) map[String(awb)] = String(reason).trim();
    }
  }
  return map;
}

async function nimbusTrack(email, password, awbs) {
  if (!awbs.length) return {};
  const token = await nimbusLogin(email, password);
  const map = {};
  for (const group of chunk([...new Set(awbs)], 100)) {
    const res = await fetch(`${NIMBUS_BASE}/shipments/track/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": UA },
      body: JSON.stringify({ awb: group }),
    });
    if (!res.ok) throw new Error(`bulk track HTTP ${res.status} — ${await errBody(res)}`);
    const json = await res.json().catch(() => ({}));
    let data = json && json.data != null ? json.data : json;
    if (Array.isArray(data)) {
      for (const e of data) {
        const key = e.awb_number || e.awb || e.tracking_number;
        const n = normalizeTrack(e); if (key && n) map[String(key)] = n;
      }
    } else if (data && typeof data === "object") {
      for (const [key, e] of Object.entries(data)) { const n = normalizeTrack(e); if (n) map[String(key)] = n; }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ *
 *  Shopify data
 * ------------------------------------------------------------------ */

function detectPayment(o) {
  const g = ((o.payment_gateway_names || []).join(" ") + " " + (o.gateway || "") + " " + (o.tags || "")).toLowerCase();
  if (/\bcod\b|cash on delivery|cash_on_delivery/.test(g)) return "cod";
  if (o.financial_status === "pending" || o.financial_status === "partially_paid") return "cod";
  return "prepaid";
}

// Risk tag (low / high / very_high) read from the Shopify order's Tags field.
// Other tags on the order are ignored. very_high is checked first because
// "very high" also contains the word "high".
function detectRisk(o) {
  const t = String(o.tags || "").toLowerCase();
  if (/very[\s_-]*high/.test(t)) return "very_high";
  if (/\bhigh\b/.test(t)) return "high";
  if (/\blow\b/.test(t)) return "low";
  return "untagged";
}
function lineItemsOf(o) {
  return (o.line_items || []).map((li) => {
    const qty = Number(li.quantity) || 1;
    const gross = Number(li.price) || 0;
    const disc = (li.discount_allocations || []).reduce((a, d) => a + (Number(d.amount) || 0), 0);
    const productTitle = (li.title || li.name || "Unknown product").trim();
    const variantTitle = (li.variant_title || "Default").trim();
    // Group by a NORMALIZED title key, not Shopify's numeric variant_id — the
    // same pack can carry different variant_ids across re-created products, and
    // minor formatting (case, extra spaces, punctuation) was splitting identical
    // variants into separate rows. normKey collapses those while keeping
    // genuinely different names (different words/numbers) separate — no leakage.
    const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const productId = normKey(productTitle);
    const variantId = normKey(productTitle) + " | " + normKey(variantTitle);
    return {
      product: productTitle, productId,
      variant: variantTitle, variantId,
      unitPrice: Math.max(0, gross - disc / qty),
      quantity: qty,
    };
  });
}
// Canonicalize courier names so "delhivery" and "Delhivery" don't split.
const COURIER_MAP = {
  delhivery: "Delhivery", bluedart: "Bluedart", bluedartexpress: "Bluedart",
  xpressbees: "Xpressbees", ekart: "Ekart", dtdc: "DTDC", shadowfax: "Shadowfax",
  ecomexpress: "Ecom Express", ecom: "Ecom Express", amazon: "Amazon",
  amazonshipping: "Amazon", indiapost: "India Post", shiprocket: "Shiprocket",
};
function normalizeCourier(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (COURIER_MAP[key]) return COURIER_MAP[key];
  return raw.replace(/\s+/g, " ").split(" ")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

function shopifyShipmentStatus(s) {
  const t = String(s || "").toLowerCase();
  if (t.includes("delivered")) return "Delivered";
  if (t.includes("out_for_delivery")) return "Out For Delivery";
  if (t.includes("in_transit") || t.includes("confirmed")) return "In Transit";
  if (t.includes("attempted") || t.includes("failure")) return "Undelivered";
  return "";
}

async function fetchShopify(shop, token, fetchDays) {
  const host = shopHost(shop);
  if (!host) throw new Error("Missing Shopify store domain");
  // No hidden buffer: fetch exactly the requested horizon.
  const sinceISO = new Date(Date.now() - fetchDays * 86400000).toISOString();
  const headers = { "X-Shopify-Access-Token": token, Accept: "application/json", "User-Agent": UA };
  let url = `https://${host}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(sinceISO)}`;
  const raw = [];
  let brand = host.replace(".myshopify.com", "");
  for (let i = 0; i < 20 && url; i++) {
    const res = await fetch(url, { headers });
    if (!res.ok) { if (i === 0) throw new Error(`orders HTTP ${res.status} — ${await errBody(res)}`); break; }
    const json = await res.json().catch(() => ({}));
    if (Array.isArray(json.orders)) raw.push(...json.orders);
    const m = (res.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  try {
    const sr = await fetch(`https://${host}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, { headers });
    if (sr.ok) { const sj = await sr.json(); if (sj && sj.shop && sj.shop.name) brand = sj.shop.name; }
  } catch {}
  return { brand, raw };
}

// Find an AWB carried on the order itself (note attributes) — some NimbusPost
// integrations store the AWB there when a shipment is booked, before a Shopify
// fulfillment syncs.
function orderAwb(o) {
  for (const na of (o.note_attributes || [])) {
    const n = String(na.name || "").toLowerCase();
    if (/awb|waybill|tracking/.test(n)) {
      const v = String(na.value || "").trim();
      if (v && /[0-9]{6,}/.test(v)) return v;
    }
  }
  return "";
}

function buildShipments(rawOrders, statusByAwb, nimbusMap) {
  nimbusMap = nimbusMap || {};
  const shipments = []; let idc = 0;
  for (const o of rawOrders) {
    const orderNumber = String(o.name || o.order_number || o.id || "").replace(/^#/, "");
    const paymentType = detectPayment(o);
    const risk = detectRisk(o);
    const amount = Number(o.total_price) || 0;
    const fulfillments = o.fulfillments || [];
    const orderDateTop = toISO(o.created_at);
    const stateTop = (o.shipping_address && (o.shipping_address.province || o.shipping_address.province_code)) || "";

    // NimbusPost (webhook) is authoritative for shipment status. If it has a
    // record for this order (matched on digits), use it and skip Shopify.
    const nb = nimbusMap[ordKey(orderNumber)];
    if (nb && nb.status) {
      const st = nb.status, awb = nb.awb || "";
      const tracked = awb ? statusByAwb[awb] : null;
      let attempts = (tracked && Number(tracked.attempts)) || 0;
      if (attempts === 0 && /deliver|rto|return|undeliver|ndr|exception|out for delivery|attempt/i.test(st)) attempts = 1;
      shipments.push({
        id: "N" + idc++, orderNumber, awb,
        courier: normalizeCourier((tracked && tracked.courier) || ""),
        zone: (tracked && tracked.zone) || "", state: stateTop, attempts,
        paymentType, risk, amount, status: st, dispatched: true,
        ndrReason: (tracked && tracked.ndrReason) || "", ndrDate: "",
        orderDate: orderDateTop, shipmentDate: orderDateTop,
        pickupDate: tracked && tracked.pickupDate ? toISO(tracked.pickupDate) : "",
        createdAt: tracked && tracked.pickupDate ? toISO(tracked.pickupDate) : orderDateTop,
      });
      continue;
    }
    const orderDate = toISO(o.created_at);
    const state = (o.shipping_address && (o.shipping_address.province || o.shipping_address.province_code)) || "";
    const ff = String(o.fulfillment_status || "").toLowerCase();
    if (fulfillments.length === 0) {
      // No Shopify fulfillment object — but the order may still be booked/closed.
      // A "booked" COD order usually carries its AWB in the order's note
      // attributes even before a Shopify fulfillment syncs; having an AWB = booked
      // = confirmed (not open). Also: fulfillment_status fulfilled/partial =
      // dispatched; cancelled_at = cancelled; COD financial_status paid = delivered.
      const noteAwb = orderAwb(o);
      const trackedNote = noteAwb ? statusByAwb[noteAwb] : null;
      const noteStatus = trackedNote && trackedNote.status ? trackedNote.status : (noteAwb ? "Booked" : "");
      let status = "Pending", dispatched = false, awb = "", courier = "", zone = "", attempts = 0, shipmentDate = "", pickupDate = "", ndrReason = "";
      if (o.cancelled_at) status = "Cancelled";
      else if (noteAwb && /cancel/i.test(noteStatus)) {
        // Shipment moved OUT of booked (cancelled) while the order is still
        // active → re-mark as open (awaiting re-confirmation), not dispatched.
        status = "Pending"; dispatched = false;
      }
      else if (noteAwb) {
        awb = noteAwb; dispatched = true; status = noteStatus;
        attempts = (trackedNote && Number(trackedNote.attempts)) || 0;
        if (attempts === 0 && /deliver/i.test(status) && !/rto|return/i.test(status)) attempts = 1;
        courier = normalizeCourier((trackedNote && trackedNote.courier) || "");
        zone = (trackedNote && trackedNote.zone) || "";
        ndrReason = (trackedNote && trackedNote.ndrReason) || "";
        shipmentDate = orderDate;
        pickupDate = trackedNote && trackedNote.pickupDate ? toISO(trackedNote.pickupDate) : "";
      }
      else if (ff === "fulfilled" || ff === "partial") { status = "In Transit"; dispatched = true; attempts = 1; shipmentDate = orderDate; }
      else if (paymentType === "cod" && String(o.financial_status || "").toLowerCase() === "paid") { status = "Delivered"; dispatched = true; attempts = 1; shipmentDate = orderDate; }
      shipments.push({ id: "U" + idc++, orderNumber, awb, courier, zone, state, attempts, paymentType, risk, amount, status, dispatched, ndrReason, ndrDate: "", orderDate, shipmentDate, pickupDate, createdAt: shipmentDate || orderDate });
      continue;
    }
    for (const f of fulfillments) {
      const awb = f.tracking_number || (f.tracking_numbers || [])[0] || "";
      const tracked = awb ? statusByAwb[awb] : null;
      const status = (tracked && tracked.status) || shopifyShipmentStatus(f.shipment_status) ||
        (String(f.status || "").toLowerCase() === "cancelled" ? "Cancelled" : "In Transit");
      // attempts = real delivery-attempt count from NimbusPost (0 while the
      // parcel is still in transit and has not been out for delivery). A
      // delivered parcel implies at least one successful attempt. We do NOT
      // default this to 1 — doing so would wrongly pull still-in-transit orders
      // into the FAD denominator and understate the rate.
      let attempts = (tracked && Number(tracked.attempts)) || 0;
      if (attempts === 0 && /deliver/i.test(status) && !/rto|return/i.test(status)) attempts = 1;
      // A fulfillment means the order was dispatched/booked — even if the
      // tracking number hasn't synced back to Shopify yet. "dispatched" (not the
      // presence of an AWB) is what COD confirmation should count.
      // Shipment creation = when the shipment/AWB was booked (fulfillment date).
      const shipmentDate = toISO(f.created_at || o.created_at);
      // Prefer NimbusPost's true pickup scan; fall back to the fulfillment date.
      const pickupDate = (tracked && tracked.pickupDate)
        ? toISO(tracked.pickupDate)
        : toISO(f.created_at || o.created_at);
      shipments.push({
        id: "S" + idc++, orderNumber, awb,
        courier: normalizeCourier((tracked && tracked.courier) || f.tracking_company || ""),
        zone: (tracked && tracked.zone) || "",
        state,
        attempts,
        paymentType, risk, amount, status, dispatched: true,
        ndrReason: (tracked && tracked.ndrReason) || "",
        ndrDate: (tracked && tracked.ndrDate) || "",
        orderDate, shipmentDate, pickupDate, createdAt: pickupDate,
      });
    }
  }
  return shipments;
}
function buildOrders(rawOrders) {
  return rawOrders.map((o) => ({
    orderNumber: String(o.name || o.order_number || o.id || "").replace(/^#/, ""),
    createdAt: toISO(o.created_at),
    paymentType: detectPayment(o),
    risk: detectRisk(o),
    lineItems: lineItemsOf(o),
  }));
}

/* ------------------------------------------------------------------ *
 *  CALLING MODULE — queue assembly, Shopify write-back, Exotel
 * ------------------------------------------------------------------ */

function resolveShopify() {
  const stored = loadCreds().shopify || {};
  return { shop: stored.shop || KK.shopifyShop, token: stored.accessToken || KK.shopifyToken };
}
function digits(s) { return String(s || "").replace(/[^\d+]/g, ""); }
// Digits-only order key so "kk2468" (NimbusPost) and "#2468" (Shopify) match.
function ordKey(s) { return String(s || "").replace(/[^0-9]/g, ""); }

// Best-effort order source from UTM / referrer / channel.
function parseSource(o) {
  const ls = o.landing_site || "";
  let m = ls.match(/[?&]utm_source=([^&]+)/i);
  if (m) return decodeURIComponent(m[1]).replace(/\+/g, " ").toLowerCase();
  for (const na of (o.note_attributes || [])) if (/utm_source/i.test(na.name || "")) return String(na.value || "").toLowerCase();
  const ref = (o.referring_site || "").toLowerCase();
  if (/facebook|instagram|fbclid/.test(ref) || /fbclid/i.test(ls)) return "facebook";
  if (/google|gclid/.test(ref) || /gclid/i.test(ls)) return "google";
  if (ref) { try { return new URL(o.referring_site).hostname.replace(/^www\./, ""); } catch { return ref; } }
  return o.source_name && o.source_name !== "web" ? o.source_name : "direct";
}
function buildCallCard(o) {
  const sa = o.shipping_address || {}, cust = o.customer || {};
  const name = sa.name || [cust.first_name, cust.last_name].filter(Boolean).join(" ") || "Customer";
  const phone = digits(sa.phone || o.phone || cust.phone || "");
  const items = (o.line_items || []).map((li) => ({
    title: li.title, variant: li.variant_title || "", qty: li.quantity,
    price: Number(li.price) || 0,
    discount: (li.discount_allocations || []).reduce((a, d) => a + (Number(d.amount) || 0), 0),
  }));
  return {
    orderNumber: String(o.name || o.order_number || o.id).replace(/^#/, ""), orderId: o.id,
    customer: name, phone,
    address: { name, phone, line1: sa.address1 || "", line2: sa.address2 || "", city: sa.city || "", state: sa.province || "", zip: sa.zip || "", country: sa.country || "India" },
    source: parseSource(o), createdAt: o.created_at, items,
    subtotal: Number(o.subtotal_price) || 0, discount: Number(o.total_discounts) || 0, total: Number(o.total_price) || 0,
    paymentType: detectPayment(o), risk: detectRisk(o),
  };
}

async function shopifyREST(method, pathStr, body) {
  const { shop, token } = resolveShopify();
  const host = shopHost(shop);
  if (!host || !token) throw new Error("Shopify not connected.");
  const res = await fetch(`https://${host}/admin/api/${SHOPIFY_API_VERSION}/${pathStr}`, {
    method, headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Shopify ${method} ${pathStr} HTTP ${res.status} — ${await errBody(res)}`);
  return res.json().catch(() => ({}));
}
// Add multiple separate tags to a Shopify order (de-duplicated).
async function shopifyAddTags(id, tagList) {
  const order = (await shopifyREST("GET", `orders/${id}.json`)).order || {};
  const tags = (order.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of tagList) {
    const tag = String(t || "").trim();
    if (tag && !tags.some((x) => x.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  await shopifyREST("PUT", `orders/${id}.json`, { order: { id, tags: tags.join(", ") } });
}
async function shopifyCancelOrder(id) { return shopifyREST("POST", `orders/${id}/cancel.json`, {}); }
async function shopifyUpdateAddress(id, a) {
  await shopifyREST("PUT", `orders/${id}.json`, { order: { id, shipping_address: {
    name: a.name, phone: a.phone, address1: a.line1, address2: a.line2, city: a.city, province: a.state, zip: a.zip, country: a.country } } });
}

async function exotelConnect(agentPhone, customerPhone) {
  const sid = process.env.EXOTEL_SID, key = process.env.EXOTEL_KEY, token = process.env.EXOTEL_TOKEN;
  const callerId = process.env.EXOTEL_CALLER_ID, sub = process.env.EXOTEL_SUBDOMAIN || "api.exotel.com";
  if (!sid || !key || !token || !callerId) throw new Error("Exotel not configured (SID/KEY/TOKEN/CALLER_ID).");
  if (!agentPhone) throw new Error("Your account has no phone number — ask an admin to add it.");
  if (!customerPhone) throw new Error("This order has no customer phone number.");
  const auth64 = Buffer.from(`${key}:${token}`).toString("base64");
  const body = new URLSearchParams({
    From: agentPhone, To: customerPhone, CallerId: callerId, CallType: "trans", TimeLimit: "1800",
    Record: "true",                                         // record the conversation
    StatusCallback: `${PUBLIC_BASE}/webhooks/exotel`,       // Exotel posts recording + duration here
    StatusCallbackEvents: "terminal",
  });
  const res = await fetch(`https://${sub}/v1/Accounts/${sid}/Calls/connect.json`, {
    method: "POST", headers: { Authorization: `Basic ${auth64}`, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`Exotel HTTP ${res.status} — ${await errBody(res)}`);
  const data = await res.json().catch(() => ({}));
  const call = data.Call || data.call || {};
  return { sid: call.Sid || call.sid || "", status: call.Status || "", raw: data };
}

// The pool of caller accounts to auto-assign across (active + has calling access).
async function callingPool() {
  const users = await db.listUsers();
  return users.filter((u) => u.active && (u.role === "admin" || (Array.isArray(u.modules) && u.modules.includes("calling")))).map((u) => u.id);
}
// An order is "booked" once a shipment/AWB exists — these no longer need a
// confirmation call. Signals: a Shopify fulfillment, fulfillment_status, or an
// AWB written onto the order (NimbusPost stores it in note attributes).
function isBooked(o) {
  if ((o.fulfillments || []).length > 0) return true;
  const ff = String(o.fulfillment_status || "").toLowerCase();
  if (ff === "fulfilled" || ff === "partial") return true;
  if (orderAwb(o)) return true;
  return false;
}

// Coarse outcome of a past order, from NimbusPost (preferred) then Shopify.
function outcomeOf(o, nimbusMap) {
  const n = ordKey(o.name || o.order_number || o.id);
  const txt = (nimbusMap[n] && String(nimbusMap[n].status || "").toLowerCase()) || "";
  if (/rto|return/.test(txt)) return "rto";
  if (/deliver/.test(txt)) return "delivered";
  if (/cancel/.test(txt)) return "cancelled";
  if (/transit|out for delivery|dispatch|pickup|picked|shipped|booked|spd|ofd/.test(txt)) return "in_transit";
  if (o.cancelled_at) return "cancelled";
  const ff = String(o.fulfillment_status || "").toLowerCase();
  if (ff === "fulfilled" || ff === "partial") return "in_transit";
  return "open";
}
// The customer's full order history (newest first), each with its outcome.
async function customerHistory(o, nimbusMap) {
  const cust = o.customer || {};
  const email = o.email || cust.email || "";
  let past = [];
  try {
    if (cust.id) past = (await shopifyREST("GET", `customers/${cust.id}/orders.json?status=any&limit=50`)).orders || [];
    else if (email) past = (await shopifyREST("GET", `orders.json?status=any&limit=50&email=${encodeURIComponent(email)}`)).orders || [];
  } catch (_) { past = []; }
  return past.map((p) => ({
    orderNumber: String(p.name || p.order_number || p.id).replace(/^#/, ""),
    at: p.created_at, total: Number(p.total_price) || 0,
    payment: detectPayment(p), outcome: outcomeOf(p, nimbusMap),
  })).sort((a, b) => new Date(b.at) - new Date(a.at));
}
// RTO-risk heuristic from prior delivered/RTO record + Shopify fraud + pincode.
function rtoRisk(history, currentNumber, shopRisk, pinFlag) {
  const prior = history.filter((h) => h.orderNumber !== currentNumber);
  const delivered = prior.filter((h) => h.outcome === "delivered").length;
  const rto = prior.filter((h) => h.outcome === "rto").length;
  const cancelled = prior.filter((h) => h.outcome === "cancelled").length;
  const completed = delivered + rto;
  const rate = completed ? rto / completed : 0;
  const reasons = [];
  let level = "low";
  if (rto >= 2 || (completed >= 2 && rate >= 0.5)) { level = "high"; reasons.push(`${rto} past RTO${rto > 1 ? "s" : ""} of ${completed} delivered`); }
  else if (rto === 1) { level = "medium"; reasons.push("1 past RTO"); }
  if (delivered >= 2 && rto === 0) reasons.push(`${delivered} clean past deliveries`);
  if (!prior.length) reasons.push("first-time customer (no history)");
  if (cancelled >= 2) { reasons.push(`${cancelled} past cancellations`); if (level === "low") level = "medium"; }
  if (shopRisk === "high" || shopRisk === "very_high") { reasons.push("Shopify flags high fraud risk"); level = "high"; }
  if (pinFlag && pinFlag.serviceable === false) { reasons.push("pincode marked non-serviceable"); level = "high"; }
  if (!reasons.length) reasons.push("no risk signals");
  return { level, reasons, stats: { delivered, rto, cancelled, orders: prior.length } };
}

// Build the full card payload (items, history, pincode flag, RTO, last call).
async function enrichCard(chosen, raw, nimbus, now) {
  const card = buildCallCard(raw);
  card.attemptsToday = CallQueue.attemptsToday(chosen, now).length;   // dials today
  card.required = CallQueue.requiredByNow(now);
  card.history = (chosen.allAttempts || chosen.attempts || []).map((a) => ({ at: a.at, caller: a.caller, outcome: a.outcome }));
  const pinFlag = await db.getPincode(card.address.zip).catch(() => null);
  card.pincode = { value: String(card.address.zip || "").replace(/\D/g, ""),
    serviceable: pinFlag ? pinFlag.serviceable : null, note: pinFlag ? pinFlag.note : "" };
  const history = await customerHistory(raw, nimbus || {});
  card.customerHistory = history;
  card.rto = rtoRisk(history, card.orderNumber, card.risk, pinFlag);
  card.callInfo = await db.latestCallForOrder(card.orderNumber).catch(() => null);
  return card;
}
// The active calling series: orders DUE by the SLA cadence (oldest first). If the
// SLA is fully satisfied, fall back to the backlog (oldest, least-dialled first)
// so callers loop back instead of going idle.
function queueSeries(orders, now) {
  const due = CallQueue.dueOrders(orders, now);
  if (due.length) return { list: due, wrapped: false };
  const at = (o) => CallQueue.attemptsToday(o, now).length;
  const backlog = orders.filter((o) => CallQueue.eligible(o, now) && !o.callback)
    .sort((a, b) => (at(a) - at(b)) || (new Date(a.createdAt) - new Date(b.createdAt)));
  return { list: backlog, wrapped: true };
}
// Walk a series from `fromNum` in a direction, wrapping around (for Prev/Next).
function navOrder(dir, list, fromNum) {
  const n = list.length, out = [];
  if (!n) return out;
  const idx = list.findIndex((o) => o.orderNumber === fromNum);
  if (dir === "prev") {
    const start = idx >= 0 ? idx - 1 : n - 1;
    for (let k = 0; k < n; k++) out.push(list[((start - k) % n + n) % n]);
  } else {
    const start = idx >= 0 ? idx + 1 : 0;
    for (let k = 0; k < n; k++) out.push(list[(start + k) % n]);
  }
  return out;
}

// Assemble the live queue: COD orders (last 4d) that are NOT yet booked,
// plus DB attempts/actions/locks.
async function buildCallQueue() {
  const { shop, token } = resolveShopify();
  if (!shop || !token) return { orders: [], byNum: {} };
  const { raw } = await fetchShopify(shop, token, 4);
  // NimbusPost is the source of truth for "has this been booked/cancelled?".
  // Any order NimbusPost has a shipment record for (booked, in transit,
  // cancelled, anything) is NOT a confirmation-call candidate. Shopify's
  // fulfillment/AWB is only a fallback for orders we have no webhook event for.
  const nimbus = await db.nimbusByOrder().catch(() => ({}));
  const cod = raw.filter((o) => {
    if (detectPayment(o) !== "cod") return false;
    if (o.cancelled_at) return false;     // cancelled in Shopify
    const n = String(o.name || o.order_number || o.id).replace(/^#/, "");
    if (nimbus[ordKey(n)]) return false;  // NimbusPost has a shipment (any status — match on digits)
    if (isBooked(o)) return false;        // Shopify shows a shipment/AWB (fallback)
    return true;
  });
  const nums = cod.map((o) => String(o.name || o.order_number || o.id).replace(/^#/, ""));
  const [attempts, actions, locks, callbacks] = await Promise.all([
    db.attemptsByOrder(nums), db.allActions(), db.activeLocks(), db.pendingCallbacks().catch(() => ({})),
  ]);
  const lockMap = {}; locks.forEach((l) => (lockMap[l.order_number] = l));
  const orders = cod.map((o) => {
    const n = String(o.name || o.order_number || o.id).replace(/^#/, "");
    const lk = lockMap[n];
    const all = attempts[n] || [];
    // SLA cadence counts actual DIALS only (outcome "called"); skips/confirms/etc
    // are dispositions, kept in allAttempts for history but not toward the SLA.
    const dials = all.filter((a) => a.outcome === "called");
    return { orderNumber: n, createdAt: o.created_at, paymentType: "cod", actioned: !!actions[n],
      attempts: dials, allAttempts: all, lockedBy: lk ? lk.caller_id : null, lockUntil: lk ? lk.locked_until : null,
      callback: callbacks[n] || null, _raw: o };
  });
  const byNum = {}; orders.forEach((o) => (byNum[o.orderNumber] = o));
  return { orders, byNum, nimbus, callbacks };
}

/* ------------------------------------------------------------------ *
 *  /api/data
 * ------------------------------------------------------------------ */

async function handleData(reqBody) {
  const { nimbus = {}, shopify = {}, days = 35 } = reqBody || {};
  const errors = [];
  const sample = SampleData.generate();
  const stored = loadCreds().shopify || {};

  // logDays = the window the shipment log shows (exactly what the user set).
  // fetchDays = how much we actually pull: at least 90 days so the editable
  // metric windows AND their previous-period comparison have enough history
  // (e.g. FAD 5–30 compares against 30–55 days old).
  const logDays = Math.max(1, Number(days) || 35);
  const fetchDays = Math.max(logDays, 90);

  // Resolve Shopify creds: explicit (manual) > stored (OAuth) > KeraKing default.
  const shopDomain = shopify.shop || stored.shop || KK.shopifyShop;
  const shopToken = shopify.token || stored.accessToken || KK.shopifyToken;
  // NimbusPost creds: from the request, else KeraKing default (so every device
  // works with no setup).
  if (!nimbus.email) nimbus.email = KK.nimbusEmail;
  if (!nimbus.password) nimbus.password = KK.nimbusPassword;

  let rawOrders = null, brand = null;
  if (shopDomain && shopToken) {
    try {
      const r = await fetchShopify(shopDomain, shopToken, fetchDays);
      rawOrders = r.raw; brand = r.brand;
      if (!rawOrders.length) errors.push("Shopify returned no orders in the selected window.");
    } catch (e) { errors.push("Shopify: " + e.message); }
  } else {
    errors.push("Shopify not connected — open Settings and click Connect Shopify.");
  }

  let statusByAwb = {}, nimbusTried = false;
  if (rawOrders && rawOrders.length && nimbus.email && nimbus.password) {
    nimbusTried = true;
    const awbs = [];
    for (const o of rawOrders) {
      let any = false;
      for (const f of o.fulfillments || []) {
        const a = f.tracking_number || (f.tracking_numbers || [])[0]; if (a) { awbs.push(a); any = true; }
      }
      if (!any) { const a = orderAwb(o); if (a) awbs.push(a); } // booked-but-unsynced AWB on the order
    }
    if (!awbs.length) errors.push("No AWB/tracking numbers on Shopify fulfillments — using Shopify's own delivery status. (Is NimbusPost writing tracking back to Shopify?)");
    else {
      try {
        statusByAwb = await nimbusTrack(nimbus.email, nimbus.password, awbs);
        if (!Object.keys(statusByAwb).length) errors.push("NimbusPost tracking returned no matches for your AWBs.");
      } catch (e) { errors.push("NimbusPost: " + e.message + " — falling back to Shopify status."); }
      // Enrich with the real NDR reasons from the NDR List endpoint.
      try {
        const ndr = await nimbusNdrList(nimbus.email, nimbus.password);
        for (const awb in ndr) {
          if (!statusByAwb[awb]) statusByAwb[awb] = { status: "Undelivered" };
          statusByAwb[awb].ndrReason = ndr[awb];
        }
      } catch (_) {}
    }
  } else if (!nimbus.email || !nimbus.password) {
    errors.push("NimbusPost credentials not set — statuses come from Shopify only.");
  }

  // NimbusPost webhook store is authoritative for shipment status (Shopify is fallback).
  const nimbusMap = db.dbEnabled ? await db.nimbusByOrder().catch(() => ({})) : {};
  let shipments = null, orders = null;
  if (rawOrders && rawOrders.length) { shipments = buildShipments(rawOrders, statusByAwb, nimbusMap); orders = buildOrders(rawOrders); }

  let usedSample = false;
  if (!shipments || !shipments.length) { shipments = sample.shipments; orders = sample.orders; usedSample = true; }
  if (!brand) brand = usedSample ? sample.brand : "Your Store";

  const liveStatuses = Object.keys(statusByAwb).length > 0;
  const source = usedSample ? "sample" : liveStatuses || nimbusTried ? "live" : "partial";
  return { source, brand, shipments, orders, errors, logDays, fetchDays, asOf: new Date().toISOString() };
}

/* ------------------------------------------------------------------ *
 *  HTTP plumbing
 * ------------------------------------------------------------------ */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      // Never cache app files locally — always serve the latest edits so a
      // plain refresh is enough (no more hard-refresh needed).
      "Cache-Control": "no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(data);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function publicUser(u) {
  return u ? { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, modules: Array.isArray(u.modules) ? u.modules : [], active: u.active } : null;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // Legacy password lock — only when there is NO user database (pure local mode).
  if (APP_PASSWORD && !db.dbEnabled) {
    const hdr = req.headers.authorization || "";
    const [scheme, enc] = hdr.split(" ");
    let ok = false;
    if (scheme === "Basic" && enc) {
      const pass = Buffer.from(enc, "base64").toString().split(":").slice(1).join(":");
      if (pass === APP_PASSWORD) ok = true;
    }
    if (!ok) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="KERAKING"' }); return res.end("Authentication required"); }
  }

  try {
    // ---------- public auth endpoints (no session needed) ----------
    if (req.method === "POST" && pathname === "/auth/otp/request") {
      const b = await readJson(req);
      return sendJson(res, 200, await auth.requestOtp(String(b.email || "").trim()));
    }
    if (req.method === "POST" && pathname === "/auth/otp/verify") {
      const b = await readJson(req);
      const r = await auth.verifyOtp(String(b.email || "").trim(), String(b.code || "").trim());
      if (r.ok) { res.setHeader("Set-Cookie", r.cookie); return sendJson(res, 200, { ok: true, user: publicUser(r.user) }); }
      return sendJson(res, 200, { ok: false, error: r.error });
    }
    if (req.method === "POST" && pathname === "/auth/logout") {
      res.setHeader("Set-Cookie", await auth.logout(req));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && pathname === "/auth/me") {
      const u = db.dbEnabled ? await auth.currentUser(req)
        : { id: 0, name: "Local Admin", email: "", phone: "", role: "admin", modules: db.MODULES, active: true };
      return sendJson(res, 200, { authRequired: db.dbEnabled, user: publicUser(u) });
    }
    // Exotel posts call status here (public — Exotel can't carry a session).
    // It sends CallSid + Status + RecordingUrl + duration once the call ends.
    if (pathname === "/webhooks/exotel") {
      let p = {};
      try { p = await readBody(req); } catch (_) {}
      try {
        const callSid = String(p.CallSid || p.callsid || p.Sid || p.sid || "").trim();
        const status = String(p.Status || p.DialCallStatus || p.status || "").trim();
        const recordingUrl = String(p.RecordingUrl || p.recording_url || p.RecordingUri || "").trim();
        const duration = p.ConversationDuration || p.Duration || p.DialCallDuration || p.duration || null;
        if (callSid && db.dbEnabled) await db.updateCallLog({ callSid, status, recordingUrl, duration });
      } catch (_) {}
      res.writeHead(200); return res.end("ok");
    }
    // NimbusPost pushes shipment/AWB/status events here (public).
    if (pathname === "/webhooks/nimbus") {
      let p = {};
      try { p = await readBody(req); } catch (_) {}
      try {
        const d = p && p.data && typeof p.data === "object" ? Object.assign({}, p, p.data) : p;
        const orderNumber = String(d.order_number || d.order_id || d.orderid || d.reference || d.client_order_id || d.order || "").replace(/^#/, "");
        const awb = String(d.awb || d.awb_number || d.tracking_number || d.waybill || "").trim();
        const status = String(d.status || d.current_status || d.status_text || d.shipment_status || d.order_status || "").trim();
        if ((orderNumber || awb) && db.dbEnabled) await db.upsertNimbusShipment({ awb, orderNumber, status, raw: p });
      } catch (_) {}
      res.writeHead(200); return res.end("ok");
    }

    // ---------- session gate (only in DB / multi-user mode) ----------
    let sessionUser = null;
    if (db.dbEnabled) {
      sessionUser = await auth.currentUser(req);
      if (!sessionUser) {
        if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) return sendJson(res, 401, { error: "Not authenticated" });
        return serveStatic(req, res, "/login.html"); // self-contained login page
      }
    }
    const isAdmin = !db.dbEnabled || (sessionUser && sessionUser.role === "admin");

    // ---------- app routes ----------
    if (req.method === "POST" && pathname === "/api/data") {
      const out = await handleData(await readJson(req));
      return sendJson(res, 200, out);
    }

    // ---------- user management (admin only) ----------
    if (pathname === "/api/users") {
      if (!isAdmin) return sendJson(res, 403, { error: "Admin only" });
      if (!db.dbEnabled) return sendJson(res, 200, { users: [], dbEnabled: false });
      if (req.method === "GET") return sendJson(res, 200, { users: await db.listUsers() });
      if (req.method === "POST") {
        const b = await readJson(req);
        const allowed = (Array.isArray(b.modules) ? b.modules : []).filter((m) => ["delivery", "unit", "calling"].includes(m));
        if (b.id) {
          // Don't let an admin lock themselves out.
          if (sessionUser && String(b.id) === String(sessionUser.id) && (b.active === false || b.role === "user"))
            return sendJson(res, 200, { ok: false, error: "You can't remove your own admin access." });
          const u = await db.updateUser(b.id, {
            name: b.name, phone: b.phone, role: b.role,
            modules: b.role === "admin" ? db.MODULES : allowed, active: b.active,
          });
          return sendJson(res, 200, { ok: true, user: publicUser(u) });
        }
        const email = String(b.email || "").trim().toLowerCase();
        if (!email.includes("@")) return sendJson(res, 200, { ok: false, error: "A valid email is required." });
        const u = await db.createUser({
          name: b.name || "", email, phone: b.phone || "",
          role: b.role === "admin" ? "admin" : "user",
          modules: b.role === "admin" ? db.MODULES : allowed,
        });
        return sendJson(res, 200, { ok: true, user: publicUser(u) });
      }
    }

    // ---------- calling module ----------
    if (pathname.startsWith("/api/calling/")) {
      if (!db.dbEnabled) return sendJson(res, 400, { error: "Calling needs the hosted/database setup." });
      const canCall = isAdmin || (sessionUser && (sessionUser.modules || []).includes("calling"));
      if (!canCall) return sendJson(res, 403, { error: "No calling access" });
      const caller = sessionUser || { id: 0, name: "Admin", phone: "" };
      const now = Date.now();

      if (req.method === "GET" && pathname === "/api/calling/next") {
        const { orders, byNum, nimbus } = await buildCallQueue();
        const summary = CallQueue.summary(orders, now);
        const [myDay, online] = await Promise.all([db.callerDayAttempts(caller.id), db.onlineCallers().catch(() => 0)]);
        // Pull-based distribution: every active caller draws from one shared
        // queue, oldest order first. The atomic claim guarantees no two callers
        // are ever shown the same order — works for a team of 1 or 20, and the
        // pool self-balances as people join/leave. Hold at most one order each.
        await db.releaseCallerLocks(caller.id);
        const lease = new Date(now + 5 * 60000).toISOString();
        const series = queueSeries(orders, now);
        let chosen = null;
        for (const o of series.list) {
          if (await db.claimOrder(o.orderNumber, caller.id, lease)) { chosen = o; break; }
        }
        if (!chosen) return sendJson(res, 200, { order: null, summary, myDay, online });
        const card = await enrichCard(chosen, byNum[chosen.orderNumber]._raw, nimbus, now);
        card.wrapped = series.wrapped;
        const idx = series.list.findIndex((o) => o.orderNumber === chosen.orderNumber);
        card.position = { index: idx + 1, total: series.list.length, mode: series.wrapped ? "backlog" : "due" };
        return sendJson(res, 200, { order: card, summary, myDay, online, wrapped: series.wrapped });
      }
      // Manual navigation: Prev / Next (within the due-by-SLA series) and jump to
      // a specific order ID. If the target is held by another caller, return a
      // collision and auto-advance to the next free order.
      if (req.method === "GET" && pathname === "/api/calling/nav") {
        const dir = (urlObj.searchParams.get("dir") || "next").toLowerCase();
        const from = String(urlObj.searchParams.get("from") || "").replace(/^#/, "");
        const toRaw = urlObj.searchParams.get("to") || "";
        const { orders, byNum, nimbus } = await buildCallQueue();
        const summary = CallQueue.summary(orders, now);
        const [myDay, online, users] = await Promise.all([
          db.callerDayAttempts(caller.id), db.onlineCallers().catch(() => 0), db.listUsers().catch(() => []),
        ]);
        const nameById = {}; users.forEach((u) => (nameById[u.id] = u.name || u.email));
        const series = queueSeries(orders, now);
        const list = series.list;
        const lease = new Date(now + 5 * 60000).toISOString();
        const byDigits = {}; orders.forEach((o) => (byDigits[ordKey(o.orderNumber)] = o));
        await db.releaseCallerLocks(caller.id);
        let chosen = null, collision = null;
        if (dir === "jump") {
          const tgt = byDigits[ordKey(toRaw)];
          if (!tgt) return sendJson(res, 200, { ok: true, notFound: true, summary, myDay, online,
            message: `Order #${String(toRaw).replace(/[^0-9]/g, "")} isn't in the calling queue — it may be non-COD, already booked/cancelled/confirmed, or outside the 4-day window.` });
          if (await db.claimOrder(tgt.orderNumber, caller.id, lease)) chosen = tgt;
          else {
            collision = { orderNumber: tgt.orderNumber, by: nameById[tgt.lockedBy] || "another caller" };
            for (const o of navOrder("next", list, tgt.orderNumber)) {
              if (await db.claimOrder(o.orderNumber, caller.id, lease)) { chosen = o; break; }
            }
          }
        } else {
          for (const o of navOrder(dir, list, from)) {
            if (await db.claimOrder(o.orderNumber, caller.id, lease)) { chosen = o; break; }
          }
        }
        if (!chosen) return sendJson(res, 200, { ok: true, order: null, collision, summary, myDay, online, wrapped: series.wrapped });
        const card = await enrichCard(chosen, byNum[chosen.orderNumber]._raw, nimbus, now);
        card.wrapped = series.wrapped;
        const idx = list.findIndex((o) => o.orderNumber === chosen.orderNumber);
        card.position = idx >= 0 ? { index: idx + 1, total: list.length, mode: series.wrapped ? "backlog" : "due" }
                                 : { index: null, total: list.length, mode: "jumped" };
        return sendJson(res, 200, { ok: true, order: card, collision, summary, myDay, online, wrapped: series.wrapped });
      }
      if (req.method === "GET" && pathname === "/api/calling/debug") {
        if (!isAdmin) return sendJson(res, 403, { error: "Admin only" });
        return sendJson(res, 200, { nimbus: await db.recentNimbus(50) });
      }
      // Latest recorded call for an order (polled after a call ends).
      if (req.method === "GET" && pathname === "/api/calling/callinfo") {
        const orderNumber = urlObj.searchParams.get("orderNumber") || "";
        return sendJson(res, 200, { ok: true, call: await db.latestCallForOrder(orderNumber).catch(() => null) });
      }
      const b = req.method === "POST" ? await readJson(req) : {};
      if (req.method === "POST" && pathname === "/api/calling/call") {
        try {
          const call = await exotelConnect(digits(caller.phone), digits(b.phone));
          if (call.sid) await db.startCallLog({ callSid: call.sid, orderNumber: b.orderNumber, callerId: caller.id, callerName: caller.name });
          // A dial = one SLA attempt (counts toward the 1-by-noon / 2-by-3pm / 3-by-6pm cadence).
          if (b.orderNumber) await db.logAttempt({ orderNumber: b.orderNumber, callerId: caller.id, callerName: caller.name, outcome: "called" });
          // Keep the order leased to this caller while the call is live.
          if (b.orderNumber) await db.claimOrder(b.orderNumber, caller.id, new Date(now + 10 * 60000).toISOString());
          return sendJson(res, 200, { ok: true, recorded: true, sid: call.sid, call });
        } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
      }
      if (req.method === "POST" && pathname === "/api/calling/skip") {
        const reason = String(b.reason || "No answer").slice(0, 120);
        const note = String(b.note || "").slice(0, 300);
        await db.logAttempt({ orderNumber: b.orderNumber, callerId: caller.id, callerName: caller.name, outcome: "skipped", notes: note ? `${reason} — ${note}` : reason });
        // "Call later": hide the order until the chosen date/time.
        if (b.callbackAt) {
          const t = new Date(b.callbackAt);
          if (!isNaN(t)) await db.setCallback(b.orderNumber, t.toISOString(), reason, note, caller.name);
        }
        await db.releaseCallerLocks(caller.id, null); // free it for the pool
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && pathname === "/api/calling/confirm") {
        try { await shopifyAddTags(b.orderId, ["Verified", caller.name]); }
        catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
        await db.setAction(b.orderNumber, "verified", caller.name);
        await db.clearCallback(b.orderNumber).catch(() => {});
        await db.logAttempt({ orderNumber: b.orderNumber, callerId: caller.id, callerName: caller.name, outcome: "confirmed" });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && pathname === "/api/calling/cancel") {
        try { await shopifyCancelOrder(b.orderId); } catch (_) { /* may already be cancelled */ }
        try { await shopifyAddTags(b.orderId, ["Cancelled", caller.name]); }
        catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
        await db.setAction(b.orderNumber, "cancelled", caller.name);
        await db.clearCallback(b.orderNumber).catch(() => {});
        await db.logAttempt({ orderNumber: b.orderNumber, callerId: caller.id, callerName: caller.name, outcome: "cancelled" });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && pathname === "/api/calling/address") {
        try { await shopifyUpdateAddress(b.orderId, b.address || {}); await shopifyAddTags(b.orderId, ["Address Change", caller.name]); }
        catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
        await db.logAttempt({ orderNumber: b.orderNumber, callerId: caller.id, callerName: caller.name, outcome: "address_updated" });
        return sendJson(res, 200, { ok: true });
      }
      // Save / clear a pincode's serviceability. Future orders on it auto-flag.
      if (req.method === "POST" && pathname === "/api/calling/pincode") {
        const row = await db.setPincode(b.pincode, b.serviceable !== false, b.note || "", caller.name);
        return sendJson(res, 200, { ok: true, pincode: row });
      }
      if (req.method === "GET" && pathname === "/api/calling/pincodes") {
        return sendJson(res, 200, { ok: true, pincodes: await db.listNonServiceable().catch(() => []) });
      }
    }
    if (req.method === "POST" && pathname === "/auth/start") {
      if (!isAdmin) return sendJson(res, 403, { error: "Admin only" });
      return await authStart(req, res);
    }
    if (req.method === "GET" && pathname === "/auth/callback") return await authCallback(req, res, urlObj);
    if (req.method === "GET" && pathname === "/auth/status") return authStatus(req, res);
    if (req.method === "POST" && pathname === "/auth/disconnect") {
      if (!isAdmin) return sendJson(res, 403, { error: "Admin only" });
      return authDisconnect(req, res);
    }
  } catch (e) {
    if (pathname === "/api/data") {
      const sample = SampleData.generate();
      return sendJson(res, 200, { source: "sample", brand: sample.brand, shipments: sample.shipments, orders: sample.orders, errors: ["Server error: " + e.message], asOf: new Date().toISOString() });
    }
    return sendJson(res, 500, { error: e.message });
  }

  serveStatic(req, res, decodeURIComponent(pathname));
});

if (require.main === module) {
  (async () => {
    try {
      await db.init();
      if (db.dbEnabled) console.log("\n  ✓ Database connected — multi-user login is ON");
    } catch (e) {
      console.error("\n  ✗ Database init failed:", e.message, "\n  (Check DATABASE_URL in .env)");
    }
    server.listen(PORT, () => {
      console.log(`\n  KeraKing Control Center`);
      console.log(`  ▶  http://localhost:${PORT}\n`);
      if (db.dbEnabled) console.log(`  Log in with your admin email (${process.env.ADMIN_EMAIL || "set ADMIN_EMAIL"}) — an OTP is emailed to you.\n`);
      console.log(`  Shopify OAuth redirect URL (add this in your Dev Dashboard app):`);
      console.log(`  ${REDIRECT_URI}\n`);
    });
  })();
}

module.exports = { buildShipments, buildOrders, detectPayment, detectRisk, normalizeCourier, shopHost, shopifyShipmentStatus, normalizeTrack, verifyShopifyHmac };
