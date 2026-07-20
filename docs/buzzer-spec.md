# Buzzer Rooms — Feature Spec & Verification Plan

Status: **approved for implementation** · Feature flag: none needed (opt-in by UI)
Scope: optional real-time buzzer system for the GitHub Pages Jeopardy game.

---

# Part A — Specification

## 1. Overview

Let players use their phones as real Jeopardy buzzers. The host opens a **room**
and gets a short **room code**. Players visit the same site URL on their phone,
enter the code and their name, and get a full-screen buzzer button. When the
host **arms** the buzzers during a clue, the first player to tap buzzes in; the
host sees who it was and judges them with the existing ✓/✗ flow.

**Strictly optional.** A host who never touches the buzzer UI gets exactly
today's game — same screens, same flows, no network calls beyond what exists
now, still works offline from disk.

### Goals

- Host can open/close a room; room code is prominently displayed with join
  instructions.
- Players join from any device with code + name; they get a big, obvious,
  state-coloured buzzer.
- First-buzz-wins arbitration, lockout on wrong answers, re-arm for the rest.
- Zero impact on the existing game when unused; graceful degradation when the
  network/broker is unreachable.

### Non-goals (do not build)

- Early-buzz penalty timing windows (future idea; note in README as such).
- Answer typing/submission from phones, chat, or player-side score display
  beyond buzzer state.
- QR-code rendering (would need another library; the join URL is short enough).
- Persisting mid-clue armed/buzzed state across a host refresh (host just
  re-arms; document this).
- Any server or account. GitHub Pages static hosting is a hard constraint.

## 2. Technology choice (locked)

**PeerJS (WebRTC data channels) with the free public PeerJS cloud broker.**

- Works from a static page; no API key, no account, no backend.
- Loaded **lazily from CDN only when the buzzer feature is first used** (host
  opens a room / player page boots). The core game must never load it.
- Room code IS the host's peer ID (prefixed): players connect directly to the
  host; the broker is signaling-only.
- Pin an exact version served from cdnjs, e.g.
  `https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.x/peerjs.min.js`.
  **Implementer MUST verify the exact URL resolves (HTTP 200) before coding
  against it**, and SHOULD add the official SRI hash from the cdnjs API
  (`https://api.cdnjs.com/libraries/peerjs/<version>`) plus
  `crossorigin="anonymous"` on the injected script tag. If SRI proves flaky in
  testing, drop it and record why in the implementation report.
- Requires internet. Offline → feature unavailable with a clear message; game
  itself unaffected.

## 3. Files & load order

New files (each < 800 lines; functions < 50 lines where practical):

| File | Role |
|------|------|
| `js/buzzer-protocol.js` | **Pure** protocol core: room-code generator, message validation/sanitisation, host reducer, player reducer. No DOM, no PeerJS, no globals other than its export. Must run in both browser and Node (UMD-style export, see §7). |
| `js/buzzer-host.js` | Host side: lazy PeerJS load, room lifecycle, connection map, applies reducer effects, renders host buzzer UI (setup panel, topbar chip, clue-modal buzz bar). |
| `js/buzzer-player.js` | Player side: detects player mode from URL, join screen, full-screen buzzer, reconnect loop. Self-initialises when in player mode. |
| `css/buzzer.css` | All buzzer styles (host panel + player screen). Linked from `index.html` after `styles.css`. Do NOT grow `styles.css` (it is already over the 800-line house limit). |
| `tests/buzzer-protocol.test.mjs` | Node unit tests for the pure core (see Part B). |
| `tests/harness.html` | In-browser loopback integration harness (see Part B). |

Script order in `index.html`:
`data.js` → `buzzer-protocol.js` → `buzzer-player.js` → `app.js` →
`buzzer-host.js` → `editor.js`.

Rationale: `buzzer-player.js` must be able to claim the page before `app.js`
boots the host game (see §6.1); `buzzer-host.js` needs `app.js` globals.

## 4. UX

### 4.1 Host — opening a room

