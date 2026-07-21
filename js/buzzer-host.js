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
  // Broker-reconnect backoff (spec §9.5): capped exponential retries; P2P survives a blip.
  const MAX_BROKER_RETRIES = 8;
  const BROKER_BASE_MS = 1000;
  const BROKER_MAX_MS = 15000;

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
  // Heartbeat + broker health (spec §9.3, §9.5) — transport-only, never serialised.
  const lastHeard = new Map(); // peerId → ms of the last inbound message
  const stalePeers = new Set(); // peers silent past HOST_STALE_MS (🔴 overlay; no removal)
  let heartbeatTimer = null, suppressPong = false; // suppressPong: harness seam (I4)
  let brokerStatus = "ok"; // "ok" | "reconnecting" | "lost"
  let brokerRetries = 0, brokerTimer = null;

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
    // Shared resilient ICE for symmetric-NAT/CGNAT phones (spec §9.1); degrade if net absent.
    const opts = window.BuzzerNet && window.BuzzerNet.PEER_OPTIONS;
    return opts ? new window.peerjs.Peer(id, opts) : new window.peerjs.Peer(id);
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
      brokerRecovered(); // also covers a re-fired open after a broker blip (§9.5)
      // Host liveness sweep (spec §9.3): flag phones silent >30s as 🔴.
      if (!heartbeatTimer) heartbeatTimer = setInterval(sweepLiveness, window.BuzzerNet ? window.BuzzerNet.HEARTBEAT_SWEEP_MS : 5000);
      persistRoomCode(code);
      renderAll();
    });
    peer.on("connection", handleConnection);
    peer.on("error", handlePeerError);
    // Broker drop → capped-backoff reconnect while P2P keeps working (spec §9.5).
    if (typeof peer.on === "function") peer.on("disconnected", onBrokerDisconnected);
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
      // A blip AFTER the room opened must NOT tear it down — P2P keeps working;
      // re-signal (spec §9.5). Only a failure before the room opened is fatal.
      if (roomStatus === "open") onBrokerDisconnected();
      else failRoom("Lost the connection to the buzzer server.", err);
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
    lastHeard.clear();
    stalePeers.clear();
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
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (brokerTimer) clearTimeout(brokerTimer);
    brokerTimer = null;
    brokerStatus = "ok";
    brokerRetries = 0;
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
    markHeard(conn.peer); // any inbound message is liveness evidence (spec §9.3)
    const msg = window.BuzzerProtocol.validateMessage(data);
    // Valid heartbeats bypass the abuse guard (spec §9.3); junk still counts.
    const isHeartbeat = !!msg && (msg.t === "ping" || msg.t === "pong");
    if (!isHeartbeat && isFlooding(conn.peer)) {
      dropConnection(conn.peer, false);
      return;
    }
    if (!msg) return;
    if (msg.t === "ping") { if (!suppressPong) trySend(conn, { v: 1, t: "pong" }); return; }
    if (msg.t === "pong") return; // liveness already recorded above
    if (msg.t === "join") handleJoin(conn, msg.name);
    else if (msg.t === "buzz") handleBuzz(conn.peer);
    // DD / Final wager + answer messages are owned by the wagers module.
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
    lastHeard.delete(peerId);
    stalePeers.delete(peerId);
    const result = window.BuzzerProtocol.roomReduce(roomState, { type: "leave", peerId });
    roomState = result.next;
    applyEffects(result.effects);
    renderAll();
  }

  /* ============ Heartbeat + broker resilience (spec §9.3, §9.5) ============ */

  function markHeard(peerId) {
    lastHeard.set(peerId, Date.now());
    if (stalePeers.delete(peerId)) renderAll(); // a silent phone spoke again → 🟢
  }

  // Flag connected players silent past HOST_STALE_MS as 🔴 (spec §9.3) — status
  // only, no roster removal; re-render only on a real change so a host mid-typing a
  // Final wager isn't disrupted every tick.
  function sweepLiveness() {
    const net = window.BuzzerNet;
    if (!net) return;
    const now = Date.now();
    let changed = false;
    for (const id of Object.keys(roomState.players)) {
      const stale = roomState.players[id].connected && net.isStaleAt(lastHeard.get(id), now, net.HOST_STALE_MS);
      if (stale === stalePeers.has(id)) continue;
      if (stale) stalePeers.add(id); else stalePeers.delete(id);
      changed = true;
    }
    if (changed) renderAll();
  }

  // Broker drop (disconnected event or post-open network error): keep P2P alive and
  // re-signal with capped backoff (spec §9.5); success re-fires open → brokerRecovered.
  function onBrokerDisconnected() {
    if (!peer || peer.destroyed || roomStatus !== "open" || brokerTimer) return;
    if (peer.open) return brokerRecovered();
    if (brokerRetries >= MAX_BROKER_RETRIES) {
      if (brokerStatus !== "lost") { brokerStatus = "lost"; renderAll(); }
      return;
    }
    if (brokerStatus !== "reconnecting") { brokerStatus = "reconnecting"; renderAll(); }
    const delay = Math.min(BROKER_BASE_MS * 2 ** brokerRetries++, BROKER_MAX_MS);
    brokerTimer = setTimeout(() => {
      brokerTimer = null;
      try { if (peer && peer.disconnected && typeof peer.reconnect === "function") peer.reconnect(); }
      catch (err) { console.warn("Buzzer broker reconnect failed:", err); }
    }, delay);
  }

  function brokerRecovered() {
    if (brokerTimer) clearTimeout(brokerTimer);
    brokerTimer = null;
    brokerRetries = 0;
    if (brokerStatus !== "ok") { brokerStatus = "ok"; renderAll(); }
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
    // A regular clue with a live audience opens the reading window (phones → RED
    // "Wait for it…"); a Daily Double (or no connected players) just resets to
    // idle — no early-buzz trap on non-buzzable clues (spec §4.2, R8). The prior
    // clue's closeClue→clueReset already cleared any lockouts.
    if (isBuzzBarLive()) dispatch({ type: "clueOpened" });
    else dispatch({ type: "clueReset" });
    // Run AFTER the reading/idle broadcast so a Daily-Double prompt is the
    // last word the answering phone hears (spec §8.1).
    window.BuzzerWagers?.onClueOpened?.();
  }
  function onAnswerRevealed() {
    // Ends the buzzable window entirely: phones → idle (not back to reading).
    dispatch({ type: "answerRevealed" });
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
    const broker = window.BuzzerNet ? window.BuzzerNet.brokerLabel(brokerStatus) : "";
    if (broker) box.appendChild(el("p", "buzzer-broker", broker));
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
    // 🔴 for a dropped OR live-but-silent-past-30s connection (spec §9.3) — honest status.
    const down = !player.connected || stalePeers.has(peerId);
    li.appendChild(el("span", "buzzer-dot", down ? "🔴" : "🟢"));
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
    chip.textContent = `${roomCode} · ${connectedCount()} 🔔${brokerStatus === "ok" ? "" : " · ⚠"}`;
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
    const early = earlyLockedNames();
    if (early.length > 0) {
      bar.appendChild(el("p", "buzzer-early-note", `🚫 too soon: ${early.join(", ")}`));
    }
  }

  /** Names of players locked out THIS clue for buzzing early (spec §4.2). */
  function earlyLockedNames() {
    const reasons = roomState.lockReason || {};
    return Object.keys(roomState.players)
      .filter((id) => roomState.lockedOut[id] && reasons[id] === "early")
      .map((id) => roomState.players[id].name);
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
    // Harness seam (I4): silence pong replies to exercise the player staleness path.
    _suppressPong: (v) => { suppressPong = !!v; return api; },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  return api;
})();

window.BuzzerHost = BuzzerHost;
