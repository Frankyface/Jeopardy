/* ============================================================
   Unit tests for the pure answer-timer core (spec §12, TM-C*)
   plus the timer-related protocol behavior (TM-P6+, kept here so
   buzzer-protocol.test.mjs stays under the file-size cap).
   Zero npm deps: node:test + node:assert only.
   Run from the project root:  node --test
   (bare — Node 24 rejects a `tests/` directory positional).
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import TC from "../js/timer-core.js";
import BP from "../js/buzzer-protocol.js";

/** Room state with the given connected players. */
function roomWith(players, extra = {}) {
  return { ...BP.createRoomState(), ...extra, players: { ...players } };
}
function peer(name, playerId, connected = true) {
  return { name, playerId, connected };
}
function sendsTo(effects, peerId) {
  return effects.filter((e) => e.to === peerId && e.msg);
}

/* ============ TM-C1 — litBlocks pairwise countdown ============ */

test("TM-C1 litBlocks: 9 blocks go out pairwise from the ends over 5 stages", () => {
  assert.equal(TC.BLOCKS, 9);
  const total = 10_000; // 10s → 5 stages of 2s each
  assert.equal(TC.litBlocks(0, total), 9);
  assert.equal(TC.litBlocks(1_999, total), 9);
  assert.equal(TC.litBlocks(2_000, total), 7);
  assert.equal(TC.litBlocks(3_999, total), 7);
  assert.equal(TC.litBlocks(4_000, total), 5);
  assert.equal(TC.litBlocks(6_000, total), 3);
  assert.equal(TC.litBlocks(8_000, total), 1);
  assert.equal(TC.litBlocks(9_999, total), 1);
  assert.equal(TC.litBlocks(10_000, total), 0);
  assert.equal(TC.litBlocks(99_999, total), 0);
});

test("TM-C1b litBlocks: lit counts are always odd until they hit zero", () => {
  const total = 7_000;
  for (let ms = 0; ms < total; ms += 50) {
    const lit = TC.litBlocks(ms, total);
    assert.ok(lit > 0 && lit % 2 === 1, `lit=${lit} at ${ms}ms`);
  }
  assert.equal(TC.litBlocks(total, total), 0);
});

/* ============ TM-C2 — litBlocks guards ============ */

test("TM-C2 litBlocks: junk inputs never throw and fail closed", () => {
  // A dead/absent duration means no timer — nothing lit.
  for (const bad of [0, -5, NaN, Infinity, undefined, null]) {
    assert.equal(TC.litBlocks(1_000, bad), 0, `totalMs=${bad}`);
  }
  // Junk elapsed is treated as "just started" — full bar, not a crash.
  for (const bad of [-500, NaN, undefined, null]) {
    assert.equal(TC.litBlocks(bad, 10_000), 9, `elapsedMs=${bad}`);
  }
});

/* ============ TM-C3 — normalizeSeconds ============ */

test("TM-C3 normalizeSeconds: clamps numbers, falls back on junk", () => {
  assert.equal(TC.normalizeSeconds(10, 15), 10);
  assert.equal(TC.normalizeSeconds(0, 15), 0); // 0 = timer off, legal
  assert.equal(TC.normalizeSeconds(4.6, 15), 5); // rounds
  assert.equal(TC.normalizeSeconds(-3, 15), 0); // clamps low
  assert.equal(TC.normalizeSeconds(9_999, 15), TC.MAX_SECONDS); // clamps high
  for (const junk of ["10", NaN, Infinity, -Infinity, null, undefined, {}, [], true]) {
    assert.equal(TC.normalizeSeconds(junk, 15), 15, `junk=${String(junk)}`);
  }
});

/* ============ TM-C4 — the protocol cap is pinned to the core cap ============ */

test("TM-C4 protocol timerSeconds cap tracks TimerCore.MAX_SECONDS", () => {
  // The protocol restates the cap to stay dependency-free; this pins the two
  // constants together so raising one without the other fails loudly here
  // instead of silently stripping timers off every message.
  const atCap = BP.validateMessage({ v: 1, t: "buzzer", mode: "won", timerSeconds: TC.MAX_SECONDS });
  assert.equal(atCap.timerSeconds, TC.MAX_SECONDS);
  const overCap = BP.validateMessage({ v: 1, t: "buzzer", mode: "won", timerSeconds: TC.MAX_SECONDS + 1 });
  assert.equal(overCap.timerSeconds, undefined);
});