- **Setup screen**: new section "Buzzer room *(optional)*" under Players:
  - Closed: one ghost button **"Open buzzer room"** + one-line explainer
    ("Players use their phones to buzz in — needs internet").
  - Open: room code HUGE (the projector shot), join instructions with the full
    join URL (`<current page URL>?room=CODE`), connected-player list
    (name → linked scoreboard player, 🟢 connected / 🔴 dropped, per-player
    **Kick** button), sound-toggle 🔊, and **"Close room"**.
  - States: `connecting…` → open / error (broker unreachable, code collision
    after retries, no internet) — every error path gets a visible, plain-English
    message in this panel. Never silent.
- **Board screen**: small topbar chip showing `CODE · n 🔔` (connected count).
  Clicking it toggles a compact popover with the same room panel (join URL,
  player list, kick, close). Keep it out of the board's way.
- **New Game / Play Again** keeps the room open and players connected (spec'd
  in §6.3 — `newGame()` must preserve the buzzer state slice).
- Host closes tab / refreshes: peer dies; on reload, if a room code is in saved
  state, **auto-reopen the room with the same code** so player phones reconnect
  by themselves.

### 4.2 Host — during a clue

In the clue modal, ONLY when: room open AND ≥1 player connected AND the clue is
a regular clue (NOT Daily Double, never Final Jeopardy):

- A **buzz bar** under the clue text:
  - Disarmed: gold button **"Arm buzzers"**.
  - Armed: pulsing "🔔 Buzzers armed…" + ghost "Disarm".
  - On buzz: prominent banner **"🔔 {Name}"** with ✓ / ✗ buttons for that
    player right in the banner (reuse `judgeCorrect` / `judgeWrong` — see §6.2),
    plus a short host-side beep (WebAudio oscillator, ~0.15 s; respects the 🔊
    toggle; no audio asset files).
- ✗ on the buzzed player → they are **locked out for this clue** and buzzers
  **auto re-arm** for the remaining unlocked players. ✓ closes the clue via the
  existing flow. "No one got it — close" and Escape close + disarm + reset.
- `Reveal Answer` auto-disarms (nobody buzzes after the answer is up). The
  existing post-reveal judge row still works unchanged as the manual fallback;
  if someone had buzzed, highlight their chip (`.buzzed` class).
- Arming is **manual** (host finishes reading first). No auto-arm on clue open.
- **Arm hotkey — Spacebar.** So the host can unlock the instant they finish
  reading (no mouse hunt, no one buzzing early): while the buzz bar is live
  (room open, ≥1 connected, active REGULAR clue, answer not revealed) the
  Space key toggles armed/disarmed exactly like the button. Rules:
  - Handle on `keydown` at document level and `preventDefault()` so a focused
    "Reveal Answer" button is NOT space-clicked while the hotkey is live; when
    the buzz bar is not live, Space is left completely alone (existing
    keyboard behavior unchanged — regression R6).
  - Ignore when: a buzz winner is pending (`won` state), `event.repeat` is
    true (holding Space must not machine-gun toggle), the event target is an
    INPUT/TEXTAREA/SELECT, or the editor screen is open. Debounce toggles by
    ~300 ms so a nervous double-tap doesn't arm-then-instantly-disarm.
  - Discoverability: the Arm button reads "Arm buzzers (Space)" and the armed
    state hint reads "armed — Space locks"; mention the hotkey in the README
    hosting steps.

### 4.3 Player experience (phone)

Player mode = the page URL has a `room` query param (see §6.1).

