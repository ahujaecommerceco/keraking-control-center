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
async function activeLocks() {
  const r = await q(`SELECT order_number, caller_id, locked_until FROM order_locks WHERE locked_until > now()`);
  return r.rows;
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
// Map order_number -> { status, awb } using the latest event per order.
async function nimbusByOrder() {
  const r = await q(`SELECT DISTINCT ON (order_number) order_number, status, awb
                     FROM nimbus_shipments WHERE order_number IS NOT NULL
                     ORDER BY order_number, updated_at DESC`);
  const map = {};
  for (const row of r.rows) map[row.order_number] = { status: row.status, awb: row.awb };
  return map;
}

module.exports = {
  dbEnabled, MODULES, init, q,
  getUserByEmail, getUserById, listUsers, createUser, updateUser,
  saveOtp, getOtp, bumpOtpAttempts, clearOtp,
  createSession, getSession, deleteSession,
  logAttempt, attemptsByOrder, lockOrder, activeLocks, setAction, allActions,
  upsertNimbusShipment, nimbusByOrder,
};
