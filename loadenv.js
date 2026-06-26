/*
 * loadenv.js — tiny zero-dependency .env loader.
 * Require this FIRST (before db.js / auth.js) so process.env is populated.
 * Lines are KEY=VALUE; blank lines and # comments are ignored. Existing
 * environment variables (e.g. set by the host) always win.
 */
const fs = require("fs");
const path = require("path");
try {
  const file = path.join(__dirname, ".env");
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch (_) { /* no .env file — rely on real environment variables */ }
