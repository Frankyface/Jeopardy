/* ============================================================
   Jeopardy — buzzer connection-resilience layer (PURE + config)
   The "some phones can't connect" package (spec §9): the shared ICE
   config used by BOTH peers, the heartbeat/timeout timing constants,
   pure liveness helpers (injected clocks — no real timers), and a
   pure in-app-browser sniffer. No DOM, no PeerJS, no app globals.
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
    // pure liveness helpers
    createLiveness,
    markHeard,
    msSinceHeard,
    isStale,
    isStaleAt,
    probeFailed,
    // in-app-browser hint
    detectInAppBrowser,
    isInAppBrowser,
    // broker health label
    brokerLabel,
  };
});
