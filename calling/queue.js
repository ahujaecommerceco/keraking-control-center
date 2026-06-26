/*
 * calling/queue.js — call-queue scheduling engine (pure, no I/O).
 *
 * Rules (per the spec):
 *  - Eligible orders: COD, placed within the last 4 days, not yet actioned
 *    (no Verified/Cancelled tag).
 *  - Daily attempt SLA until actioned:
 *      • ≥1 attempt before 12:00
 *      • ≥2 attempts by 15:00
 *      • ≥3 attempts by 18:00
 *    OR the order is satisfied for the day if it already received 3 attempts
 *    within any 2-hour span that day.
 *  - The queue surfaces orders that are DUE for their next attempt right now,
 *    oldest order first.
 *  - Due orders are auto-distributed across the active telecaller accounts
 *    (round-robin, balanced), and an order can be locked to a caller during a
 *    call so two callers never get the same one.
 *
 * An "order" object here looks like:
 *   { orderNumber, createdAt, paymentType:"cod",
 *     actioned:false,                // true once Verified/Cancelled
 *     attempts:[{ at:ISO, caller, outcome }],
 *     lockedBy, lockUntil }          // optional in-call lock
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CallQueue = api;
})(typeof self !== "undefined" ? self : this, function () {
  const HOUR = 3600000;
  const DAY = 86400000;
  const WINDOW_DAYS = 4;

  // Local calendar-day key (so "today" matches the caller's day).
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function attemptsToday(order, now) {
    const k = dayKey(now);
    return (order.attempts || []).filter((a) => dayKey(a.at) === k);
  }
  // Cumulative attempts required by the current time of day.
  function requiredByNow(now) {
    const h = new Date(now).getHours();
    if (h < 12) return 1;
    if (h < 15) return 2;
    return 3; // 15:00 onwards (incl. after 18:00) cap at 3
  }
  // Satisfied for the day if 3 attempts fell within any 2-hour window.
  function burstSatisfied(order, now) {
    const t = attemptsToday(order, now).map((a) => new Date(a.at).getTime()).sort((a, b) => a - b);
    for (let i = 0; i + 2 < t.length; i++) if (t[i + 2] - t[i] <= 2 * HOUR) return true;
    return false;
  }
  function withinWindow(order, now) {
    return now - new Date(order.createdAt).getTime() <= WINDOW_DAYS * DAY;
  }
  function isLocked(order, now) {
    return !!order.lockUntil && new Date(order.lockUntil).getTime() > now;
  }
  function eligible(order, now) {
    return order.paymentType === "cod" && !order.actioned && withinWindow(order, now);
  }
  // An order is DUE if eligible, not satisfied for the day, and below the
  // required attempt count for the current time of day.
  function isDue(order, now) {
    if (!eligible(order, now)) return false;
    if (burstSatisfied(order, now)) return false;
    return attemptsToday(order, now).length < requiredByNow(now);
  }

  // All due orders, oldest first.
  function dueOrders(orders, now) {
    now = now || Date.now();
    return orders
      .filter((o) => isDue(o, now))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  // Balanced round-robin assignment of due orders across active callers.
  // Returns { callerId: [orders...] } (each list oldest-first).
  function assign(orders, callers, now) {
    now = now || Date.now();
    const map = {};
    (callers || []).forEach((c) => (map[c] = []));
    if (!callers || !callers.length) return map;
    dueOrders(orders, now).forEach((o, i) => map[callers[i % callers.length]].push(o));
    return map;
  }

  // The next order a given caller should call: their first assigned, unlocked,
  // due order. Returns null if nothing is due for them.
  function nextForCaller(orders, callers, callerId, now) {
    now = now || Date.now();
    const list = assign(orders, callers, now)[callerId] || [];
    return list.find((o) => !isLocked(o, now)) || null;
  }

  // Convenience stats for a dashboard header.
  function summary(orders, now) {
    now = now || Date.now();
    const elig = orders.filter((o) => eligible(o, now));
    return {
      eligible: elig.length,
      due: elig.filter((o) => isDue(o, now)).length,
      attemptedToday: elig.filter((o) => attemptsToday(o, now).length > 0).length,
      required: requiredByNow(now),
    };
  }

  return {
    WINDOW_DAYS, dayKey, attemptsToday, requiredByNow, burstSatisfied,
    withinWindow, isLocked, eligible, isDue, dueOrders, assign, nextForCaller, summary,
  };
});
