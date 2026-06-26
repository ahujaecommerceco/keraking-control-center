# Deploying KeraKing Control Center (Render + Neon, free)

Everything in the code is ready. These are the steps **you** do (account/website
actions I can't do for you). ~20–30 min. Database (Neon), email (Resend), and
Exotel are already set up — this just puts the app online.

---

## A. Add Shopify write access (one time)
The calling actions (Confirm/Cancel/Edit address) need write permission.
1. Open your Shopify **Dev Dashboard** app → API access / scopes.
2. Add **`write_orders`** (keep the existing read scopes) → **Release**.
(You'll re-connect Shopify in step F so the new token includes write access.)

---

## B. Put the code on GitHub
1. Create a free account at github.com → **New repository** → name it
   `keraking-control-center` → Private → Create.
2. On the repo page click **“uploading an existing file.”**
3. Drag in **everything in this folder EXCEPT these three** (do not upload them):
   - `node_modules/`  (Render rebuilds it)
   - `.env`  (secrets go in Render instead)
   - `.credentials.json`  (local only)
   Upload: `server.js, db.js, auth.js, loadenv.js, package.json,
   package-lock.json, render.yaml, README.md, the `public/` folder, the
   `calling/` folder`. GitHub keeps the folder structure when you drag folders.
4. Click **Commit changes.**

---

## C. Create the Render service
1. Sign up at render.com (use “Sign in with GitHub”).
2. **New → Blueprint** → pick your `keraking-control-center` repo.
   (Render reads `render.yaml` and sets up the web service automatically.)
3. It will ask for the environment variable **values** — fill them from step D.
4. Click **Apply / Create**. First build takes a few minutes.

---

## D. Environment variables (copy values from your local `.env`)
Open your `.env` file and copy each value into Render:

| Key | Value |
|-----|-------|
| `APP_SECRET` | (the long random string from `.env`) |
| `DATABASE_URL` | (your Neon `postgresql://…` string) |
| `RESEND_API_KEY` | `re_…` |
| `RESEND_FROM` | `KeraKing <otp@keraking.com>` |
| `ADMIN_EMAIL` | your admin login email |
| `ADMIN_NAME` | your name |
| `EXOTEL_SID` | `ahujaecommerceco1` |
| `EXOTEL_KEY` | (from `.env`) |
| `EXOTEL_TOKEN` | (from `.env`) |
| `EXOTEL_CALLER_ID` | your ExoPhone |
| `SHOPIFY_SHOP` | `vuu0g7-c1.myshopify.com` |
| `SHOPIFY_TOKEN` | leave blank for now — set in step F |

Do **not** set `OTP_DEV` (so codes only go by email).

---

## E. Point Shopify's redirect at the live URL
After the service is live you'll have a URL like
`https://keraking-control-center.onrender.com`.
1. In the Shopify **Dev Dashboard** app → add an **Allowed redirect URL**:
   `https://YOUR-RENDER-URL/auth/callback`
2. (Resend domain `keraking.com` is already verified — nothing to do.)

---

## F. First login + connect Shopify (write token)
1. Open your Render URL → sign in with `ADMIN_EMAIL` (OTP arrives by email).
2. Home → **Connect Shopify** → approve. The success page prints
   `SHOPIFY_SHOP=…` and `SHOPIFY_TOKEN=shpat_…` (now write-enabled).
3. Copy that `SHOPIFY_TOKEN` into Render → Environment → `SHOPIFY_TOKEN` → Save.
   (Render free has no persistent disk, so storing the token as an env var keeps
   you connected across restarts.) Render redeploys automatically.

---

## G. Final setup + test
1. **User Management** → set your **phone number** (needed for the call's agent leg).
   Add your telecallers (name/email/phone) and tick the **Calling** module.
2. Run the test checklist: login → Calling shows un-booked COD orders → Call
   (your phone rings, then customer) → Confirm adds the `Verified` tag in Shopify.

### Keep it awake (optional, free)
Render's free service sleeps after 15 min idle (first hit ~1 min). Add a free
**UptimeRobot** HTTP monitor hitting `https://YOUR-RENDER-URL/login.html` every
5 min during work hours to keep it warm (and to reliably receive Exotel/webhook
callbacks). Or upgrade to Render Starter (~$7/mo) for always-on.
