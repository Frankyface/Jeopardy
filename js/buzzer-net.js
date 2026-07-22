/* ============================================================
   Jeopardy — buzzer connection-resilience layer (PURE + config)
   The "some phones can't connect" package (spec §9): the shared ICE
   config used by BOTH peers, the heartbeat/timeout timing constants,
   pure liveness + press-latch + join-attempt helpers (injected clocks
   — no real timers), a pure in-app-browser sniffer, and the broker-
   reconnect controller (§9.5, all effects injected — timers, peer
   access and status render are passed in). No DOM, no PeerJS, no app
   globals: everything here is either pure or effect-injected.
   UMD like buzzer-protocol.js: attaches globalThis.BuzzerNet in the
   browser AND sets module.exports in Node so node:test can import it
   directly. Split out of buzzer-protocol.js purely to keep both files
   under the 800-line house cap; nothing here mutates its inputs.
   ============================================================ */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BuzzerNet = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ============ ICE / PeerJS transport config (spec §9.1) ============ */

  // NOTE: the TURN username/credential below are the Open Relay Project's
  // *intentionally public, shared* constants — the WebRTC equivalent of a public
  // STUN URL, NOT leaked secrets. They carry no account data and anyone may use
  // them. (Verified 2026-07: metered.ca has moved its primary docs to an API-key
  // model, but the static `openrelay.metered.ca` endpoint still resolves and is
  // the only public TURN that needs no backend and no signup — see the
  // implementation report. If it is ever discontinued, ICE simply ignores the
  // dead relay and falls back to STUN — never worse than STUN-only. To upgrade,
  // fetch short-lived credentials from an API-key TURN and swap ICE_SERVERS.)
  const OPEN_RELAY_USER = "openrelayproject";
  const OPEN_RELAY_PASS = "openrelayproject"; // public shared credential — not a secret

  // Kept to 4 entries so ICE gathering stays fast (spec §9.1): two STUN
  // providers, the Open Relay UDP relay on :80, and its TLS relay on :443 —
  // relayed traffic on 443 looks like ordinary HTTPS, so it passes most strict
  // venue/corporate firewalls and CGNAT where STUN alone cannot.
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "turn:openrelay.metered.ca:80", username: OPEN_RELAY_USER, credential: OPEN_RELAY_PASS },
    { urls: "turns:openrelay.metered.ca:443?transport=tcp", username: OPEN_RELAY_USER, credential: OPEN_RELAY_PASS },
  ];

  // Pass as PeerJS's `config` (an RTCConfiguration). BOTH `new Peer(...)` calls
  // (host + player) share this exact object so they negotiate the same relays.
  const PEER_OPTIONS = { config: { iceServers: ICE_SERVERS } };

  /* ============ Heartbeat / timeout timing (spec §9.2–9.3, ms) ============ */

  const CONNECT_TIMEOUT_MS = 15000; // §9.2 player: no data channel in 15s → give up
  const PLAYER_PING_MS = 10000; // §9.3 player pings every 10s
  const PLAYER_STALE_MS = 25000; // §9.3 player: 25s of silence → connection is dead
  const HOST_STALE_MS = 30000; // §9.3 host: 30s of silence from a player → 🔴
  const VISIBILITY_PROBE_MS = 3000; // §9.3 wake-from-sleep probe deadline
  const HEARTBEAT_SWEEP_MS = 5000; // host staleness-poll cadence (implementation detail)

  /* ============ Whole-phase join deadline + press-latch (spec §9.7–9.8) ============ */

  // §9.7: ONE deadline covers the WHOLE join attempt — PeerJS script load, broker
  // registration (peer "open"), AND the DataConnection open — from the moment Join
  // is pressed. A hung 101/pending broker socket fires neither "open" nor "error",
  // so the §9.2 data-channel-only timer never engages; this whole-phase deadline
  // absorbs it. Kept a little shorter than the old 15s so three player attempts
  // still resolve inside a reasonable wait.
  const JOIN_DEADLINE_MS = 12000;
  const JOIN_MAX_ATTEMPTS = 3; // §9.7 player: initial + up to 2 auto-retries
  const HOST_OPEN_ATTEMPTS = 2; // §9.7 host: initial + one auto-retry
  const PRESS_LATCH_MS = 500; // §9.8 a click ≤500ms after a handled press is its ghost

  /* ============ Pure liveness helpers (injected clock) ============ */

  /**
   * A minimal record of when we last heard from the other end. Times are plain
   * numbers so tests can inject a fake clock (no real timers, spec §9.6/U19).
   * @typedef {{lastHeard:number}} Liveness
   */

  /** @param {number} now @returns {Liveness} */
  function createLiveness(now) {
    return { lastHeard: now };
  }

  /** Immutable "we just heard something" stamp. @returns {Liveness} */
  function markHeard(_liveness, now) {
    return { lastHeard: now };
  }

  /** ms elapsed since the last inbound message. @returns {number} */
  function msSinceHeard(liveness, now) {
    return now - (liveness ? liveness.lastHeard : now);
  }

  /**
   * True once `thresholdMs` has passed with no inbound message — the connection
   * should be considered dead (player 25s) or the player 🔴 (host 30s).
   * @returns {boolean}
   */
  function isStale(liveness, now, thresholdMs) {
    return !!liveness && now - liveness.lastHeard >= thresholdMs;
  }

  /**
   * Host-side variant keyed by a raw timestamp (a peer we have never heard from —
   * `undefined`/non-finite — is treated as NOT stale so a just-connected phone is
   * never flagged before its first message lands).
   * @returns {boolean}
   */
  function isStaleAt(lastHeardMs, now, thresholdMs) {
    return Number.isFinite(lastHeardMs) && now - lastHeardMs >= thresholdMs;
  }

  /**
   * Visibility-probe decision (spec §9.3). After the phone becomes visible it
   * sends one probe ping at `probeStartedAt`; it should tear down + fast-reconnect
   * iff the 3s deadline has elapsed AND nothing has been heard since the probe
   * fired (a pong would have bumped `lastHeard` to ≥ probeStartedAt).
   * @returns {boolean}
   */
  function probeFailed(probeStartedAt, liveness, now, deadlineMs) {
    if (now - probeStartedAt < deadlineMs) return false;
    return !liveness || liveness.lastHeard < probeStartedAt;
  }

  /* ============ Press-latch: buzz on press, ignore ghost click (spec §9.8) ============ */

  // §9.8: the buzz fires on CONTACT (pointerdown/touchstart), not release. The
  // browser then also fires a synthetic click for the same interaction; that ghost
  // must be swallowed so one press = one buzz. A click with NO recent press is a
  // keyboard/AT activation (Enter/Space on the focused button) and MUST still buzz.
  // The latch is just the timestamp of the last press; time is injected so this is
  // unit-testable without real clocks (spec §9.9/U20).

  /** @typedef {{pressedAt:number|null}} PressLatch */

  /** @returns {PressLatch} a fresh latch (no press recorded yet). */
  function createPressLatch() {
    return { pressedAt: null };
  }

  /** Immutable "a press just happened at `now`" stamp. @returns {PressLatch} */
  function markPress(_latch, now) {
    return { pressedAt: now };
  }

  /**
   * Is this click the synthetic ghost of a just-handled press (→ ignore it)? True
   * iff a press was stamped within `windowMs` before `now`. A bare click — no press,
   * or a press whose window has expired — is NOT a ghost, so it buzzes (keyboard).
   * @param {PressLatch} latch
   * @param {number} now
   * @param {number} windowMs
   * @returns {boolean}
   */
  function isGhostClick(latch, now, windowMs) {
    if (!latch || !Number.isFinite(latch.pressedAt)) return false;
    return now - latch.pressedAt <= windowMs;
  }

  /* ============ Broker/join-attempt bookkeeping (spec §9.7 — injected clock) ============ */

  /** @typedef {{attempt:number, startedAt:number|null}} JoinAttempts */

  /** @returns {JoinAttempts} attempt counter before the first try. */
  function createJoinAttempts() {
    return { attempt: 0, startedAt: null };
  }

  /**
   * Begin the next attempt: bump the counter and stamp when it started. Immutable.
   * @param {JoinAttempts} attempts
   * @param {number} now
   * @returns {JoinAttempts}
   */
  function beginAttempt(attempts, now) {
    return { attempt: (attempts ? attempts.attempt : 0) + 1, startedAt: now };
  }

  /**
   * Has the whole-phase deadline elapsed for the current attempt? A never-started
   * bookkeeping record (no `startedAt`) is treated as NOT expired.
   * @returns {boolean}
   */
  function joinExpired(attempts, now, deadlineMs) {
    return !!attempts && Number.isFinite(attempts.startedAt) && now - attempts.startedAt >= deadlineMs;
  }

  /** May we still auto-retry (attempt budget not yet spent)? @returns {boolean} */
  function canRetryJoin(attempts, maxAttempts) {
    return !!attempts && attempts.attempt < maxAttempts;
  }

  /** Visible "Connecting… attempt N of M" text for the join screen (spec §9.7). */
  function attemptLabel(attempts, maxAttempts) {
    const n = attempts ? attempts.attempt : 0;
    return `Connecting… attempt ${n} of ${maxAttempts}`;
  }

  /* ============ In-app webview detection (spec §9.4 — hint only) ============ */

  // UA markers for the common in-app browsers that frequently break WebRTC data
  // channels. This is a *hint only* — it must never block joining (spec §9.4).
  const IN_APP_MARKERS = [
    { name: "Instagram", re: /Instagram/i },
    { name: "Facebook", re: /\bFBAN\b|\bFBAV\b|FB_IAB/i },
    { name: "Messenger", re: /Messenger/i },
    { name: "TikTok", re: /musical_ly|BytedanceWebview|\bTikTok\b/i },
    { name: "Snapchat", re: /Snapchat/i },
  ];

  /**
   * Best-effort name of the in-app browser the phone is running inside, or null.
   * @param {string} ua a navigator.userAgent string
   * @returns {string|null}
   */
  function detectInAppBrowser(ua) {
    if (typeof ua !== "string" || !ua) return null;
    for (const m of IN_APP_MARKERS) if (m.re.test(ua)) return m.name;
    return null;
  }

  /** @param {string} ua @returns {boolean} */
  function isInAppBrowser(ua) {
    return detectInAppBrowser(ua) !== null;
  }

  /* ============ Broker health label (spec §9.5) ============ */

  /**
   * Plain-English broker status for the host panel/chip, "" when healthy.
   * @param {"ok"|"reconnecting"|"lost"} status
   * @returns {string}
   */
  function brokerLabel(status) {
    if (status === "reconnecting") return "Reconnecting to the buzzer server… connected players stay in.";
    if (status === "lost") return "Lost the buzzer server — connected players keep working; new joins are paused.";
    return "";
  }

  /* ============ Broker-reconnect controller (spec §9.5) ============ */

  // Default broker-reconnect tuning. Capped exponential backoff; P2P survives a
  // broker blip so a reconnect never tears the room down.
  const MAX_BROKER_RETRIES = 8;
  const BROKER_BASE_MS = 1000;
  const BROKER_MAX_MS = 15000;

  /** Capped exponential backoff for the Nth broker-reconnect retry. @returns {number} ms */
  function brokerBackoffMs(retries, baseMs, maxMs) {
    return Math.min(baseMs * 2 ** retries, maxMs);
  }

  /**
   * Stateful broker-reconnect controller (spec §9.5). Every effect — reading the
   * live Peer, reporting status, scheduling/clearing the retry timer — is INJECTED,
   * so this stays free of DOM/PeerJS/app globals and is unit-testable with fake
   * timers. Behaviour is byte-for-byte the inline host logic it replaced; it lives
   * here so buzzer-host.js keeps under the 800-line house cap (see report).
   * @param {{
   *   getPeer: () => any,
   *   isRoomOpen: () => boolean,
   *   onStatusChange: (status: "ok"|"reconnecting"|"lost") => void,
   *   maxRetries?: number, baseMs?: number, maxMs?: number,
   *   setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (handle: any) => void,
   * }} deps
   */
  function createBrokerController(deps) {
    const maxRetries = deps.maxRetries != null ? deps.maxRetries : MAX_BROKER_RETRIES;
    const baseMs = deps.baseMs != null ? deps.baseMs : BROKER_BASE_MS;
    const maxMs = deps.maxMs != null ? deps.maxMs : BROKER_MAX_MS;
    const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer || ((h) => clearTimeout(h));
    let status = "ok";
    let retries = 0;
    let timer = null;

    function setStatus(next) {
      if (status !== next) { status = next; deps.onStatusChange(next); }
    }
    // Broker drop (disconnected event or post-open network error): keep P2P alive
    // and re-signal with capped backoff; success re-fires "open" → recovered().
    function onDisconnected() {
      const peer = deps.getPeer();
      if (!peer || peer.destroyed || !deps.isRoomOpen() || timer) return;
      if (peer.open) return recovered();
      if (retries >= maxRetries) { setStatus("lost"); return; }
      setStatus("reconnecting");
      const delay = brokerBackoffMs(retries++, baseMs, maxMs);
      timer = setTimer(() => {
        timer = null;
        try {
          const p = deps.getPeer();
          if (p && p.disconnected && typeof p.reconnect === "function") p.reconnect();
        } catch (err) {
          if (typeof console !== "undefined") console.warn("Buzzer broker reconnect failed:", err);
        }
      }, delay);
    }
    function recovered() {
      if (timer) clearTimer(timer);
      timer = null;
      retries = 0;
      setStatus("ok");
    }
    // Teardown/close: forget the retry state silently (no render — the room is going
    // away, other state changes drive the paint).
    function reset() {
      if (timer) clearTimer(timer);
      timer = null;
      retries = 0;
      status = "ok";
    }
    return { onDisconnected, recovered, reset, status: () => status };
  }

  return {
    // transport config
    ICE_SERVERS,
    PEER_OPTIONS,
    // timing
    CONNECT_TIMEOUT_MS,
    PLAYER_PING_MS,
    PLAYER_STALE_MS,
    HOST_STALE_MS,
    VISIBILITY_PROBE_MS,
    HEARTBEAT_SWEEP_MS,
    // whole-phase join deadline + press-latch (spec §9.7–9.8)
    JOIN_DEADLINE_MS,
    JOIN_MAX_ATTEMPTS,
    HOST_OPEN_ATTEMPTS,
    PRESS_LATCH_MS,
    // pure liveness helpers
    createLiveness,
    markHeard,
    msSinceHeard,
    isStale,
    isStaleAt,
    probeFailed,
    // press-latch decision helpers (spec §9.8)
    createPressLatch,
    markPress,
    isGhostClick,
    // broker/join-attempt bookkeeping (spec §9.7)
    createJoinAttempts,
    beginAttempt,
    joinExpired,
    canRetryJoin,
    attemptLabel,
    // in-app-browser hint
    detectInAppBrowser,
    isInAppBrowser,
    // broker health label + reconnect controller
    brokerLabel,
    brokerBackoffMs,
    createBrokerController,
  };
});