- **Join screen**: room-code field (prefilled from `?room=CODE`, uppercase,
  4 chars), name field (maxlength 24, same cap as the host's player input),
  **Join** button. Errors inline: bad code ("No room with that code"), name
  taken, room full, no internet / broker down.
- **Buzzer screen**: giant circular button filling the viewport centre —
  the whole lower screen is the tap target. States:

| Mode | Visual | Label |
|------|--------|-------|
| `idle` | dim navy, disabled | "Wait for the host…" |
| `armed` | gold, glowing, enabled | "BUZZ!" |
| `won` | bright blue | "You buzzed in! Answer!" |
| `taken` | dim, disabled | "{Name} buzzed first" |
| `locked` | red-tinted, disabled | "Locked out for this clue" |

- Header: room code + connection dot + their player name. Footer: "Leave room".
- Taps in any non-`armed` state do nothing (button disabled — no penalty).
- SHOULD: `navigator.vibrate(50)` on arm and on `won` (feature-detected);
  screen wake-lock via `navigator.wakeLock` while connected (feature-detected,
  silently skipped where unsupported — e.g. iOS Safari < 16.4).
- Disconnect (host refresh, network blip): show "Reconnecting…" and retry the
  connection every 3 s with the same code+name until it succeeds or the player
  leaves. Rejoining with the same name relinks to the same scoreboard player.
- `room-closed` message → friendly "The host closed the room" + back to join
  screen.
- The player page hides ALL host chrome (topbar buttons, board, editor) — a
  `player-mode` class on `<body>` plus its own `<section>`; phone-first layout,
  works in portrait, no horizontal scroll at 320 px.

## 5. Protocol (v1)

JSON messages over PeerJS data connections (`serialization: "json"`). Every
message carries `v: 1`. Receivers MUST ignore messages with unknown `t`
(forward compatibility) and MUST tolerate malformed input (validate before use;
never throw on junk).

Player → host:
- `{ v:1, t:"join", name:string }` — sent once on connection open.
- `{ v:1, t:"buzz" }`
- `{ v:1, t:"dd-wager", amount:number }` — reply to a `dd-wager-request`.
- `{ v:1, t:"final-wager", amount:number }` — reply to `final` stage `wager`.
- `{ v:1, t:"final-answer", text:string }` — reply to `final` stage `answer`.

Host → player:
- `{ v:1, t:"joined", playerName:string }` — accepted; `playerName` is the
  (possibly relinked) scoreboard name to display.
- `{ v:1, t:"reject", reason:"name-taken"|"room-full"|"bad-name" }` — then the
  host closes that connection.
- `{ v:1, t:"buzzer", mode:"idle"|"armed"|"won"|"taken"|"locked", by?:string }`
  — `by` = buzzer-winner's name, present for `taken`.
- `{ v:1, t:"dd-wager-request", category:string, clueValue:number,
  score:number, min:number, max:number }` — this player is answering a Daily
  Double; wager on your phone. Followed by `dd-wager-accepted` or `dd-cancel`.
- `{ v:1, t:"dd-wager-accepted", amount:number }` / `{ v:1, t:"dd-cancel" }`
- `{ v:1, t:"final", stage:"wager", category:string, score:number,
  max:number }` — enter your Final Jeopardy wager.
- `{ v:1, t:"final", stage:"answer", category:string, clue:string }` — clue is
  up; type your answer.
- `{ v:1, t:"final", stage:"waiting" }` — pencils down (judging under way).
- `{ v:1, t:"final-result", correct:boolean, delta:number, score:number }` —
  your Final Jeopardy verdict.
- `{ v:1, t:"final-cancel" }` — host backed out of Final; return to buzzer.
- `{ v:1, t:"input-rejected", kind:"dd-wager"|"final-wager"|"final-answer",
  reason:string }` — host-side validation failed; phone re-shows the form
  with the reason.
- `{ v:1, t:"room-closed" }`

All numeric inputs are validated **host-side** (authoritative — never trust
the phone): integers, finite, within the same bounds the manual UI enforces
(`MIN_WAGER..dailyDoubleMaxWager` for DD; `0..finalMaxWager` for Final).
Answers pass `sanitizeAnswer`: trim, strip control chars, cap **120** chars,
empty → treated as "no answer". Out-of-stage submissions (e.g. a
`final-answer` arriving after judging started) are ignored.

Rules:
- **Arbitration**: first `buzz` received by the host while armed and not locked
  out wins; host processing is single-threaded so order of arrival is the tie
  break. Later buzzes are ignored (their senders get `taken`).
- `buzz` while not armed, from a locked-out player, or when someone already
  won: silently ignored.
- **Name rules**: trim; strip control characters; cap at 24 chars; empty after
  cleaning → `bad-name`. Case-insensitive match against the scoreboard roster:
  match found (and not already claimed by a live connection) → link to that
  player; no match → auto-add a scoreboard player (any phase) unless the
  roster is at `MAX_PLAYERS` (8) → `room-full`. Name already claimed by a
  connected player → `name-taken`.
- **Room code**: 4 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I/L/O/0/1).
  Peer ID = `ghj-` + code. On PeerJS `unavailable-id`, regenerate and retry
  (max 5) before surfacing an error.
