/*
 * db.js — Postgres (Neon) data layer for auth, users, and call logs.
 *
 * Uses `pg` only when DATABASE_URL is set, and lazy-requires it so the existing
 * dashboards still run locally with zero dependencies / no database.
 *   dbEnabled === false  → auth & calling features are inactive (local dev).
 *   dbEnabled === true   → full multi-user mode (hosted).
 */
const DATABASE_URL = process.env.DATABASE_URL || "";
let pool = null;
const dbEnabled = !!DATABASE_URL;

if (dbEnabled) {
  // eslint-disable-next-line global-require
  const { Pool } = require("pg");
  // Drop sslmode from the URL and set SSL explicitly (Neon uses TLS; this also
  // avoids pg's upcoming verify-full default).
  const cleanUrl = DATABASE_URL.replace(/[?&]sslmode=[^&]+/i, "");
  pool = new Pool({
    connectionString: cleanUrl,
    ssl: cleanUrl.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

async function q(text, params) {
  if (!pool) throw new Error("Database not configured (DATABASE_URL missing).");
  return pool.query(text, params);
}

const MODULES = ["delivery", "unit", "calling", "users"]; // "users" = user-management (admin only)

async function init() {
  if (!dbEnabled) return;
  await q(`CREATE TABLE IF NOT EXISTS users (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    email        TEXT UNIQUE NOT NULL,
    phone        TEXT NOT NULL DEFAULT '',
    role         TEXT NOT NULL DEFAULT 'user',         -- 'admin' | 'user'
    modules      JSONB NOT NULL DEFAULT '[]'::jsonb,    -- enabled module keys
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS otp_codes (
    id          BIGSERIAL PRIMARY KEY,
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS call_attempts (
    id            BIGSERIAL PRIMARY KEY,
    order_number  TEXT NOT NULL,
    caller_id     BIGINT,
    caller_name   TEXT NOT NULL DEFAULT '',
    outcome       TEXT NOT NULL DEFAULT '',     -- 'no_answer' | 'confirmed' | 'cancelled' | 'address_updated' | 'skipped'
    notes         TEXT NOT NULL DEFAULT '',
    at            TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS call_attempts_order_idx ON call_attempts(order_number)`);
  await q(`CREATE TABLE IF NOT EXISTS order_locks (
    order_number  TEXT PRIMARY KEY,
    caller_id     BIGINT,
    locked_until  TIMESTAMPTZ NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS order_actions (
    order_number  TEXT PRIMARY KEY,
    status        TEXT NOT NULL,                -- 'verified' | 'cancelled'
    caller_name   TEXT NOT NULL DEFAULT '',
    at            TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Shipment status pushed by NimbusPost webhooks (authoritative booking status).
  await q(`CREATE TABLE IF NOT EXISTS nimbus_shipments (
    ref           TEXT PRIMARY KEY,             -- awb, else 'ord:<order_number>'
    order_number  TEXT,
    awb           TEXT,
    status        TEXT NOT NULL DEFAULT '',
    raw           JSONB,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS nimbus_order_idx ON nimbus_shipments(order_number)`);
  // Scheduled callbacks ("call later") — order hidden from the queue until callback_at.
  await q(`CREATE TABLE IF NOT EXISTS order_callbacks (
    order_number  TEXT PRIMARY KEY,
    callback_at   TIMESTAMPTZ NOT NULL,
    reason        TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    caller_name   TEXT NOT NULL DEFAULT '',
    at            TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Exotel call records (recording + duration captured from the status webhook).
  await q(`CREATE TABLE IF NOT EXISTS call_logs (
    call_sid       TEXT PRIMARY KEY,
    order_number   TEXT,
    caller_id      BIGINT,
    caller_name    TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT '',
    recording_url  TEXT NOT NULL DEFAULT '',
    duration       INT NOT NULL DEFAULT 0,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS call_logs_order_idx ON call_logs(order_number)`);
  // Pincode serviceability list (caller/admin-maintained). serviceable=false flags an order.
  await q(`CREATE TABLE IF NOT EXISTS pincodes (
    pincode      TEXT PRIMARY KEY,
    serviceable  BOOLEAN NOT NULL DEFAULT TRUE,
    note         TEXT NOT NULL DEFAULT '',
    updated_by   TEXT NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  // Seed the admin from env ADMIN_EMAIL (full access). Safe to run repeatedly.
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (adminEmail) {
    await q(
      `INSERT INTO users (name, email, phone, role, modules, active)
       VALUES ($1,$2,'','admin',$3,TRUE)
       ON CONFLICT (email) DO UPDATE SET role='admin', modules=$3, active=TRUE`,
      [process.env.ADMIN_NAME || "Admin", adminEmail, JSON.stringify(MODULES)]
    );
  }
}

/* ---- users ---- */
const norm = (e) => String(e || "").trim().toLowerCase();
async function getUserByEmail(email) {
  const r = await q(`SELECT * FROM users WHERE email=$1`, [norm(email)]);
  return r.rows[0] || null;
}
async function getUserById(id) {
  const r = await q(`SELECT * FROM users WHERE id=$1`, [id]);
  return r.rows[0] || null;
}
async function listUsers() {
  const r = await q(`SELECT id,name,email,phone,role,modules,active,created_at FROM users ORDER BY created_at`);
  return r.rows;
}
async function createUser({ name, email, phone, role = "user", modules = [] }) {
  const r = await q(
    `INSERT INTO users (name,email,phone,role,modules) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET name=$1, phone=$3, role=$4, modules=$5, active=TRUE
     RETURNING *`,
    [name || "", norm(email), phone || "", role, JSON.stringify(modules)]
  );
  return r.rows[0];
}
async function updateUser(id, { name, phone, role, modules, active }) {
  const r = await q(
    `UPDATE users SET
       name=COALESCE($2,name), phone=COALESCE($3,phone), role=COALESCE($4,role),
       modules=COALESCE($5,modules), active=COALESCE($6,active)
     WHERE id=$1 RETURNING *`,
    [id, name ?? null, phone ?? null, role ?? null, modules ? JSON.stringify(modules) : null, active ?? null]
  );
  return r.rows[0];
}

/* ---- otp ---- */
async function saveOtp(email, codeHash, expiresAt) {
  await q(`DELETE FROM otp_codes WHERE email=$1`, [norm(email)]);
  await q(`INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1,$2,$3)`, [norm(email), codeHash, expiresAt]);
}
async function getOtp(email) {
  const r = await q(`SELECT * FROM otp_codes WHERE email=$1 ORDER BY created_at DESC LIMIT 1`, [norm(email)]);
  return r.rows[0] || null;
}
async function bumpOtpAttempts(id) { await q(`UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1`, [id]); }
async function clearOtp(email) { await q(`DELETE FROM otp_codes WHERE email=$1`, [norm(email)]); }

/* ---- sessions ---- */
async function createSession(id, userId, expiresAt) {
  await q(`INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2,$3)`, [id, userId, expiresAt]);
}
async function getSession(id) {
  const r = await q(
    `SELECT s.*, u.id AS uid, u.name, u.email, u.phone, u.role, u.modules, u.active
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id=$1 AND s.expires_at > now()`, [id]
  );
  return r.rows[0] || null;
}
async function deleteSession(id) { await q(`DELETE FROM sessions WHERE id=$1`, [id]); }

/* ---- calling ---- */
async function logAttempt({ orderNumber, callerId, callerName, outcome, notes }) {
  await q(`INSERT INTO call_attempts (order_number,caller_id,caller_name,outcome,notes) VALUES ($1,$2,$3,$4,$5)`,
    [orderNumber, callerId || null, callerName || "", outcome || "", notes || ""]);
}
async function attemptsByOrder(orderNumbers) {
  if (!orderNumbers.length) return {};
  const r = await q(`SELECT order_number, at, caller_name, outcome FROM call_attempts WHERE order_number = ANY($1)`, [orderNumbers]);
  const map = {};
  for (const row of r.rows) (map[row.order_number] = map[row.order_number] || []).push({ at: row.at, caller: row.caller_name, outcome: row.outcome });
  return map;
}
async function lockOrder(orderNumber, callerId, untilISO) {
  await q(`INSERT INTO order_locks (order_number,caller_id,locked_until) VALUES ($1,$2,$3)
           ON CONFLICT (order_number) DO UPDATE SET caller_id=$2, locked_until=$3`, [orderNumber, callerId || null, untilISO]);
}
// Atomically claim an order for a caller. Succeeds only if it is free, the lock
// has expired, or it is already this caller's. This is the guarantee that two
// callers can never be shown the same order, at any team size.
async function claimOrder(orderNumber, callerId, untilISO) {
  const r = await q(
    `INSERT INTO order_locks (order_number, caller_id, locked_until)
     VALUES ($1,$2,$3)
     ON CONFLICT (order_number) DO UPDATE SET caller_id=$2, locked_until=$3
       WHERE order_locks.locked_until < now() OR order_locks.caller_id = $2
     RETURNING order_number`,
    [orderNumber, callerId || null, untilISO]
  );
  return r.rowCount > 0;
}
// Release every order this caller is holding (except an optional one to keep),
// so each caller holds at most one live order.
async function releaseCallerLocks(callerId, exceptOrder) {
  await q(`DELETE FROM order_locks WHERE caller_id=$1 AND order_number <> COALESCE($2,'')`, [callerId, exceptOrder || null]);
}
async function activeLocks() {
  const r = await q(`SELECT order_number, caller_id, locked_until FROM order_locks WHERE locked_until > now()`);
  return r.rows;
}
// How many distinct callers are actively holding an order right now (team-online gauge).
async function onlineCallers() {
  const r = await q(`SELECT COUNT(DISTINCT caller_id) AS n FROM order_locks WHERE locked_until > now() AND caller_id IS NOT NULL`);
  return Number(r.rows[0] && r.rows[0].n) || 0;
}
async function setAction(orderNumber, status, callerName) {
  await q(`INSERT INTO order_actions (order_number,status,caller_name) VALUES ($1,$2,$3)
           ON CONFLICT (order_number) DO UPDATE SET status=$2, caller_name=$3, at=now()`, [orderNumber, status, callerName || ""]);
}
async function allActions() {
  const r = await q(`SELECT order_number, status, caller_name, at FROM order_actions`);
  const map = {};
  for (const row of r.rows) map[row.order_number] = row;
  return map;
}

/* ---- NimbusPost shipment status (from webhooks) ---- */
async function upsertNimbusShipment({ awb, orderNumber, status, raw }) {
  const ref = awb || (orderNumber ? "ord:" + orderNumber : null);
  if (!ref) return;
  await q(
    `INSERT INTO nimbus_shipments (ref, order_number, awb, status, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (ref) DO UPDATE SET order_number=COALESCE($2,nimbus_shipments.order_number),
       awb=COALESCE($3,nimbus_shipments.awb), status=$4, raw=$5, updated_at=now()`,
    [ref, orderNumber || null, awb || null, String(status || ""), raw ? JSON.stringify(raw) : null]
  );
}
// A caller's attempts so far today (for the performance strip).
async function callerDayAttempts(callerId) {
  const r = await q(`SELECT outcome, at FROM call_attempts WHERE caller_id=$1 AND at >= date_trunc('day', now()) ORDER BY at`, [callerId]);
  return r.rows;
}
// Recent NimbusPost webhook events (admin debug).
async function recentNimbus(limit) {
  const r = await q(`SELECT order_number, awb, status, updated_at FROM nimbus_shipments ORDER BY updated_at DESC LIMIT $1`, [limit || 50]);
  return r.rows;
}
// Map DIGITS-ONLY order number -> { status, awb }, latest event per order.
// NimbusPost sends references like "kk2468"; Shopify uses "#2468" — matching on
// the numeric part makes them line up regardless of prefix.
async function nimbusByOrder() {
  const r = await q(`SELECT DISTINCT ON (order_number) order_number, status, awb
                     FROM nimbus_shipments WHERE order_number IS NOT NULL
                     ORDER BY order_number, updated_at DESC`);
  const map = {};
  for (const row of r.rows) {
    const key = String(row.order_number).replace(/[^0-9]/g, "");
    if (key) map[key] = { status: row.status, awb: row.awb, ref: row.order_number };
  }
  return map;
}

/* ---- callbacks ("call later") ---- */
async function setCallback(orderNumber, callbackAtISO, reason, note, callerName) {
  await q(`INSERT INTO order_callbacks (order_number, callback_at, reason, note, caller_name)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (order_number) DO UPDATE SET callback_at=$2, reason=$3, note=$4, caller_name=$5, at=now()`,
    [orderNumber, callbackAtISO, reason || "", note || "", callerName || ""]);
}
async function clearCallback(orderNumber) { await q(`DELETE FROM order_callbacks WHERE order_number=$1`, [orderNumber]); }
// Orders whose callback time is still in the future → keep them out of the queue.
async function pendingCallbacks() {
  const r = await q(`SELECT order_number, callback_at, reason, caller_name FROM order_callbacks WHERE callback_at > now()`);
  const map = {};
  for (const row of r.rows) map[row.order_number] = { at: row.callback_at, reason: row.reason, caller: row.caller_name };
  return map;
}

/* ---- call logs (recording + duration) ---- */
async function startCallLog({ callSid, orderNumber, callerId, callerName }) {
  if (!callSid) return;
  await q(`INSERT INTO call_logs (call_sid, order_number, caller_id, caller_name, status)
           VALUES ($1,$2,$3,$4,'initiated')
           ON CONFLICT (call_sid) DO NOTHING`,
    [callSid, orderNumber || null, callerId || null, callerName || ""]);
}
async function updateCallLog({ callSid, status, recordingUrl, duration }) {
  if (!callSid) return;
  await q(`UPDATE call_logs SET
             status=COALESCE($2,status),
             recording_url=COALESCE(NULLIF($3,''),recording_url),
             duration=COALESCE($4,duration),
             updated_at=now()
           WHERE call_sid=$1`,
    [callSid, status || null, recordingUrl || "", (duration === undefined || duration === null) ? null : Number(duration) || 0]);
}
// Latest call for an order (for the card's "recorded · duration · link" line).
async function latestCallForOrder(orderNumber) {
  const r = await q(`SELECT call_sid, status, recording_url, duration, caller_name, started_at
                     FROM call_logs WHERE order_number=$1 ORDER BY started_at DESC LIMIT 1`, [orderNumber]);
  return r.rows[0] || null;
}

/* ---- pincode serviceability ---- */
async function getPincode(pin) {
  const p = String(pin || "").replace(/\D/g, "");
  if (!p) return null;
  const r = await q(`SELECT pincode, serviceable, note FROM pincodes WHERE pincode=$1`, [p]);
  return r.rows[0] || null;
}
async function setPincode(pin, serviceable, note, by) {
  const p = String(pin || "").replace(/\D/g, "");
  if (!p) return null;
  const r = await q(`INSERT INTO pincodes (pincode, serviceable, note, updated_by, updated_at)
                     VALUES ($1,$2,$3,$4, now())
                     ON CONFLICT (pincode) DO UPDATE SET serviceable=$2, note=$3, updated_by=$4, updated_at=now()
                     RETURNING pincode, serviceable, note`, [p, serviceable !== false, note || "", by || ""]);
  return r.rows[0];
}
async function listNonServiceable() {
  const r = await q(`SELECT pincode, note, updated_by, updated_at FROM pincodes WHERE serviceable=FALSE ORDER BY updated_at DESC`);
  return r.rows;
}

module.exports = {
  dbEnabled, MODULES, init, q,
  getUserByEmail, getUserById, listUsers, createUser, updateUser,
  saveOtp, getOtp, bumpOtpAttempts, clearOtp,
  createSession, getSession, deleteSession,
  logAttempt, attemptsByOrder, lockOrder, claimOrder, releaseCallerLocks, activeLocks, onlineCallers,
  setAction, allActions,
  upsertNimbusShipment, nimbusByOrder, callerDayAttempts, recentNimbus,
  setCallback, clearCallback, pendingCallbacks,
  startCallLog, updateCallLog, latestCallForOrder,
  getPincode, setPincode, listNonServiceable,
};
