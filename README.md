# KERAKING Control Center

A localhost control center for a D2C brand. It's built as a **multi-dashboard
shell** — the first dashboard is the **Delivery Matrix** (more can be added
alongside it). The Home tab shows just the brand logo; the nav switches between
dashboards.

The Delivery Matrix pulls live data from **Shopify** (orders, products,
variants, real selling prices, payment type, risk tags) and **NimbusPost**
(per-AWB status, couriers) and turns it into COD delivery intelligence.

**Theme.** Light by default (background `#F4F3EA`, black text, gold `#D4AF37`
accent, Montserrat) with a one-click dark mode (inverted). The logo is a
theme-adaptive SVG — to use the official KERAKING artwork instead, drop the PNGs
in `public/` and I can wire them in.

Nothing is hardcoded — brand name, products, variants and prices all come from
the APIs, so it works for any Shopify store.

---

## Run it

Requires **Node.js 18+** (no `npm install` — zero dependencies).

```bash
cd delivery-intelligence-dashboard
node server.js
```

Then open **http://localhost:4317**, click **⚙ Settings**, paste your
credentials, and hit **Save & refresh**. Until you do, the dashboard shows
sample data so the screen is never blank.

To change the port: `PORT=8080 node server.js`.

### Connecting Shopify (one-time, ~5 min)

As of 2026 Shopify **no longer issues paste-in Admin API tokens** — new apps live
in the **Dev Dashboard** and use OAuth. The dashboard does the OAuth handshake
for you, so you only need to create the app and click Connect.

1. Go to **https://dev.shopify.com/dashboard** and create an app (any name).
2. In the app's **Configuration / API access**, set Admin API scopes:
   `read_orders`, `read_products`, `read_fulfillments`. **Release** the change.
3. Add an **Allowed redirect URL** exactly equal to:
   `http://localhost:4317/auth/callback`
   (if you run on another port, use that port). This must match exactly.
4. Copy the app's **Client ID** and **Client Secret**.
5. In the dashboard → **⚙ Settings → Shopify**: enter your store domain,
   paste Client ID + Client Secret, and click **🔗 Connect Shopify**.
6. Shopify shows an approval screen — click **Install / Approve**. You're
   redirected back and the token is captured automatically. The status line
   should read **✓ Connected**.

### NimbusPost

Enter the **email + password** for your NimbusPost account in Settings. NimbusPost
is used to bulk-track the AWBs found on your Shopify orders.

### Where credentials live

NimbusPost email/password and your Shopify domain/Client ID/Secret are saved in
your browser's `localStorage`. The Shopify **access token** obtained via OAuth is
stored by the local server in `.credentials.json` in this folder — keep that file
private and don't commit or share it. Everything stays on your machine.

---

## How the CORS problem is solved

Browsers block direct calls from a localhost page to `api.nimbuspost.com` and to
the Shopify Admin API (Shopify forbids browser-side Admin calls entirely). So:

```
browser  ──(same-origin, no CORS)──>  local Node proxy  ──(server-to-server)──>  NimbusPost / Shopify
```

The page talks only to `http://localhost:4317` (same origin → no CORS). The
Node server (`server.js`) makes the real outbound API calls server-side, where
CORS does not apply, and returns normalized data. The NimbusPost login token is
cached in memory so refreshes don't re-login.

---

## Data flow (important)

NimbusPost's Partners API has **no "list all my shipments" endpoint** — it can
create/cancel/manifest shipments and **track a shipment by its AWB** (single or
bulk, up to 100 per call). So the dashboard assembles intelligence like this:

```
Shopify orders ──> line items (product / variant / real price)
               ──> fulfillments (AWB + Shopify's own delivery status, fallback)
               ──> payment type (COD vs prepaid)

NimbusPost     ──> bulk-track those AWBs for authoritative live status
                   (Delivered / RTO / In Transit / NDR), courier, attempts
```

Shopify is the **backbone** (it's the source of orders and AWBs); NimbusPost
**enriches status**. For NimbusPost tracking to work, your AWB/tracking numbers
must be on the Shopify orders' fulfillments — i.e. NimbusPost must be writing
tracking back to Shopify (its Shopify integration does this). If it isn't, the
dashboard still works using Shopify's own delivery status, but RTO detection is
weaker. If NimbusPost tracking fails, it falls back to Shopify status; if Shopify
fails entirely, it falls back to sample data.

## Architecture & files

```
delivery-intelligence-dashboard/
├── server.js              Zero-dependency proxy + static server. Pulls Shopify
│                          orders (the backbone), bulk-tracks their AWBs via
│                          NimbusPost for live status, NORMALIZES into one shape,
│                          and falls back to sample data if a call fails.
├── package.json
└── public/
    ├── index.html         Layout: header, scope switcher, metric cards,
    │                      variant price table, shipment log, settings drawer.
    ├── styles.css
    ├── sample-data.js     Shared sample dataset (used by server AND browser).
    ├── metrics.js         All the delivery math. Runs in the browser so manual
    │                      overrides recompute instantly.
    └── app.js             Controller: loads data, renders, wires up settings,
                           scope switching, overrides and the log filter.
```

The proxy returns one clean record shape; the browser does the joins and math.

---

## What the numbers mean

All COD metrics are computed at the **order level** (not per shipment), because
one order can produce several fulfillments and counting shipments would
double-count.

- **COD share · last 7 days (live).** Of orders placed in the rolling last 7
  days, the share that are COD vs prepaid. Cancelled orders excluded. Because
  this comes from your connected Shopify store, it already reflects only that
  store's channel (e.g. KeraKing) — no separate channel filter needed.

- **COD confirmation · closed 7-day window.** COD orders that actually got
  dispatched ÷ all COD orders, computed over the **most recent 7-day window in
  which no COD order is still open** (every COD order has either shipped or been
  cancelled). This deliberately skips the freshest days, where COD orders are
  still awaiting confirmation, so the ratio isn't understated. The window dates
  used are shown on the card.

- **COD FAD rate · 5–30 days, COD only** — with a **risk breakdown**:
  *delivered ÷ (delivered + RTO + exception + any other COD order with
  attempts > 0)*. COD orders that were never attempted (0 attempts) are
  excluded, which is what keeps the number from being artificially low. Shown
  overall and split by the order's risk tag: **low / high / very_high** (read
  from the Shopify order Tags field). Respects the product/variant scope.