- Abuse guard: if one connection delivers > 20 messages/second, close it.

## 6. Integration with the existing app (keep the diff small)

`js/app.js` may ONLY be touched at the points below. `js/editor.js`,
`js/data.js`, `questions.json` are untouched.

### 6.1 Player-mode boot guard

Top of `init()` (js/app.js:850): if
`new URLSearchParams(location.search).has("room")`, add `player-mode` to
`document.body.classList` and **return before wiring anything** (no fetch, no
state restore, no host rendering). `buzzer-player.js` detects the same param
and boots itself. (`?room` wins over `?game`; document in README.)

### 6.2 Hook calls (all optional-chained so the game runs even if buzzer
scripts fail to load)

- End of `render()` (app.js:192): `window.BuzzerHost?.onRender?.();` — the
  buzzer re-syncs its UI (setup panel, topbar chip, clue buzz bar) idempotently
  on every render.
- End of `openClue()`: `window.BuzzerHost?.onClueOpened?.();` (reset per-clue
  buzz state, push `idle`).
- End of `revealAnswer()`: `window.BuzzerHost?.onAnswerRevealed?.();` (disarm).
- End of `judgeWrong(playerId)`: `window.BuzzerHost?.onJudgedWrong?.(playerId);`
  — if that player is the current buzz winner: lock them out and auto re-arm
  the rest.
- End of `closeClue()`: `window.BuzzerHost?.onClueClosed?.();` (disarm + reset,
  push `idle`).

BuzzerHost reads game data via the existing globals (`state`, `addPlayer`-style
helpers) but MUST route roster/score changes through existing functions /
`setState` patches — never mutate `state` directly.

### 6.3 State slice & persistence

- `freshState()` gains `buzzer: { roomCode: null }`. That slice is the ONLY
  buzzer data inside `state` (it must stay JSON-serializable — `Peer`,
  connections, armed/winner/lockout live in module scope inside
  `buzzer-host.js`).
- `newGame()` (app.js:290) rebuilds state by hand — it MUST carry
  `buzzer: state.buzzer` across, so the room survives "New Game".
- `loadSavedState()`: tolerate missing/invalid `buzzer` (normalise to
  `{ roomCode: null }`; a restored `roomCode` must match `^[A-Z2-9]{4}$` or be
  dropped).
- On host boot, if `state.buzzer.roomCode` is set → auto-reopen the room with
  that code.

### 6.4 House style (hard requirements)

- **`textContent` only. Zero `innerHTML` / `insertAdjacentHTML` / etc.** The
  current codebase has none; keep it that way (verified by gate V5).
- Immutable `setState` patches only; no direct `state` mutation.
- Plain scripts, `"use strict"`, no modules-in-browser, no build step, no npm
  deps (PeerJS via lazy CDN tag is the single exception; `node:test` for tests
  is dev-only and built into Node).
- Naming/JSDoc match the existing code (`camelCase`, JSDoc typedefs for the
  protocol messages and reducer state).
- Every failure path (peer error, send failure, load failure) surfaces a
  user-visible message; `console.warn` for diagnostics is fine (matches
  existing code); no `console.log`.
- New UI must keep the existing visual language (navy board blues, gold
  accents, `Anton`/`Inter`, existing `.btn` classes) and honour
  `prefers-reduced-motion` for any new animation (pulse/glow).

## 7. Pure core design (what makes this testable)

`js/buzzer-protocol.js` exports (UMD-ish; attach to `globalThis.BuzzerProtocol`
in browsers AND `module.exports` when `module` exists, so Node's test runner
can `require`/`import` it directly):

- `generateRoomCode(randFn)` — injectable RNG for determinism.
- `sanitizeName(raw)` → cleaned name or `null`.
- `validateMessage(obj)` → typed message or `null` (junk-safe).
- `createRoomState()` → `{ armed:false, winnerId:null, lockedOut:{}, players:{} }`
  (players: peerId → `{ name, playerId, connected }`).
