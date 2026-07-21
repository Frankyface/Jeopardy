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
    connect();
  }

  function connect() {
    connecting = true;
    setNotice("");
    render();
    loadPeerJs().then(openPeer).catch(() => onConnectFail("Can't reach the buzzer server. Check your internet."));
  }

  function openPeer() {
    teardownPeer();
    try {
      peer = new window.peerjs.Peer();
    } catch (err) {
      onConnectFail("This browser can't use buzzers.");
      console.warn("Buzzer player peer error:", err);
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
      onConnectFail("Couldn't reach that room.");
      console.warn("Buzzer player connect error:", err);
      return;
    }
    conn.on("open", () => {
      connecting = false;
      connLive = true;
      cancelReconnect();
      safeSend({ v: 1, t: "join", name: playerName });
      acquireWakeLock();
      render();
    });
    conn.on("data", handleMessage);
    conn.on("close", () => dropped());
    conn.on("error", (err) => console.warn("Buzzer player connection error:", err));
  }

  function handleMessage(data) {
    const prevMode = ui.mode;
    const next = window.BuzzerProtocol.playerReduce(ui, data);
    if (next === ui) return; // junk / ignorable message
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
    if (type === "peer-unavailable") {
      onConnectFail("No room with that code — check with the host.");
      return;
    }
    if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
      onConnectFail("Can't reach the buzzer server. Retrying…");
      dropped();
      return;
    }
    if (type === "browser-incompatible") {
      onConnectFail("This browser can't use buzzers.");
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

  function leave() {
    wantConnected = false;
    connLive = false;
    sent = false;
    cancelReconnect();
    releaseWakeLock();
    teardownPeer();
    ui = window.BuzzerProtocol.createPlayerUiState();
    render();
  }

  function teardownPeer() {
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
      btn.textContent = connecting ? "Connecting…" : "Join";
    }
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
    if (buzzBtn) buzzBtn.addEventListener("click", sendBuzz);
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
      if (document.visibilityState === "visible" && connLive) acquireWakeLock();
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
