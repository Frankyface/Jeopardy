/* ============================================================
   Jeopardy — buzzer host glue (transport + DOM)
   Lazy-loads PeerJS the first time a room is opened, owns the peer
   + connection map, feeds incoming messages through the pure
   reducer (BuzzerProtocol.roomReduce) and carries out its effects,
   and renders the host-side buzzer UI (setup panel, topbar chip +
   popover, clue-modal buzz bar). All non-serialisable state (Peer,
   connections, armed/winner/lockout) lives here in module scope —
   only { roomCode } ever reaches app state.

   Shares the global scope with app.js, so it reuses app's globals
   directly: state, setState, el, $, show, MAX_PLAYERS, judgeCorrect,
   judgeWrong. Every hook is optional-chained by app.js, so the game
   runs unchanged if this script fails to load.
   ============================================================ */

"use strict";

const BuzzerHost = (function () {
  /* ============ Constants ============ */

  const PEER_PREFIX = "ghj-";
  // Pinned, SRI-verified PeerJS build (see README). Loaded lazily on first use.
  const PEERJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js";
  const PEERJS_SRI =
    "sha512-XEKeWX+mI3Ov+tg2evDlVQFzVOIp4T8J3cNcCEPaEUGpxJV3eZaN8rHuvnFPvQpGJBHPmrozJDMpm2xcDvtmyQ==";
  const MAX_MSGS_PER_SEC = 20;
  const MAX_OPEN_RETRIES = 5;
  const CLOSE_FLUSH_MS = 400; // let a final message flush before closing a conn.
  const BEEP_HZ = 880;
  const BEEP_MS = 150;
  const HOTKEY_DEBOUNCE_MS = 300; // Space arm/disarm debounce.

  /* ============ Module state (never serialised) ============ */

  let roomState = window.BuzzerProtocol.createRoomState();
  let roomCode = null;
  /** @type {"closed"|"connecting"|"open"|"error"} */
  let roomStatus = "closed";
  let roomError = null;
  let peer = null;
  /** @type {Map<string, any>} */
  const connections = new Map();
  /** @type {Map<string, number[]>} */
  const msgTimes = new Map();
  let customPeerFactory = null; // set by _init() for the loopback harness.
  let peerJsPromise = null;
  let openRetries = 0;
  let popoverOpen = false;
  let soundOn = true;
  let audioCtx = null;
  let idCounter = 0;
  let wired = false;
  let lastToggleAt = 0; // for the Space-hotkey debounce.

  /* ============ App-global bridges (defensive) ============ */

  function appState() {
    return typeof state !== "undefined" ? state : null;
  }
  function maxPlayers() {
    return typeof MAX_PLAYERS !== "undefined" ? MAX_PLAYERS : 8;
  }
  function genPlayerId() {
    idCounter += 1;
    return `bz${Date.now()}-${idCounter}`;
  }
  function connectedCount() {
    return Object.keys(roomState.players).filter((id) => roomState.players[id].connected).length;
  }

  // The buzz bar is "live" (arming is possible) only during an open, unrevealed,
  // regular clue with at least one connected player. The Space hotkey and the
  // arm/disarm affordance are both scoped to this — outside it Space is untouched.
  function isBuzzBarLive() {
    const active = appState()?.active;
    return (
      roomStatus === "open" &&
      !!active &&
      !active.isDailyDouble &&
      !active.revealed &&
      connectedCount() > 0
    );
  }

  function isEditorOpen() {
    return !!(document.body && document.body.classList.contains("editor-open"));
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

  function createPeer(id) {
    if (customPeerFactory) return customPeerFactory(id);
    return new window.peerjs.Peer(id);
  }

  /* ============ Room lifecycle ============ */

  function openRoom(code) {
    if (roomStatus === "connecting" || roomStatus === "open") return;
    roomStatus = "connecting";
    roomError = null;
    renderAll();
    const ready = customPeerFactory ? Promise.resolve() : loadPeerJs();
    ready
      .then(() => startPeer(code || window.BuzzerProtocol.generateRoomCode()))
      .catch((err) => failRoom("Couldn't load the buzzer library — check your internet.", err));
  }

  function startPeer(code) {
    let instance;
    try {
      instance = createPeer(PEER_PREFIX + code);
    } catch (err) {
      failRoom("Couldn't start the buzzer room.", err);
      return;
    }
    peer = instance;
    peer.on("open", () => {
      roomCode = code;
      roomStatus = "open";
      roomError = null;
      openRetries = 0;
      persistRoomCode(code);
      renderAll();
    });
    peer.on("connection", handleConnection);
    peer.on("error", handlePeerError);
    if (typeof peer.on === "function") {
      peer.on("disconnected", () => {
        try {
          if (peer && typeof peer.reconnect === "function") peer.reconnect();
        } catch (err) {
          console.warn("Buzzer reconnect failed:", err);
        }
      });
    }
  }

  function handlePeerError(err) {
    const type = err && err.type;
    if (type === "unavailable-id") {
      if (openRetries < MAX_OPEN_RETRIES) {
        openRetries += 1;
        destroyPeer();
        startPeer(window.BuzzerProtocol.generateRoomCode());
        return;
      }
      failRoom("Couldn't grab a free room code — please try again.", err);
      return;
    }
    if (type === "peer-unavailable") {
      // A player tried to reach a stale id; nothing for the host to do.
      console.warn("Buzzer: peer-unavailable", err);
      return;
    }
    if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
      failRoom("Lost the connection to the buzzer server.", err);
      return;
    }
    console.warn("Buzzer peer error:", err);
  }

  function failRoom(message, err) {
    if (err) console.warn("Buzzer:", message, err);
    roomStatus = "error";
    roomError = message;
    renderAll();
  }

  function persistRoomCode(code) {
    const s = appState();
    if (!s || typeof setState !== "function") return;
    setState({ buzzer: { ...(s.buzzer || {}), roomCode: code } });
  }

  function closeRoom() {
    window.BuzzerWagers?.onRoomClosed?.();
    for (const conn of connections.values()) trySend(conn, { v: 1, t: "room-closed" });
    setTimeout(destroyPeer, CLOSE_FLUSH_MS);
    connections.clear();
    msgTimes.clear();
    roomState = window.BuzzerProtocol.createRoomState();
    roomStatus = "closed";
    roomCode = null;
    roomError = null;
    popoverOpen = false;
    persistRoomCode(null);
    renderAll();
  }

  function destroyPeer() {
    try {
      if (peer && typeof peer.destroy === "function") peer.destroy();
    } catch (err) {
      console.warn("Buzzer: destroy failed", err);
    }
    peer = null;
  }

  /* ============ Connections & inbound messages ============ */

  function handleConnection(conn) {
    if (!conn || !conn.peer) return;
    connections.set(conn.peer, conn);
    msgTimes.set(conn.peer, []);
    conn.on("data", (data) => handleData(conn, data));
    conn.on("close", () => handleClose(conn.peer));
    conn.on("error", (err) => console.warn("Buzzer connection error:", err));
  }

  function handleData(conn, data) {
    if (isFlooding(conn.peer)) {
      dropConnection(conn.peer, false);
      return;
    }
    const msg = window.BuzzerProtocol.validateMessage(data);
    if (!msg) return;
    if (msg.t === "join") handleJoin(conn, msg.name);
    else if (msg.t === "buzz") handleBuzz(conn.peer);
    // Daily-Double / Final wager + answer messages are owned by the wagers
    // module (kept out of this file to respect the 800-line house limit).
    else if (window.BuzzerWagers) window.BuzzerWagers.handleMessage(conn.peer, msg);
  }

  function isFlooding(peerId) {
    const now = Date.now();
    const recent = (msgTimes.get(peerId) || []).filter((t) => now - t < 1000);
    recent.push(now);
    msgTimes.set(peerId, recent);
    return recent.length > MAX_MSGS_PER_SEC;
  }

  function handleJoin(conn, name) {
    const newPlayerId = genPlayerId();
    const roster = (appState()?.players || []).map((p) => ({ id: p.id, name: p.name }));
    const result = window.BuzzerProtocol.roomReduce(roomState, {
      type: "join",
      peerId: conn.peer,
      name,
      roster,
      maxPlayers: maxPlayers(),
      newPlayerId,
    });
    roomState = result.next;
    applyEffects(result.effects, { newPlayerId });
    // A phone that (re)joins mid Daily-Double/Final needs the current podium
    // prompt re-sent — the wagers module decides what (if anything) to push.
    window.BuzzerWagers?.onJoin?.(conn.peer);
    renderAll();
  }

  function handleBuzz(peerId) {
    const hadWinner = roomState.winnerId;
    const result = window.BuzzerProtocol.roomReduce(roomState, { type: "buzz", peerId });
    roomState = result.next;
    applyEffects(result.effects);
    if (!hadWinner && roomState.winnerId === peerId) {
      playBeep();
      vibrateHost();
    }
    renderAll();
  }

  function handleClose(peerId) {
    connections.delete(peerId);
    msgTimes.delete(peerId);
    const result = window.BuzzerProtocol.roomReduce(roomState, { type: "leave", peerId });
    roomState = result.next;
    applyEffects(result.effects);
    renderAll();
  }

  /* ============ Effect application ============ */

  function applyEffects(effects, ctx) {
    const context = ctx || {};
    for (const eff of effects) {
      if (eff.to) sendTo(eff.to, eff.msg);
      else if (eff.close) dropConnection(eff.close, true);
      else if (eff.addPlayer !== undefined && context.newPlayerId) {
        addScoreboardPlayer(context.newPlayerId, eff.addPlayer);
      }
      // linkPlayer: the scoreboard entry already exists — nothing to do.
    }
  }

  function sendTo(to, msg) {
    if (to === "all") {
      for (const conn of connections.values()) trySend(conn, msg);
      return;
    }
    const conn = connections.get(to);
    if (conn) trySend(conn, msg);
  }

  function trySend(conn, msg) {
    try {
      if (conn && conn.open !== false) conn.send(msg);
    } catch (err) {
      console.warn("Buzzer send failed:", err);
    }
  }

  function dropConnection(peerId, deferred) {
    const conn = connections.get(peerId);
    if (!conn) return;
    const doClose = () => {
      try {
        conn.close();
      } catch (err) {
        console.warn("Buzzer close failed:", err);
      }
    };
    if (deferred) setTimeout(doClose, CLOSE_FLUSH_MS);
    else doClose();
  }

  function addScoreboardPlayer(id, name) {
    const s = appState();
    if (!s || typeof setState !== "function") return;
    if (s.players.some((p) => p.id === id)) return;
    setState({ players: [...s.players, { id, name, score: 0 }] });
  }

  /* ============ Host-driven buzzer actions ============ */

  function arm() {
    dispatch({ type: "arm" });
  }
  function disarm() {
    dispatch({ type: "disarm" });
  }
  function dispatch(event) {
    if (roomStatus !== "open") return;
    const result = window.BuzzerProtocol.roomReduce(roomState, event);
    roomState = result.next;
    applyEffects(result.effects);
    renderAll();
  }

  function kick(peerId) {
    const conn = connections.get(peerId);
    if (conn) trySend(conn, { v: 1, t: "room-closed" });
    dropConnection(peerId, true);
    handleClose(peerId);
  }

  /* ============ Hooks called from app.js ============ */

  function onRender() {
    renderAll();
  }
  function onClueOpened() {
    dispatch({ type: "clueReset" });
    // Run AFTER the clueReset idle-broadcast so a Daily-Double prompt is the
    // last word the answering phone hears (spec §8.1).
    window.BuzzerWagers?.onClueOpened?.();
  }
  function onAnswerRevealed() {
    dispatch({ type: "disarm" });
  }
  function onClueClosed() {
    dispatch({ type: "clueReset" });
  }
  function onJudgedWrong(playerId) {
    dispatch({ type: "judgedWrong", playerId });
  }

  /* ============ Sound + haptics ============ */

  function toggleSound() {
    soundOn = !soundOn;
    renderAll();
  }

  function playBeep() {
    if (!soundOn) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = BEEP_HZ;
      const now = audioCtx.currentTime;
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + BEEP_MS / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + BEEP_MS / 1000 + 0.02);
    } catch (err) {
      console.warn("Buzzer beep failed:", err);
    }
  }

  function vibrateHost() {
    try {
      if (navigator && typeof navigator.vibrate === "function") navigator.vibrate(30);
    } catch (err) {
      /* haptics are best-effort */
    }
  }

  /* ============ Rendering ============ */

  function renderAll() {
    renderSetupPanel();
    renderChip();
    renderPopover();
    renderClueBar();
    // Idempotent DD/Final decorations + stage syncs (spec §8).
    window.BuzzerWagers?.onRender?.();
  }

  function joinUrl() {
    const loc = window.location;
    return `${loc.origin}${loc.pathname}?room=${roomCode}`;
  }

  function renderSetupPanel() {
    const host = $("buzzer-setup");
    if (!host) return;
    host.replaceChildren();
    host.appendChild(el("h3", "setup-heading", "Buzzer room (optional)"));
    if (roomStatus === "open") host.appendChild(buildOpenPanel());
    else host.appendChild(buildClosedPanel());
  }

  function buildClosedPanel() {
    const box = el("div", "buzzer-panel");
    if (roomStatus === "connecting") {
      box.appendChild(el("p", "buzzer-status", "Opening room…"));
      return box;
    }
    const open = el("button", "btn btn-ghost", "Open buzzer room");
    open.type = "button";
    open.addEventListener("click", () => openRoom());
    box.appendChild(open);
    box.appendChild(el("p", "buzzer-hint", "Players use their phones to buzz in — needs internet."));
    if (roomStatus === "error" && roomError) {
      box.appendChild(el("p", "error-msg", roomError));
    }
    return box;
  }

  function buildOpenPanel() {
    const box = el("div", "buzzer-panel buzzer-open");
    box.appendChild(buildCodeBlock());
    box.appendChild(buildJoinLine());
    box.appendChild(buildPlayerList());
    box.appendChild(buildRoomControls());
    return box;
  }

  function buildCodeBlock() {
    const wrap = el("div", "buzzer-code-wrap");
    wrap.appendChild(el("p", "buzzer-code-label", "Room code"));
    wrap.appendChild(el("p", "buzzer-code", roomCode || ""));
    return wrap;
  }

  function buildJoinLine() {
    const wrap = el("div", "buzzer-join");
    wrap.appendChild(el("span", "buzzer-join-label", "Join at"));
    wrap.appendChild(el("span", "buzzer-join-url", joinUrl()));
    return wrap;
  }

  function buildPlayerList() {
    const list = el("ul", "buzzer-players");
    const ids = Object.keys(roomState.players);
    if (ids.length === 0) {
      list.appendChild(el("li", "buzzer-empty", "No players connected yet."));
      return list;
    }
    ids.forEach((peerId) => list.appendChild(buildPlayerRow(peerId)));
    return list;
  }

  function buildPlayerRow(peerId) {
    const player = roomState.players[peerId];
    const li = el("li", "buzzer-player-row");
    li.appendChild(el("span", "buzzer-dot", player.connected ? "🟢" : "🔴"));
    li.appendChild(el("span", "buzzer-player-name", player.name));
    const kickBtn = el("button", "buzzer-kick", "Kick");
    kickBtn.type = "button";
    kickBtn.setAttribute("aria-label", `Remove ${player.name} from the room`);
    kickBtn.addEventListener("click", () => kick(peerId));
    li.appendChild(kickBtn);
    return li;
  }

  function buildRoomControls() {
    const row = el("div", "buzzer-controls");
    const sound = el("button", "btn btn-ghost btn-small", soundOn ? "🔊 Sound on" : "🔇 Sound off");
    sound.type = "button";
    sound.addEventListener("click", toggleSound);
    row.appendChild(sound);

    const close = el("button", "btn btn-ghost btn-small", "Close room");
    close.type = "button";
    close.addEventListener("click", closeRoom);
    row.appendChild(close);
    return row;
  }

  function renderChip() {
    const chip = $("buzzer-chip");
    if (!chip) return;
    const onBoard = appState()?.phase === "board";
    const visible = onBoard && roomStatus === "open";
    show(chip, visible);
    if (!visible) return;
    chip.textContent = `${roomCode} · ${connectedCount()} 🔔`;
    chip.setAttribute("aria-label", `Buzzer room ${roomCode}, ${connectedCount()} connected. Toggle details`);
  }

  function renderPopover() {
    const pop = $("buzzer-popover");
    if (!pop) return;
    const onBoard = appState()?.phase === "board";
    const visible = onBoard && roomStatus === "open" && popoverOpen;
    show(pop, visible);
    if (!visible) return;
    pop.replaceChildren();
    pop.appendChild(buildJoinLine());
    pop.appendChild(buildPlayerList());
    pop.appendChild(buildRoomControls());
  }

  function renderClueBar() {
    const bar = $("buzzer-clue-bar");
    if (!bar) return;
    const active = appState()?.active;
    const eligible =
      roomStatus === "open" && !!active && !active.isDailyDouble && connectedCount() > 0;
    // Show the arming affordance only while live; keep the winner banner up
    // after Reveal so the host can still judge the player who buzzed.
    const showBar = eligible && (!!roomState.winnerId || !active.revealed);
    show(bar, showBar);
    if (!showBar) return;
    bar.replaceChildren();
    if (roomState.winnerId) bar.appendChild(buildWinnerBanner());
    else if (roomState.armed) bar.appendChild(buildArmedBar());
    else bar.appendChild(buildDisarmedBar());
  }

  function buildDisarmedBar() {
    const wrap = el("div", "buzzer-bar");
    const armBtn = el("button", "btn btn-gold", "Arm buzzers (Space)");
    armBtn.type = "button";
    armBtn.addEventListener("click", arm);
    wrap.appendChild(armBtn);
    return wrap;
  }

  function buildArmedBar() {
    const wrap = el("div", "buzzer-bar buzzer-armed");
    wrap.appendChild(el("span", "buzzer-armed-label", "🔔 Buzzers armed — Space locks"));
    const disarmBtn = el("button", "btn btn-ghost btn-small", "Disarm");
    disarmBtn.type = "button";
    disarmBtn.addEventListener("click", disarm);
    wrap.appendChild(disarmBtn);
    return wrap;
  }

  function buildWinnerBanner() {
    const winner = roomState.players[roomState.winnerId];
    const wrap = el("div", "buzzer-bar buzzer-winner");
    wrap.appendChild(el("span", "buzzer-winner-name", `🔔 ${winner ? winner.name : "Buzzed in"}`));
    const playerId = winner ? winner.playerId : null;

    const right = el("button", "judge-btn correct", "✓");
    right.type = "button";
    right.setAttribute("aria-label", "Correct");
    right.addEventListener("click", () => {
      if (playerId && typeof judgeCorrect === "function") judgeCorrect(playerId);
    });
    wrap.appendChild(right);

    const wrong = el("button", "judge-btn wrong", "✗");
    wrong.type = "button";
    wrong.setAttribute("aria-label", "Wrong");
    wrong.addEventListener("click", () => {
      if (playerId && typeof judgeWrong === "function") judgeWrong(playerId);
    });
    wrap.appendChild(wrong);
    return wrap;
  }

  /* ============ Global wiring & boot ============ */

  function togglePopover() {
    popoverOpen = !popoverOpen;
    renderPopover();
  }

  // Spacebar arm/disarm. Interception is provably scoped to a live buzz bar:
  // if it isn't live we return before touching the event, so Space keeps its
  // normal behaviour everywhere else (regression R6).
  function onSpaceHotkey(event) {
    if (event.key !== " " && event.code !== "Space") return;
    if (!isBuzzBarLive()) return;
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // let inputs type
    if (isEditorOpen()) return;
    if (roomState.winnerId) return; // a buzz is being judged — leave Space alone
    // The hotkey now owns Space: stop a focused button (e.g. Reveal) firing.
    event.preventDefault();
    if (event.repeat) return; // holding Space must not machine-gun toggle
    const now = Date.now();
    if (now - lastToggleAt < HOTKEY_DEBOUNCE_MS) return;
    lastToggleAt = now;
    if (roomState.armed) disarm();
    else arm();
  }

  function wireGlobalEvents() {
    if (wired) return;
    wired = true;
    const chip = $("buzzer-chip");
    if (chip) chip.addEventListener("click", togglePopover);
    document.addEventListener("keydown", onSpaceHotkey);
    document.addEventListener("click", (event) => {
      if (!popoverOpen) return;
      const pop = $("buzzer-popover");
      const chipEl = $("buzzer-chip");
      const t = event.target;
      if (pop && !pop.contains(t) && chipEl && !chipEl.contains(t)) {
        popoverOpen = false;
        renderPopover();
      }
    });
  }

  function boot() {
    if (document.body && document.body.classList.contains("player-mode")) return;
    wireGlobalEvents();
    renderAll();
    const s = appState();
    const savedCode = s && s.buzzer && typeof s.buzzer.roomCode === "string" ? s.buzzer.roomCode : null;
    if (savedCode && window.BuzzerProtocol.ROOM_CODE_RE.test(savedCode)) openRoom(savedCode);
  }

  /* ============ Public API ============ */

  const api = {
    onRender,
    onClueOpened,
    onAnswerRevealed,
    onClueClosed,
    onJudgedWrong,
    openRoom,
    closeRoom,
    arm,
    disarm,
    kick,
    toggleSound,
    connectedCount,
    status: () => roomStatus,
    _init(opts) {
      if (opts && typeof opts.createPeer === "function") customPeerFactory = opts.createPeer;
      return api;
    },
    _roomState: () => roomState,
    // Transport seam for the wagers module: send one message to a peer id.
    _send: (peerId, msg) => sendTo(peerId, msg),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  return api;
})();

window.BuzzerHost = BuzzerHost;