- `roomReduce(roomState, event)` → `{ next, effects }` where `effects` is a
  list of `{ to: peerId|"all", msg }` sends plus roster instructions for the
  glue layer (e.g. `{ addPlayer: name }`, `{ linkPlayer: playerId }`). Events:
  `join`, `buzz`, `arm`, `disarm`, `judgedWrong`, `clueReset`, `leave`.
  **Pure and immutable** — never mutates its inputs.
- `playerReduce(uiState, msg)` → next UI state for the player screen.

`buzzer-host.js` / `buzzer-player.js` are thin glue: transport + DOM. The host
glue accepts an injectable peer factory (`BuzzerHost._init({ createPeer })`)
defaulting to real PeerJS — this is the seam `tests/harness.html` uses to run
host+player logic against an in-page loopback fake with no network.

## 8. Phone wagers & answers (Daily Double + Final Jeopardy)

Turn connected phones into full contestant podiums: Daily-Double wagers,
secret Final-Jeopardy wagers, and typed Final answers all come from the
player's phone. **Mixed mode is a hard requirement**: scoreboard players
without a connected phone keep today's manual host-side flow, and the host can
always manually override a phone player (dead battery mid-Final must never
strand the game).

### 8.1 Daily Double

- When the DD splash is open and the player selected in `#dd-player` is
  linked + connected: send them `dd-wager-request` and show
  "📱 {name} is wagering on their phone…" in the splash. The manual wager
  input stays usable the whole time (host lock wins; on manual lock send
  `dd-cancel`).
- Changing the select re-targets: `dd-cancel` to the old player, fresh request
  to the new one.
- A valid phone `dd-wager` fills `#dd-wager` and calls the existing
  `lockDailyDoubleWager()` — from there the flow is exactly today's (wager
  public once locked, same as TV). Invalid → `input-rejected`, phone re-shows.
- Clue closed/Escape before lock → `dd-cancel`. After lock the phone shows a
  "wager locked — look up!" beat, then returns to the normal buzzer screen.
- No typed answers for DD (verbal, host judges — same as today).

### 8.2 Final Jeopardy

- **Wager stage:** every linked+connected player gets `final` stage `wager`
  (category, their score, their max). Submissions land via `setState` into
  `state.final.wagers[playerId]` (persist across host refresh). On the host's
  wager list, a phone-locked player's input is prefilled, `disabled`, switched
  to `type="password"` (so the projector shows dots — **secret wagers,
  properly**, unlike the manual flow), with a "🔒 from phone" note and an
  **Unlock** button that re-enables manual override. Manual inputs for
  unlinked/disconnected players work exactly as today. "Lock wagers & show
  clue" validates ALL wagers as today.
- **Answer stage:** on lock, phones get `final` stage `answer` (category +
  clue text) with a text box (maxlength 120) and Submit; a decoration in the
  host's final modal shows a live "Answers in: n/m" counter. Submissions land
  in a NEW serializable dict `state.final.answers[playerId]` (accepted only
  during stage `clue`; players may resubmit to correct themselves until
  reveal — last one wins). Host reveals whenever ready (host decides timing,
  no auto-timer).
- **Judge stage:** phones get stage `waiting`. Each judge row is decorated
  with the player's submitted answer in quotes (or "— no answer —"),
  rendered via `textContent` only. Host judges ✓/✗ exactly as today; as each
  verdict lands, that player's phone gets `final-result` (correct, ±delta,
  new score) and shows a win/lose screen.
- **No automatic answer checking — locked decision.** Typed answers are
  display-only for the host to read out and rule on. Do NOT compare them to
  the correct answer, auto-award, auto-advance stages when all answers are
  in, or add any timer. The host is always the judge and always drives the
  pace.
- **Standings:** phones show "Game over — you finished on {score}" and return
  to the buzzer screen when the host goes back to the board / starts a new
  game. "Back to board" from the wager stage → `final-cancel` to all phones.

### 8.3 Required supporting fix — Final Jeopardy must be one-shot

