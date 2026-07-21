/* ============================================================
   Jeopardy — buzzer protocol core (PURE)
   Room-code generation, message validation/sanitisation, and the
   host + player reducers. No DOM, no PeerJS, no app globals — the
   only side effect is attaching the export. Runs in the browser
   (globalThis.BuzzerProtocol) and in Node (module.exports) so the
   node:test suite can exercise it directly. Reducers are pure and
   immutable: they never mutate their inputs.
   ============================================================ */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BuzzerProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ============ Constants ============ */

  // Room-code alphabet: A–Z and 2–9 minus the visually ambiguous I, L, O, 0, 1.
  const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const ROOM_CODE_LEN = 4;
  // A restored/received code must look like a real code (see spec §6.3). This
  // is deliberately broader than ROOM_ALPHABET so old codes normalise cleanly.
  const ROOM_CODE_RE = /^[A-Z2-9]{4}$/;
  const NAME_MAX = 24; // display cap; matches the host's player-name input.
  // Raw structural cap (~10× the display cap) — rejects abusive payloads at the
  // validation boundary; sanitizeName still enforces the real 24-char cap.
  const NAME_FIELD_MAX = 240;
  const ANSWER_MAX = 120; // typed Final-answer display cap (spec §5).
  const ANSWER_FIELD_MAX = 1200; // structural cap (~10×); sanitizeAnswer enforces 120.
  // Host→player text fields (category/clue) come from the trusted host but are
  // still capped so a junk frame is rejected rather than rendered.
  const HOST_TEXT_MAX = 4000;
  // Smallest legal wager, matching the manual UI's MIN_WAGER (app.js). DD wagers
  // are bounded MIN_WAGER..max; Final wagers 0..max.
  const MIN_WAGER = 5;
  // C0 controls + DEL + C1 controls. Built from escapes so the source stays
  // pure printable ASCII (no literal control bytes in the file).
  const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");

  /** @typedef {"idle"|"reading"|"armed"|"won"|"taken"|"locked"} BuzzerMode */
  /** @typedef {"early"|"wrong"} LockReason — why a phone is locked out this clue. */
  const BUZZER_MODES = new Set(["idle", "reading", "armed", "won", "taken", "locked"]);
  // Accompanies a `locked` buzzer message; a missing reason is treated as "wrong"
  // so older messages stay valid (spec §5).
  const LOCK_REASONS = new Set(["early", "wrong"]);
  const REJECT_REASONS = new Set(["name-taken", "room-full", "bad-name"]);
  const FINAL_STAGES = new Set(["wager", "answer", "waiting"]);
  const INPUT_REJECT_KINDS = new Set(["dd-wager", "final-wager", "final-answer"]);

  /* ============ Protocol message typedefs ============ */

  /**
   * @typedef {{v:1, t:"join", name:string}} JoinMsg
   * @typedef {{v:1, t:"buzz"}} BuzzMsg
   * @typedef {{v:1, t:"dd-wager", amount:number}} DdWagerMsg
   * @typedef {{v:1, t:"final-wager", amount:number}} FinalWagerMsg
   * @typedef {{v:1, t:"final-answer", text:string}} FinalAnswerMsg
   * @typedef {{v:1, t:"joined", playerName:string}} JoinedMsg
   * @typedef {{v:1, t:"reject", reason:"name-taken"|"room-full"|"bad-name"}} RejectMsg
   * @typedef {{v:1, t:"buzzer", mode:BuzzerMode, by?:string, reason?:LockReason}} BuzzerMsg
   * @typedef {{v:1, t:"dd-wager-request", category:string, clueValue:number,
   *            score:number, min:number, max:number}} DdWagerRequestMsg
   * @typedef {{v:1, t:"dd-wager-accepted", amount:number}} DdWagerAcceptedMsg
   * @typedef {{v:1, t:"dd-cancel"}} DdCancelMsg
   * @typedef {{v:1, t:"final", stage:"wager", category:string, score:number, max:number}} FinalWagerStageMsg
   * @typedef {{v:1, t:"final", stage:"answer", category:string, clue:string}} FinalAnswerStageMsg
   * @typedef {{v:1, t:"final", stage:"waiting"}} FinalWaitingStageMsg
   * @typedef {FinalWagerStageMsg|FinalAnswerStageMsg|FinalWaitingStageMsg} FinalMsg
   * @typedef {{v:1, t:"final-result", correct:boolean, delta:number, score:number}} FinalResultMsg
   * @typedef {{v:1, t:"final-cancel"}} FinalCancelMsg
   * @typedef {{v:1, t:"input-rejected", kind:"dd-wager"|"final-wager"|"final-answer", reason:string}} InputRejectedMsg
   * @typedef {{v:1, t:"room-closed"}} RoomClosedMsg
   * @typedef {JoinMsg|BuzzMsg|DdWagerMsg|FinalWagerMsg|FinalAnswerMsg|JoinedMsg|RejectMsg|BuzzerMsg|
   *           DdWagerRequestMsg|DdWagerAcceptedMsg|DdCancelMsg|FinalMsg|FinalResultMsg|FinalCancelMsg|
   *           InputRejectedMsg|RoomClosedMsg} ProtocolMsg
   */

  /* ============ Room-state typedefs ============ */

  /**
   * @typedef {{name:string, playerId:string|null, connected:boolean}} RoomPlayer
   * @typedef {{
   *   armed:boolean,
   *   reading:boolean,
   *   winnerId:string|null,
   *   lockedOut:Record<string,boolean>,
   *   lockReason:Record<string,LockReason>,
   *   players:Record<string,RoomPlayer>
   * }} RoomState
   *
   * @typedef {{to:string, msg:ProtocolMsg}} SendEffect
   * @typedef {{addPlayer:string}} AddPlayerEffect
   * @typedef {{linkPlayer:string}} LinkPlayerEffect
   * @typedef {{close:string}} CloseEffect
   * @typedef {SendEffect|AddPlayerEffect|LinkPlayerEffect|CloseEffect} Effect
   *
   * @typedef {{type:"join", peerId:string, name:string,
   *            roster:Array<{id:string,name:string}>, maxPlayers:number,
   *            newPlayerId:string}} JoinEvent
   * @typedef {{type:"buzz", peerId:string}} BuzzEvent
   * @typedef {{type:"arm"}} ArmEvent
   * @typedef {{type:"disarm"}} DisarmEvent
   * @typedef {{type:"judgedWrong", playerId:string}} JudgedWrongEvent
   * @typedef {{type:"clueReset"}} ClueResetEvent
   * @typedef {{type:"clueOpened"}} ClueOpenedEvent — regular clue opened: reading window starts.
   * @typedef {{type:"answerRevealed"}} AnswerRevealedEvent — window ends unarmed.
   * @typedef {{type:"leave", peerId:string}} LeaveEvent
   * @typedef {JoinEvent|BuzzEvent|ArmEvent|DisarmEvent|JudgedWrongEvent|ClueResetEvent|
   *           ClueOpenedEvent|AnswerRevealedEvent|LeaveEvent} RoomEvent
   *
   * @typedef {{category?:string, clueValue?:number, score?:number, min?:number,
   *            max?:number, clue?:string}} PlayerPrompt
   * @typedef {{correct:boolean, delta:number, score:number}} PlayerResult
   * @typedef {{screen:"join"|"buzzer"|"dd-wager"|"final-wager"|"final-answer"|
   *            "final-waiting"|"final-result",
   *            mode:BuzzerMode, by:string|null, lockReason:LockReason|null,
   *            playerName:string|null, notice:string|null, prompt:PlayerPrompt|null,
   *            result:PlayerResult|null}} PlayerUiState
   */

  /* ============ Room code + name helpers ============ */

  /**
   * Generate a 4-char room code. `randFn` is injectable (default Math.random)
   * so the code is deterministic under a seeded RNG in tests.
   * @param {() => number} [randFn]
   * @returns {string}
   */
  function generateRoomCode(randFn) {
    const rand = typeof randFn === "function" ? randFn : Math.random;
    let code = "";
    for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
      const idx = Math.floor(rand() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length;
      code += ROOM_ALPHABET.charAt(idx);
    }
    return code;
  }

  /**
   * Clean a player-supplied name: strip control chars, trim, cap at 24.
   * @param {unknown} raw
   * @returns {string|null} cleaned name, or null when empty/invalid.
   */
  function sanitizeName(raw) {
    if (typeof raw !== "string") return null;
    const stripped = raw.replace(CONTROL_CHARS, "");
    const trimmed = stripped.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, NAME_MAX).trim();
  }

  /**
   * Clean a typed Final-Jeopardy answer: strip control chars, trim, cap at 120.
   * Empty after cleaning → null (treated by callers as "no answer"). Purely a
   * display value — answers are never compared to the correct answer (spec §8.2).
   * @param {unknown} raw
   * @returns {string|null}
   */
  function sanitizeAnswer(raw) {
    if (typeof raw !== "string") return null;
    const stripped = raw.replace(CONTROL_CHARS, "");
    const trimmed = stripped.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, ANSWER_MAX).trim();
  }

  /* ============ Wager-bounds helpers (host-authoritative) ============ */

  /**
   * True iff `amount` is an integer within [min, max]. All phone numeric input
   * is validated host-side against the same bounds the manual UI enforces.
   * @param {unknown} amount
   * @param {number} min
   * @param {number} max
   * @returns {boolean}
   */
  function isWagerInRange(amount, min, max) {
    return Number.isInteger(amount) && amount >= min && amount <= max;
  }

  /** Daily-Double wager bounds: MIN_WAGER..max. @returns {boolean} */
  function isValidDdWager(amount, max) {
    return isWagerInRange(amount, MIN_WAGER, max);
  }

  /** Final-Jeopardy wager bounds: 0..max. @returns {boolean} */
  function isValidFinalWager(amount, max) {
    return isWagerInRange(amount, 0, max);
  }

  /* ============ Message validation ============ */

  /**
   * Validate + normalise a decoded message. Returns a typed message with only
   * the known fields, or null for anything malformed or unknown (so callers can
   * ignore it without throwing — forward-compatible with future `t` values).
   * @param {unknown} obj
   * @returns {ProtocolMsg|null}
   */
  function validateMessage(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const m = /** @type {Record<string, unknown>} */ (obj);
    if (m.v !== 1 || typeof m.t !== "string") return null;

    switch (m.t) {
      case "join":
        if (typeof m.name !== "string" || m.name.length > NAME_FIELD_MAX) return null;
        return { v: 1, t: "join", name: m.name };
      case "buzz":
        return { v: 1, t: "buzz" };
      case "dd-wager":
        if (!Number.isInteger(m.amount)) return null;
        return { v: 1, t: "dd-wager", amount: /** @type {number} */ (m.amount) };
      case "final-wager":
        if (!Number.isInteger(m.amount)) return null;
        return { v: 1, t: "final-wager", amount: /** @type {number} */ (m.amount) };
      case "final-answer":
        if (typeof m.text !== "string" || m.text.length > ANSWER_FIELD_MAX) return null;
        return { v: 1, t: "final-answer", text: m.text };
      case "joined":
        if (typeof m.playerName !== "string" || m.playerName.length > NAME_FIELD_MAX) return null;
        return { v: 1, t: "joined", playerName: m.playerName };
      case "reject":
        if (typeof m.reason !== "string" || !REJECT_REASONS.has(m.reason)) return null;
        return { v: 1, t: "reject", reason: /** @type {RejectMsg["reason"]} */ (m.reason) };
      case "buzzer":
        return validateBuzzer(m);
      case "dd-wager-request":
        return validateDdRequest(m);
      case "dd-wager-accepted":
        if (!Number.isFinite(m.amount)) return null;
        return { v: 1, t: "dd-wager-accepted", amount: /** @type {number} */ (m.amount) };
      case "dd-cancel":
        return { v: 1, t: "dd-cancel" };
      case "final":
        return validateFinalMsg(m);
      case "final-result":
        if (typeof m.correct !== "boolean" || !Number.isFinite(m.delta) || !Number.isFinite(m.score)) {
          return null;
        }
        return {
          v: 1, t: "final-result",
          correct: m.correct, delta: /** @type {number} */ (m.delta), score: /** @type {number} */ (m.score),
        };
      case "final-cancel":
        return { v: 1, t: "final-cancel" };
      case "input-rejected":
        if (typeof m.kind !== "string" || !INPUT_REJECT_KINDS.has(m.kind)) return null;
        if (typeof m.reason !== "string" || m.reason.length > HOST_TEXT_MAX) return null;
        return {
          v: 1, t: "input-rejected",
          kind: /** @type {InputRejectedMsg["kind"]} */ (m.kind), reason: m.reason,
        };
      case "room-closed":
        return { v: 1, t: "room-closed" };
      default:
        return null; // unknown `t` → ignorable
    }
  }

  /**
   * @param {Record<string, unknown>} m
   * @returns {DdWagerRequestMsg|null}
   */
  function validateDdRequest(m) {
    if (typeof m.category !== "string" || m.category.length > HOST_TEXT_MAX) return null;
    if (!Number.isFinite(m.clueValue) || !Number.isFinite(m.score)) return null;
    if (!Number.isFinite(m.min) || !Number.isFinite(m.max)) return null;
    return {
      v: 1, t: "dd-wager-request",
      category: m.category,
      clueValue: /** @type {number} */ (m.clueValue),
      score: /** @type {number} */ (m.score),
      min: /** @type {number} */ (m.min),
      max: /** @type {number} */ (m.max),
    };
  }

  /**
   * @param {Record<string, unknown>} m
   * @returns {FinalMsg|null}
   */
  function validateFinalMsg(m) {
    if (typeof m.stage !== "string" || !FINAL_STAGES.has(m.stage)) return null;
    if (m.stage === "waiting") return { v: 1, t: "final", stage: "waiting" };
    if (typeof m.category !== "string" || m.category.length > HOST_TEXT_MAX) return null;
    if (m.stage === "wager") {
      if (!Number.isFinite(m.score) || !Number.isFinite(m.max)) return null;
      return {
        v: 1, t: "final", stage: "wager",
        category: m.category, score: /** @type {number} */ (m.score), max: /** @type {number} */ (m.max),
      };
    }
    // stage === "answer"
    if (typeof m.clue !== "string" || m.clue.length > HOST_TEXT_MAX) return null;
    return { v: 1, t: "final", stage: "answer", category: m.category, clue: m.clue };
  }

  /**
   * @param {Record<string, unknown>} m
   * @returns {BuzzerMsg|null}
   */
  function validateBuzzer(m) {
    if (typeof m.mode !== "string" || !BUZZER_MODES.has(m.mode)) return null;
    if (m.by !== undefined && typeof m.by !== "string") return null;
    /** @type {BuzzerMsg} */
    const out = { v: 1, t: "buzzer", mode: /** @type {BuzzerMode} */ (m.mode) };
    if (typeof m.by === "string") out.by = m.by;
    // An unknown/absent reason is dropped, not fatal — receivers treat a locked
    // message with no reason as "wrong" (spec §5), so junk stays forward-compatible.
    if (typeof m.reason === "string" && LOCK_REASONS.has(m.reason)) {
      out.reason = /** @type {LockReason} */ (m.reason);
    }
    return out;
  }

  /* ============ Message + effect builders ============ */

  /** @returns {SendEffect} */
  function send(to, msg) {
    return { to, msg };
  }

  /** @returns {BuzzerMsg} */
  function buzzerMsg(mode, by, reason) {
    /** @type {BuzzerMsg} */
    const msg = { v: 1, t: "buzzer", mode };
    if (by) msg.by = by;
    if (reason) msg.reason = reason;
    return msg;
  }

  /* ----- host→player payload builders (kept pure + testable, spec §8.4) ----- */

  /** @returns {DdWagerRequestMsg} */
  function ddWagerRequestMsg(category, clueValue, score, min, max) {
    return { v: 1, t: "dd-wager-request", category, clueValue, score, min, max };
  }
  /** @returns {DdWagerAcceptedMsg} */
  function ddAcceptedMsg(amount) {
    return { v: 1, t: "dd-wager-accepted", amount };
  }
  /** @returns {DdCancelMsg} */
  function ddCancelMsg() {
    return { v: 1, t: "dd-cancel" };
  }
  /** @returns {FinalWagerStageMsg} */
  function finalWagerMsg(category, score, max) {
    return { v: 1, t: "final", stage: "wager", category, score, max };
  }
  /** @returns {FinalAnswerStageMsg} */
  function finalAnswerMsg(category, clue) {
    return { v: 1, t: "final", stage: "answer", category, clue };
  }
  /** @returns {FinalWaitingStageMsg} */
  function finalWaitingMsg() {
    return { v: 1, t: "final", stage: "waiting" };
  }
  /** @returns {FinalResultMsg} */
  function finalResultMsg(correct, delta, score) {
    return { v: 1, t: "final-result", correct, delta, score };
  }
  /** @returns {FinalCancelMsg} */
  function finalCancelMsg() {
    return { v: 1, t: "final-cancel" };
  }
  /** @returns {InputRejectedMsg} */
  function inputRejectedMsg(kind, reason) {
    return { v: 1, t: "input-rejected", kind, reason };
  }

  /* ============ Room state ============ */

  /** @returns {RoomState} */
  function createRoomState() {
    return { armed: false, reading: false, winnerId: null, lockedOut: {}, lockReason: {}, players: {} };
  }

  /** Peer ids of players currently connected. @returns {string[]} */
  function connectedPeers(state) {
    return Object.keys(state.players).filter((id) => state.players[id].connected);
  }

  /** The buzzer mode a given peer should currently see. @returns {BuzzerMode} */
  function modeForPeer(state, peerId) {
    if (state.lockedOut[peerId]) return "locked";
    if (state.winnerId) return peerId === state.winnerId ? "won" : "taken";
    if (state.armed) return "armed";
    if (state.reading) return "reading";
    return "idle";
  }

  /** Name to show as the buzz winner, if any. @returns {string|null} */
  function winnerName(state) {
    const w = state.winnerId && state.players[state.winnerId];
    return w ? w.name : null;
  }

  /**
   * Send every connected, NON-locked peer the buzzer mode it should now see.
   * Locked phones are intentionally skipped: their screen (and its "early" vs
   * "wrong" reason) is set once at lock time and must not be overwritten by a
   * generic re-broadcast; a `clueReset` clears the lock and sends `idle`.
   */
  function broadcastModes(state) {
    return connectedPeers(state)
      .filter((id) => !state.lockedOut[id])
      .map((id) => send(id, buzzerMsg(modeForPeer(state, id), winnerName(state))));
  }

  /* ============ Room reducer ============ */

  /**
   * Pure host-side reducer. Given the current room state and an event, returns
   * the next state plus a list of effects (message sends + roster instructions)
   * for the glue layer to carry out. Never mutates its inputs.
   * @param {RoomState} state
   * @param {RoomEvent} event
   * @returns {{next: RoomState, effects: Effect[]}}
   */
  function roomReduce(state, event) {
    switch (event && event.type) {
      case "join": return reduceJoin(state, event);
      case "buzz": return reduceBuzz(state, event);
      case "arm": return reduceArm(state);
      case "disarm": return reduceDisarm(state);
      case "judgedWrong": return reduceJudgedWrong(state, event);
      case "clueReset": return reduceClueReset(state);
      case "clueOpened": return reduceClueOpened(state);
      case "answerRevealed": return reduceAnswerRevealed(state);
      case "leave": return reduceLeave(state, event);
      default: return { next: state, effects: [] };
    }
  }

  /**
   * @param {RoomState} state
   * @param {JoinEvent} event
   */
  function reduceJoin(state, event) {
    const cleaned = sanitizeName(event.name);
    if (!cleaned) return reject(state, event.peerId, "bad-name");

    const lower = cleaned.toLowerCase();
    const takenByLive = Object.keys(state.players).some((id) => {
      const p = state.players[id];
      return p.connected && p.name.toLowerCase() === lower;
    });
    if (takenByLive) return reject(state, event.peerId, "name-taken");

    const roster = Array.isArray(event.roster) ? event.roster : [];
    const match = roster.find(
      (r) => r && typeof r.name === "string" && r.name.toLowerCase() === lower
    );

    if (match) return acceptJoin(state, event.peerId, match.name, match.id, "linkPlayer");
    if (roster.length >= event.maxPlayers) return reject(state, event.peerId, "room-full");
    return acceptJoin(state, event.peerId, cleaned, event.newPlayerId, "addPlayer");
  }

  /**
   * Add/relink a connection, then emit joined + the roster instruction + an
   * initial buzzer-state sync for the joining peer.
   * @param {RoomState} state
   * @param {"addPlayer"|"linkPlayer"} rosterKey
   */
  function acceptJoin(state, peerId, displayName, playerId, rosterKey) {
    // Drop any stale room entries for the same scoreboard player (reconnect),
    // and hand a retained winner slot over to the fresh connection.
    /** @type {Record<string, RoomPlayer>} */
    const players = {};
    let winnerId = state.winnerId;
    for (const id of Object.keys(state.players)) {
      if (state.players[id].playerId === playerId) {
        if (winnerId === id) winnerId = peerId;
        continue;
      }
      players[id] = state.players[id];
    }
    players[peerId] = { name: displayName, playerId, connected: true };

    const next = { ...state, players, winnerId };
    const rosterEffect =
      rosterKey === "linkPlayer" ? { linkPlayer: playerId } : { addPlayer: displayName };
    return {
      next,
      effects: [
        send(peerId, { v: 1, t: "joined", playerName: displayName }),
        rosterEffect,
        send(peerId, buzzerMsg(modeForPeer(next, peerId), winnerName(next))),
      ],
    };
  }

  /**
   * @param {RoomState} state
   * @param {RejectMsg["reason"]} reason
   */
  function reject(state, peerId, reason) {
    return {
      next: state,
      effects: [send(peerId, { v: 1, t: "reject", reason }), { close: peerId }],
    };
  }

  /**
   * A buzz is arbitrated purely by arrival order at the host (spec §5): armed →
   * win; reading (open, not armed) → the sender jumped early and is locked out of
   * this clue; anything else (idle / already won / already locked / gone) → ignore.
   * @param {RoomState} state
   * @param {BuzzEvent} event
   */
  function reduceBuzz(state, event) {
    const peer = state.players[event.peerId];
    if (!peer || !peer.connected) return { next: state, effects: [] };
    if (state.winnerId || state.lockedOut[event.peerId]) return { next: state, effects: [] };
    if (state.armed) return winBuzz(state, event, peer);
    if (state.reading) return earlyLock(state, event);
    return { next: state, effects: [] }; // idle — no live clue window, no penalty
  }

  /**
   * @param {RoomState} state
   * @param {BuzzEvent} event
   * @param {RoomPlayer} peer
   */
  function winBuzz(state, event, peer) {
    const next = { ...state, winnerId: event.peerId };
    /** @type {Effect[]} */
    const effects = [send(event.peerId, buzzerMsg("won"))];
    for (const id of connectedPeers(next)) {
      if (id !== event.peerId && !next.lockedOut[id]) {
        effects.push(send(id, buzzerMsg("taken", peer.name)));
      }
    }
    return { next, effects };
  }

  /**
   * Early buzz during the reading window: lock the sender out of this whole clue
   * (reusing lockedOut so arm/re-arm exclude them for free), tag the reason
   * "early" for the host's buzz bar, and tell only that phone. Scores never move.
   * @param {RoomState} state
   * @param {BuzzEvent} event
   */
  function earlyLock(state, event) {
    const next = {
      ...state,
      lockedOut: { ...state.lockedOut, [event.peerId]: true },
      lockReason: { ...(state.lockReason || {}), [event.peerId]: "early" },
    };
    return { next, effects: [send(event.peerId, buzzerMsg("locked", null, "early"))] };
  }

  /** @param {RoomState} state */
  function reduceArm(state) {
    const next = { ...state, armed: true, winnerId: null };
    return { next, effects: broadcastModes(next) };
  }

  /** @param {RoomState} state */
  function reduceDisarm(state) {
    const next = { ...state, armed: false };
    // With a winner held (mid-judging) leave the won/taken screens untouched.
    if (state.winnerId) return { next, effects: [] };
    return { next, effects: broadcastModes(next) };
  }

  /**
   * @param {RoomState} state
   * @param {JudgedWrongEvent} event
   */
  function reduceJudgedWrong(state, event) {
    const winner = state.winnerId ? state.players[state.winnerId] : null;
    if (!winner || winner.playerId !== event.playerId) return { next: state, effects: [] };

    const lockedPeer = state.winnerId;
    const next = {
      ...state,
      winnerId: null,
      armed: true,
      lockedOut: { ...state.lockedOut, [lockedPeer]: true },
      lockReason: { ...(state.lockReason || {}), [lockedPeer]: "wrong" },
    };
    /** @type {Effect[]} */
    const effects = [send(lockedPeer, buzzerMsg("locked", null, "wrong"))];
    for (const id of connectedPeers(next)) {
      if (id !== lockedPeer && !next.lockedOut[id]) effects.push(send(id, buzzerMsg("armed")));
    }
    return { next, effects };
  }

  /** Clue closed/next clue: wipe the whole per-clue slice, everyone back to idle. */
  function reduceClueReset(state) {
    const next = { ...state, armed: false, reading: false, winnerId: null, lockedOut: {}, lockReason: {} };
    return { next, effects: broadcastModes(next) };
  }

  /**
   * A regular clue opened: the reading window begins. Non-locked phones flip to
   * the RED "reading" trap; already-locked phones are a no-op (they keep their
   * lockout, which a preceding clueReset would normally have cleared). Winner/arm
   * are cleared defensively so the fresh window is clean.
   * @param {RoomState} state
   */
  function reduceClueOpened(state) {
    const next = { ...state, reading: true, armed: false, winnerId: null };
    return { next, effects: broadcastModes(next) };
  }

  /**
   * Answer revealed with nobody buzzed: the buzzable window ends. Phones go idle
   * (reading false, not armed). A held winner (mid-judge) keeps their screen.
   * @param {RoomState} state
   */
  function reduceAnswerRevealed(state) {
    const next = { ...state, armed: false, reading: false };
    if (state.winnerId) return { next, effects: [] };
    return { next, effects: broadcastModes(next) };
  }

  /**
   * @param {RoomState} state
   * @param {LeaveEvent} event
   */
  function reduceLeave(state, event) {
    if (!state.players[event.peerId]) return { next: state, effects: [] };

    // Keep the winner slot (host may still be judging them), just mark it down.
    if (event.peerId === state.winnerId) {
      const players = {
        ...state.players,
        [event.peerId]: { ...state.players[event.peerId], connected: false },
      };
      return { next: { ...state, players }, effects: [] };
    }
    const players = { ...state.players };
    delete players[event.peerId];
    return { next: { ...state, players }, effects: [] };
  }

  /* ============ Player reducer ============ */

  /** @returns {PlayerUiState} */
  function createPlayerUiState() {
    return {
      screen: "join", mode: "idle", by: null, lockReason: null, playerName: null,
      notice: null, prompt: null, result: null,
    };
  }

  /** @param {RejectMsg["reason"]} reason */
  function rejectNotice(reason) {
    if (reason === "name-taken") return "That name is already taken — pick another.";
    if (reason === "room-full") return "This room is full.";
    return "Enter a valid name.";
  }

  /**
   * Pure player-side reducer: fold one host→player message into the phone UI
   * state. Junk / player→host / unknown messages leave the state untouched.
   * @param {PlayerUiState} ui
   * @param {unknown} rawMsg
   * @returns {PlayerUiState}
   */
  function playerReduce(ui, rawMsg) {
    const msg = validateMessage(rawMsg);
    if (!msg) return ui;
    switch (msg.t) {
      case "joined":
        return {
          ...ui, screen: "buzzer", mode: "idle", by: null, lockReason: null,
          playerName: msg.playerName, notice: null, prompt: null, result: null,
        };
      case "reject":
        return { ...ui, screen: "join", notice: rejectNotice(msg.reason) };
      case "buzzer":
        // A live buzzer update clears any lingering "wager locked" beat. The lock
        // reason (early vs wrong) rides along so the phone shows the right label.
        return {
          ...ui, screen: "buzzer", mode: msg.mode, by: msg.by ?? null,
          lockReason: msg.reason ?? null, prompt: null, notice: null,
        };
      case "dd-wager-request":
        return {
          ...ui, screen: "dd-wager", notice: null, result: null,
          prompt: {
            category: msg.category, clueValue: msg.clueValue,
            score: msg.score, min: msg.min, max: msg.max,
          },
        };
      case "dd-wager-accepted":
        return {
          ...ui, screen: "buzzer", prompt: null, result: null,
          notice: "Wager locked — look up!",
        };
      case "dd-cancel":
        return { ...ui, screen: "buzzer", prompt: null, result: null, notice: null };
      case "final":
        return reduceFinalStage(ui, msg);
      case "final-result":
        return {
          ...ui, screen: "final-result", prompt: null, notice: null,
          result: { correct: msg.correct, delta: msg.delta, score: msg.score },
        };
      case "final-cancel":
        return { ...ui, screen: "buzzer", prompt: null, result: null, notice: null };
      case "input-rejected":
        // Stay on the current form; surface the host's reason so the phone
        // re-shows the field with the error (spec §5).
        return { ...ui, notice: msg.reason };
      case "room-closed":
        return {
          ...ui, screen: "join", mode: "idle", by: null, lockReason: null,
          notice: "The host closed the room.", prompt: null, result: null,
        };
      default:
        return ui; // join / buzz / *-wager / final-answer are player→host.
    }
  }

  /**
   * Fold a host `final` stage message into the phone UI.
   * @param {PlayerUiState} ui
   * @param {FinalMsg} msg
   * @returns {PlayerUiState}
   */
  function reduceFinalStage(ui, msg) {
    if (msg.stage === "wager") {
      return {
        ...ui, screen: "final-wager", notice: null, result: null,
        prompt: { category: msg.category, score: msg.score, min: 0, max: msg.max },
      };
    }
    if (msg.stage === "answer") {
      return {
        ...ui, screen: "final-answer", notice: null, result: null,
        prompt: { category: msg.category, clue: msg.clue },
      };
    }
    return { ...ui, screen: "final-waiting", notice: null, prompt: null };
  }

  return {
    ROOM_ALPHABET,
    ROOM_CODE_RE,
    NAME_MAX,
    ANSWER_MAX,
    MIN_WAGER,
    generateRoomCode,
    sanitizeName,
    sanitizeAnswer,
    isWagerInRange,
    isValidDdWager,
    isValidFinalWager,
    validateMessage,
    createRoomState,
    roomReduce,
    createPlayerUiState,
    playerReduce,
    // host→player payload builders (spec §8.4)
    ddWagerRequestMsg,
    ddAcceptedMsg,
    ddCancelMsg,
    finalWagerMsg,
    finalAnswerMsg,
    finalWaitingMsg,
    finalResultMsg,
    finalCancelMsg,
    inputRejectedMsg,
  };
});
