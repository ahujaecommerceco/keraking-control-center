/*
 * auth.js — passwordless email-OTP login + signed cookie sessions.
 *
 * Security model:
 *  - Only emails that an admin has pre-created as users can receive an OTP
 *    (no open signup). OTPs are 6 digits, hashed at rest, expire in 10 min,
 *    max 5 verify attempts, and rate-limited.
 *  - Sessions are random ids stored server-side (DB), referenced by a signed,
 *    httpOnly cookie. Every protected request is checked server-side, so the
 *    browser cannot grant itself rights.
 */
const crypto = require("crypto");
const db = require("./db.js");

const SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString("hex");
const FROM_EMAIL = process.env.RESEND_FROM || "KeraKing <onboarding@resend.dev>";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE = "kk_session";

/* ---- OTP ---- */
function genOtp() { return String(crypto.randomInt(0, 1000000)).padStart(6, "0"); }
function hashOtp(code, email) {
  return crypto.createHmac("sha256", SECRET).update(code + "|" + String(email).toLowerCase()).digest("hex");
}

async function sendOtpEmail(email, code) {
  if (!RESEND_API_KEY) { console.log(`[OTP] ${email} -> ${code} (RESEND_API_KEY not set; logging only)`); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_EMAIL, to: [email], subject: `Your KeraKing login code: ${code}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#141414">
        <p>Your KeraKing Control Center login code is:</p>
        <p style="font-size:30px;font-weight:700;letter-spacing:6px;color:#A8801C">${code}</p>
        <p style="color:#777">It expires in 10 minutes. If you didn't request this, ignore this email.</p></div>`,
    }),
  });
  if (!res.ok) throw new Error("Email send failed (HTTP " + res.status + ")");
}

// Returns { ok, error?, devCode? }. Only known, active users get an OTP.
async function requestOtp(email) {
  const user = await db.getUserByEmail(email);
  if (!user || !user.active) return { ok: true }; // don't reveal whether the email exists
  const recent = await db.getOtp(email);
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 45 * 1000) return { ok: true }; // rate limit
  const code = genOtp();
  await db.saveOtp(email, hashOtp(code, email), new Date(Date.now() + OTP_TTL_MS).toISOString());
  try { await sendOtpEmail(email, code); } catch (e) { if (!process.env.OTP_DEV) throw e; }
  // OTP_DEV=1 surfaces the code in the response for local testing (remove for prod).
  const dev = !RESEND_API_KEY || process.env.OTP_DEV === "1";
  return { ok: true, devCode: dev ? code : undefined };
}

async function verifyOtp(email, code) {
  const row = await db.getOtp(email);
  if (!row) return { ok: false, error: "Request a new code." };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: "Code expired." };
  if (row.attempts >= 5) return { ok: false, error: "Too many attempts. Request a new code." };
  if (hashOtp(String(code), email) !== row.code_hash) { await db.bumpOtpAttempts(row.id); return { ok: false, error: "Incorrect code." }; }
  await db.clearOtp(email);
  const user = await db.getUserByEmail(email);
  if (!user || !user.active) return { ok: false, error: "Account inactive." };
  const sid = crypto.randomBytes(24).toString("hex");
  await db.createSession(sid, user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return { ok: true, user, cookie: cookieHeader(sid) };
}

/* ---- signed cookie ---- */
function sign(sid) { return sid + "." + crypto.createHmac("sha256", SECRET).update(sid).digest("hex").slice(0, 24); }
function unsign(token) {
  if (!token || !token.includes(".")) return null;
  const sid = token.slice(0, token.indexOf("."));
  return sign(sid) === token ? sid : null;
}
function cookieHeader(sid, clear) {
  const base = `${COOKIE}=${clear ? "" : sign(sid)}; HttpOnly; Path=/; SameSite=Lax; Secure`;
  return clear ? base + "; Max-Age=0" : base + `; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("="); if (i < 0) return;
    out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

// Resolve the current user from the request cookie (or null).
async function currentUser(req) {
  const sid = unsign(parseCookies(req)[COOKIE]);
  if (!sid) return null;
  const s = await db.getSession(sid);
  if (!s) return null;
  return { id: s.uid, name: s.name, email: s.email, phone: s.phone, role: s.role,
    modules: Array.isArray(s.modules) ? s.modules : [], active: s.active, sid };
}
function canAccess(user, moduleKey) {
  if (!user || !user.active) return false;
  if (user.role === "admin") return true;
  return (user.modules || []).includes(moduleKey);
}
async function logout(req) {
  const sid = unsign(parseCookies(req)[COOKIE]);
  if (sid) await db.deleteSession(sid);
  return cookieHeader("", true);
}

module.exports = {
  requestOtp, verifyOtp, currentUser, canAccess, logout, cookieHeader, COOKIE,
  _internal: { genOtp, hashOtp, sign, unsign }, // exported for tests
};