The review found Final Jeopardy can be re-entered after judging, re-applying
every wager to the scores a second time. Phone wagers make that bug both
easier to hit and worse (phones would be re-prompted to wager). Fix as part
of this feature: set `finalPlayed: true` in state on the **first**
`judgeFinal` call; when `finalPlayed`, `startFinal()` refuses to restart
(and the topbar `btn-final` + board-done banner route to Standings instead
of a fresh Final). "Back to board" pre-judging (wager/clue stages, nothing
judged yet) remains allowed and re-entry is fine in that case. `newGame()`
resets `finalPlayed`. `loadSavedState` normalises it (missing → false).

### 8.4 Additional permitted `app.js` edit points (extends §6)

- `buildFinalJudgeRow`: add `li.dataset.playerId = player.id` (one line, so
  the judge-row decoration can target rows).
- `startFinal`: include `answers: {}` in the fresh final object; implement the
  `finalPlayed` guard of §8.3.
- `judgeFinal`: set `finalPlayed: true` (part of the same setState patch).
- `render()`/`renderBoardDoneBanner`/`btn-final` visibility: respect
  `finalPlayed` (route to standings).
- `loadSavedState`: normalise `final.answers` (missing → `{}`) and
  `finalPlayed` (missing → `false`).
- `newGame()`: reset `finalPlayed: false` (it already rebuilds state by hand).

Everything else (DD splash decoration, wager-input masking, answer counter,
judge-row answer display, result pushes) is done by `buzzer-host.js` in its
idempotent `onRender` pass — no further app.js surgery. The pure parts
(`sanitizeAnswer`, numeric validation helpers, new message validation, and
the final/DD payload builders) go in `buzzer-protocol.js` so they are
unit-testable.

## 9. README

Add a "Buzzer rooms (optional)" section: what it is, how to host/join, that it
needs internet (PeerJS public broker for signaling, then peer-to-peer WebRTC),
that no game data touches any server, troubleshooting (strict corporate/school
networks can block WebRTC; regenerate room if code collides), and the `?room=`
param. Update the project-layout block with the new files. Note `?room` takes
precedence over `?game`. Document the phone Daily-Double wagers, the secret
phone Final wagers, typed Final answers (and the manual fallback/override for
players without phones), and that Final Jeopardy can only be played once per
game.

---

# Part B — Verification plan & success states

Every state below is **machine-checkable or directly observable**; the tester
reports PASS/FAIL per ID with evidence (command output, screenshot, or DOM
text). "Done" = all MUST states pass.

## Tiers

- **T1 — Unit (Node, no network):** `node --test tests/` from the project
  root. Requires Node ≥ 18 (check `node --version` first; if Node is missing,
  report BLOCKED for T1 and continue with T2-T5).
- **T2 — Loopback integration (browser, no network):** open
  `tests/harness.html` via a local static server; it drives host reducer +
  player reducer through a scripted game over an in-page fake transport and
  renders a PASS/FAIL list into the DOM (`#results li` items carry
  `data-pass="true|false"`).
- **T3 — Real-network E2E (browser, PeerJS cloud):** two tabs on a local
  static server. Best effort: if the sandbox blocks the broker (wss) or
  WebRTC, record BLOCKED-ENV with the exact console error — do not fake it —
  and note it needs a manual run.
- **T4 — Regression (browser):** the game with the buzzer feature never
  touched must behave exactly as before.
- **T5 — Static gates (shell):** greps and size checks.

Serve statically for T2-T4 (e.g. `.claude/launch.json` entry running
`python -m http.server <port>` or `npx serve` in the project folder — no build).

## Success states

### Unit — protocol core (T1) — MUST

- **U1** `generateRoomCode`: 4 chars, only `[A-Z2-9]` minus I/L/O/0/1;
  deterministic under an injected RNG.
- **U2** `sanitizeName`: trims; strips control chars; caps at 24; empty/junk →
  `null`.
- **U3** `validateMessage`: accepts well-formed `join`/`buzz`; returns `null`
  for junk (non-objects, wrong types, oversized names); unknown `t` → ignorable
  result, never a throw.
- **U4** join flow: new name → `joined` effect + roster-add instruction;
  case-insensitive name → links to existing player, no roster-add; name held
  by a live connection → `reject name-taken`; unknown name with full roster →
  `reject room-full`.
- **U5** arm: all connected, non-locked players receive `armed`.
- **U6** first buzz wins: winner recorded; effects tell winner `won` and
  others `taken` with the winner's name; a second buzz changes nothing.
