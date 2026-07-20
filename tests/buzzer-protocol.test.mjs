/* ============================================================
   Unit tests for the pure buzzer protocol core (spec Part B, U1–U12).
   Zero npm deps: node:test + node:assert only.
   Run from the project root:  node --test tests/
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import BP from "../js/buzzer-protocol.js";

/* ---- helpers ------------------------------------------------ */

// Deterministic LCG so RNG-injected functions are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CTRL = (n) => String.fromCharCode(n);

/** Build a room state with the given connected players. */
function roomWith(players, extra = {}) {
  const state = BP.createRoomState();
  return { ...state, ...extra, players: { ...players } };
}

/** Peer entry shorthand. */
function peer(name, playerId, connected = true) {
  return { name, playerId, connected };
}

/** All effects that are message sends to a specific peer. */
function sendsTo(effects, peerId) {
  return effects.filter((e) => e.to === peerId && e.msg);
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

/* ============ U1 — generateRoomCode ============ */

test("U1 room code: 4 chars, allowed alphabet only, deterministic", () => {
  const rng = lcg(12345);
  for (let i = 0; i < 500; i += 1) {
    const code = BP.generateRoomCode(rng);
    assert.equal(code.length, 4);
    for (const ch of code) {
      assert.ok(BP.ROOM_ALPHABET.includes(ch), `char ${ch} not in alphabet`);
      assert.ok(!"ILO01".includes(ch), `ambiguous char ${ch} leaked`);
    }
  }
  // Deterministic under an injected RNG: same seed => same sequence.
  assert.equal(BP.generateRoomCode(lcg(7)), BP.generateRoomCode(lcg(7)));
  assert.equal(BP.generateRoomCode(() => 0), "AAAA");
});

/* ============ U2 — sanitizeName ============ */

test("U2 sanitizeName: trims, strips control chars, caps at 24, junk -> null", () => {
  assert.equal(BP.sanitizeName("  Rita  "), "Rita");
  assert.equal(BP.sanitizeName("a" + CTRL(0) + CTRL(9) + CTRL(31) + CTRL(127) + "b"), "ab");
  assert.equal(BP.sanitizeName("x".repeat(40)).length, 24);
  assert.equal(BP.sanitizeName("   "), null);
  assert.equal(BP.sanitizeName(""), null);
  assert.equal(BP.sanitizeName(CTRL(0) + CTRL(1) + CTRL(2)), null);
  for (const junk of [null, undefined, 123, {}, [], true]) {
    assert.equal(BP.sanitizeName(junk), null);
  }
});

/* ============ U3 — validateMessage ============ */

test("U3 validateMessage: accepts join/buzz, null for junk, unknown t ignorable", () => {
  assert.deepEqual(BP.validateMessage({ v: 1, t: "join", name: "Rita" }), {
    v: 1, t: "join", name: "Rita",
  });
  assert.deepEqual(BP.validateMessage({ v: 1, t: "buzz" }), { v: 1, t: "buzz" });

  // Junk: non-objects and wrong-typed fields.
  for (const junk of [null, undefined, 123, "x", [], { t: "join" }, { v: 2, t: "buzz" }]) {
    assert.equal(BP.validateMessage(junk), null);
  }
  assert.equal(BP.validateMessage({ v: 1, t: "join" }), null); // missing name
  assert.equal(BP.validateMessage({ v: 1, t: "join", name: 5 }), null); // wrong type
  assert.equal(BP.validateMessage({ v: 1, t: "join", name: "x".repeat(241) }), null); // oversized

  // Unknown t -> ignorable (null), and never throws.
  let unknown;
  assert.doesNotThrow(() => { unknown = BP.validateMessage({ v: 1, t: "future-thing", x: 9 }); });
  assert.equal(unknown, null);

  // Host->player shapes validate too; bad enums rejected.
  assert.ok(BP.validateMessage({ v: 1, t: "joined", playerName: "Rita" }));
  assert.ok(BP.validateMessage({ v: 1, t: "reject", reason: "room-full" }));
  assert.equal(BP.validateMessage({ v: 1, t: "reject", reason: "nope" }), null);
  assert.ok(BP.validateMessage({ v: 1, t: "buzzer", mode: "armed" }));
  assert.deepEqual(BP.validateMessage({ v: 1, t: "buzzer", mode: "taken", by: "Rita" }), {
    v: 1, t: "buzzer", mode: "taken", by: "Rita",
  });
  assert.equal(BP.validateMessage({ v: 1, t: "buzzer", mode: "purple" }), null);
  assert.equal(BP.validateMessage({ v: 1, t: "buzzer", mode: "armed", by: 5 }), null);
  assert.ok(BP.validateMessage({ v: 1, t: "room-closed" }));
});

/* ============ U4 — join flow ============ */

test("U4 join: new name -> joined + addPlayer instruction", () => {
  const state = BP.createRoomState();
  const { next, effects } = BP.roomReduce(state, {
    type: "join", peerId: "A", name: "Rita", roster: [], maxPlayers: 8, newPlayerId: "np1",
  });
  assert.ok(effects.some((e) => e.msg && e.msg.t === "joined" && e.msg.playerName === "Rita"));
  assert.ok(effects.some((e) => e.addPlayer === "Rita"));
  assert.ok(!effects.some((e) => e.linkPlayer));
  assert.deepEqual(next.players.A, peer("Rita", "np1", true));
});

test("U4 join: case-insensitive name links to existing player, no roster-add", () => {
  const state = BP.createRoomState();
  const { next, effects } = BP.roomReduce(state, {
    type: "join", peerId: "A", name: "rita", roster: [{ id: "p1", name: "Rita" }],
    maxPlayers: 8, newPlayerId: "np1",
  });
  assert.ok(effects.some((e) => e.linkPlayer === "p1"));
  assert.ok(!effects.some((e) => e.addPlayer));
  // Display name comes from the roster's stored casing.
  assert.ok(effects.some((e) => e.msg && e.msg.t === "joined" && e.msg.playerName === "Rita"));
  assert.equal(next.players.A.playerId, "p1");
});

test("U4 join: name held by a live connection -> reject name-taken + close", () => {
  const state = roomWith({ B: peer("Bob", "p1", true) });
  const { next, effects } = BP.roomReduce(state, {
    type: "join", peerId: "C", name: "BOB", roster: [{ id: "p1", name: "Bob" }],
    maxPlayers: 8, newPlayerId: "np2",
  });
  assert.ok(effects.some((e) => e.msg && e.msg.t === "reject" && e.msg.reason === "name-taken"));
  assert.ok(effects.some((e) => e.close === "C"));
  assert.equal(next.players.C, undefined); // not added
});

test("U4 join: unknown name with a full roster -> reject room-full", () => {
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const { effects } = BP.roomReduce(BP.createRoomState(), {
    type: "join", peerId: "A", name: "Newbie", roster, maxPlayers: 8, newPlayerId: "np1",
  });
  assert.ok(effects.some((e) => e.msg && e.msg.t === "reject" && e.msg.reason === "room-full"));
  assert.ok(effects.some((e) => e.close === "A"));
});

test("U4 join: empty/blank name -> reject bad-name", () => {
  const { effects } = BP.roomReduce(BP.createRoomState(), {
    type: "join", peerId: "A", name: "   ", roster: [], maxPlayers: 8, newPlayerId: "np1",
  });
  assert.ok(effects.some((e) => e.msg && e.msg.t === "reject" && e.msg.reason === "bad-name"));
});

/* ============ U5 — arm ============ */

test("U5 arm: all connected, non-locked players receive armed", () => {
  const state = roomWith(
    { A: peer("Ann", "p1"), B: peer("Bo", "p2"), C: peer("Cy", "p3", false) },
    { lockedOut: { B: true } }
  );
  const { next, effects } = BP.roomReduce(state, { type: "arm" });
  assert.equal(next.armed, true);
  // A is connected + not locked -> armed.
  assert.ok(sendsTo(effects, "A").some((e) => e.msg.t === "buzzer" && e.msg.mode === "armed"));
  // B is locked -> not armed (gets locked instead).
  assert.ok(!sendsTo(effects, "B").some((e) => e.msg.mode === "armed"));
  // C is disconnected -> no message at all.
  assert.equal(sendsTo(effects, "C").length, 0);
});

/* ============ U6 — first buzz wins ============ */

test("U6 first buzz wins: winner won, others taken(by), second buzz no-op", () => {
  const armed = roomWith({ A: peer("Ann", "p1"), B: peer("Bo", "p2") }, { armed: true });
  const first = BP.roomReduce(armed, { type: "buzz", peerId: "A" });
  assert.equal(first.next.winnerId, "A");
  assert.ok(sendsTo(first.effects, "A").some((e) => e.msg.t === "buzzer" && e.msg.mode === "won"));
  const takenB = sendsTo(first.effects, "B").find((e) => e.msg.mode === "taken");
  assert.ok(takenB && takenB.msg.by === "Ann");

  // A second buzz from B changes nothing.
  const second = BP.roomReduce(first.next, { type: "buzz", peerId: "B" });
  assert.equal(second.next, first.next);
  assert.deepEqual(second.effects, []);
});

/* ============ U7 — buzz ignored ============ */

test("U7 buzz ignored: not armed / already won / locked out", () => {
  const players = { A: peer("Ann", "p1"), B: peer("Bo", "p2") };

  const notArmed = roomWith(players, { armed: false });
  const r1 = BP.roomReduce(notArmed, { type: "buzz", peerId: "A" });
  assert.equal(r1.next, notArmed);
  assert.deepEqual(r1.effects, []);

  const alreadyWon = roomWith(players, { armed: true, winnerId: "A" });
  const r2 = BP.roomReduce(alreadyWon, { type: "buzz", peerId: "B" });
  assert.equal(r2.next, alreadyWon);
  assert.deepEqual(r2.effects, []);

  const lockedSender = roomWith(players, { armed: true, lockedOut: { A: true } });
  const r3 = BP.roomReduce(lockedSender, { type: "buzz", peerId: "A" });
  assert.equal(r3.next, lockedSender);
  assert.deepEqual(r3.effects, []);
});

/* ============ U8 — judgedWrong ============ */

test("U8 judgedWrong on winner: locks winner, re-arms the rest", () => {
  const state = roomWith(
    { A: peer("Ann", "p1"), B: peer("Bo", "p2") },
    { armed: true, winnerId: "A" }
  );
  const { next, effects } = BP.roomReduce(state, { type: "judgedWrong", playerId: "p1" });
  assert.equal(next.winnerId, null);
  assert.equal(next.armed, true);
  assert.equal(next.lockedOut.A, true);
  assert.ok(sendsTo(effects, "A").some((e) => e.msg.t === "buzzer" && e.msg.mode === "locked"));
  assert.ok(sendsTo(effects, "B").some((e) => e.msg.t === "buzzer" && e.msg.mode === "armed"));
});

test("U8 judgedWrong on a non-winner: no change", () => {
  const state = roomWith(
    { A: peer("Ann", "p1"), B: peer("Bo", "p2") },
    { armed: true, winnerId: "A" }
  );
  const { next, effects } = BP.roomReduce(state, { type: "judgedWrong", playerId: "p2" });
  assert.equal(next, state);
  assert.deepEqual(effects, []);
});

/* ============ U9 — clueReset ============ */

test("U9 clueReset: clears winner + lockouts, everyone idle", () => {
  const state = roomWith(
    { A: peer("Ann", "p1"), B: peer("Bo", "p2") },
    { armed: true, winnerId: "A", lockedOut: { B: true } }
  );
  const { next, effects } = BP.roomReduce(state, { type: "clueReset" });
  assert.equal(next.winnerId, null);
  assert.deepEqual(next.lockedOut, {});
  assert.equal(next.armed, false);
  for (const id of ["A", "B"]) {
    assert.ok(sendsTo(effects, id).some((e) => e.msg.t === "buzzer" && e.msg.mode === "idle"));
  }
});

/* ============ U10 — leave ============ */

test("U10 leave: non-winner removed; winner retained but disconnected", () => {
  const base = roomWith(
    { A: peer("Ann", "p1"), B: peer("Bo", "p2") },
    { armed: true, winnerId: "A" }
  );

  // Non-winner leaves -> removed entirely.
  const left = BP.roomReduce(base, { type: "leave", peerId: "B" });
  assert.equal(left.next.players.B, undefined);
  assert.ok(left.next.players.A);

  // Winner leaves mid-judging -> retained, marked disconnected, winnerId kept.
  const winnerGone = BP.roomReduce(base, { type: "leave", peerId: "A" });
  assert.equal(winnerGone.next.winnerId, "A");
  assert.equal(winnerGone.next.players.A.connected, false);
});

/* ============ U11 — immutability ============ */

test("U11 reducers never mutate frozen inputs", () => {
  const events = [
    { type: "join", peerId: "Z", name: "Zed", roster: [{ id: "p1", name: "Ann" }], maxPlayers: 8, newPlayerId: "np9" },
    { type: "buzz", peerId: "A" },
    { type: "arm" },
    { type: "disarm" },
    { type: "judgedWrong", playerId: "p1" },
    { type: "clueReset" },
    { type: "leave", peerId: "A" },
  ];
  for (const event of events) {
    const state = roomWith(
      { A: peer("Ann", "p1"), B: peer("Bo", "p2") },
      { armed: true, winnerId: "A", lockedOut: { B: true } }
    );
    const snapshot = JSON.parse(JSON.stringify(state));
    deepFreeze(state);
    deepFreeze(event);
    assert.doesNotThrow(() => BP.roomReduce(state, event), `event ${event.type} threw`);
    assert.deepEqual(state, snapshot, `event ${event.type} mutated input`);
  }

  // playerReduce is immutable too.
  const ui = deepFreeze(BP.createPlayerUiState());
  assert.doesNotThrow(() => BP.playerReduce(ui, { v: 1, t: "buzzer", mode: "armed" }));
});

/* ============ U12 — playerReduce ============ */

test("U12 playerReduce maps every buzzer mode and ignores junk", () => {
  const ui = BP.createPlayerUiState();
  for (const mode of ["idle", "armed", "won", "taken", "locked"]) {
    const nextUi = BP.playerReduce(ui, { v: 1, t: "buzzer", mode });
    assert.equal(nextUi.screen, "buzzer");
    assert.equal(nextUi.mode, mode);
  }
  const takenUi = BP.playerReduce(ui, { v: 1, t: "buzzer", mode: "taken", by: "Ann" });
  assert.equal(takenUi.by, "Ann");

  // joined / reject / room-closed transitions.
  const joined = BP.playerReduce(ui, { v: 1, t: "joined", playerName: "Rita" });
  assert.equal(joined.screen, "buzzer");
  assert.equal(joined.playerName, "Rita");
  const rejected = BP.playerReduce(ui, { v: 1, t: "reject", reason: "room-full" });
  assert.equal(rejected.screen, "join");
  assert.ok(rejected.notice);
  const closed = BP.playerReduce({ ...ui, screen: "buzzer" }, { v: 1, t: "room-closed" });
  assert.equal(closed.screen, "join");
  assert.ok(closed.notice);

  // Junk / player->host messages leave state untouched (same reference).
  for (const junk of [null, {}, "x", { v: 1, t: "buzzer", mode: "nope" }, { v: 1, t: "buzz" }]) {
    assert.equal(BP.playerReduce(ui, junk), ui);
  }
});

/* ============ U13 — sanitizeAnswer ============ */

test("U13 sanitizeAnswer: trims, strips control chars, caps at 120, empty -> null", () => {
  assert.equal(BP.sanitizeAnswer("  What is Rome?  "), "What is Rome?");
  assert.equal(BP.sanitizeAnswer("a" + CTRL(0) + CTRL(9) + CTRL(10) + CTRL(127) + "b"), "ab");
  assert.equal(BP.sanitizeAnswer("x".repeat(200)).length, 120);
  assert.equal(BP.sanitizeAnswer("   "), null);
  assert.equal(BP.sanitizeAnswer(""), null);
  assert.equal(BP.sanitizeAnswer(CTRL(1) + CTRL(2)), null);
  // Markup is preserved verbatim (display-only; rendered via textContent).
  assert.equal(BP.sanitizeAnswer("<img src=x onerror=1>"), "<img src=x onerror=1>");
  for (const junk of [null, undefined, 5, {}, [], true]) {
    assert.equal(BP.sanitizeAnswer(junk), null);
  }
});

/* ============ U14 — validateMessage: wager + answer messages ============ */

test("U14 validateMessage: dd-wager/final-wager integers, final-answer; rejects bad amounts", () => {
  assert.deepEqual(BP.validateMessage({ v: 1, t: "dd-wager", amount: 500 }), {
    v: 1, t: "dd-wager", amount: 500,
  });
  assert.deepEqual(BP.validateMessage({ v: 1, t: "final-wager", amount: 0 }), {
    v: 1, t: "final-wager", amount: 0,
  });
  assert.deepEqual(BP.validateMessage({ v: 1, t: "final-answer", text: "who is Ada?" }), {
    v: 1, t: "final-answer", text: "who is Ada?",
  });

  // Non-numeric / non-finite / non-integer amounts are rejected.
  for (const bad of [Infinity, -Infinity, NaN, 3.5, "5", "500", null, undefined, {}]) {
    assert.equal(BP.validateMessage({ v: 1, t: "dd-wager", amount: bad }), null, `dd-wager ${bad}`);
    assert.equal(BP.validateMessage({ v: 1, t: "final-wager", amount: bad }), null, `final-wager ${bad}`);
  }
  assert.equal(BP.validateMessage({ v: 1, t: "dd-wager" }), null); // missing amount

  // Oversized / wrong-typed answers rejected; empty string is structurally valid
  // (sanitizeAnswer decides "no answer" later).
  assert.equal(BP.validateMessage({ v: 1, t: "final-answer", text: "x".repeat(1201) }), null);
  assert.equal(BP.validateMessage({ v: 1, t: "final-answer", text: 5 }), null);
  assert.ok(BP.validateMessage({ v: 1, t: "final-answer", text: "" }));

  // Host→player wager/answer messages validate too; bad enums/types rejected.
  assert.ok(BP.validateMessage({ v: 1, t: "dd-wager-request", category: "Sci", clueValue: 400, score: 1000, min: 5, max: 2000 }));
  assert.equal(BP.validateMessage({ v: 1, t: "dd-wager-request", category: "Sci", clueValue: "x", score: 1, min: 5, max: 9 }), null);
  assert.ok(BP.validateMessage({ v: 1, t: "final", stage: "wager", category: "Sci", score: 1000, max: 1000 }));
  assert.ok(BP.validateMessage({ v: 1, t: "final", stage: "answer", category: "Sci", clue: "It orbits." }));
  assert.ok(BP.validateMessage({ v: 1, t: "final", stage: "waiting" }));
  assert.equal(BP.validateMessage({ v: 1, t: "final", stage: "bogus" }), null);
  assert.deepEqual(BP.validateMessage({ v: 1, t: "final-result", correct: true, delta: 500, score: 1500 }), {
    v: 1, t: "final-result", correct: true, delta: 500, score: 1500,
  });
  assert.equal(BP.validateMessage({ v: 1, t: "final-result", correct: "yes", delta: 1, score: 1 }), null);
  assert.ok(BP.validateMessage({ v: 1, t: "input-rejected", kind: "final-wager", reason: "too big" }));
  assert.equal(BP.validateMessage({ v: 1, t: "input-rejected", kind: "nope", reason: "x" }), null);
  assert.ok(BP.validateMessage({ v: 1, t: "dd-cancel" }));
  assert.ok(BP.validateMessage({ v: 1, t: "final-cancel" }));
});

/* ============ U15 — wager-bounds helpers ============ */

test("U15 wager bounds: DD MIN_WAGER..max, Final 0..max; edges, off-by-one, non-integers", () => {
  // Daily Double: MIN_WAGER (5) .. max.
  assert.equal(BP.isValidDdWager(BP.MIN_WAGER, 2000), true);
  assert.equal(BP.isValidDdWager(2000, 2000), true);
  assert.equal(BP.isValidDdWager(BP.MIN_WAGER - 1, 2000), false);
  assert.equal(BP.isValidDdWager(2001, 2000), false);
  assert.equal(BP.isValidDdWager(500.5, 2000), false);
  assert.equal(BP.isValidDdWager("500", 2000), false);
  assert.equal(BP.isValidDdWager(NaN, 2000), false);

  // Final: 0 .. max (a $0 wager is legal house rules).
  assert.equal(BP.isValidFinalWager(0, 1000), true);
  assert.equal(BP.isValidFinalWager(1000, 1000), true);
  assert.equal(BP.isValidFinalWager(-1, 1000), false);
  assert.equal(BP.isValidFinalWager(1001, 1000), false);
  assert.equal(BP.isValidFinalWager(10.01, 1000), false);
  assert.equal(BP.isValidFinalWager(Infinity, 1000), false);

  // Generic helper honours arbitrary bounds.
  assert.equal(BP.isWagerInRange(7, 5, 10), true);
  assert.equal(BP.isWagerInRange(4, 5, 10), false);
});

/* ============ U16 — playerReduce: wager + final host messages ============ */

test("U16 playerReduce maps DD/Final host messages to the right screen, junk-safe", () => {
  const ui = BP.createPlayerUiState();

  const ddReq = BP.playerReduce(ui, {
    v: 1, t: "dd-wager-request", category: "Sci", clueValue: 400, score: 1200, min: 5, max: 2000,
  });
  assert.equal(ddReq.screen, "dd-wager");
  assert.equal(ddReq.prompt.max, 2000);
  assert.equal(ddReq.prompt.category, "Sci");

  const ddOk = BP.playerReduce(ddReq, { v: 1, t: "dd-wager-accepted", amount: 800 });
  assert.equal(ddOk.screen, "buzzer");
  assert.ok(ddOk.notice);
  assert.equal(ddOk.prompt, null);

  const ddCancel = BP.playerReduce(ddReq, { v: 1, t: "dd-cancel" });
  assert.equal(ddCancel.screen, "buzzer");
  assert.equal(ddCancel.prompt, null);

  const fWager = BP.playerReduce(ui, { v: 1, t: "final", stage: "wager", category: "Hist", score: 900, max: 900 });
  assert.equal(fWager.screen, "final-wager");
  assert.equal(fWager.prompt.max, 900);
  assert.equal(fWager.prompt.min, 0);

  const fAnswer = BP.playerReduce(fWager, { v: 1, t: "final", stage: "answer", category: "Hist", clue: "It fell in 476." });
  assert.equal(fAnswer.screen, "final-answer");
  assert.equal(fAnswer.prompt.clue, "It fell in 476.");

  const fWaiting = BP.playerReduce(fAnswer, { v: 1, t: "final", stage: "waiting" });
  assert.equal(fWaiting.screen, "final-waiting");

  const fResult = BP.playerReduce(fWaiting, { v: 1, t: "final-result", correct: false, delta: -300, score: 600 });
  assert.equal(fResult.screen, "final-result");
  assert.equal(fResult.result.correct, false);
  assert.equal(fResult.result.delta, -300);
  assert.equal(fResult.result.score, 600);

  const fCancel = BP.playerReduce(fResult, { v: 1, t: "final-cancel" });
  assert.equal(fCancel.screen, "buzzer");
  assert.equal(fCancel.result, null);

  // input-rejected keeps the current form screen but surfaces the reason.
  const rejected = BP.playerReduce(fWager, { v: 1, t: "input-rejected", kind: "final-wager", reason: "Too high." });
  assert.equal(rejected.screen, "final-wager");
  assert.equal(rejected.notice, "Too high.");

  // Junk / out-of-order host frames never throw and leave state untouched.
  for (const junk of [null, {}, "x", { v: 1, t: "final", stage: "bogus" }, { v: 1, t: "final-result", correct: "x" }]) {
    assert.doesNotThrow(() => BP.playerReduce(ui, junk));
    assert.equal(BP.playerReduce(ui, junk), ui);
  }
});