/* ============ TM-P6 — answer reveal clears phone clocks (spec §12.2) ============ */

test("TM-P6 answerRevealed with a held winner re-syncs won/taken with NO clock", () => {
  const state = roomWith({ A: peer("Rita", "p1"), B: peer("Sam", "p2") }, { winnerId: "A" });
  const { next, effects } = BP.roomReduce(state, { type: "answerRevealed" });
  assert.equal(next.winnerId, "A"); // judging screens stay up…
  const won = sendsTo(effects, "A").find((e) => e.msg.t === "buzzer").msg;
  assert.equal(won.mode, "won");
  assert.equal(won.timerSeconds, undefined); // …but the clock is gone
  const taken = sendsTo(effects, "B").find((e) => e.msg.t === "buzzer").msg;
  assert.equal(taken.mode, "taken");
  assert.equal(taken.timerSeconds, undefined);

  // On the phone: the re-sync nulls a ticking clock without changing screens.
  let ui = BP.playerReduce(BP.createPlayerUiState(), { v: 1, t: "joined", playerName: "Rita" });
  ui = BP.playerReduce(ui, { v: 1, t: "buzzer", mode: "won", timerSeconds: 10 });
  ui = BP.playerReduce(ui, won);
  assert.equal(ui.mode, "won");
  assert.equal(ui.timerSeconds, null);
});

/* ============ TM-P7 — rejoin carries total + remaining (spec §12.3) ============ */

test("TM-P7a validateMessage: timerTotalSeconds needs a legal timerSeconds and total >= remaining", () => {
  const ok = BP.validateMessage({ v: 1, t: "buzzer", mode: "won", timerSeconds: 7, timerTotalSeconds: 30 });
  assert.equal(ok.timerSeconds, 7);
  assert.equal(ok.timerTotalSeconds, 30);
  // total without remaining, total < remaining, junk total → the field drops.
  for (const bad of [
    { timerTotalSeconds: 30 },
    { timerSeconds: 7, timerTotalSeconds: 5 },
    { timerSeconds: 7, timerTotalSeconds: "30" },
    { timerSeconds: 7, timerTotalSeconds: 9999 },
  ]) {
    const out = BP.validateMessage({ v: 1, t: "buzzer", mode: "won", ...bad });
    assert.equal(out.timerTotalSeconds, undefined, JSON.stringify(bad));
  }
  const fj = BP.validateMessage({
    v: 1, t: "final", stage: "answer", category: "C", clue: "Q",
    timerSeconds: 6, timerTotalSeconds: 30,
  });
  assert.equal(fj.timerTotalSeconds, 30);
});

test("TM-P7b join mid-buzz syncs the remaining clock WITH its original total", () => {
  const state = roomWith({ A: peer("Rita", "p1") }, { winnerId: "A" });
  const { effects } = BP.roomReduce(state, {
    type: "join", peerId: "B", name: "Sam", roster: [], maxPlayers: 8,
    newPlayerId: "np1", timerSeconds: 7, timerTotalSeconds: 30,
  });
  const sync = sendsTo(effects, "B").find((e) => e.msg.t === "buzzer").msg;
  assert.equal(sync.mode, "taken");
  assert.equal(sync.timerSeconds, 7);
  assert.equal(sync.timerTotalSeconds, 30);

  // The phone keeps both so its bar can render the true stage, not a fresh one.
  let ui = BP.playerReduce(BP.createPlayerUiState(), { v: 1, t: "joined", playerName: "Sam" });
  ui = BP.playerReduce(ui, sync);
  assert.equal(ui.timerSeconds, 7);
  assert.equal(ui.timerTotalSeconds, 30);
  ui = BP.playerReduce(ui, { v: 1, t: "buzzer", mode: "armed" });
  assert.equal(ui.timerTotalSeconds, null); // clears with the clock
});
