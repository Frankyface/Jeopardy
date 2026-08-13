/* ============================================================
   Jeopardy — answer-timer DOM glue (spec §12)
   Owns the four red-block countdown bars (host clue modal, host
   Final modal, phone buzzer, phone Final answer). Purely a visual
   cue: hitting zero flashes the bar and nothing else — no auto
   scoring, closing, or locking anywhere. Countdown state is
   ephemeral module state, never serialised (a refresh simply
   drops the clock). The math lives in TimerCore (pure, tested);
   this file only paints it. Loads before app.js and the buzzer
   modules; every caller optional-chains window.GameTimer, so the
   game runs unchanged if this script fails to load.
   ============================================================ */

"use strict";

const GameTimer = (function () {
  const TICK_MS = 100;

  /** Fixed slots — each one is a container div in index.html. */
  const SLOTS = {
    clue: "clue-timer", // host clue modal (buzz answer + Daily Double)
    final: "final-timer", // host Final Jeopardy modal
    phoneBuzz: "player-timer", // phone buzzer screen (won/taken)
    phoneAnswer: "player-answer-timer", // phone Final typed-answer screen
  };

  /** @type {Map<string, {intervalId:number, startAt:number, totalMs:number, key:string|null}>} */
  const running = new Map();

  function core() {
    return window.TimerCore || null;
  }

  function slotNode(slot) {
    const id = SLOTS[slot];
    return id ? document.getElementById(id) : null;
  }

  function buildBlocks(host, count) {
    host.replaceChildren();
    for (let i = 0; i < count; i += 1) {
      const block = document.createElement("span");
      block.className = "timer-block";
      host.appendChild(block);
    }
  }

  /**
   * Start (or restart) a slot's countdown with `seconds` left on the clock.
   * `totalSeconds` (defaulting to `seconds`) is the countdown's ORIGINAL
   * length: a rejoining phone passes both so its bar resumes at the true
   * stage instead of lighting a fresh full strip (spec §12.3). Seconds ≤ 0,
   * a missing container, or a missing core all mean "no timer" — do nothing.
   * @param {string} slot
   * @param {unknown} seconds
   * @param {string|null} [key] identity token used by sync() idempotence.
   * @param {unknown} [totalSeconds]
   */
  function start(slot, seconds, key, totalSeconds) {
    stop(slot);
    const tc = core();
    const node = slotNode(slot);
    const secs = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
    if (!tc || !node || secs <= 0) return;
    const totalSecs =
      typeof totalSeconds === "number" && Number.isFinite(totalSeconds) && totalSeconds > secs
        ? totalSeconds
        : secs;
    buildBlocks(node, tc.BLOCKS);
    node.classList.remove("hidden", "timer-done");
    const entry = {
      startAt: Date.now() - (totalSecs - secs) * 1000, // back-dated by the elapsed part
      totalMs: totalSecs * 1000,
      key: key || null,
      intervalId: 0,
      lastLit: -1,
    };
    entry.intervalId = window.setInterval(() => tick(slot, entry), TICK_MS);
    running.set(slot, entry);
    tick(slot, entry); // paint the current bar immediately
  }

  function tick(slot, entry) {
    const tc = core();
    const node = slotNode(slot);
    if (!tc || !node) {
      window.clearInterval(entry.intervalId);
      running.delete(slot);
      return;
    }
    const lit = tc.litBlocks(Date.now() - entry.startAt, entry.totalMs);
    if (lit === entry.lastLit) return; // only 6 of ~100s worth of ticks repaint
    entry.lastLit = lit;
    const blocks = node.children;
    // Blocks extinguish pairwise from the ends: the lit ones are the centred `lit`.
    const firstLit = (tc.BLOCKS - lit) / 2;
    for (let i = 0; i < blocks.length; i += 1) {
      blocks[i].classList.toggle("off", i < firstLit || i >= firstLit + lit);
    }
    if (lit === 0 && entry.intervalId) {
      // Time's up: freeze the bar, flash it (CSS), change nothing else. The
      // expired entry stays registered so remaining() reports 0 and a later
      // stop()/sync() still cleans the DOM.
      window.clearInterval(entry.intervalId);
      entry.intervalId = 0;
      node.classList.add("timer-done");
    }
  }

  /** Stop a slot and hide its bar. Safe to call when nothing is running. */
  function stop(slot) {
    const entry = running.get(slot);
    if (entry) {
      if (entry.intervalId) window.clearInterval(entry.intervalId);
      running.delete(slot);
    }
    const node = slotNode(slot);
    if (node && (entry || !node.classList.contains("hidden"))) {
      node.classList.add("hidden");
      node.classList.remove("timer-done");
      node.replaceChildren();
    }
  }

  /**
   * Whole seconds left on a slot's clock (0 when idle or expired). Used to
   * hand a rejoining phone the REMAINING clock, not a fresh one (spec §12).
   * @returns {number}
   */
  function remaining(slot) {
    const entry = running.get(slot);
    if (!entry) return 0;
    const leftMs = entry.totalMs - (Date.now() - entry.startAt);
    return leftMs > 0 ? Math.ceil(leftMs / 1000) : 0;
  }

  /** A slot's original countdown length in whole seconds (0 when idle). */
  function total(slot) {
    const entry = running.get(slot);
    return entry ? Math.round(entry.totalMs / 1000) : 0;
  }

  /**
   * Declarative form for render loops: keep the slot running while `key` is
   * truthy and unchanged, (re)start it when the key changes, stop it when the
   * key is null. Calling every render is safe — an unchanged key never resets
   * a ticking clock.
   */
  function sync(slot, key, seconds, totalSeconds) {
    const entry = running.get(slot);
    if (!key) {
      if (entry) stop(slot);
      return;
    }
    if (entry && entry.key === key) return;
    start(slot, seconds, key, totalSeconds);
  }

  return { start, stop, remaining, total, sync };
})();

window.GameTimer = GameTimer;
