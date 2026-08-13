/* ============================================================
   Jeopardy — answer-timer core (PURE, spec §12)
   The block-countdown math and the settings normaliser. No DOM,
   no timers, no app globals — the only side effect is attaching
   the export. Runs in the browser (globalThis.TimerCore) and in
   Node (module.exports) so the node:test suite can exercise it.
   The DOM half (window.GameTimer) lives in js/timer.js.
   ============================================================ */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TimerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // TV-podium style: an odd number of blocks, one pair extinguishing from the
  // outside in per stage, the centre block last. 9 blocks → 5 stages.
  const BLOCKS = 9;
  const STAGES = (BLOCKS + 1) / 2;
  const MAX_SECONDS = 300; // settings clamp — anything longer isn't a timer.

  /**
   * How many blocks are still lit `elapsedMs` into a `totalMs` countdown.
   * Fails closed: a junk duration lights nothing; junk elapsed means "just
   * started" and lights everything.
   * @param {unknown} elapsedMs
   * @param {unknown} totalMs
   * @returns {number} 9, 7, 5, 3, 1 or 0
   */
  function litBlocks(elapsedMs, totalMs) {
    if (typeof totalMs !== "number" || !Number.isFinite(totalMs) || totalMs <= 0) return 0;
    const elapsed =
      typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? Math.max(elapsedMs, 0) : 0;
    if (elapsed >= totalMs) return 0;
    const stage = Math.floor(elapsed / (totalMs / STAGES));
    return BLOCKS - 2 * Math.min(stage, STAGES - 1);
  }

  /**
   * Normalise a timer-length setting: any finite number is rounded and clamped
   * to 0..MAX_SECONDS (0 = timer off); anything else falls back.
   * @param {unknown} value
   * @param {number} fallback
   * @returns {number}
   */
  function normalizeSeconds(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), 0), MAX_SECONDS);
  }

  return { BLOCKS, MAX_SECONDS, litBlocks, normalizeSeconds };
});