**Average selling price per variant.** The mean price *actually paid* in Shopify
order history for that variant — not the listed price — so discounts and
promos are reflected.

> Closed rate and Shipment Multiple are intentionally not shown right now.

**Two kinds of date window — don't confuse them:**

- The **Shipment log window** (the "show last N days" box in Settings) controls
  *only* the shipment log at the bottom. Set it to 7 and the log shows exactly
  the last 7 days — nothing older leaks in.
- Each **metric card** uses its own fixed window, printed on the card (COD share
  = last 7 days, COD FAD = 5–30 days). These are independent of the log box.

Regardless of the log box, the server always loads at least 35 days of orders so
the 5–30 day FAD math and the COD-confirmation scan have enough data to be
correct.

**Predicted outcome (shipment log).** Each shipment gets a projected final state
from its current status + age (e.g. an in-transit parcel older than the FAD
window is flagged *Stuck → RTO risk*).

Every metric can be broken down three ways: **Blended** (all products), **per
product**, and **per variant** (Single, Pack of 2, …) using the actual variants
found in your Shopify orders. Click any row in the variant table to scope to it.

---

## Manual overrides (scenario modelling)

Every live metric card has an **override** input. Type a value (e.g. a target
FAD rate of `70`%) and the card switches to that number, shown in amber. Clear
the input to return to the live value. Overrides persist in `localStorage` so
you can model "what if my closed rate were X" against everything else live.

---

## Graceful degradation

The working source always stays live. If NimbusPost tracking fails, statuses
fall back to Shopify. If Shopify fails entirely, the page falls back to sample
data. If the proxy itself is unreachable, the page uses embedded sample data.
You never get a blank screen — and the banner always names what failed.

---

## Troubleshooting

The banner now shows the **real error text** from each API. Common cases:

- **"Shopify not connected"** — open Settings and click **Connect Shopify**.
- **Connection fails with "Could not verify the request signature"** — the
  Client Secret is wrong; re-copy it from the Dev Dashboard.
- **Shopify shows "redirect_uri is not whitelisted" / "invalid redirect"** — the
  Allowed redirect URL in your Dev Dashboard app must be **exactly**
  `http://localhost:4317/auth/callback` (same port you're running on).
- **`Shopify: orders HTTP 401`** after connecting — the token was revoked or the
  app uninstalled; click **Disconnect** then **Connect Shopify** again.
- **`Shopify: orders HTTP 403`** — the app is missing a scope; add `read_orders` /
  `read_products` / `read_fulfillments` in the Dev Dashboard, **Release**, then
  reconnect.
- **`NimbusPost: login ...`** — email/password rejected; verify them in the
  NimbusPost dashboard.
- **`NimbusPost: bulk track HTTP 4xx`** — the printed body says why; if your
  account's tracking response is shaped differently, adjust `normalizeTrack`
  in `server.js`.
- **"No AWB/tracking numbers found on Shopify fulfillments"** — NimbusPost isn't
  writing tracking back to your Shopify orders, so statuses come from Shopify
  only. Enable tracking writeback in the NimbusPost↔Shopify integration for full
  RTO detection.

---

## Notes / assumptions

- Shipments are joined to Shopify orders by **order number** (`#` stripped). A
  shipment is attributed to the **dominant line item** (highest quantity ×
  price) so one shipment equals one delivery outcome and counts aren't
  double-attributed.
- One shipment row is created **per Shopify fulfillment** (so RTO reships, which
  are separate fulfillments/AWBs, are counted naturally), plus one **Pending**
  row per order that has no fulfillment yet — that's what powers the COD
  confirmation ratio.
- Status classification is substring matching on the status text (`deliver`,
  `rto`/`return`, `lost`, `cancel`), robust to NimbusPost label changes.
- Payment type (COD vs prepaid) is detected from Shopify's
  `payment_gateway_names` / `financial_status`.
- History window defaults to 35 days (configurable in Settings). The proxy
  paginates Shopify until it has covered the window, then bulk-tracks AWBs in
  batches of 100.
