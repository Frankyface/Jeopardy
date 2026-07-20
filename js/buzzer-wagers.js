/* ============================================================
   Jeopardy — phone wagers & answers glue (Daily Double + Final)
   The host-side orchestration for spec §8: prompt a connected
   phone for a Daily-Double wager, run secret phone Final wagers,
   collect typed Final answers (DISPLAY ONLY — never auto-judged),
   and push per-player results as the host rules ✓/✗.

   Split out of buzzer-host.js purely to keep every file under the
   800-line house limit. It leans on that module for transport
   (BuzzerHost._send / _roomState) and reuses app.js globals the
   same way buzzer-host.js does (bare, defensive references):
   state, setState, $, el, dailyDoubleMaxWager, finalMaxWager,
   lockDailyDoubleWager. Every app hook that reaches this file is
   optional-chained, so the game runs unchanged if it fails to load.

   All state that must survive a host refresh (final wagers/answers)
   lives in app `state` via setState with serialisable data only;
   the transient prompt/target bookkeeping lives here in module scope.
   ============================================================ */

"use strict";

const BuzzerWagers = (function () {
  const BP = window.BuzzerProtocol;

  /* ============ Module state (never serialised) ============ */

  let ddPeerId = null; // peer currently prompted for a Daily-Double wager.
  /** @type {string|null} the app final.stage we last pushed to phones. */
  let lastFinalStage = null;
  /** @type {Record<string, boolean>} host manually overrode these wager inputs. */
  let finalUnlocked = {};
  /** @type {Record<string, boolean>} players whose final-result we already sent. */
  let finalResultsSent = {};
  /** @type {Record<string, number>} pre-verdict scores captured at judge entry. */
  let finalScoreSnapshot = {};

  /* ============ App-global bridges (defensive) ============ */

  function appState() {
    return typeof state !== "undefined" ? state : null;
  }
  function host() {
    return window.BuzzerHost || null;
  }
  function isPlayerMode() {
    return !!(document.body && document.body.classList.contains("player-mode"));
  }
  function roomOpen() {
    const h = host();
    return !!h && typeof h.status === "function" && h.status() === "open";
  }
  function send(peerId, msg) {
    const h = host();
    if (h && typeof h._send === "function") h._send(peerId, msg);
  }
  function roomPlayers() {
    const h = host();
    return h && typeof h._roomState === "function" ? h._roomState().players : {};
  }

  /** First connected room peer linked to `playerId`, or null. */
  function connectedPeerFor(playerId) {
    if (!playerId) return null;
    const players = roomPlayers();
    for (const peerId of Object.keys(players)) {
      const p = players[peerId];
      if (p.connected && p.playerId === playerId) return peerId;
    }
    return null;
  }

  /** Every connected, scoreboard-linked phone. @returns {Array<{peerId:string, playerId:string}>} */
  function connectedLinked() {
    const players = roomPlayers();
    const out = [];
    for (const peerId of Object.keys(players)) {
      const p = players[peerId];
      if (p.connected && p.playerId) out.push({ peerId, playerId: p.playerId });
    }
    return out;
  }

  function ddMaxWager(playerId) {
    return typeof dailyDoubleMaxWager === "function" ? dailyDoubleMaxWager(playerId) : 0;
  }
  function finalMax(player) {
    if (typeof finalMaxWager === "function") return finalMaxWager(player);
    return Math.max(player ? player.score : 0, 0);
  }

  /* ============ Inbound phone messages (from host handleData) ============ */

  /**
   * @param {string} peerId
   * @param {{t:string, amount?:number, text?:string}} msg validated by the protocol.
   */
  function handleMessage(peerId, msg) {
    if (msg.t === "dd-wager") handleDdWager(peerId, msg.amount);
    else if (msg.t === "final-wager") handleFinalWager(peerId, msg.amount);
    else if (msg.t === "final-answer") handleFinalAnswer(peerId, msg.text);
  }

  /* ============ Daily Double ============ */

  function onClueOpened() {
    ddPeerId = null; // fresh clue — drop any stale target, then (re)prompt.
    syncDdPrompt();
  }

  /** Re-target the DD prompt to whoever is selected in #dd-player. */
  function syncDdPrompt() {
    const active = appState()?.active;
    const awaiting = !!active && active.isDailyDouble && !active.wagerLocked;
    if (!awaiting) {
      cleanupDd();
      return;
    }
    const sel = $("dd-player");
    promptDdFor(sel ? sel.value : null);
  }

  /** Send a DD wager request to `playerId`'s phone (if linked+connected). */
  function promptDdFor(playerId) {
    const targetPeer = connectedPeerFor(playerId);
    if (targetPeer !== ddPeerId) {
      if (ddPeerId) send(ddPeerId, BP.ddCancelMsg());
      if (targetPeer) sendDdRequest(targetPeer, playerId);
      ddPeerId = targetPeer;
    }
    renderDdNote(targetPeer);
  }

  function sendDdRequest(peerId, playerId) {
    const s = appState();
    const active = s?.active;
    if (!active) return;
    const cat = s.game && s.game.categories ? s.game.categories[active.cat] : null;
    const clue = cat && cat.clues ? cat.clues[active.row] : null;
    const player = s.players.find((p) => p.id === playerId);
    send(peerId, BP.ddWagerRequestMsg(
      cat ? cat.name : "Daily Double",
      clue ? clue.value : 0,
      player ? player.score : 0,
      BP.MIN_WAGER,
      ddMaxWager(playerId)
    ));
  }

  /** DD splash closed with a prompt still out → cancel it (spec §8.1). */
  function cleanupDd() {
    if (ddPeerId) {
      send(ddPeerId, BP.ddCancelMsg());
      ddPeerId = null;
    }
    renderDdNote(null);
  }

  /** A valid phone wager fills the manual form and locks via the app flow. */
  function handleDdWager(peerId, amount) {
    if (peerId !== ddPeerId) return; // only the currently prompted phone
    const active = appState()?.active;
    if (!active || !active.isDailyDouble || active.wagerLocked) return; // out of stage
    const linkedId = (roomPlayers()[peerId] || {}).playerId;
    const max = ddMaxWager(linkedId);
    if (!BP.isValidDdWager(amount, max)) {
      send(peerId, BP.inputRejectedMsg(
        "dd-wager",
        `Enter a whole-number wager between ${BP.MIN_WAGER} and ${max}.`
      ));
      return;
    }
    const sel = $("dd-player");
    const wagerInput = $("dd-wager");
    if (sel && linkedId) sel.value = linkedId;
    if (wagerInput) wagerInput.value = String(amount);
    ddPeerId = null; // claim the lock so the ensuing render doesn't send dd-cancel
    if (typeof lockDailyDoubleWager === "function") lockDailyDoubleWager();
    if (appState()?.active?.wagerLocked) {
      send(peerId, BP.ddAcceptedMsg(amount));
      renderDdNote(null);
    } else {
      ddPeerId = peerId; // lock failed unexpectedly — keep the prompt live
    }
  }

  /** The host changed #dd-player: cancel the old phone, prompt the new one. */
  function onDdPlayerChange() {
    if (!roomOpen()) return;
    syncDdPrompt();
  }

  function renderDdNote(targetPeer) {
    const splash = $("dd-splash");
    if (!splash) return;
    let note = $("buzzer-dd-note");
    if (targetPeer) {
      if (!note) {
        note = el("p", "buzzer-dd-note");
        note.id = "buzzer-dd-note";
        splash.appendChild(note);
      }
      const name = (roomPlayers()[targetPeer] || {}).name || "Player";
      note.textContent = `📱 ${name} is wagering on their phone…`;
      note.classList.remove("hidden");
    } else if (note) {
      note.classList.add("hidden");
    }
  }

  /* ============ Final Jeopardy ============ */

  function handleFinalWager(peerId, amount) {
    const s = appState();
    const final = s?.final;
    if (!final || final.stage !== "wager") return; // out of stage
    const linkedId = (roomPlayers()[peerId] || {}).playerId;
    const player = linkedId ? s.players.find((p) => p.id === linkedId) : null;
    if (!player) return;
    const max = finalMax(player);
    if (!BP.isValidFinalWager(amount, max)) {
      send(peerId, BP.inputRejectedMsg(
        "final-wager",
        `Enter a whole-number wager between 0 and ${max}.`
      ));
      return;
    }
    if (typeof setState === "function") {
      setState({ final: { ...final, wagers: { ...final.wagers, [linkedId]: amount } } });
    }
  }

  /** Typed answers are stored verbatim for the host to READ — never compared. */
  function handleFinalAnswer(peerId, text) {
    const s = appState();
    const final = s?.final;
    if (!final || final.stage !== "clue") return; // accepted only while clue is up
    const linkedId = (roomPlayers()[peerId] || {}).playerId;
    if (!linkedId) return;
    const cleaned = BP.sanitizeAnswer(text); // trims/caps; null => "no answer"
    const answers = { ...(final.answers || {}) };
    answers[linkedId] = cleaned || "";
    if (typeof setState === "function") setState({ final: { ...final, answers } });
  }

  /** Detect app-stage transitions and push the matching phone prompt. */
  function syncFinalStage() {
    const final = appState()?.final;
    const stage = final ? final.stage : null;
    if (stage === lastFinalStage) return;
    const prev = lastFinalStage;
    lastFinalStage = stage;
    onFinalStageChange(prev, stage);
  }

  function onFinalStageChange(from, to) {
    if (to === "wager") {
      resetFinalTracking();
      broadcastFinal((peerId, playerId) => finalWagerFor(peerId, playerId));
    } else if (to === "clue") {
      broadcastFinal((peerId) => send(peerId, finalAnswerPayload()));
    } else if (to === "judge") {
      snapshotScores();
      broadcastFinal((peerId) => send(peerId, BP.finalWaitingMsg()));
    } else if (to === null && from !== null && from !== "standings") {
      broadcastFinalCancel();
    } else if (to === null) {
      // Left standings (or a never-played final) → make sure phones return home.
      broadcastFinalCancel();
      resetFinalTracking();
    }
  }

  function finalWagerFor(peerId, playerId) {
    const s = appState();
    const fj = s.game && s.game.finalJeopardy;
    const player = s.players.find((p) => p.id === playerId);
    if (!fj || !player) return;
    send(peerId, BP.finalWagerMsg(fj.category, player.score, finalMax(player)));
  }

  function finalAnswerPayload() {
    const fj = appState().game.finalJeopardy;
    return BP.finalAnswerMsg(fj.category, fj.clue);
  }

  /** Run `fn(peerId, playerId)` for every connected+linked phone. */
  function broadcastFinal(fn) {
    if (!roomOpen()) return;
    for (const { peerId, playerId } of connectedLinked()) fn(peerId, playerId);
  }

  function broadcastFinalCancel() {
    if (!roomOpen()) return;
    for (const { peerId } of connectedLinked()) send(peerId, BP.finalCancelMsg());
  }

  function snapshotScores() {
    finalScoreSnapshot = {};
    const s = appState();
    if (!s) return;
    for (const p of s.players) finalScoreSnapshot[p.id] = p.score;
  }

  /** Push final-result to each newly-judged player's phone (host-driven ✓/✗). */
  function pushFinalResults() {
    const s = appState();
    const final = s?.final;
    if (!final || !final.judged) return;
    if (final.stage !== "judge" && final.stage !== "standings") return;
    for (const player of s.players) {
      if (!final.judged[player.id] || finalResultsSent[player.id]) continue;
      finalResultsSent[player.id] = true;
      const peerId = connectedPeerFor(player.id);
      if (!peerId) continue;
      const snap = finalScoreSnapshot[player.id];
      const delta = typeof snap === "number" ? player.score - snap : (final.wagers[player.id] || 0);
      // Verdict is the host's actual ✓/✗ (spec §8.3): a $0 wager gives a 0 delta
      // that cannot be inferred. Legacy saves stored `true` (pre-fix) — fall back
      // to the delta sign for those. Delta still drives the ±amount display.
      const verdict = final.judged[player.id];
      const correct = verdict === "correct" ? true : verdict === "wrong" ? false : delta >= 0;
      send(peerId, BP.finalResultMsg(correct, delta, player.score));
    }
  }

  function resetFinalTracking() {
    finalUnlocked = {};
    finalResultsSent = {};
    finalScoreSnapshot = {};
  }

  /* ============ Host-side final decorations (idempotent) ============ */

  function renderFinalDecorations() {
    const final = appState()?.final;
    if (!final || !roomOpen()) return;
    if (final.stage === "wager") decorateFinalWagerInputs(final);
    else if (final.stage === "clue") renderAnswerCounter(final);
    else if (final.stage === "judge") decorateFinalJudgeRows(final);
  }

  /** Mask each phone-locked wager input (secret on the projector) + Unlock. */
  function decorateFinalWagerInputs(final) {
    const inputs = document.querySelectorAll(".wager-list input[data-player-id]");
    inputs.forEach((input) => {
      const pid = input.dataset.playerId;
      const submitted = Object.prototype.hasOwnProperty.call(final.wagers, pid);
      if (!submitted || finalUnlocked[pid]) return; // manual / unlocked → editable
      input.value = String(final.wagers[pid]);
      input.type = "password";
      input.disabled = true;
      const li = input.closest("li");
      if (!li || li.querySelector(".buzzer-final-lock")) return;
      li.appendChild(el("span", "buzzer-final-lock", "🔒 from phone"));
      const unlock = el("button", "btn btn-ghost btn-small buzzer-unlock", "Unlock");
      unlock.type = "button";
      unlock.addEventListener("click", () => {
        finalUnlocked[pid] = true;
        input.type = "number";
        input.disabled = false;
        const note = li.querySelector(".buzzer-final-lock");
        if (note) note.remove();
        unlock.remove();
        input.focus();
      });
      li.appendChild(unlock);
    });
  }

  /** A passive "Answers in: n/m" readout — the host still reveals manually. */
  function renderAnswerCounter(final) {
    const body = $("final-body");
    if (!body) return;
    const linked = connectedLinked();
    if (linked.length === 0) return; // no phones → no counter (regression R7)
    const answered = linked.filter(({ playerId }) => {
      const a = final.answers && final.answers[playerId];
      return typeof a === "string" && a.length > 0;
    }).length;
    const existing = body.querySelector(".buzzer-final-counter");
    if (existing) existing.remove();
    body.appendChild(el("p", "buzzer-final-counter", `Answers in: ${answered}/${linked.length}`));
  }

  /** Show each phone player's typed answer beside their judge row (textContent
   *  only). Pure manual players (no phone, no submission) get no decoration. */
  function decorateFinalJudgeRows(final) {
    const linkedIds = new Set(connectedLinked().map((x) => x.playerId));
    const rows = document.querySelectorAll(".final-judge-list li[data-player-id]");
    rows.forEach((li) => {
      if (li.querySelector(".buzzer-final-answer")) return;
      const pid = li.dataset.playerId;
      const a = final.answers && final.answers[pid];
      const hasAnswer = typeof a === "string";
      if (!linkedIds.has(pid) && !hasAnswer) return; // manual player — leave as-is
      const text = hasAnswer && a.trim() ? `"${a}"` : "— no answer —";
      const span = el("span", "buzzer-final-answer", text);
      li.insertBefore(span, li.children[1] || null);
    });
  }

  /* ============ Reconnect: re-send the current podium prompt ============ */

  function onJoin(peerId) {
    const final = appState()?.final;
    if (final && roomOpen()) sendCurrentFinalTo(peerId);
    // A Daily-Double prompt re-targets itself through the onRender syncDdPrompt.
  }

  function sendCurrentFinalTo(peerId) {
    const s = appState();
    const final = s.final;
    const playerId = (roomPlayers()[peerId] || {}).playerId;
    if (!playerId) return;
    if (final.stage === "wager") finalWagerFor(peerId, playerId);
    else if (final.stage === "clue") send(peerId, finalAnswerPayload());
    else if (final.stage === "judge" || final.stage === "standings") send(peerId, BP.finalWaitingMsg());
  }

  /* ============ Hooks + boot ============ */

  function onRender() {
    if (isPlayerMode()) return;
    syncFinalStage();
    syncDdPrompt();
    renderFinalDecorations();
    pushFinalResults();
  }

  function onRoomClosed() {
    ddPeerId = null;
    lastFinalStage = null;
    resetFinalTracking();
  }

  function boot() {
    if (isPlayerMode()) return;
    const sel = $("dd-player");
    if (sel) sel.addEventListener("change", onDdPlayerChange);
    // Seed from a restored mid-final game so we neither re-push settled results
    // nor forget the current stage.
    const final = appState()?.final;
    if (final) {
      lastFinalStage = final.stage;
      if (final.judged) {
        for (const pid of Object.keys(final.judged)) {
          if (final.judged[pid]) finalResultsSent[pid] = true;
        }
      }
    }
  }

  const api = { onRender, onClueOpened, onJoin, onRoomClosed, handleMessage, _promptDd: promptDdFor };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  return api;
})();

window.BuzzerWagers = BuzzerWagers;