- **U7** buzz ignored when: not armed / already won / sender locked out —
  state unchanged, no effects.
- **U8** `judgedWrong` on the winner: winner → `lockedOut`, gets `locked`;
  remaining unlocked players get `armed` again; `judgedWrong` on a non-winner
  changes nothing.
- **U9** `clueReset`: winner + lockouts cleared; everyone gets `idle`.
- **U10** `leave`: player removed from room state; if they were the armed-round
  winner the winner is retained but marked disconnected (host is mid-judging
  them).
- **U11** immutability: reducers never mutate inputs (frozen-input test).
- **U12** `playerReduce` maps every host `buzzer` message mode to the correct
  screen state, ignores junk.
- **U13** `sanitizeAnswer`: trims, strips control chars, caps at 120, empty →
  null ("no answer").
- **U14** `validateMessage` accepts well-formed `dd-wager`/`final-wager`
  (finite integer amounts) and `final-answer`; rejects non-numeric, Infinity,
  NaN, string amounts, and oversized answers.
- **U15** wager-bounds helpers: DD bounds (`MIN_WAGER..max`) and Final bounds
  (`0..max`) accept edge values, reject one-below/one-above, and reject
  non-integers.
- **U16** `playerReduce` handles the new host messages (`dd-wager-request`,
  `dd-wager-accepted`, `dd-cancel`, `final` stages wager/answer/waiting,
  `final-result`, `final-cancel`, `input-rejected`) mapping each to the right
  phone screen; junk/out-of-order messages never throw.

### Loopback integration (T2) — MUST

- **I1** harness page loads with zero console errors and every `#results` row
  has `data-pass="true"`. The scripted scenario must cover: 2 players join →
  arm → P1 buzzes (wins, P2 taken) → P1 judged wrong (locked, P2 re-armed) →
  P2 buzzes (wins) → clue reset (both idle) → P1 leaves.
- **I2** harness additionally covers, over the loopback transport: a DD
  wager round-trip (request → phone submit → accepted; plus an out-of-bounds
  submit → `input-rejected`) and a full phone Final (wager stage → both
  submit → answer stage → submits land, resubmit overwrites → waiting →
  results pushed with correct deltas → cancel path returns phones to idle).

### Real-network E2E (T3) — MUST, downgradable to BLOCKED-ENV with evidence

- **E1** Host tab: open room on the setup screen → a 4-char code renders and
  the panel shows "0 connected" (or equivalent).
- **E2** Player tab at `?room=CODE`: join as `Remote Rita` → host list shows
  her 🟢 within 5 s; scoreboard gains/links a player named Remote Rita.
- **E3** Host starts game, opens a regular clue, clicks **Arm buzzers** →
  player buzzer goes `armed` within 2 s.
- **E4** Player taps BUZZ → host banner shows "Remote Rita" within 2 s; player
  shows `won`.
- **E5** Host ✗ in the banner → Rita's score is −clue value; her buzzer shows
  `locked`; (with a 2nd player connected) the other buzzer re-arms.
- **E6** Host ✓ (after re-buzz or fresh clue) → score +value, clue closes,
  both buzzers return `idle`.
- **E7** Player reloads their tab mid-game and rejoins with the same code+name
  → relinks to the same scoreboard player (score intact, no duplicate roster
  entry).
- **E8** Daily Double clue: NO buzz bar appears in the clue modal.
- **E9** Close room → player shows "host closed the room"; host panel returns
  to closed state.
