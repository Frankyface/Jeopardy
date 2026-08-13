/* ============================================================
   Jeopardy — buzzer player glue (phone side)
   Runs only in "player mode" (the page URL carries ?room=CODE).
   Loads before app.js so it can claim the page before the host
   game boots. Owns the join screen, the full-screen buzzer, and a
   reconnect loop; folds every host message through the pure
   BuzzerProtocol.playerReduce and renders the result. Defines its
   own tiny DOM helpers because app.js has not loaded yet.
   ============================================================ */

"use strict";

(function () {
  /* ============ Constants ============ */

  const PEER_PREFIX = "ghj-";
  // Same pinned, SRI-verified PeerJS build as the host (see README).
  const PEERJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js";
  const PEERJS_SRI =
    "sha512-XEKeWX+mI3Ov+tg2evDlVQFzVOIp4T8J3cNcCEPaEUGpxJV3eZaN8rHuvnFPvQpGJBHPmrozJDMpm2xcDvtmyQ==";
  const NAME_MAX = 24;
  const CODE_LEN = 4;
  const RECONNECT_MS = 3000;
  const CODE_RE = /^[A-Z2-9]{4}$/;
  const NET = window.BuzzerNet; // connection-resilience layer (spec §9)
  const FAIL_TIP_THRESHOLD = 2; // consecutive connect fails before the tips appear (§9.4)

  const LABELS = {
    idle: "Wait for the host…",
    reading: "Wait for it…",
    armed: "BUZZ!",
    won: "You buzzed in! Answer!",
    taken: "buzzed first",
    locked: "Locked out for this clue",
    lockedEarly: "Too soon! Locked out for this clue",
  };
  // Buttons the player can actually press. `reading` is the RED trap: pressable,
  // and a tap during it early-locks you (the host arbitrates by arrival order).
  const PRESSABLE = new Set(["reading", "armed"]);

  /* ============ Module state ============ */

  let ui = window.BuzzerProtocol.createPlayerUiState();
  let peer = null;
  let conn = null;
  let code = "";
  let playerName = "";
  let connecting = false;
  let connLive = false;
  let wantConnected = false;
  let reconnectTimer = null;
  // Connection-resilience timers + counters (spec §9.2–9.4, §9.7).
  let joinDeadline = null; // §9.7 whole-phase join deadline (load + peer open + channel)
  let joinAttempts = { attempt: 0, startedAt: null }; // §9.7 attempt bookkeeping
  let everConnected = false; // has a channel opened this session? (reconnect vs first join)
  let pingTimer = null; // 10s ping cadence
  let livenessTimer = null; // staleness poll
  let probeTimer = null; // visibility-probe deadline
  let liveness = null; // BuzzerNet last-heard record
  let failCount = 0; // consecutive connect failures
  let peerJsPromise = null;
  let wakeLock = null;
  // Local "I submitted the current form" latch — cleared whenever a host
  // message advances the screen (or rejects the input). Never leaves this file.
  let sent = false;

  /* ============ DOM helpers (self-contained) ============ */

  const $$ = (id) => document.getElementById(id);

  function pel(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pshow(node, visible) {
    if (node) node.classList.toggle("hidden", !visible);
  }

  function isPlayerMode() {
    return new URLSearchParams(location.search).has("room");
  }

  /** "$1,200" / "-$50" — mirrors app.js formatMoney for the phone. */
  function money(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v).toLocaleString("en-US");
    return v < 0 ? `-$${abs}` : `$${abs}`;
  }

  /** Signed delta for the result screen, e.g. "+$800" / "-$300". */
  function signed(n) {
    const v = Number(n) || 0;
    return (v < 0 ? "-" : "+") + `$${Math.abs(v).toLocaleString("en-US")}`;
  }

  /* ============ PeerJS lazy load ============ */

  function loadPeerJs() {
    if (window.peerjs && window.peerjs.Peer) return Promise.resolve();
    if (peerJsPromise) return peerJsPromise;
    peerJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PEERJS_URL;
      script.integrity = PEERJS_SRI;
      script.crossOrigin = "anonymous";
      script.async = true;
      script.onload = () =>
        window.peerjs && window.peerjs.Peer
          ? resolve()
          : reject(new Error("PeerJS loaded but global missing"));
      script.onerror = () => reject(new Error("Failed to load PeerJS from CDN"));
      document.head.appendChild(script);
    });
    return peerJsPromise;
  }

  /* ============ Connection ============ */

  function join() {
    const rawCode = ($$("player-code").value || "").trim().toUpperCase();
    const rawName = ($$("player-name").value || "").trim();
    if (!CODE_RE.test(rawCode)) {
      setNotice("Enter the 4-letter room code.");
      return;
    }
    if (!rawName) {
      setNotice("Enter your name.");
      return;
    }
    code = rawCode;
    playerName = rawName.slice(0, NAME_MAX);
    wantConnected = true;
    joinAttempts = NET.createJoinAttempts(); // fresh §9.7 attempt sequence
    connect();
  }

  function connect() {
    // §9.7: begin an attempt and arm ONE deadline covering the WHOLE join — script
    // load, broker registration (peer "open"), AND the data channel. A hung
    // 101/pending broker socket fires neither "open" nor "error", so without this
    // whole-phase deadline nothing downstream would ever time out.
    joinAttempts = NET.beginAttempt(joinAttempts, Date.now());
    connecting = true;
    setNotice("");
    armJoinDeadline();
    render();
    loadPeerJs().then(openPeer).catch(() => attemptFailed("Can't reach the buzzer server. Check your internet.", false));
  }

  function armJoinDeadline() {
    clearTimeout(joinDeadline);
    joinDeadline = setTimeout(onJoinDeadline, NET.JOIN_DEADLINE_MS);
  }

  function onJoinDeadline() {
    joinDeadline = null;
    if (connLive) return; // the channel opened in time — nothing to do
    attemptFailed("Couldn't reach the buzzer server. Tap Join to try again.", false);
  }

  // Single "this attempt failed" path (§9.7). A wrong CODE (peer-unavailable) is a
  // hard stop — not a connectivity failure, so no §9.4 tip counter and no retry. A
  // failure AFTER we were once connected hands back to the §9.3 reconnect loop.
  // Otherwise (first-join connectivity failure) auto-retry up to JOIN_MAX_ATTEMPTS,
  // then rest on the error + tips (the player can always tap Join again).
  function attemptFailed(message, wrongCode) {
    clearTimeout(joinDeadline);
    joinDeadline = null;
    connecting = false;
    teardownPeer();
    if (wrongCode) { onConnectFail(message); return; }
    if (everConnected) { dropped(); return; }
    noteFailure();
    if (NET.canRetryJoin(joinAttempts, NET.JOIN_MAX_ATTEMPTS)) connect();
    else onConnectFail(message);
  }

  function openPeer() {
    teardownPeer();
    try {
      // Shared resilient ICE (STUN + Open Relay TURN/TURNS) — the same config the
      // host uses (spec §9.1) so symmetric-NAT/CGNAT phones can open a channel.
      const opts = NET && NET.PEER_OPTIONS;
      peer = opts ? new window.peerjs.Peer(undefined, opts) : new window.peerjs.Peer();
    } catch (err) {
      console.warn("Buzzer player peer error:", err);
      attemptFailed("This browser can't use buzzers.", true);
      return;
    }
    peer.on("open", () => openConnection());
    peer.on("error", handlePeerError);
    peer.on("disconnected", () => dropped());
  }

  function openConnection() {
    try {
      conn = peer.connect(PEER_PREFIX + code, { serialization: "json", metadata: { name: playerName } });
    } catch (err) {
      console.warn("Buzzer player connect error:", err);
      attemptFailed("Couldn't reach that room.", false);
      return;
    }
    // The whole-phase deadline (§9.7, armed in connect) already covers the data
    // channel, so there is no separate §9.2 data-channel timer to arm here.
    conn.on("open", () => {
      connecting = false;
      connLive = true;
      everConnected = true;
      // Any pre-drop clock is stale — the host's rejoin sync brings the true
      // remaining time. Without this, the render below would briefly restart
      // a FULL countdown from the old ui (spec §12.3).
      ui = { ...ui, timerSeconds: null, timerTotalSeconds: null };
      failCount = 0; // a clean connection resets the failure guidance (§9.4)
      clearTimeout(joinDeadline);
      joinDeadline = null;
      joinAttempts = NET.createJoinAttempts(); // later drops use the §9.3 loop, not §9.7
      cancelReconnect();
      startHeartbeat();
      safeSend({ v: 1, t: "join", name: playerName });
      acquireWakeLock();
      render();
    });
    conn.on("data", handleMessage);
    conn.on("close", () => dropped());
    conn.on("error", (err) => console.warn("Buzzer player connection error:", err));
  }

  function handleMessage(data) {
    liveness = NET.markHeard(liveness, Date.now()); // any host message = liveness (§9.3)
    const prevMode = ui.mode;
    const next = window.BuzzerProtocol.playerReduce(ui, data);
    if (next === ui) return; // junk / ignorable message (e.g. pong) — liveness noted above
    ui = next;
    // Any accepted host message either advances the screen or rejects our input,
    // so the local "submitted" latch no longer applies.
    sent = false;
    const msg = window.BuzzerProtocol.validateMessage(data);
    if (msg && (msg.t === "reject" || msg.t === "room-closed")) {
      // Host refused us or closed the room: stop retrying, drop the peer.
      wantConnected = false;
      connLive = false;
      cancelReconnect();
      releaseWakeLock();
      teardownPeer();
    } else if (ui.mode !== prevMode && (ui.mode === "armed" || ui.mode === "won")) {
      vibrate();
    }
    render();
  }

  function handlePeerError(err) {
    const type = err && err.type;
    // A wrong CODE is a hard stop, NOT a connectivity failure (no §9.4 tips, no
    // retry). Network/socket errors during a join ARE connectivity failures → the
    // attempt path retries (first join) or hands off to the reconnect loop (§9.3).
    if (type === "peer-unavailable") {
      attemptFailed("No room with that code — check with the host.", true);
      return;
    }
    if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
      attemptFailed("Can't reach the buzzer server.", false);
      return;
    }
    if (type === "browser-incompatible") {
      attemptFailed("This browser can't use buzzers.", true);
      return;
    }
    console.warn("Buzzer player peer error:", err);
  }

  function onConnectFail(message) {
    connecting = false;
    connLive = false;
    ui = { ...ui, screen: "join", notice: message };
    render();
  }

  function dropped() {
    connLive = false;
    releaseWakeLock();
    render();
    if (wantConnected) scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (wantConnected && !connLive) connect();
    }, RECONNECT_MS);
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /* ============ Heartbeat, connect timeout + failure guidance (spec §9.2–9.4) ============ */

  function startHeartbeat() {
    stopHeartbeat();
    liveness = NET.createLiveness(Date.now());
    pingTimer = setInterval(() => safeSend({ v: 1, t: "ping" }), NET.PLAYER_PING_MS);
    livenessTimer = setInterval(checkLiveness, NET.HEARTBEAT_SWEEP_MS);
  }

  function stopHeartbeat() {
    if (pingTimer) clearInterval(pingTimer);
    if (livenessTimer) clearInterval(livenessTimer);
    if (probeTimer) clearTimeout(probeTimer);
    pingTimer = livenessTimer = probeTimer = null;
  }

  // 25s of silence (no pong / host message) = a dead connection → reconnect (§9.3).
  function checkLiveness() {
    if (connLive && NET.isStale(liveness, Date.now(), NET.PLAYER_STALE_MS)) heartbeatLost();
  }

  // Wake-from-sleep probe (§9.3): on becoming visible, ping and demand a pong within
  // 3s; no reply → fast reconnect (~3s, not the ~30s the plain staleness path takes).
  function probeConnection() {
    if (!connLive) return;
    safeSend({ v: 1, t: "ping" });
    const started = Date.now();
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (connLive && NET.probeFailed(started, liveness, Date.now(), NET.VISIBILITY_PROBE_MS)) heartbeatLost();
    }, NET.VISIBILITY_PROBE_MS + 50);
  }

  function heartbeatLost() {
    teardownPeer(); // also stops the heartbeat + connect timer
    dropped(); // → "Reconnecting…" UI + the existing reconnect loop
  }

  // A connectivity failure (timeout / network / load) — NOT a wrong code — bumps the
  // counter that expands the join-screen tips after two in a row (§9.4).
  function noteFailure() {
    failCount += 1;
  }

  function leave() {
    wantConnected = false;
    connLive = false;
    everConnected = false;
    sent = false;
    clearTimeout(joinDeadline);
    joinDeadline = null;
    joinAttempts = NET.createJoinAttempts();
    cancelReconnect();
    releaseWakeLock();
    teardownPeer();
    ui = window.BuzzerProtocol.createPlayerUiState();
    render();
  }

  // NOTE: teardownPeer does NOT touch joinDeadline — the whole-phase deadline is a
  // join-attempt concern owned by connect()/attemptFailed(), and openPeer() calls
  // teardownPeer() while that deadline is deliberately still armed (spec §9.7).
  function teardownPeer() {
    stopHeartbeat();
    try {
      if (conn && typeof conn.close === "function") conn.close();
    } catch (err) {
      console.warn("Buzzer player close failed:", err);
    }
    try {
      if (peer && typeof peer.destroy === "function") peer.destroy();
    } catch (err) {
      console.warn("Buzzer player destroy failed:", err);
    }
    conn = null;
    peer = null;
  }

  function safeSend(msg) {
    try {
      if (conn && conn.open !== false) conn.send(msg);
    } catch (err) {
      console.warn("Buzzer player send failed:", err);
    }
  }

  function sendBuzz() {
    // Send during reading too — the host locks an early tap out, but a tap on the
    // knife-edge of arming is forgiven by arrival order (spec §5). Idle/won/etc.
    // are disabled buttons, so they never reach here.
    if (!PRESSABLE.has(ui.mode)) return;
    safeSend({ v: 1, t: "buzz" });
  }

  /* ============ Buzz on press, not release (spec §9.8) ============ */

  // The buzz fires on CONTACT (pointerdown, or touchstart where Pointer Events are
  // unavailable), not on click/release — a release costs 50–100 ms of reaction time
  // and feels mushy. preventDefault suppresses the synthetic ghost click that
  // follows; the shared BuzzerNet press-latch swallows that ghost so one press = one
  // buzz, while a bare click with NO preceding press (keyboard Enter/Space, assistive
  // tech) still buzzes. Fires in BOTH armed and reading modes — sendBuzz gates the
  // mode, so the reading-phase early tap triggers on contact too (consistent physics).
  function makeBuzzHandlers(buzz, clock) {
    const nowFn = clock || Date.now;
    let latch = NET.createPressLatch();
    return {
      press(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        latch = NET.markPress(latch, nowFn());
        buzz();
      },
      click(event) {
        if (NET.isGhostClick(latch, nowFn(), NET.PRESS_LATCH_MS)) return; // ghost of a handled press
        buzz(); // bare click = keyboard / assistive-tech activation
      },
    };
  }

  function wireBuzz(button, buzz, clock) {
    const h = makeBuzzHandlers(buzz, clock);
    if (window.PointerEvent) button.addEventListener("pointerdown", h.press);
    else button.addEventListener("touchstart", h.press, { passive: false });
    button.addEventListener("click", h.click);
    return h;
  }

  function submitWager() {
    if (ui.screen !== "dd-wager" && ui.screen !== "final-wager") return;
    const raw = ($$("player-wager-input").value || "").trim();
    const amount = Number.parseInt(raw, 10);
    if (!Number.isFinite(amount)) {
      setNotice("Enter a whole-number wager.");
      return;
    }
    // The host re-validates against the real bounds and may reject us.
    const t = ui.screen === "dd-wager" ? "dd-wager" : "final-wager";
    safeSend({ v: 1, t, amount });
    ui = { ...ui, notice: null };
    sent = true;
    render();
  }

  function submitAnswer() {
    if (ui.screen !== "final-answer") return;
    const text = $$("player-answer-input").value || "";
    safeSend({ v: 1, t: "final-answer", text });
    sent = true; // stays editable — players may resubmit until the host reveals
    render();
  }

  /* ============ Haptics + wake lock (feature-detected) ============ */

  function vibrate() {
    try {
      if (navigator && typeof navigator.vibrate === "function") navigator.vibrate(50);
    } catch (err) {
      /* best-effort */
    }
  }

  function acquireWakeLock() {
    try {
      if (!navigator.wakeLock || wakeLock) return;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          wakeLock = lock;
          lock.addEventListener("release", () => {
            wakeLock = null;
          });
        })
        .catch(() => {
          /* unsupported or denied — silently skip */
        });
    } catch (err) {
      /* iOS Safari < 16.4 etc. — ignore */
    }
  }

  function releaseWakeLock() {
    try {
      if (wakeLock && typeof wakeLock.release === "function") wakeLock.release();
    } catch (err) {
      /* ignore */
    }
    wakeLock = null;
  }

  /* ============ Rendering ============ */

  function setNotice(msg) {
    ui = { ...ui, notice: msg || null };
    render();
  }

  function render() {
    const join = $$("player-join");
    const buzzer = $$("player-buzzer");
    if (!join || !buzzer) return;
    const view = resolveView();
    pshow(join, view === "join");
    pshow(buzzer, view === "buzzer");
    pshow($$("player-wager"), view === "wager");
    pshow($$("player-answer"), view === "answer");
    pshow($$("player-message"), view === "message");
    if (view === "join") renderJoin();
    else if (view === "buzzer") renderBuzzer();
    else if (view === "wager") renderWager();
    else if (view === "answer") renderAnswer();
    else renderMessage();
    syncPhoneTimers(view);
  }

  /**
   * Keep the phone's answer-clock bars in step with the reduced UI (spec §12).
   * Declarative via GameTimer.sync: an unchanged key never resets a ticking
   * clock, so re-renders (notices, reconnect dots) don't restart the countdown.
   * Distinct buzz-holds always pass through idle/armed in between, which nulls
   * the key and re-arms a fresh start.
   */
  function syncPhoneTimers(view) {
    const GT = window.GameTimer;
    if (!GT) return;
    const secs = ui.timerSeconds;
    const total = ui.timerTotalSeconds; // rejoin syncs carry the original length
    const onClock = ui.mode === "won" || ui.mode === "taken";
    const buzzKey =
      view === "buzzer" && connLive && onClock && secs ? `${ui.mode}:${secs}` : null;
    GT.sync("phoneBuzz", buzzKey, secs, total);
    const answerKey = view === "answer" && connLive && secs ? `answer:${secs}` : null;
    GT.sync("phoneAnswer", answerKey, secs, total);
  }

  /** Map the reduced screen + live-connection flag onto one visible container. */
  function resolveView() {
    const s = ui.screen;
    if (s === "join") return "join";
    if (s === "buzzer") return "buzzer"; // its button self-shows "Reconnecting…"
    if (!connLive) return "message"; // any podium screen while dropped
    if (s === "dd-wager" || s === "final-wager") return "wager";
    if (s === "final-answer") return "answer";
    return "message"; // final-waiting / final-result
  }

  function renderJoin() {
    const err = $$("player-error");
    if (err) err.textContent = ui.notice || "";
    const btn = $$("player-join-btn");
    if (btn) {
      btn.disabled = connecting;
      // §9.7: while connecting, show the visible attempt counter ("Connecting…
      // attempt N of 3") so a stalled broker phase never looks like a dead button.
      btn.textContent = connecting ? NET.attemptLabel(joinAttempts, NET.JOIN_MAX_ATTEMPTS) : "Join";
    }
    renderJoinExtras();
  }

  // Proactive in-app-browser advisory + post-failure connection tips (spec §9.4).
  // Built here with textContent only (index.html has no elements for them); both are
  // hints that only appear when relevant — they never block joining.
  function renderJoinExtras() {
    const host = $$("player-join");
    if (!host || !NET) return;
    const app = NET.detectInAppBrowser(navigator.userAgent);
    let hint = $$("player-webview-hint");
    if (app && !hint) {
      hint = pel("p", "player-webview-hint");
      hint.id = "player-webview-hint";
      const label = $$("player-code") ? $$("player-code").closest("label") : null;
      if (label) host.insertBefore(hint, label);
      else host.appendChild(hint);
    }
    if (hint) {
      pshow(hint, !!app);
      if (app) {
        hint.textContent = `Opened inside the ${app} app? Buzzers may not connect — tap ⋯ and “Open in Safari/Chrome”.`;
      }
    }
    let tips = $$("player-tips");
    const showTips = failCount >= FAIL_TIP_THRESHOLD;
    if (showTips && !tips) {
      tips = buildTips();
      const err = $$("player-error");
      if (err && err.parentNode) err.parentNode.insertBefore(tips, err.nextSibling);
      else host.appendChild(tips);
    }
    if (tips) pshow(tips, showTips);
  }

  function buildTips() {
    const box = pel("div", "player-tips");
    box.id = "player-tips";
    box.appendChild(pel("p", "player-tips-title", "Still can’t connect? Try:"));
    const ul = pel("ul", "player-tips-list");
    [
      "Join the same Wi-Fi as the host",
      "Switch between Wi-Fi and mobile data",
      "If you opened this from a chat app, open it in Safari or Chrome instead",
    ].forEach((t) => ul.appendChild(pel("li", null, t)));
    box.appendChild(ul);
    return box;
  }

  function renderBuzzer() {
    $$("player-head-code").textContent = code;
    $$("player-head-name").textContent = ui.playerName || playerName;
    const dot = $$("player-head-dot");
    if (dot) {
      dot.textContent = connLive ? "🟢" : "🔴";
      dot.setAttribute("aria-label", connLive ? "Connected" : "Reconnecting");
    }
    const note = $$("player-buzz-note");
    if (note) note.textContent = connLive ? ui.notice || "" : "";
    renderBuzzButton();
  }

  function renderBuzzButton() {
    const btn = $$("player-buzz");
    if (!btn) return;
    const mode = connLive ? ui.mode : "idle";
    btn.className = `player-buzz-btn mode-${mode}`;
    btn.disabled = !PRESSABLE.has(mode);
    btn.textContent = buzzLabel(mode);
  }

  function buzzLabel(mode) {
    if (!connLive) return "Reconnecting…";
    if (mode === "taken") return `${ui.by || "Someone"} ${LABELS.taken}`;
    if (mode === "locked" && ui.lockReason === "early") return LABELS.lockedEarly;
    return LABELS[mode] || LABELS.idle;
  }

  function renderWager() {
    const p = ui.prompt || {};
    const isDd = ui.screen === "dd-wager";
    $$("player-wager-title").textContent = isDd
      ? "Daily Double — your wager"
      : "Final Jeopardy — your wager";
    $$("player-wager-cat").textContent = p.category || "";
    const lo = Number.isFinite(p.min) ? p.min : 0;
    const hi = Number.isFinite(p.max) ? p.max : 0;
    $$("player-wager-meta").textContent =
      `Your score ${money(p.score)} · wager ${money(lo)}–${money(hi)}`;
    const input = $$("player-wager-input");
    input.min = String(lo);
    input.max = String(hi);
    $$("player-wager-error").textContent = ui.notice || "";
    const submit = $$("player-wager-submit");
    submit.disabled = sent;
    submit.textContent = sent
      ? (isDd ? "Wager sent — look up!" : "Wager locked in")
      : "Submit wager";
  }

  function renderAnswer() {
    const p = ui.prompt || {};
    $$("player-answer-cat").textContent = p.category || "";
    $$("player-answer-clue").textContent = p.clue || "";
    $$("player-answer-note").textContent = sent
      ? "Answer submitted — you can update it until the host reveals."
      : "";
    $$("player-answer-submit").textContent = sent ? "Update answer" : "Submit answer";
  }

  function renderMessage() {
    const title = $$("player-message-title");
    const sub = $$("player-message-sub");
    if (!connLive) {
      title.textContent = "Reconnecting…";
      sub.textContent = "Hang tight — your buzzer will be back.";
      return;
    }
    if (ui.screen === "final-waiting") {
      title.textContent = "Pencils down";
      sub.textContent = "The host is checking answers…";
      return;
    }
    const r = ui.result || { correct: false, delta: 0, score: 0 };
    title.textContent = r.correct ? "Correct!" : "Sorry — incorrect";
    sub.textContent = `${signed(r.delta)} · you finished on ${money(r.score)}`;
  }

  /* ============ Boot ============ */

  function prefillCode() {
    const param = (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
    const field = $$("player-code");
    if (field && CODE_RE.test(param)) field.value = param;
  }

  function wireEvents() {
    const joinBtn = $$("player-join-btn");
    if (joinBtn) joinBtn.addEventListener("click", join);
    const nameField = $$("player-name");
    if (nameField) {
      nameField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") join();
      });
    }
    const buzzBtn = $$("player-buzz");
    if (buzzBtn) wireBuzz(buzzBtn, sendBuzz); // §9.8: press (pointerdown/touchstart), not release
    const leaveBtn = $$("player-leave");
    if (leaveBtn) leaveBtn.addEventListener("click", leave);

    const wagerBtn = $$("player-wager-submit");
    if (wagerBtn) wagerBtn.addEventListener("click", submitWager);
    const wagerInput = $$("player-wager-input");
    if (wagerInput) {
      wagerInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitWager();
      });
    }
    const answerBtn = $$("player-answer-submit");
    if (answerBtn) answerBtn.addEventListener("click", submitAnswer);
    const answerInput = $$("player-answer-input");
    if (answerInput) {
      answerInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitAnswer();
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !connLive) return;
      acquireWakeLock();
      probeConnection(); // recover a slept radio in ~3s instead of ~30 (spec §9.3)
    });
  }

  function boot() {
    if (!isPlayerMode()) return;
    document.body.classList.add("player-mode");
    const section = $$("screen-player");
    if (section) section.classList.remove("hidden");
    prefillCode();
    wireEvents();
    render();
  }

  // Test seam (mirrors BuzzerHost's _init): lets tests/harness.html drive the real
  // buzz press/click wiring against a fake button + injected clock, without booting
  // the whole player. Production code never reads this.
  window.BuzzerPlayer = { _wireBuzz: wireBuzz, _makeBuzzHandlers: makeBuzzHandlers };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
