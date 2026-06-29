/*
 * app.js — KERAKING Control Center controller.
 * Loads data from the local proxy (/api/data), renders the Delivery Matrix and
 * Unit Economics Analyser, and keeps connections/setup on the Home page.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const LS = {
    creds: "dind.creds.v1",
    theme: "dind.theme.v1",
    view: "dind.view.v1",
    windows: "dind.windows.v1",
    unit: "dind.unit.v2",     // map: variantId -> input set
    cb: "dind.cb.v1",         // courier breakdown filters
    perf: "dind.perf.v1",     // performance section filters
  };

  function loadJSON(key, dflt) {
    try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch { return dflt; }
  }
  function saveJSON(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

  // Credentials/defaults live SERVER-SIDE (never in browser JS). The home form
  // is only for overrides; blank fields mean "use the server's KeraKing default".
  function getCreds() { return loadJSON(LS.creds, {}); }

  const state = {
    raw: null, enriched: [], orderRecs: [], catalog: [],
    scope: { level: "blended" },
    windows: null,
    cb: Object.assign({ courier: "all", risk: "all", payment: "all", delay: "all", text: "" }, loadJSON(LS.cb, {})),
    vSort: { key: "price", dir: 1 },
    cbSort: { key: "orders", dir: -1 },
    ueVariant: "_blended",
    perfOptions: { payment: [], risk: [], courier: [], product: [], variant: [] },
    perf: null,
    now: Date.now(),
  };

  const PERF = {
    daily:   { group: "day",     groupLabel: "Day",     hide: [] },
    state:   { group: "state",   groupLabel: "State",   hide: [] },
    varprod: { group: "variant", groupLabel: "Variant", hide: [], toggle: true },
    zone:    { group: "zone",    groupLabel: "Zone",    hide: [] },
  };
  function defPerf(extra) {
    const t = new Date(), iso = (d) => d.toISOString().slice(0, 10);
    return Object.assign({ payment: "all", risk: "all", product: "all", variant: "all", courier: "all",
      from: iso(new Date(t.getTime() - 30 * 86400000)), to: iso(t), sort: { key: "total", dir: -1 } }, extra || {});
  }
  function initPerf() {
    const saved = loadJSON(LS.perf, {});
    state.perf = {
      ndr: saved.ndr || defPerf({ sort: { key: "count", dir: -1 } }),
      daily: saved.daily || defPerf({ sort: { key: "key", dir: -1 } }),
      state: saved.state || defPerf(),
      varprod: saved.varprod || defPerf({ group: "variant" }),
      zone: saved.zone || defPerf(),
    };
  }

  const fmtPct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
  const fmtMoney = (x) => (x == null ? "—" : "₹" + Math.round(x).toLocaleString("en-IN"));

  /* ---------------- windows (date-based) ---------------- */
  function effectiveWindows() {
    const def = window.Metrics.defaultWindows(state.now);
    const saved = loadJSON(LS.windows, {});
    return {
      split: saved.split || def.split,
      confirm: saved.confirm || def.confirm,
      fad: saved.fad || def.fad,
    };
  }
  function setWindow(key, field, val) {
    const saved = loadJSON(LS.windows, {});
    saved[key] = Object.assign({}, state.windows[key], { [field]: val });
    saveJSON(LS.windows, saved);
    state.windows[key] = saved[key];
    renderCards();
  }

  /* ---------------- data loading ---------------- */
  async function loadData() {
    setBadge("loading");
    const c = getCreds();
    const body = {
      nimbus: { email: c.npEmail || "", password: c.npPassword || "" },
      shopify: { shop: c.shShop || "" }, // token is server-side after OAuth
      days: 90,
    };
    let data;
    try {
      const res = await fetch("/api/data", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      data = await res.json();
    } catch (e) {
      const s = window.SampleData.generate();
      data = { source: "sample", brand: s.brand, shipments: s.shipments, orders: s.orders,
        errors: ["Could not reach the proxy — showing sample data."], asOf: s.asOf };
    }
    applyData(data);
  }

  function applyData(data) {
    state.raw = data;
    state.now = Date.now();
    state.windows = effectiveWindows();
    state.enriched = window.Metrics.enrich(data.shipments || [], data.orders || []);
    state.orderRecs = window.Metrics.buildOrderRecords(data.shipments || [], data.orders || [], state.now);
    state.catalog = window.Metrics.buildCatalog(data.orders || []);
    state.perfOptions = window.Metrics.perfOptions(state.enriched);
    if (state.scope.level === "product" && !state.catalog.some((p) => p.productId === state.scope.productId)) state.scope = { level: "blended" };
    renderAll();
  }

  /* ---------------- header / banner ---------------- */
  function setBadge(kind) { const el = $("sourceBadge"); el.className = "badge " + kind; el.textContent = kind; }
  function renderHeader() {
    const d = state.raw;
    $("brandName").textContent = d.brand || "Delivery Matrix";
    $("brandSub").textContent = `${state.enriched.length} shipments · updated ${new Date(d.asOf).toLocaleString()}`;
    setBadge(d.source);
    const banner = $("banner"); const msgs = [];
    if (d.source === "sample") msgs.push("Showing sample data — add connections on the Home page to go live.");
    else if (d.source === "partial") msgs.push("Partial live data — one source fell back to sample.");
    if (d.errors && d.errors.length) msgs.push(d.errors.join("  ·  "));
    if (msgs.length) { banner.classList.remove("hidden"); banner.textContent = msgs.join("   "); } else banner.classList.add("hidden");
    $("footStamp").textContent = `Source: ${d.source} · as of ${new Date(d.asOf).toLocaleString()}`;
  }

  /* ---------------- scope switcher ---------------- */
  function renderScopeControls() {
    const ps = $("productSelect"), vs = $("variantSelect");
    ps.innerHTML = ""; ps.add(new Option("All products (blended)", "_blended"));
    state.catalog.forEach((p) => ps.add(new Option(p.product, p.productId)));
    ps.value = state.scope.level === "blended" ? "_blended" : state.scope.productId;
    vs.innerHTML = "";
    if (state.scope.level === "blended") { vs.classList.add("hidden"); return; }
    vs.classList.remove("hidden");
    const prod = state.catalog.find((p) => p.productId === state.scope.productId);
    vs.add(new Option("All variants", "_all"));
    (prod ? prod.variants : []).forEach((v) => vs.add(new Option(`${v.variant} · ${fmtMoney(v.avgPrice)}`, v.variantId)));
    vs.value = state.scope.level === "variant" ? state.scope.variantId : "_all";
  }
  function onProductChange() {
    const v = $("productSelect").value;
    state.scope = v === "_blended" ? { level: "blended" } : { level: "product", productId: v };
    renderAll();
  }
  function onVariantChange() {
    const v = $("variantSelect").value;
    state.scope = v === "_all" ? { level: "product", productId: state.scope.productId } : { level: "variant", productId: state.scope.productId, variantId: v };
    renderAll();
  }

  /* ---------------- metric cards ---------------- */
  function deltaBadge(cur, prev, goodUp) {
    if (cur == null || prev == null) return `<span class="delta muted">— no prior period</span>`;
    const d = (cur - prev) * 100;
    const arrow = d > 0.05 ? "▲" : d < -0.05 ? "▼" : "▬";
    let cls = "muted";
    if (goodUp !== null && Math.abs(d) >= 0.05) cls = (d > 0) === goodUp ? "good" : "bad";
    return `<span class="delta ${cls}">${arrow} ${d > 0 ? "+" : ""}${d.toFixed(1)} pp <span class="muted">vs ${fmtPct(prev)} prior</span></span>`;
  }
  function rangeRow(key, win) {
    return `<div class="range-row">
      <span class="range-label">From</span><input type="date" value="${win.from}" data-win="${key}" data-f="from" />
      <span class="range-label">to</span><input type="date" value="${win.to}" data-win="${key}" data-f="to" />
    </div>`;
  }
  function card(opts) {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
      <div class="label">${opts.label}</div>
      <div class="value">${opts.value}</div>
      ${opts.deltaHTML || ""}
      ${opts.extraHTML || ""}
      ${opts.rangeHTML || ""}
      <div class="detail">${opts.detail || ""}</div>`;
    return div;
  }

  function renderCards() {
    const m = window.Metrics.computeAll(state.orderRecs, state.scope, state.now, state.windows);
    const wrap = $("cards"); wrap.innerHTML = "";
    $("scopeCount").textContent = `${m.scopeCount} orders in scope`;

    const sp = m.split.cur, spp = m.split.prev, codPct = sp.codShare, ppPct = sp.prepaidShare;
    wrap.appendChild(card({
      label: "COD share", value: fmtPct(codPct) + " COD",
      deltaHTML: deltaBadge(codPct, spp.codShare, null),
      extraHTML: `<div class="bar"><span class="seg-cod" style="width:${(codPct || 0) * 100}%"></span><span class="seg-prepaid" style="width:${(ppPct || 0) * 100}%"></span></div>
        <div class="sub-metrics"><div><div class="v tag-cod">${sp.cod}</div><div class="detail">COD</div></div><div><div class="v tag-prepaid">${sp.prepaid}</div><div class="detail">Prepaid</div></div></div>`,
      rangeHTML: rangeRow("split", m.split.win),
      detail: `${sp.total} orders in window · prior ${spp.total} · by order date`,
    }));

    const cc = m.codConfirm.cur, ccp = m.codConfirm.prev;
    wrap.appendChild(card({
      label: "COD confirmation", value: fmtPct(cc.rate),
      deltaHTML: deltaBadge(cc.rate, ccp.rate, true),
      detail: `${cc.shipped} of ${cc.total} COD dispatched · ${cc.open} open · ${cc.cancelled} cancelled · by order date`,
      rangeHTML: rangeRow("confirm", m.codConfirm.win),
    }));

    const f = m.codFad.cur, fp = m.codFad.prev;
    const riskRow = (label, r) => `<div class="risk-row"><span class="risk-label ${label}">${label.replace("_", " ")}</span><span class="risk-val">${fmtPct(r.rate)}</span><span class="risk-det">${r.delivered}/${r.denom}</span></div>`;
    wrap.appendChild(card({
      label: "COD FAD rate", value: fmtPct(f.rate),
      deltaHTML: deltaBadge(f.rate, fp.rate, true),
      extraHTML: `<div class="risk-breakdown"><div class="risk-row risk-head"><span></span><span>FAD</span><span>n</span></div>${riskRow("low", f.byRisk.low)}${riskRow("high", f.byRisk.high)}${riskRow("very_high", f.byRisk.very_high)}</div>`,
      rangeHTML: rangeRow("fad", m.codFad.win),
      detail: `${f.delivered} delivered ÷ ${f.denom} · RTO ${f.rto} · other-attempted (counted as RTO) ${f.others} · 0-attempt in-transit excluded · by shipment-creation date`,
    }));

    wrap.querySelectorAll("input[data-win]").forEach((inp) =>
      inp.addEventListener("change", (e) => setWindow(e.target.dataset.win, e.target.dataset.f, e.target.value)));
  }

  /* ---------------- per-variant table (header-click sort) ---------------- */
  function renderVariantTable() {
    const tb = $("variantTable").querySelector("tbody"); tb.innerHTML = "";
    const rows = [];
    state.catalog.forEach((p) => p.variants.forEach((v) => {
      const m = window.Metrics.computeAll(state.orderRecs, { level: "variant", variantId: v.variantId }, state.now, state.windows);
      rows.push({ p, v, name: p.product + " " + v.variant, variant: v.variant, price: v.avgPrice, orders: v.orderCount, cod: m.split.cur.codShare, fad: m.codFad.cur.rate, denom: m.codFad.cur.denom });
    }));
    sortRows(rows, state.vSort);
    markSortHeaders("variantTable", state.vSort);
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.p.product}</td><td>${r.v.variant}</td><td class="num">${fmtMoney(r.v.avgPrice)}</td><td class="num">${r.v.orderCount}</td><td class="num">${fmtPct(r.cod)}</td><td class="num">${fmtPct(r.fad)}</td><td class="num">${r.denom}</td>`;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => { state.scope = { level: "variant", productId: r.p.productId, variantId: r.v.variantId }; renderAll(); window.scrollTo({ top: 0, behavior: "smooth" }); });
      tb.appendChild(tr);
    });
    if (!rows.length) tb.innerHTML = `<tr><td colspan="7" class="muted" style="padding:18px">No variants in data.</td></tr>`;
  }

  // Generic sort + header indicators (shared by both tables).
  function sortRows(rows, sort) {
    const { key, dir } = sort;
    rows.sort((a, b) => {
      let x = a[key], y = b[key];
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * dir;
      x = x == null ? -Infinity : x; y = y == null ? -Infinity : y;
      return (x - y) * dir;
    });
  }
  function markSortHeaders(tableId, sort) {
    document.querySelectorAll(`#${tableId} thead th.sortable`).forEach((th) => {
      th.classList.toggle("sorted", th.dataset.k === sort.key);
      th.dataset.dir = th.dataset.k === sort.key ? (sort.dir < 0 ? "desc" : "asc") : "";
    });
  }
  const TEXT_KEYS = ["courier", "risk", "payment", "delay", "name", "variant", "key", "reason"];
  function toggleSort(sort, key) {
    if (sort.key === key) sort.dir = -sort.dir;
    else { sort.key = key; sort.dir = TEXT_KEYS.includes(key) ? 1 : -1; }
  }

  /* ---------------- delivery by courier · risk · payment ---------------- */
  function fillSelect(el, values, current) {
    el.innerHTML = "";
    el.add(new Option("All", "all"));
    values.forEach((v) => el.add(new Option(v.replace("_", " "), v)));
    el.value = current && (current === "all" || values.includes(current)) ? current : "all";
  }
  function renderCourierTable() {
    const res = window.Metrics.deliveryBreakdown(state.enriched, state.scope, state.now, state.cb);
    fillSelect($("cbCourier"), res.options.courier, state.cb.courier);
    fillSelect($("cbRisk"), res.options.risk, state.cb.risk);
    fillSelect($("cbPayment"), res.options.payment, state.cb.payment);
    fillSelect($("cbDelay"), res.options.delay, state.cb.delay);
    const q = (state.cb.text || "").toLowerCase();
    const rows = res.rows.filter((r) => !q || `${r.courier} ${r.risk} ${r.payment} ${r.delay}`.toLowerCase().includes(q));
    sortRows(rows, state.cbSort);
    markSortHeaders("courierTable", state.cbSort);
    const delayCell = (d) => {
      if (d === "yes") return `<span class="pill bad">Yes</span>`;
      if (d === "no") return `<span class="pill good">No</span>`;
      if (d === "unknown") return `<span class="pill muted">unknown</span>`;
      return `<span class="muted">${d}</span>`;
    };
    const tb = $("courierTable").querySelector("tbody"); tb.innerHTML = "";
    const rowHtml = (r, t) => `<tr class="${t ? "total-row" : ""}"><td>${r.courier}</td><td>${(r.risk || "").replace("_", " ")}</td><td>${(r.payment || "").toUpperCase()}</td><td>${delayCell(r.delay)}</td><td class="num">${r.orders}</td><td class="num">${fmtPct(r.fadRate)}</td><td class="num">${r.fadDenom}</td></tr>`;
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="7" class="muted" style="padding:18px">No dispatched shipments match.</td></tr>`; return; }
    tb.innerHTML = rows.map((r) => rowHtml(r, false)).join("") + rowHtml(res.total, true);
  }

  /* ---------------- performance sections (generic) ---------------- */
  function panelOf(id) { return document.querySelector(`[data-perf="${id}"]`); }
  function ctlSelect(key, label, opts, cur) {
    return `<div class="scope-group"><label>${label}</label><select data-pf="${key}">` +
      `<option value="all"${!cur || cur === "all" ? " selected" : ""}>All</option>` +
      opts.map(([v, l]) => `<option value="${v}"${cur === v ? " selected" : ""}>${l}</option>`).join("") +
      `</select></div>`;
  }
  function perfControls(id) {
    const sec = id === "ndr" ? { hide: [] } : PERF[id];
    const st = state.perf[id], o = state.perfOptions;
    const groupNow = sec.toggle ? st.group : sec.group;
    const hide = new Set(sec.hide || []);
    if (sec.toggle) hide.add(groupNow === "product" ? "product" : "variant");
    let html = "";
    if (sec.toggle) html += `<div class="scope-group"><label>Group by</label><select data-pf="group"><option value="variant"${groupNow === "variant" ? " selected" : ""}>Variant</option><option value="product"${groupNow === "product" ? " selected" : ""}>Product</option></select></div>`;
    const dims = [
      ["payment", "Payment", o.payment.map((v) => [v, v.toUpperCase()])],
      ["risk", "Risk", o.risk.map((v) => [v, v.replace("_", " ")])],
      ["product", "Product", o.product.map((x) => [x.id, x.label])],
      ["variant", "Variant", o.variant.map((x) => [x.id, x.label])],
      ["courier", "Courier", o.courier.map((v) => [v, v])],
    ];
    for (const [k, lbl, opts] of dims) if (!hide.has(k)) html += ctlSelect(k, lbl, opts, st[k]);
    html += `<div class="scope-group"><label>From</label><input type="date" data-pf="from" value="${st.from || ""}"></div>`;
    html += `<div class="scope-group"><label>To</label><input type="date" data-pf="to" value="${st.to || ""}"></div>`;
    panelOf(id).querySelector(".perf-ctl").innerHTML = html;
  }
  function renderPerf(id) {
    perfControls(id);
    if (id === "ndr") return renderNdr();
    const sec = PERF[id], st = state.perf[id];
    const groupNow = sec.toggle ? st.group : sec.group;
    const res = window.Metrics.performanceBreakdown(state.enriched, groupNow, st);
    sortRows(res.rows, st.sort);
    const groupLabel = sec.toggle ? (groupNow === "product" ? "Product" : "Variant") : sec.groupLabel;
    const tbl = panelOf(id).querySelector(".perf-tbl");
    tbl.querySelector("thead").innerHTML = `<tr>
      <th class="sortable" data-k="key">${groupLabel}</th>
      <th class="sortable num" data-k="total">Total shipments</th>
      <th class="sortable num" data-k="fadRate">COD FAD</th>
      <th class="sortable num" data-k="fadDenom">FAD denom</th>
      <th class="sortable num" data-k="delivered">Delivered</th>
      <th class="sortable num" data-k="rto">RTO</th></tr>`;
    markSortHeaders2(tbl, st.sort);
    const rowHtml = (r, t) => `<tr class="${t ? "total-row" : ""}"><td>${r.key}</td><td class="num">${r.total}</td><td class="num">${fmtPct(r.fadRate)}</td><td class="num">${r.fadDenom}</td><td class="num">${r.delivered}</td><td class="num">${r.rto}</td></tr>`;
    const body = tbl.querySelector("tbody");
    body.innerHTML = res.rows.length ? res.rows.map((r) => rowHtml(r, false)).join("") + rowHtml(res.total, true)
      : `<tr><td colspan="6" class="muted" style="padding:18px">No shipments match.</td></tr>`;
  }
  function renderNdr() {
    const st = state.perf.ndr;
    const res = window.Metrics.ndrBreakdown(state.enriched, st);
    sortRows(res.rows, st.sort);
    const tbl = panelOf("ndr").querySelector(".perf-tbl");
    tbl.querySelector("thead").innerHTML = `<tr><th class="sortable" data-k="reason">NDR reason</th><th class="sortable num" data-k="count">Shipments</th><th class="num">% of NDR</th></tr>`;
    markSortHeaders2(tbl, st.sort);
    const body = tbl.querySelector("tbody");
    body.innerHTML = res.rows.length ? res.rows.map((r) => `<tr><td>${r.reason}</td><td class="num">${r.count}</td><td class="num">${fmtPct(res.total ? r.count / res.total : null)}</td></tr>`).join("")
      : `<tr><td colspan="3" class="muted" style="padding:18px">No NDR shipments in range.</td></tr>`;
  }
  function markSortHeaders2(tbl, sort) {
    tbl.querySelectorAll("thead th.sortable").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.k === sort.key);
      th.dataset.dir = th.dataset.k === sort.key ? (sort.dir < 0 ? "desc" : "asc") : "";
    });
  }
  function renderPerfAll() { ["ndr", "daily", "state", "varprod"].forEach(renderPerf); }
  function wirePerf(id) {
    const panel = panelOf(id);
    panel.querySelector(".perf-ctl").addEventListener("change", (e) => {
      const el = e.target.closest("[data-pf]"); if (!el) return;
      state.perf[id][el.dataset.pf] = el.value;
      saveJSON(LS.perf, state.perf); renderPerf(id);
    });
    panel.querySelector(".perf-tbl thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]"); if (!th) return;
      toggleSort(state.perf[id].sort, th.dataset.k); renderPerf(id);
    });
  }

  /* ---------------- user management (admin) ---------------- */
  const UMODS = [["delivery", "Delivery Matrix"], ["unit", "Unit Economics"], ["calling", "Calling"]];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  async function postJson(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  }
  async function renderUsers() {
    $("nu_modules").innerHTML = UMODS.map(([k, l]) => `<label class="mod-chk"><input type="checkbox" value="${k}"> ${l}</label>`).join("");
    let data; try { data = await (await fetch("/api/users")).json(); } catch { return; }
    const tb = $("usersTable").querySelector("tbody"); tb.innerHTML = "";
    (data.users || []).forEach((u) => {
      const mods = new Set(u.modules || []);
      const tr = document.createElement("tr");
      const checks = UMODS.map(([k, l]) =>
        `<label class="mod-chk"><input type="checkbox" data-m="${k}" ${mods.has(k) ? "checked" : ""} ${u.role === "admin" ? "disabled" : ""}> ${l}</label>`).join(" ");
      tr.innerHTML = `
        <td><input class="input" data-name value="${esc(u.name)}" style="width:130px"></td>
        <td>${esc(u.email)}</td>
        <td><input class="input" data-phone value="${esc(u.phone)}" placeholder="+91…" style="width:130px"></td>
        <td><select data-role><option value="user"${u.role === "user" ? " selected" : ""}>User</option><option value="admin"${u.role === "admin" ? " selected" : ""}>Admin</option></select></td>
        <td class="mod-cell">${checks}</td>
        <td style="text-align:center"><input type="checkbox" data-active ${u.active ? "checked" : ""}></td>
        <td><button class="btn save-user">Save</button></td>`;
      tr.querySelector("[data-role]").addEventListener("change", (e) => {
        const isAdmin = e.target.value === "admin";
        tr.querySelectorAll("[data-m]").forEach((c) => { c.disabled = isAdmin; if (isAdmin) c.checked = true; });
      });
      tr.querySelector(".save-user").addEventListener("click", async () => {
        const role = tr.querySelector("[data-role]").value;
        const modules = [...tr.querySelectorAll("[data-m]:checked")].map((c) => c.dataset.m);
        const active = tr.querySelector("[data-active]").checked;
        const name = tr.querySelector("[data-name]").value;
        const phone = tr.querySelector("[data-phone]").value;
        const r = await postJson("/api/users", { id: u.id, name, phone, role, modules, active });
        if (r.ok) renderUsers(); else alert(r.error || "Could not save.");
      });
      tb.appendChild(tr);
    });
  }
  async function addUser() {
    const role = $("nu_role").value;
    const modules = [...document.querySelectorAll("#nu_modules input:checked")].map((c) => c.value);
    const body = { name: $("nu_name").value.trim(), email: $("nu_email").value.trim(), phone: $("nu_phone").value.trim(), role, modules };
    const msg = $("nu_msg");
    if (!body.email.includes("@")) { msg.textContent = "Enter a valid email."; return; }
    const r = await postJson("/api/users", body);
    if (r.ok) { msg.textContent = "Added ✓"; ["nu_name", "nu_email", "nu_phone"].forEach((i) => ($(i).value = "")); renderUsers(); setTimeout(() => (msg.textContent = ""), 1500); }
    else msg.textContent = r.error || "Could not add user.";
  }

  /* ---------------- calling module ---------------- */
  const callState = { order: null };
  function renderToday(myDay) {
    const el = $("callToday");
    if (!myDay || !myDay.length) { el.innerHTML = `<span class="muted small">No calls logged yet today.</span>`; return; }
    const cls = (o) => o === "confirmed" ? "omr-green" : o === "cancelled" ? "omr-red" : o === "called" ? "omr-call" : "omr-grey";
    let c = 0, x = 0, k = 0, s = 0;
    myDay.forEach((a) => { if (a.outcome === "confirmed") c++; else if (a.outcome === "cancelled") x++; else if (a.outcome === "called") k++; else s++; });
    el.innerHTML = `<div class="omr-wrap">
      <span class="muted small">Your day · ${k} dials</span>
      <span class="omr-dots">${myDay.map((a) => `<span class="omr ${cls(a.outcome)}" title="${esc(a.outcome)} · ${new Date(a.at).toLocaleTimeString()}"></span>`).join("")}</span>
      <span class="omr-key"><span class="omr omr-call"></span>${k} dialled <span class="omr omr-green"></span>${c} confirmed <span class="omr omr-red"></span>${x} cancelled <span class="omr omr-grey"></span>${s} skipped</span>
    </div>`;
  }
  async function renderCalling() {
    $("callHeading").textContent = `Welcome ${(state.me && state.me.name) || ""}, — Order Confirmation Calling`;
    const wrap = $("callCard");
    wrap.innerHTML = `<div class="muted" style="padding:24px">Loading next order…</div>`;
    let d; try { d = await (await fetch("/api/calling/next")).json(); } catch { wrap.innerHTML = `<div class="muted" style="padding:24px">Could not load the queue.</div>`; return; }
    if (d.error) { wrap.innerHTML = `<div class="muted" style="padding:24px">${esc(d.error)}</div>`; return; }
    renderToday(d.myDay);
    if (d.summary) $("callSummary").textContent = summaryText(d);
    if (!d.order) { callState.order = null; wrap.innerHTML = `<div class="call-empty">✅ Nothing due right now. New orders or the next SLA window will appear here.</div>`; return; }
    callState.order = d.order;
    renderCallCard(d.order);
  }
  function summaryText(d) {
    const s = d.summary; if (!s) return "";
    return `${s.due} due now · ${s.eligible} COD orders in 4-day window · ${s.attemptedToday} attempted today (need ${s.required}/order by now)${d.online ? ` · ${d.online} caller${d.online > 1 ? "s" : ""} online` : ""}`;
  }
  // Prev / Next (next due-by-SLA) / jump to a specific order ID.
  async function navMove(dir) {
    const o = callState.order;
    const from = o ? encodeURIComponent(o.orderNumber) : "";
    try { applyNav(await (await fetch(`/api/calling/nav?dir=${dir}&from=${from}`)).json()); }
    catch { /* ignore */ }
  }
  async function navJump() {
    const v = ($("navJumpId").value || "").trim();
    if (!v) return;
    try { applyNav(await (await fetch(`/api/calling/nav?dir=jump&to=${encodeURIComponent(v)}`)).json()); }
    catch { /* ignore */ }
  }
  function flashCard(html, cls) {
    const el = document.createElement("div");
    el.className = "collision-flash" + (cls ? " " + cls : "");
    el.innerHTML = html;
    const host = $("callCard"); host.prepend(el);
    setTimeout(() => el.remove(), 7000);
  }
  function applyNav(d) {
    if (d.error) { alert(d.error); return; }
    if (d.summary) $("callSummary").textContent = summaryText(d);
    if (d.myDay) renderToday(d.myDay);
    if (d.notFound) { flashCard("🚫 " + esc(d.message || "Order not found in the queue."), "warn"); return; }
    if (d.order) {
      callState.order = d.order;
      renderCallCard(d.order);
      if (d.collision) flashCard(`🔒 Order #${esc(d.collision.orderNumber)} is being handled by <b>${esc(d.collision.by)}</b> right now — you can't open it. Moved you to the next order.`);
    } else if (d.collision) {
      callState.order = null;
      $("callCard").innerHTML = `<div class="call-empty">🔒 Order #${esc(d.collision.orderNumber)} is being handled by <b>${esc(d.collision.by)}</b>. Nothing else free right now.</div>`;
    } else {
      callState.order = null;
      $("callCard").innerHTML = `<div class="call-empty">✅ Nothing else in the queue right now.</div>`;
    }
  }
  const SKIP_REASONS = ["No answer / ringing", "Phone busy", "Switched off / unreachable",
    "Call later (schedule)", "Customer will confirm later", "Wrong / invalid number",
    "Language barrier", "Other (type below)"];
  const OUTCOME_LABEL = { delivered: "Delivered", rto: "RTO", cancelled: "Cancelled", in_transit: "In transit", open: "Open" };
  function fmtDur(s) { s = Number(s) || 0; const m = Math.floor(s / 60), x = s % 60; return m ? `${m}m ${x}s` : `${x}s`; }
  function rtoBadge(rto) {
    if (!rto) return "";
    const L = { low: "Low RTO risk", medium: "Medium RTO risk", high: "High RTO risk" }[rto.level] || "RTO risk";
    return `<div class="rto-box rto-${esc(rto.level)}">
        <div class="rto-top"><span class="rto-pill">⚠ ${esc(L)}</span>
          <span class="muted small">${rto.stats.delivered} delivered · ${rto.stats.rto} RTO · ${rto.stats.cancelled} cancelled (${rto.stats.orders} past orders)</span></div>
        <div class="muted small">${(rto.reasons || []).map(esc).join(" · ")}</div>
      </div>`;
  }
  function pincodeBanner(p) {
    if (!p) return "";
    if (p.serviceable === false) return `<div class="pin-flag bad">⛔ PIN ${esc(p.value)} is marked NON-serviceable${p.note ? " — " + esc(p.note) : ""}</div>`;
    return "";
  }
  function callInfoLine(ci) {
    if (!ci) return "";
    const dur = ci.duration ? ` · ${fmtDur(ci.duration)}` : "";
    const rec = ci.recording_url ? ` · <a href="${esc(ci.recording_url)}" target="_blank" rel="noopener">▶ recording</a>` : "";
    const st = ci.status ? esc(ci.status) : "logged";
    return `<div class="call-rec">🔴 Last call: ${st}${dur}${rec} <span class="muted small">(all calls are recorded)</span></div>`;
  }
  function renderCallCard(o) {
    const a = o.address;
    const items = o.items.map((it) => `<tr><td>${esc(it.title)}${it.variant ? " · " + esc(it.variant) : ""}</td><td class="num">${it.qty}</td><td class="num">${fmtMoney(it.price * it.qty)}</td></tr>`).join("");
    const hist = o.customerHistory || [];
    const pos = o.position;
    const posText = pos ? (pos.mode === "jumped" ? "jumped to order" : `${pos.index} of ${pos.total} ${pos.mode === "backlog" ? "in backlog" : "due"}`) : "";
    $("callCard").innerHTML = `
      <div class="call-nav">
        <button id="navPrev" class="btn small">◀ Prev</button>
        <button id="navNext" class="btn small">Next ▶</button>
        <span class="nav-pos muted small">${esc(posText)}</span>
        <span class="nav-jump"><input id="navJumpId" class="input" placeholder="Go to order #" inputmode="numeric"><button id="navJumpGo" class="btn small">Go</button></span>
      </div>
      <div class="call-card">
        <div class="call-main">
          <div class="call-head"><h2>${esc(o.customer)}</h2><span class="risk-label ${o.risk}">${(o.risk || "").replace("_", " ")}</span><span class="tag-cod">COD</span></div>
          <div class="muted small">Order #${esc(o.orderNumber)} · ${new Date(o.createdAt).toLocaleString()} · source: <b>${esc(o.source)}</b> · attempt ${(o.attemptsToday || 0) + 1} (need ${o.required}/day)</div>
          ${o.wrapped ? `<div class="wrap-note">↻ All SLA calls are done — looping back to the oldest pending orders.</div>` : ""}
          ${pincodeBanner(o.pincode)}
          <div class="call-phone">📞 ${o.phone ? esc(o.phone) : "<span class='muted'>no phone on order</span>"}</div>
          <div class="call-addr">${esc(a.line1)} ${esc(a.line2)}<br>${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}<br>${esc(a.country)}</div>
          <table class="call-items"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
            <tbody>${items}</tbody>
            <tfoot>
              <tr><td>Subtotal</td><td></td><td class="num">${fmtMoney(o.subtotal)}</td></tr>
              <tr><td>Discount</td><td></td><td class="num">-${fmtMoney(o.discount)}</td></tr>
              <tr class="total-row"><td>Total (COD)</td><td></td><td class="num">${fmtMoney(o.total)}</td></tr>
            </tfoot></table>
          <div id="caCallInfo">${callInfoLine(o.callInfo)}</div>
          <div class="call-history">
            <b>Call history (${(o.history || []).length})</b>
            <ul>${(o.history && o.history.length)
              ? o.history.map((h) => `<li>${new Date(h.at).toLocaleString()} — <b>${esc(h.caller || "—")}</b> — ${esc(h.outcome || "")}</li>`).join("")
              : "<li class='muted'>No previous calls to this customer.</li>"}</ul>
          </div>
          ${rtoBadge(o.rto)}
          <div class="cust-hist">
            <button id="caHistToggle" class="link-btn">▸ Customer order history (${hist.length})</button>
            <div id="caHistBody" class="hidden">
              ${hist.length ? `<table class="hist-table"><thead><tr><th>Order</th><th>Date</th><th>Pay</th><th>Outcome</th><th class="num">Total</th></tr></thead><tbody>
                ${hist.map((h) => `<tr><td>#${esc(h.orderNumber)}</td><td>${new Date(h.at).toLocaleDateString()}</td><td>${esc((h.payment || "").toUpperCase())}</td><td><span class="oc oc-${esc(h.outcome)}">${esc(OUTCOME_LABEL[h.outcome] || h.outcome)}</span></td><td class="num">${fmtMoney(h.total)}</td></tr>`).join("")}
              </tbody></table>` : `<div class="muted small">No earlier orders for this customer.</div>`}
            </div>
          </div>
        </div>
        <div class="call-actions">
          <button id="caCall" class="btn primary lg">📞 Call customer</button>
          <div id="caCallMsg" class="muted small"></div>
          <button id="caConfirm" class="btn confirm-btn">✓ Confirm order</button>
          <button id="caAddr" class="btn">✎ Modify address</button>
          <button id="caSkip" class="btn">↷ Skip / Call later</button>
          <button id="caCancel" class="btn danger">✕ Cancel order</button>
          <button id="caPin" class="btn small ghost">${o.pincode && o.pincode.serviceable === false ? "✓ Mark PIN serviceable" : "⛔ Flag PIN non-serviceable"}</button>
        </div>
      </div>
      <div id="addrForm" class="panel hidden"></div>
      <div id="skipForm" class="panel hidden"></div>`;
    $("caCall").addEventListener("click", callCustomer);
    $("caConfirm").addEventListener("click", confirmOrder);
    $("caSkip").addEventListener("click", toggleSkipForm);
    $("caCancel").addEventListener("click", cancelOrder);
    $("caAddr").addEventListener("click", toggleAddrForm);
    $("caPin").addEventListener("click", togglePincode);
    $("navPrev").addEventListener("click", () => navMove("prev"));
    $("navNext").addEventListener("click", () => navMove("next"));
    $("navJumpGo").addEventListener("click", navJump);
    $("navJumpId").addEventListener("keydown", (e) => { if (e.key === "Enter") navJump(); });
    $("caHistToggle").addEventListener("click", () => {
      const b = $("caHistBody"), t = $("caHistToggle");
      const open = b.classList.toggle("hidden") === false;
      t.textContent = `${open ? "▾" : "▸"} Customer order history (${hist.length})`;
    });
  }
  async function callCustomer() {
    const o = callState.order; const m = $("caCallMsg");
    m.textContent = "Ringing your phone…";
    const r = await postJson("/api/calling/call", { orderNumber: o.orderNumber, phone: o.phone });
    if (!r.ok) { m.textContent = "Call failed: " + (r.error || ""); return; }
    m.innerHTML = "📲 Pick up your phone — it will connect you to the customer. <b>This call is being recorded.</b>";
    // Poll for the recording + duration after the call ends.
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const c = await (await fetch("/api/calling/callinfo?orderNumber=" + encodeURIComponent(o.orderNumber))).json();
        if (c.call) { $("caCallInfo").innerHTML = callInfoLine(c.call); if (c.call.duration || c.call.recording_url) clearInterval(poll); }
      } catch (_) {}
      if (tries > 40) clearInterval(poll); // stop after ~3-4 min
    }, 5000);
  }
  async function togglePincode() {
    const o = callState.order; const p = o.pincode || {};
    if (!p.value) { alert("This order has no PIN code."); return; }
    const makeNon = !(p.serviceable === false);
    let note = "";
    if (makeNon) { note = prompt(`Mark PIN ${p.value} as NON-serviceable. Optional note (courier/reason):`, p.note || "") ?? ""; }
    else if (!confirm(`Mark PIN ${p.value} as serviceable again?`)) return;
    const r = await postJson("/api/calling/pincode", { pincode: p.value, serviceable: !makeNon, note });
    if (r.ok) { o.pincode = { value: p.value, serviceable: !makeNon, note }; renderCallCard(o); }
    else alert(r.error || "Could not save.");
  }
  function toggleSkipForm() {
    const f = $("skipForm");
    if (!f.classList.contains("hidden")) { f.classList.add("hidden"); return; }
    $("addrForm").classList.add("hidden");
    f.innerHTML = `<h3>Skip this order</h3>
      <div class="skip-grid">
        <div><label>Reason</label>
          <select id="sk_reason" class="input">${SKIP_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></div>
        <div id="sk_when_wrap" class="hidden"><label>Call back at</label><input id="sk_when" type="datetime-local" class="input"></div>
        <div class="skip-note"><label>Note (optional)</label><input id="sk_note" class="input" placeholder="Anything useful for the next caller"></div>
      </div>
      <div class="setup-actions"><button id="sk_save" class="btn primary">Save & next order</button><span id="sk_msg" class="muted small"></span></div>`;
    f.classList.remove("hidden");
    const reason = $("sk_reason");
    const syncWhen = () => $("sk_when_wrap").classList.toggle("hidden", !/call later/i.test(reason.value));
    reason.addEventListener("change", syncWhen); syncWhen();
    $("sk_save").addEventListener("click", submitSkip);
  }
  async function submitSkip() {
    const o = callState.order;
    const reason = $("sk_reason").value;
    const note = $("sk_note").value;
    let callbackAt = "";
    if (/call later/i.test(reason)) {
      const w = $("sk_when").value;
      if (!w) { $("sk_msg").textContent = "Pick a callback date & time."; return; }
      callbackAt = new Date(w).toISOString();
    }
    const r = await postJson("/api/calling/skip", { orderNumber: o.orderNumber, reason, note, callbackAt });
    if (r.ok) renderCalling(); else alert(r.error || "");
  }
  async function confirmOrder() {
    const o = callState.order; const r = await postJson("/api/calling/confirm", { orderNumber: o.orderNumber, orderId: o.orderId });
    if (r.ok) renderCalling(); else alert(r.error || "Could not confirm.");
  }
  async function cancelOrder() {
    const o = callState.order;
    if (!confirm(`Cancel order #${o.orderNumber}? This cancels it in Shopify.`)) return;
    if (!confirm("Are you absolutely sure? This can't be undone.")) return;
    const r = await postJson("/api/calling/cancel", { orderNumber: o.orderNumber, orderId: o.orderId });
    if (r.ok) renderCalling(); else alert(r.error || "Could not cancel.");
  }
  function toggleAddrForm() {
    const f = $("addrForm");
    if (!f.classList.contains("hidden")) { f.classList.add("hidden"); return; }
    const sk = $("skipForm"); if (sk) sk.classList.add("hidden");
    const a = callState.order.address;
    f.innerHTML = `<h3>Modify shipping address</h3>
      <div class="user-form">
        <div><label>Name</label><input id="ad_name" class="input" value="${esc(a.name)}"></div>
        <div><label>Phone</label><input id="ad_phone" class="input" value="${esc(a.phone)}"></div>
        <div><label>Address line 1</label><input id="ad_l1" class="input" value="${esc(a.line1)}"></div>
        <div><label>Address line 2</label><input id="ad_l2" class="input" value="${esc(a.line2)}"></div>
        <div><label>City</label><input id="ad_city" class="input" value="${esc(a.city)}"></div>
        <div><label>State</label><input id="ad_state" class="input" value="${esc(a.state)}"></div>
        <div><label>PIN code</label><input id="ad_zip" class="input" value="${esc(a.zip)}"></div>
      </div>
      <div class="setup-actions"><button id="ad_save" class="btn primary">Save address</button><span id="ad_msg" class="muted small"></span></div>`;
    f.classList.remove("hidden");
    $("ad_save").addEventListener("click", async () => {
      const o = callState.order;
      const address = { name: $("ad_name").value, phone: $("ad_phone").value, line1: $("ad_l1").value, line2: $("ad_l2").value, city: $("ad_city").value, state: $("ad_state").value, zip: $("ad_zip").value, country: a.country };
      const r = await postJson("/api/calling/address", { orderNumber: o.orderNumber, orderId: o.orderId, address });
      $("ad_msg").textContent = r.ok ? "Saved ✓ — now Confirm the order." : (r.error || "Failed");
      if (r.ok) callState.order.address = address;
    });
  }

  /* ---------------- connections (home) ---------------- */
  function populateSettings() {
    const c = getCreds();
    $("npEmail").value = c.npEmail || "";
    $("npPassword").value = c.npPassword || "";
    $("shShop").value = c.shShop || "";
    $("shClientId").value = c.shClientId || "";
    $("shClientSecret").value = c.shClientSecret || "";
    $("redirectUrl").textContent = location.origin + "/auth/callback";
    refreshShopifyStatus();
  }
  function readSettingsForm() {
    return {
      npEmail: $("npEmail").value.trim(), npPassword: $("npPassword").value,
      shShop: $("shShop").value.trim(), shClientId: $("shClientId").value.trim(),
      shClientSecret: $("shClientSecret").value.trim(),
    };
  }
  function saveSettings() { saveJSON(LS.creds, readSettingsForm()); loadData(); flash($("saveSettings"), "Saved ✓"); }
  function clearSettings() {
    localStorage.removeItem(LS.creds);
    ["npEmail", "npPassword", "shShop", "shClientId", "shClientSecret"].forEach((i) => ($(i).value = ""));
  }
  function flash(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => (btn.textContent = o), 1500); }

  async function refreshShopifyStatus() {
    const el = $("shStatus");
    try {
      const s = await (await fetch("/auth/status")).json();
      if (s.connected) {
        el.className = "conn-status ok small";
        el.textContent = `✓ Connected to ${s.shop}` + (s.connectedAt ? ` (${s.connectedAt === "via host config" ? "via host config" : "since " + new Date(s.connectedAt).toLocaleDateString()})` : "");
        if (!$("shShop").value && s.shop) $("shShop").value = s.shop;
      } else { el.className = "conn-status off small"; el.textContent = "Not connected — fill Client ID + Secret and click Connect Shopify."; }
    } catch { el.className = "conn-status off small"; el.textContent = "Server not reachable."; }
  }
  async function connectShopify() {
    saveJSON(LS.creds, readSettingsForm());
    const shop = $("shShop").value.trim(), clientId = $("shClientId").value.trim(), clientSecret = $("shClientSecret").value.trim();
    if (!shop || !clientId || !clientSecret) { $("shStatus").className = "conn-status off small"; $("shStatus").textContent = "Fill store domain, Client ID and Client secret first."; return; }
    try {
      const j = await (await fetch("/auth/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shop, clientId, clientSecret }) })).json();
      if (j.authorizeUrl) window.location.href = j.authorizeUrl;
      else { $("shStatus").className = "conn-status off small"; $("shStatus").textContent = j.error || "Could not start connection."; }
    } catch (e) { $("shStatus").className = "conn-status off small"; $("shStatus").textContent = "Error: " + e.message; }
  }
  async function disconnectShopify() { await fetch("/auth/disconnect", { method: "POST" }).catch(() => {}); refreshShopifyStatus(); loadData(); }

  /* ---------------- render orchestration ---------------- */
  function renderAll() {
    renderHeader();
    renderScopeControls();
    renderCards();
    renderVariantTable();
    renderCourierTable();
    renderPerfAll();
    renderUnitVariantPicker();
    renderUnit();
  }

  /* ---------------- navigation + theme ---------------- */
  const VIEWS = ["home", "delivery", "unit", "calling", "users"];
  function showView(name) {
    const view = VIEWS.includes(name) ? name : "home";
    document.body.dataset.view = view;
    VIEWS.forEach((v) => $("view-" + v).classList.toggle("hidden", v !== view));
    document.querySelectorAll(".menu-item").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    localStorage.setItem(LS.view, view);
    if (view === "users") renderUsers();
    if (view === "calling") renderCalling();
    closeMenu(); window.scrollTo({ top: 0 });
  }
  function openMenu() { $("menuOverlay").classList.remove("hidden"); }
  function closeMenu() { $("menuOverlay").classList.add("hidden"); }

  function updateLogos(theme) {
    const file = theme === "dark" ? "logo-dark.png" : "logo-light.png";
    document.querySelectorAll(".logo-slot").forEach((slot) => {
      const size = slot.dataset.size;
      const probe = new Image();
      probe.onload = () => { slot.innerHTML = `<img class="brand-logo ${size}-logo" src="${file}" alt="KERAKING" />`; };
      probe.onerror = () => { slot.innerHTML = `<svg class="brand-logo ${size}-logo"><use href="#brandLogo" /></svg>`; };
      probe.src = file + "?v=" + Date.now();
    });
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(LS.theme, theme);
    const btn = $("themeToggle"); if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
    updateLogos(theme);
  }
  function toggleTheme() { applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"); }

  /* ---------------- auth / who-am-I ---------------- */
  async function setupAuth() {
    let j;
    try { j = await (await fetch("/auth/me")).json(); } catch { return; }
    state.me = j.user;
    if (!j.authRequired) return;                 // local/no-DB mode = full access
    if (!j.user) { location.href = "/login.html"; return; }

    const admin = j.user.role === "admin";
    const allowed = new Set(j.user.modules || []);
    document.querySelectorAll(".menu-item[data-view]").forEach((mi) => {
      const v = mi.dataset.view;
      if (v === "home") return;                  // home always available
      if (v === "users") { mi.style.display = admin ? "" : "none"; return; } // admin-only
      if (!admin && !allowed.has(v)) mi.style.display = "none";
    });
    // Hide the connections/API-key panel from non-admins entirely.
    document.querySelectorAll(".admin-only").forEach((el) => { el.style.display = admin ? "" : "none"; });
    const setup = document.querySelector(".home-setup");
    if (setup) setup.style.display = admin ? "" : "none";
    // If the remembered view isn't permitted, fall back to home.
    const cur = document.body.dataset.view;
    if (cur && cur !== "home" && !admin && !allowed.has(cur)) showView("home");

    // Add user chip + logout to the top bar.
    const right = document.querySelector(".nav-right");
    if (right && !document.getElementById("userChip")) {
      const chip = document.createElement("span");
      chip.id = "userChip"; chip.className = "user-chip";
      chip.textContent = (j.user.name || j.user.email) + (admin ? " · admin" : "");
      const out = document.createElement("button");
      out.className = "btn"; out.textContent = "Log out";
      out.addEventListener("click", async () => { await fetch("/auth/logout", { method: "POST" }); location.href = "/login.html"; });
      right.appendChild(chip); right.appendChild(out);
    }
  }

  /* ====================================================================== *
   *  UNIT ECONOMICS ANALYSER (per variant, remembered)
   * ====================================================================== */
  const UE_FIELDS = ["sp","sp_g","disc","prod","prod_g","pkg","pkg_g","fwpp","fwpp_g",
    "fwcod","fwcod_g","rto","rto_g","codfee","codfee_g","codgw","codgw_g","ppgw","ppgw_g",
    "crm","crm_g","addcost","ad","ad_g","codpct","codconf","coddeliv","ppdeliv"];
  const UE_DEFAULT = { sp:1499, sp_g:18, disc:5, prod:300, prod_g:18, pkg:25, pkg_g:18,
    fwpp:60, fwpp_g:18, fwcod:75, fwcod_g:18, rto:150, rto_g:18, codfee:40, codfee_g:18,
    codgw:1.5, codgw_g:18, ppgw:2, ppgw_g:18, crm:8, crm_g:18, addcost:0, ad:150, ad_g:18,
    codpct:"", codconf:"", coddeliv:"", ppdeliv:95 };

  const ueStore = () => loadJSON(LS.unit, {});
  function ueScope() { return state.ueVariant === "_blended" ? { level: "blended" } : { level: "variant", variantId: state.ueVariant }; }
  function variantAvgPrice(variantId) {
    for (const p of state.catalog) for (const v of p.variants) if (v.variantId === variantId) return v.avgPrice;
    return null;
  }
  function populateUnitInputs() {
    const saved = ueStore()[state.ueVariant] || {};
    const avg = state.ueVariant !== "_blended" ? variantAvgPrice(state.ueVariant) : null;
    UE_FIELDS.forEach((f) => {
      const el = $("ue_" + f); if (!el) return;
      let val = saved[f] !== undefined ? saved[f] : UE_DEFAULT[f];
      if (f === "sp" && saved.sp === undefined && avg) val = Math.round(avg); // prefill SP from real avg
      el.value = val === "" ? "" : val;
    });
  }
  function saveUnitInputs() {
    const store = ueStore(); const s = {};
    UE_FIELDS.forEach((f) => { const el = $("ue_" + f); if (el) s[f] = el.value; });
    store[state.ueVariant] = s; saveJSON(LS.unit, store);
  }
  function ueVal(f) { const el = $("ue_" + f); if (!el) return null; const v = parseFloat(el.value); return el.value === "" || isNaN(v) ? null : v; }

  function renderUnitVariantPicker() {
    const sel = $("ueVariant"); const prev = sel.value || state.ueVariant;
    sel.innerHTML = ""; sel.add(new Option("Blended (all variants)", "_blended"));
    state.catalog.forEach((p) => p.variants.forEach((v) => sel.add(new Option(`${p.product} · ${v.variant}`, v.variantId))));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "_blended";
    state.ueVariant = sel.value;
  }

  function getLiveFunnel(scope) {
    const m = window.Metrics.computeAll(state.orderRecs || [], scope || { level: "blended" }, state.now, state.windows);
    return { codPct: m.split.cur.codShare, codConfirm: m.codConfirm.cur.rate, codDelivery: m.codFad.cur.rate };
  }

  function computeUnitEcon() {
    const I = {};
    UE_FIELDS.forEach((f) => { I[f] = ueVal(f); if (I[f] == null && UE_DEFAULT[f] !== "") I[f] = UE_DEFAULT[f]; });
    const live = getLiveFunnel(ueScope());
    const codPct = ueVal("codpct") != null ? ueVal("codpct") / 100 : live.codPct;
    const conf = ueVal("codconf") != null ? ueVal("codconf") / 100 : live.codConfirm;
    const deliv = ueVal("coddeliv") != null ? ueVal("coddeliv") / 100 : live.codDelivery;
    const ppDeliv = (I.ppdeliv || 95) / 100;
    const line = (incl, g) => { const ex = incl / (1 + (g || 0) / 100); return { incl, ex, gst: incl - ex }; };
    const pctLine = (base, pct, g) => { const ex = base * (pct / 100); const gst = ex * (g || 0) / 100; return { incl: ex + gst, ex, gst }; };
    const summarise = (rev, L) => {
      const ks = Object.keys(L);
      return { rev, lines: L, costEx: ks.reduce((a, k) => a + L[k].ex, 0), inputGst: ks.reduce((a, k) => a + L[k].gst, 0), marginEx: rev.ex - ks.reduce((a, k) => a + L[k].ex, 0), outputGst: rev.gst };
    };
    let cod = null;
    if (conf > 0 && deliv > 0) {
      const shipped = 1 / deliv, rto = (1 - deliv) / deliv;
      cod = summarise(line(I.sp, I.sp_g), {
        product: line(I.prod, I.prod_g), packaging: line(I.pkg * shipped, I.pkg_g),
        forward: line(I.fwcod * shipped, I.fwcod_g), rto: line(I.rto * rto, I.rto_g),
        codFee: line(I.codfee, I.codfee_g), gateway: pctLine(I.sp, I.codgw, I.codgw_g), crm: line(I.crm * shipped, I.crm_g),
      });
      cod.placed = 1 / (conf * deliv);
    }
    let pp = null;
    if (ppDeliv > 0) {
      const shipped = 1 / ppDeliv, rto = (1 - ppDeliv) / ppDeliv, spPp = I.sp * (1 - I.disc / 100);
      pp = summarise(line(spPp, I.sp_g), {
        product: line(I.prod, I.prod_g), packaging: line(I.pkg * shipped, I.pkg_g),
        forward: line(I.fwpp * shipped, I.fwpp_g), rto: line(I.rto * rto, I.rto_g),
        codFee: { incl: 0, ex: 0, gst: 0 }, gateway: pctLine(spPp * shipped, I.ppgw, I.ppgw_g), crm: { incl: 0, ex: 0, gst: 0 },
      });
      pp.placed = 1 / ppDeliv;
    }
    const wCod = (codPct || 0) * (conf || 0) * (deliv || 0);
    const wPp = (1 - (codPct || 0)) * ppDeliv;
    const wTot = wCod + wPp;
    const bl = (sel) => (!wTot ? null : ((cod ? sel(cod) : 0) * wCod + (pp ? sel(pp) : 0) * wPp) / wTot);
    const blended = wTot ? { aov: bl((x) => x.rev.incl), revEx: bl((x) => x.rev.ex), costEx: bl((x) => x.costEx), marginEx: bl((x) => x.marginEx), outputGst: bl((x) => x.outputGst), inputGst: bl((x) => x.inputGst) } : null;
    const blendedDeliveryRate = wTot || null;
    const placedMultiple = wTot ? 1 / wTot : null;
    const adEx = (I.ad || 0) * (placedMultiple || 0);
    const adGst = adEx * ((I.ad_g || 0) / 100);
    const breakevenAdPerOrder = blended && blendedDeliveryRate != null ? blended.marginEx * blendedDeliveryRate : null;
    const netProfit = blended ? blended.marginEx - adEx - (I.addcost || 0) : null;
    const ebitdaPct = blended && blended.revEx ? netProfit / blended.revEx : null;
    return { I, funnel: { codPct, conf, deliv, ppDeliv }, cod, pp, blended, blendedDeliveryRate, placedMultiple, adEx, adGst, breakevenAdPerOrder, netProfit, ebitdaPct };
  }

  function renderUnit() {
    if (!state.orderRecs) return;
    const r = computeUnitEcon(); const m$ = fmtMoney; const f = r.funnel;
    const colCost = (s, key) => (s ? m$(-s.lines[key].ex) : "—");
    const rowsDef = [["Revenue (AOV, ex-GST)", r.cod ? m$(r.cod.rev.ex) : "—", r.pp ? m$(r.pp.rev.ex) : "—"],
      ["Product", colCost(r.cod, "product"), colCost(r.pp, "product")],
      ["Packaging", colCost(r.cod, "packaging"), colCost(r.pp, "packaging")],
      ["Forward shipping", colCost(r.cod, "forward"), colCost(r.pp, "forward")],
      ["RTO shipping", colCost(r.cod, "rto"), colCost(r.pp, "rto")],
      ["COD fee", colCost(r.cod, "codFee"), colCost(r.pp, "codFee")],
      ["Payment gateway", colCost(r.cod, "gateway"), colCost(r.pp, "gateway")],
      ["CRM", colCost(r.cod, "crm"), colCost(r.pp, "crm")]];
    const body = rowsDef.map((row) => `<tr><td>${row[0]}</td><td class="num">${row[1]}</td><td class="num">${row[2]}</td></tr>`).join("");
    const marginPct = r.blended && r.blended.revEx ? r.blended.marginEx / r.blended.revEx : null;
    $("ueEcon").innerHTML = `
      <div class="ue-headline">
        <div class="ue-kpi"><div class="v">${r.blended ? m$(r.blended.aov) : "—"}</div><div class="detail">AOV (incl GST)</div></div>
        <div class="ue-kpi"><div class="v" style="color:${r.blended && r.blended.marginEx >= 0 ? "var(--good)" : "var(--bad)"}">${r.blended ? m$(r.blended.marginEx) : "—"}</div><div class="detail">Contribution margin / delivered (ex-GST)</div></div>
        <div class="ue-kpi"><div class="v">${fmtPct(marginPct)}</div><div class="detail">Margin % of revenue</div></div>
        <div class="ue-kpi"><div class="v">${fmtPct(r.blendedDeliveryRate)}</div><div class="detail">Blended delivery rate</div></div>
        <div class="ue-kpi"><div class="v">${r.placedMultiple == null ? "—" : r.placedMultiple.toFixed(2) + "×"}</div><div class="detail">Orders placed / delivered</div></div>
      </div>
      <div class="muted small" style="margin:8px 0">Funnel — COD share ${fmtPct(f.codPct)}, confirmation ${fmtPct(f.conf)}, COD delivery ${fmtPct(f.deliv)}, prepaid delivery ${fmtPct(f.ppDeliv)}. Per delivered order, ex-GST. Costs negative.</div>
      <div class="table-wrap"><table><thead><tr><th>Line (per delivered order)</th><th class="num">COD</th><th class="num">Prepaid</th></tr></thead><tbody>
        ${body}
        <tr class="total-row"><td>Total cost</td><td class="num">${r.cod ? m$(-r.cod.costEx) : "—"}</td><td class="num">${r.pp ? m$(-r.pp.costEx) : "—"}</td></tr>
        <tr class="total-row"><td>Contribution margin</td><td class="num">${r.cod ? m$(r.cod.marginEx) : "—"}</td><td class="num">${r.pp ? m$(r.pp.marginEx) : "—"}</td></tr>
      </tbody></table></div>`;

    const b = r.blended;
    const inputGstAll = b ? b.inputGst + r.adGst : null;
    const netGst = b ? b.outputGst - inputGstAll : null;
    $("ueGst").innerHTML = `
      <h2>GST, Ad cost &amp; EBITDA · per delivered order (blended)</h2>
      <div class="muted small">Ad cost is per ORDER PLACED, scaled by ${r.placedMultiple == null ? "—" : r.placedMultiple.toFixed(2) + "×"} (orders placed per delivered). GST is a pass-through; output GST is offset by input GST (ITC) incl. ad spend.</div>
      <div class="table-wrap" style="margin-top:12px"><table><tbody>
        <tr><td>Output GST (on sale)</td><td class="num">${b ? m$(b.outputGst) : "—"}</td></tr>
        <tr><td>Input GST / ITC (costs + ad)</td><td class="num">${inputGstAll == null ? "—" : m$(inputGstAll)}</td></tr>
        <tr class="total-row"><td>Net GST payable</td><td class="num">${netGst == null ? "—" : m$(netGst)}</td></tr>
        <tr><td>Revenue (AOV, ex-GST)</td><td class="num">${b ? m$(b.revEx) : "—"}</td></tr>
        <tr><td>Contribution margin (ex-GST)</td><td class="num">${b ? m$(b.marginEx) : "—"}</td></tr>
        <tr><td>Breakeven ad cost / order placed</td><td class="num">${r.breakevenAdPerOrder == null ? "—" : m$(r.breakevenAdPerOrder)}</td></tr>
        <tr><td>Ad cost / order placed (input)</td><td class="num">${m$(-(r.I.ad || 0))}</td></tr>
        <tr><td>Ad cost / delivered (× ${r.placedMultiple == null ? "—" : r.placedMultiple.toFixed(2)})</td><td class="num">${m$(-r.adEx)}</td></tr>
        <tr><td>Additional cost / order (ex-GST)</td><td class="num">${m$(-(r.I.addcost || 0))}</td></tr>
        <tr class="total-row"><td>EBITDA / net profit after GST set-off</td><td class="num" style="color:${r.netProfit >= 0 ? "var(--good)" : "var(--bad)"}">${r.netProfit == null ? "—" : m$(r.netProfit)}</td></tr>
        <tr class="total-row"><td>EBITDA % (÷ net revenue)</td><td class="num" style="color:${r.ebitdaPct >= 0 ? "var(--good)" : "var(--bad)"}">${fmtPct(r.ebitdaPct)}</td></tr>
      </tbody></table></div>`;
  }
  function showUeTab(which) {
    $("ueEcon").classList.toggle("hidden", which !== "econ");
    $("ueGst").classList.toggle("hidden", which !== "gst");
    document.querySelectorAll(".ue-tab").forEach((t) => t.classList.toggle("active", t.dataset.uetab === which));
  }

  /* ---------------- wire up ---------------- */
  function init() {
    applyTheme(localStorage.getItem(LS.theme) || "light");
    showView(localStorage.getItem(LS.view) || "home");
    setupAuth();
    $("themeToggle").addEventListener("click", toggleTheme);
    $("menuBtn").addEventListener("click", openMenu);
    $("closeMenu").addEventListener("click", closeMenu);
    $("menuOverlay").addEventListener("click", (e) => { if (e.target.id === "menuOverlay") closeMenu(); });
    document.querySelectorAll("button[data-view]").forEach((el) => el.addEventListener("click", () => showView(el.dataset.view)));

    // Home / connections
    populateSettings();
    $("saveSettings").addEventListener("click", saveSettings);
    $("clearSettings").addEventListener("click", clearSettings);
    $("connectShopify").addEventListener("click", connectShopify);
    $("disconnectShopify").addEventListener("click", disconnectShopify);
    $("homeRefresh").addEventListener("click", () => { loadData(); refreshShopifyStatus(); });
    $("refreshBtn").addEventListener("click", loadData);
    if (/[?&]shopify=connected/.test(location.search)) history.replaceState({}, "", location.pathname);

    // Delivery matrix
    $("productSelect").addEventListener("change", onProductChange);
    $("variantSelect").addEventListener("change", onVariantChange);
    $("variantTable").querySelector("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]"); if (!th) return;
      toggleSort(state.vSort, th.dataset.k); renderVariantTable();
    });
    $("courierTable").querySelector("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]"); if (!th) return;
      toggleSort(state.cbSort, th.dataset.k); renderCourierTable();
    });
    $("cbCourier").addEventListener("change", (e) => { state.cb.courier = e.target.value; saveJSON(LS.cb, state.cb); renderCourierTable(); });
    $("cbRisk").addEventListener("change", (e) => { state.cb.risk = e.target.value; saveJSON(LS.cb, state.cb); renderCourierTable(); });
    $("cbPayment").addEventListener("change", (e) => { state.cb.payment = e.target.value; saveJSON(LS.cb, state.cb); renderCourierTable(); });
    $("cbDelay").addEventListener("change", (e) => { state.cb.delay = e.target.value; saveJSON(LS.cb, state.cb); renderCourierTable(); });
    $("cbFilter").addEventListener("input", (e) => { state.cb.text = e.target.value; renderCourierTable(); });

    // Unit economics
    document.querySelectorAll("#view-unit .ue-in").forEach((el) => el.addEventListener("input", () => { saveUnitInputs(); renderUnit(); }));
    document.querySelectorAll(".ue-tab").forEach((t) => t.addEventListener("click", () => showUeTab(t.dataset.uetab)));
    $("ueVariant").addEventListener("change", (e) => { saveUnitInputs(); state.ueVariant = e.target.value; populateUnitInputs(); renderUnit(); });
    $("ueUseLive").addEventListener("click", () => {
      const live = getLiveFunnel(ueScope());
      $("ue_codpct").value = live.codPct != null ? (live.codPct * 100).toFixed(1) : "";
      $("ue_codconf").value = live.codConfirm != null ? (live.codConfirm * 100).toFixed(1) : "";
      $("ue_coddeliv").value = live.codDelivery != null ? (live.codDelivery * 100).toFixed(1) : "";
      saveUnitInputs(); renderUnit();
    });
    $("ueReset").addEventListener("click", () => { const s = ueStore(); delete s[state.ueVariant]; saveJSON(LS.unit, s); populateUnitInputs(); renderUnit(); });

    populateUnitInputs();

    // User management
    $("nu_add").addEventListener("click", addUser);
    // Calling
    $("callNext").addEventListener("click", renderCalling);

    // Performance sections
    initPerf();
    ["ndr", "daily", "state", "varprod"].forEach(wirePerf);

    loadData();
    setInterval(loadData, 5 * 60 * 1000);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
