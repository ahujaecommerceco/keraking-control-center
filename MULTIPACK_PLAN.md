# Multipack Unit Economics — Plan

The single-SKU analyser is built. This is the plan to extend it to packs
(Single, Pack of 2/3/4 …) with pack-specific discounts and pack-specific
delivery/confirmation/COD ratios pulled from live data, then blend into an AOV
and a breakeven margin per order.

## What we already have to build on
- **Variants from Shopify** — `buildCatalog()` gives every variant with its
  **real average selling price** and order count.
- **Per-variant funnel** — `computeAll(scope = {variant})` already returns COD
  share, COD confirmation and COD FAD **for that variant**. So each pack can
  carry its own order multiple.
- **Per-delivered cost engine** — `computeUnitEcon()` already turns a price +
  cost set + funnel into margins and GST. We reuse it per variant.

## New inputs needed (per variant, mostly auto-derived)
1. **Pack size N** — parsed from the variant title ("Pack of 3" → 3; "Single" → 1).
2. **Product cost** = single-unit cost × N (single-unit cost stays one global input).
3. **Selling price** — two modes:
   - *Live*: the variant's real average selling price (discount already baked in).
   - *Modelled*: single SP × N × (1 − pack discount %) — a per-pack discount input
     for scenario planning.
4. **Shipping/RTO by weight** — heavier packs can sit in a higher courier weight
   slab. Optional per-pack shipping/RTO override; default = the single-SKU value.
5. **Funnel** — per-variant COD%, confirmation, FAD from live (with override),
   giving each pack its **own order multiple** = 1 ÷ (COD% × conf% × deliv%).

## Computation
- Run the existing `computeUnitEcon()` per variant with that variant's SP,
  product cost (×N), shipping, and funnel → per-pack contribution margin,
  margin %, order multiple, and breakeven margin per order placed.
- **Blended AOV** = Σ(variant SP × delivered-volume weight) ÷ Σ(weights), where
  the weight is each variant's share of delivered orders (from order counts ×
  its delivery rate).
- **Blended breakeven margin per order** = Σ(variant margin/delivered ÷ variant
  multiple × weight) ÷ Σ(weights) — i.e. each pack's "per order placed" margin,
  volume-weighted.
- **GST** rolls up the same way (output/input per variant → blended).

## UI
- A **per-pack table**: one column per variant (Single / Pack of 2 / 3 / 4) and
  a Blended column — rows for SP, units, order multiple, cost lines, contribution
  margin, margin %, breakeven/order.
- A **price-mode toggle** (live avg price vs single + pack discount).
- Reuse the existing product/variant scope idea so the analyser can be filtered
  to one product's packs.

## Open questions to confirm before building
1. Single-unit **product cost** — one global value, or different per product?
2. Does **shipping cost change by pack weight**? If yes, we add per-pack shipping.
3. For blending volume weights — use **delivered** orders (recommended) or
   **placed** orders?
4. Pack **discount source** — always read from live avg price, or do you want the
   modelled "single × N × (1 − disc%)" mode as the default for planning?