- **E10** Hotkey: with the buzz bar live, pressing Space arms (player goes
  `armed`) and pressing Space again (after the debounce) disarms — without the
  focused "Reveal Answer" button being activated. With focus in a text input
  (e.g. the topbar popover's, if any) Space types a space and does not toggle.
- **E11** DD phone wager: open a Daily Double with a linked+connected player
  selected → their phone shows the wager form with correct bounds; submitting
  a valid wager locks the DD on the host (clue revealed, wager shown) and the
  phone shows "locked". An out-of-bounds submit shows the rejection reason on
  the phone and does not lock.
- **E12** DD re-target + manual override: changing `#dd-player` cancels the
  first phone's prompt and prompts the new player; the host typing a manual
  wager and locking cancels the phone prompt.
- **E13** Final phone wagers: both connected phones get the wager form
  (correct per-player max); after submitting, the host's wager inputs are
  masked (`type="password"`, disabled, 🔒 note) and "Lock wagers & show clue"
  proceeds using those values (verified by the judged deltas later). The
  Unlock button re-enables manual editing.
- **E14** Final answers: after lock, phones show the clue + answer box; typed
  answers appear in the host's judge rows verbatim (textContent — submit an
  answer containing `<img src=x onerror=…>` and confirm it renders as literal
  text); the answers-in counter tracks n/m; a resubmit before reveal
  overwrites; a submit after reveal is ignored.
- **E15** Final results to phones: judging ✓ gives that phone "correct,
  +wager, new score"; ✗ gives "wrong, −wager, new score"; scores match the
  host scoreboard.
- **E16** Mixed mode: with one connected player and one manual (no phone)
  player, the manual player's wager input stays a normal editable number
  field, and the whole Final completes correctly for both.
- **E17** One-shot Final: after judging completes and standings show, "Back
  to board" no longer offers a fresh Final (topbar button routes to
  standings); scores do not change a second time. Re-entry from the wager
  stage BEFORE any judging (Back to board → Final Jeopardy) still works and
  re-prompts phones without double-scoring.

### Regression (T4) — MUST

- **R1** With the room never opened: setup → add 2 players → start → open
  clue → reveal → ✓ → score updates and tile marked used — identical to the
  pre-change flow, zero console errors.
- **R2** No request to any peerjs/cdnjs host appears in the network log when
  the buzzer feature is never used (lazy-load proof).
- **R3** Daily Double and Final Jeopardy flows still complete end-to-end.
- **R4** Refresh mid-board restores the game exactly as before (including a
  restored game WITHOUT any `buzzer` slice in old saved state — no crash).
- **R5** The existing three-review baseline isn't worsened: no new global
  leaks (`window.<accidental>`), no new console errors during a full game.
- **R6** With no room open (or the feature never used), Space behaves exactly
  as before everywhere — in particular it still activates a focused button
  (e.g. "Reveal Answer") and types spaces in inputs. The hotkey interception
  must provably be scoped to a live buzz bar only.
- **R7** With no room open, Daily Double and Final Jeopardy run EXACTLY as
  today: normal editable wager inputs (no masking, no 🔒, no phone notes, no
  answer rows/counters), and an old saved state without `final.answers` /
  `finalPlayed` restores cleanly mid-Final. The one visible intended change
  outside buzzer usage is the §8.3 one-shot guard: a fully judged Final can
  no longer be restarted (verify it engages in a manual-only game too).

### Static gates (T5) — MUST

- **V1** `node --test` exit code 0 (T1 green).
- **V2** Every new/changed file < 800 lines; no function > ~50 lines without a
  recorded justification.
- **V3** Grep gate: `innerHTML|insertAdjacentHTML|outerHTML\s*=|document\.write|eval\(|new Function` → zero matches across `js/` and `tests/`.
- **V4** Grep gate: `console\.log` → zero matches in `js/`.
- **V5** `state` stays serializable: grep confirms no `Peer`/connection object
  is ever placed into `setState`/`state.buzzer` (manual code check + R4).
- **V6** The pinned PeerJS CDN URL returns HTTP 200 and the README documents
  the exact pinned version.

### SHOULD (report, don't block)

- **S1** Wake-lock + vibration code paths feature-detected (no errors on
  desktop browsers without support).
- **S2** Player page usable at 320 px wide (no horizontal scroll) and the
  buzz button ≥ 60 % of viewport width in portrait.
- **S3** Host beep respects the 🔊 toggle; `prefers-reduced-motion` disables
  the armed pulse.
- **S4** SRI hash present on the injected PeerJS script tag.

## Tester deliverable

A verification report: per-ID PASS / FAIL / BLOCKED-ENV table with evidence
(test output, DOM text, screenshots for E-states), plus a defect list with
file:line for anything that failed. Fix-worthy defects go back to the
implementer, not silently patched by the tester, unless trivial (< 5 lines).
