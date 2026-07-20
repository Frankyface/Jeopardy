/* ============================================================
   Jeopardy — game logic
   State is held in a single object, updated immutably via
   setState(), persisted to localStorage, and re-rendered per
   phase. All user-provided strings are inserted with
   textContent (never innerHTML) to avoid XSS from custom JSON.
   ============================================================ */

"use strict";

const STORAGE_KEY = "gh-jeopardy-state-v1";
const MAX_PLAYERS = 8;
const MAX_CATEGORIES = 8;
const MAX_CLUES_PER_CATEGORY = 8;
const MIN_WAGER = 5;

/** @type {{
 *  phase: 'setup'|'board'|'final',
 *  game: object|null,
 *  source: string,
 *  sourceKind: 'default'|'fetch'|'upload',
 *  sourceUrl: string|null,
 *  players: Array<{id:string, name:string, score:number}>,
 *  used: Record<string, boolean>,
 *  active: null|{cat:number, row:number, revealed:boolean, missed:Record<string,boolean>,
 *                isDailyDouble:boolean, wagerLocked:boolean, wager:number, wagerPlayerId:string|null},
 *  final: null|{stage:'wager'|'clue'|'judge'|'standings', wagers:Record<string,number>,
 *               answers:Record<string,string>, judged:Record<string,boolean>},
 *  finalPlayed: boolean,
 *  buzzer: {roomCode: string|null}
 * }} */
let state = freshState();

let playerIdCounter = 0;

function freshState() {
  return {
    phase: "setup",
    game: null,
    source: "loading…",
    sourceKind: "default",
    sourceUrl: null,
    players: [],
    used: {},
    active: null,
    final: null,
    finalPlayed: false,
    buzzer: { roomCode: null },
  };
}

function setState(patch) {
  state = { ...state, ...patch };
  saveState();
  render();
}

/* ============ Persistence ============ */

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Could not save game state:", err);
  }
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || !saved.phase) return null;
    if (saved.game) validateGame(saved.game);
    const restored = { ...freshState(), ...saved };
    // Tolerate missing/invalid buzzer slice; a restored code must look real.
    const savedCode =
      saved.buzzer && typeof saved.buzzer.roomCode === "string" ? saved.buzzer.roomCode : null;
    restored.buzzer = { roomCode: /^[A-Z2-9]{4}$/.test(savedCode || "") ? savedCode : null };
    // Normalise the phone-Final additions on old saved states (spec §8.4).
    if (restored.final && typeof restored.final === "object") {
      if (!restored.final.answers || typeof restored.final.answers !== "object") {
        restored.final = { ...restored.final, answers: {} };
      }
    }
    if (typeof restored.finalPlayed !== "boolean") restored.finalPlayed = false;
    return restored;
  } catch (err) {
    console.warn("Ignoring corrupt saved state:", err);
    return null;
  }
}

function clearSavedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn("Could not clear saved state:", err);
  }
}

/* ============ Game data loading & validation ============ */

function validateGame(data) {
  const fail = (msg) => { throw new Error(msg); };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("Game file must be a JSON object.");
  }
  if (data.title !== undefined && typeof data.title !== "string") {
    fail('"title" must be a string.');
  }
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    fail('"categories" must be a non-empty array.');
  }
  if (data.categories.length > MAX_CATEGORIES) {
    fail(`Too many categories (max ${MAX_CATEGORIES}).`);
  }
  data.categories.forEach((cat, c) => validateCategory(cat, c, fail));
  validateFinal(data.finalJeopardy, fail);
  return data;
}

function validateCategory(cat, c, fail) {
  const where = `Category ${c + 1}`;
  if (!cat || typeof cat !== "object") fail(`${where} must be an object.`);
  if (typeof cat.name !== "string" || !cat.name.trim()) {
    fail(`${where} needs a non-empty "name".`);
  }
  if (!Array.isArray(cat.clues) || cat.clues.length === 0) {
    fail(`${where} ("${cat.name}") needs a non-empty "clues" array.`);
  }
  if (cat.clues.length > MAX_CLUES_PER_CATEGORY) {
    fail(`${where} ("${cat.name}") has too many clues (max ${MAX_CLUES_PER_CATEGORY}).`);
  }
  cat.clues.forEach((clue, r) => {
    const at = `${where} ("${cat.name}"), clue ${r + 1}`;
    if (!clue || typeof clue !== "object") fail(`${at} must be an object.`);
    if (!Number.isFinite(clue.value) || clue.value <= 0) {
      fail(`${at} needs a positive numeric "value".`);
    }
    if (typeof clue.clue !== "string" || !clue.clue.trim()) {
      fail(`${at} needs a non-empty "clue".`);
    }
    if (typeof clue.answer !== "string" || !clue.answer.trim()) {
      fail(`${at} needs a non-empty "answer".`);
    }
  });
}

function validateFinal(fj, fail) {
  if (fj === undefined || fj === null) return;
  if (typeof fj !== "object") fail('"finalJeopardy" must be an object.');
  for (const key of ["category", "clue", "answer"]) {
    if (typeof fj[key] !== "string" || !fj[key].trim()) {
      fail(`"finalJeopardy" needs a non-empty "${key}".`);
    }
  }
}

async function fetchGameData() {
  const params = new URLSearchParams(window.location.search);
  const customUrl = params.get("game");
  const url = customUrl || "questions.json";
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    validateGame(data);
    return {
      game: data,
      source: customUrl ? `custom URL (${customUrl})` : "questions.json",
      sourceKind: "fetch",
      sourceUrl: customUrl,
    };
  } catch (err) {
    console.warn(`Could not load ${url}, using built-in sample game.`, err);
    return {
      game: DEFAULT_GAME,
      source: `built-in sample (${url} could not be fetched)`,
      sourceKind: "default",
      sourceUrl: null,
    };
  }
}

/* ============ DOM helpers ============ */

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(node, visible) {
  node.classList.toggle("hidden", !visible);
}

function formatMoney(amount) {
  const abs = Math.abs(amount).toLocaleString("en-US");
  return amount < 0 ? `-$${abs}` : `$${abs}`;
}

/* ============ Render dispatch ============ */

function render() {
  const onBoard = state.phase === "board";
  show($("screen-setup"), state.phase === "setup");
  show($("screen-board"), onBoard);
  show($("btn-new-game"), state.phase !== "setup");
  show($("btn-final"), onBoard && !!state.game?.finalJeopardy && !state.active);
  // Once Final has been judged it is one-shot: the button routes to standings.
  $("btn-final").textContent = state.finalPlayed ? "Final Standings" : "Final Jeopardy";

  $("game-title").textContent = state.game?.title || "Jeopardy";

  if (state.phase === "setup") renderSetup();
  if (onBoard) {
    renderBoard();
    renderScoreboard();
    renderBoardDoneBanner();
  }
  renderClueModal();
  renderFinalModal();
  window.BuzzerHost?.onRender?.();
}

/* ============ Setup screen ============ */

function renderSetup() {
  $("setup-title").textContent = state.game?.title || "Jeopardy!";
  $("source-note").textContent = `Questions: ${state.source}`;

  const list = $("player-list");
  list.replaceChildren();
  if (state.players.length === 0) {
    const li = el("li", "empty-note", "No players yet — add at least one to start.");
    list.appendChild(li);
  }
  state.players.forEach((player) => {
    const li = el("li");
    li.appendChild(el("span", null, player.name));
    const remove = el("button", "remove-btn", "✕");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${player.name}`);
    remove.addEventListener("click", () => removePlayer(player.id));
    li.appendChild(remove);
    list.appendChild(li);
  });
}

function setSetupError(msg) {
  $("setup-error").textContent = msg || "";
}

function addPlayer(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (state.players.length >= MAX_PLAYERS) {
    setSetupError(`Maximum of ${MAX_PLAYERS} players.`);
    return;
  }
  setSetupError("");
  playerIdCounter += 1;
  const player = { id: `p${Date.now()}-${playerIdCounter}`, name: trimmed, score: 0 };
  setState({ players: [...state.players, player] });
}

function removePlayer(id) {
  setState({ players: state.players.filter((p) => p.id !== id) });
}

function handleCustomFile(file) {
  const reader = new FileReader();
  reader.onerror = () => setSetupError("Could not read that file.");
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      validateGame(data);
      setSetupError("");
      setState({
        game: data,
        source: `uploaded file (${file.name})`,
        sourceKind: "upload",
        sourceUrl: null,
      });
    } catch (err) {
      setSetupError(`Invalid questions file: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function startGame() {
  if (!state.game) {
    setSetupError("Questions are still loading — try again in a second.");
    return;
  }
  if (state.players.length === 0) {
    setSetupError("Add at least one player to start.");
    return;
  }
  setSetupError("");
  setState({ phase: "board", used: {}, active: null, final: null });
}

function newGame() {
  const ok = window.confirm("Start a new game? Current scores and board will be lost.");
  if (!ok) return;
  clearSavedState();
  state = {
    ...freshState(),
    game: state.game,
    source: state.source,
    sourceKind: state.sourceKind,
    sourceUrl: state.sourceUrl,
    players: state.players.map((p) => ({ ...p, score: 0 })),
    buzzer: state.buzzer,
  };
  saveState();
  render();
}

/* ============ Board ============ */

function clueKey(cat, row) {
  return `${cat}-${row}`;
}

function maxBoardValue() {
  return state.game.categories.reduce(
    (max, cat) => cat.clues.reduce((m, clue) => Math.max(m, clue.value), max),
    0
  );
}

function renderBoard() {
  const board = $("board");
  board.replaceChildren();
  const cats = state.game.categories;
  const rows = Math.max(...cats.map((c) => c.clues.length));
  board.style.gridTemplateColumns = `repeat(${cats.length}, 1fr)`;

  cats.forEach((cat) => {
    board.appendChild(el("div", "board-cell cell-category", cat.name));
  });

  for (let row = 0; row < rows; row += 1) {
    cats.forEach((cat, c) => {
      board.appendChild(buildClueCell(cat, c, row));
    });
  }
}

function buildClueCell(cat, c, row) {
  const clue = cat.clues[row];
  if (!clue) return el("div", "board-cell cell-empty");

  const used = !!state.used[clueKey(c, row)];
  const cell = el("button", "board-cell cell-clue", formatMoney(clue.value));
  cell.type = "button";
  if (used) {
    cell.classList.add("used");
    cell.disabled = true;
    cell.setAttribute("aria-label", `${cat.name} ${formatMoney(clue.value)} — already played`);
  } else {
    cell.setAttribute("aria-label", `${cat.name} for ${formatMoney(clue.value)}`);
    cell.addEventListener("click", () => openClue(c, row));
  }
  return cell;
}

function allCluesUsed() {
  return state.game.categories.every((cat, c) =>
    cat.clues.every((_, r) => state.used[clueKey(c, r)])
  );
}

function renderBoardDoneBanner() {
  const banner = $("board-done-banner");
  const done = allCluesUsed() && !state.active && !state.final;
  show(banner, done);
  if (!done) return;
  $("btn-board-done").textContent = state.game.finalJeopardy && !state.finalPlayed
    ? "Play Final Jeopardy"
    : "Show Final Standings";
}

function handleBoardDone() {
  if (state.game.finalJeopardy) startFinal();
  else showStandings();
}

/* ============ Scoreboard ============ */

function renderScoreboard() {
  const board = $("scoreboard");
  board.replaceChildren();
  state.players.forEach((player) => {
    const card = el("div", "podium");
    card.appendChild(el("p", "podium-name", player.name));
    const score = el("button", "podium-score", formatMoney(player.score));
    score.type = "button";
    if (player.score < 0) score.classList.add("negative");
    score.title = "Click to adjust score";
    score.setAttribute("aria-label", `${player.name}: ${formatMoney(player.score)}. Adjust score`);
    score.addEventListener("click", () => editScore(player.id));
    card.appendChild(score);
    board.appendChild(card);
  });
  board.appendChild(el("p", "score-hint", "Tip: click a score to adjust it manually."));
}

function editScore(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return;
  const input = window.prompt(`New score for ${player.name}:`, String(player.score));
  if (input === null) return;
  const value = Number.parseInt(input.replace(/[$,\s]/g, ""), 10);
  if (!Number.isFinite(value)) return;
  applyScore(playerId, value - player.score);
}

function applyScore(playerId, delta) {
  setState({
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, score: p.score + delta } : p
    ),
  });
}

/* ============ Clue modal ============ */

function openClue(cat, row) {
  const clue = state.game.categories[cat].clues[row];
  setState({
    active: {
      cat,
      row,
      revealed: false,
      missed: {},
      isDailyDouble: !!clue.dailyDouble,
      wagerLocked: false,
      wager: 0,
      wagerPlayerId: null,
    },
  });
  focusClueModal();
  window.BuzzerHost?.onClueOpened?.();
}

function activeClue() {
  if (!state.active) return null;
  return state.game.categories[state.active.cat].clues[state.active.row];
}

function activeClueAmount() {
  const clue = activeClue();
  if (!clue) return 0;
  return state.active.isDailyDouble ? state.active.wager : clue.value;
}

function renderClueModal() {
  const modal = $("clue-modal");
  const active = state.active;
  show(modal, !!active);
  if (!active) return;

  const clue = activeClue();
  const category = state.game.categories[active.cat];
  const awaitingWager = active.isDailyDouble && !active.wagerLocked;

  $("clue-category").textContent = category.name;
  $("clue-value").textContent = awaitingWager
    ? ""
    : formatMoney(activeClueAmount());

  show($("dd-splash"), awaitingWager);
  show($("clue-text"), !awaitingWager);
  show($("answer-text"), active.revealed);
  show($("btn-reveal"), !awaitingWager && !active.revealed);
  show($("judge-row"), active.revealed);
  show($("btn-skip"), !awaitingWager);

  $("clue-text").textContent = clue.clue;
  $("answer-text").textContent = clue.answer;

  if (awaitingWager) renderDailyDoubleForm();
  if (active.revealed) renderJudgeRow();
}

function focusClueModal() {
  window.requestAnimationFrame(() => {
    const target = state.active?.isDailyDouble && !state.active.wagerLocked
      ? $("dd-wager")
      : $("btn-reveal");
    if (target && !target.classList.contains("hidden")) target.focus();
  });
}

function renderDailyDoubleForm() {
  const select = $("dd-player");
  select.replaceChildren();
  state.players.forEach((player) => {
    const opt = el("option", null, player.name);
    opt.value = player.id;
    select.appendChild(opt);
  });
  $("dd-error").textContent = "";
  updateDailyDoubleNote();
}

function dailyDoubleMaxWager(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const score = player ? player.score : 0;
  return Math.max(score, maxBoardValue());
}

function updateDailyDoubleNote() {
  const playerId = $("dd-player").value;
  const max = dailyDoubleMaxWager(playerId);
  $("dd-wager").max = String(max);
  $("dd-wager").min = String(MIN_WAGER);
  if (!$("dd-wager").value) $("dd-wager").value = String(activeClue()?.value ?? max);
  $("dd-max-note").textContent =
    `Wager between ${formatMoney(MIN_WAGER)} and ${formatMoney(max)}.`;
}

function lockDailyDoubleWager() {
  const playerId = $("dd-player").value;
  if (!playerId) {
    $("dd-error").textContent = "Pick a player first.";
    return;
  }
  const wager = Number.parseInt($("dd-wager").value, 10);
  const max = dailyDoubleMaxWager(playerId);
  if (!Number.isFinite(wager) || wager < MIN_WAGER || wager > max) {
    $("dd-error").textContent =
      `Enter a wager between ${formatMoney(MIN_WAGER)} and ${formatMoney(max)}.`;
    return;
  }
  setState({
    active: { ...state.active, wagerLocked: true, wager, wagerPlayerId: playerId },
  });
  focusClueModal();
}

function revealAnswer() {
  setState({ active: { ...state.active, revealed: true } });
  window.BuzzerHost?.onAnswerRevealed?.();
}

function renderJudgeRow() {
  const row = $("judge-row");
  row.replaceChildren();
  const active = state.active;
  const judgeable = active.isDailyDouble
    ? state.players.filter((p) => p.id === active.wagerPlayerId)
    : state.players;

  judgeable.forEach((player) => {
    row.appendChild(buildJudgeChip(player, !!active.missed[player.id]));
  });
}

function buildJudgeChip(player, missed) {
  const chip = el("div", "judge-chip");
  if (missed) chip.classList.add("missed");
  chip.appendChild(el("span", "judge-name", player.name));

  const right = el("button", "judge-btn correct", "✓");
  right.type = "button";
  right.disabled = missed;
  right.setAttribute("aria-label", `${player.name} answered correctly`);
  right.addEventListener("click", () => judgeCorrect(player.id));
  chip.appendChild(right);

  const wrong = el("button", "judge-btn wrong", "✗");
  wrong.type = "button";
  wrong.disabled = missed;
  wrong.setAttribute("aria-label", `${player.name} answered incorrectly`);
  wrong.addEventListener("click", () => judgeWrong(player.id));
  chip.appendChild(wrong);
  return chip;
}

function judgeCorrect(playerId) {
  const amount = activeClueAmount();
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, score: p.score + amount } : p
  );
  closeClue({ players });
}

function judgeWrong(playerId) {
  const amount = activeClueAmount();
  const active = state.active;
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, score: p.score - amount } : p
  );
  if (active.isDailyDouble) {
    // Only one player answers a daily double; a miss ends the clue.
    closeClue({ players });
    return;
  }
  setState({
    players,
    active: { ...active, missed: { ...active.missed, [playerId]: true } },
  });
  window.BuzzerHost?.onJudgedWrong?.(playerId);
}

function closeClue(extraPatch = {}) {
  const { cat, row } = state.active;
  setState({
    ...extraPatch,
    used: { ...state.used, [clueKey(cat, row)]: true },
    active: null,
  });
  // Hand keyboard focus back to the board instead of dropping it on <body>.
  window.requestAnimationFrame(() => {
    const next = document.querySelector(".cell-clue:not(.used)") || $("btn-board-done");
    if (next) next.focus();
  });
  window.BuzzerHost?.onClueClosed?.();
}

/* ============ Final Jeopardy ============ */

function startFinal() {
  // One-shot: a fully judged Final can never restart (spec §8.3). Route the
  // request to the standings the host already produced.
  if (state.finalPlayed) {
    showStandings();
    return;
  }
  setState({ final: { stage: "wager", wagers: {}, answers: {}, judged: {} } });
}

function showStandings() {
  setState({ final: { stage: "standings", wagers: {}, answers: {}, judged: {} } });
}

function finalMaxWager(player) {
  return Math.max(player.score, 0);
}

function renderFinalModal() {
  const modal = $("final-modal");
  show(modal, !!state.final);
  if (!state.final) return;

  const body = $("final-body");
  body.replaceChildren();
  const stage = state.final.stage;

  if (stage === "standings") {
    $("final-heading").textContent = "Final Standings";
    renderStandings(body);
    return;
  }

  $("final-heading").textContent = "Final Jeopardy";
  if (stage === "wager") renderFinalWagers(body);
  if (stage === "clue" || stage === "judge") renderFinalClue(body, stage);
}

function renderFinalWagers(body) {
  const fj = state.game.finalJeopardy;
  body.appendChild(el("p", "final-category", `Category: ${fj.category}`));

  const list = el("ul", "wager-list");
  state.players.forEach((player) => {
    const li = el("li");
    const label = el("label");
    label.appendChild(el("span", null, player.name));
    const meta = el("span", "wager-meta",
      `${formatMoney(player.score)} — wager up to ${formatMoney(finalMaxWager(player))}`);
    label.appendChild(meta);
    li.appendChild(label);

    const input = el("input");
    input.type = "number";
    input.min = "0";
    input.max = String(finalMaxWager(player));
    input.step = "1";
    input.inputMode = "numeric";
    input.value = String(state.final.wagers[player.id] ?? 0);
    input.dataset.playerId = player.id;
    input.setAttribute("aria-label", `Wager for ${player.name}`);
    li.appendChild(input);
    list.appendChild(li);
  });
  body.appendChild(list);

  const error = el("p", "error-msg");
  error.id = "final-wager-error";
  error.setAttribute("role", "alert");
  body.appendChild(error);

  const actions = el("div", "final-actions");
  const back = el("button", "btn btn-ghost", "Back to board");
  back.type = "button";
  back.addEventListener("click", () => setState({ final: null }));
  actions.appendChild(back);

  const lock = el("button", "btn btn-gold", "Lock wagers & show clue");
  lock.type = "button";
  lock.addEventListener("click", lockFinalWagers);
  actions.appendChild(lock);
  body.appendChild(actions);
}

function lockFinalWagers() {
  const inputs = Array.from(document.querySelectorAll(".wager-list input"));
  const wagers = {};
  for (const input of inputs) {
    const playerId = input.dataset.playerId;
    const player = state.players.find((p) => p.id === playerId);
    const value = Number.parseInt(input.value, 10);
    const max = finalMaxWager(player);
    if (!Number.isFinite(value) || value < 0 || value > max) {
      $("final-wager-error").textContent =
        `${player.name}'s wager must be between $0 and ${formatMoney(max)}.`;
      return;
    }
    wagers[playerId] = value;
  }
  setState({ final: { ...state.final, stage: "clue", wagers } });
}

function renderFinalClue(body, stage) {
  const fj = state.game.finalJeopardy;
  body.appendChild(el("p", "final-category", fj.category));
  body.appendChild(el("p", "final-clue", fj.clue));

  if (stage === "clue") {
    const actions = el("div", "final-actions");
    const reveal = el("button", "btn btn-gold btn-big", "Reveal Answer");
    reveal.type = "button";
    reveal.addEventListener("click", () =>
      setState({ final: { ...state.final, stage: "judge" } })
    );
    actions.appendChild(reveal);
    body.appendChild(actions);
    return;
  }

  body.appendChild(el("p", "answer-text", fj.answer));
  renderFinalJudging(body);
}

function renderFinalJudging(body) {
  const list = el("ul", "final-judge-list");
  state.players.forEach((player) => {
    list.appendChild(buildFinalJudgeRow(player));
  });
  body.appendChild(list);

  const allJudged = state.players.every((p) => state.final.judged[p.id]);
  const actions = el("div", "final-actions");
  const finish = el("button", "btn btn-gold btn-big", "Show Final Standings");
  finish.type = "button";
  finish.disabled = !allJudged;
  finish.addEventListener("click", showStandings);
  actions.appendChild(finish);
  body.appendChild(actions);
}

function buildFinalJudgeRow(player) {
  const li = el("li");
  li.dataset.playerId = player.id; // lets the buzzer glue target this row
  const wager = state.final.wagers[player.id] ?? 0;
  const judged = !!state.final.judged[player.id];
  li.appendChild(el("span", null, `${player.name} (wagered ${formatMoney(wager)})`));

  if (judged) {
    li.appendChild(el("span", "standings-score", formatMoney(player.score)));
    return li;
  }

  const chip = el("div", "judge-chip");
  const right = el("button", "judge-btn correct", "✓");
  right.type = "button";
  right.setAttribute("aria-label", `${player.name} answered correctly`);
  right.addEventListener("click", () => judgeFinal(player.id, true));
  chip.appendChild(right);

  const wrong = el("button", "judge-btn wrong", "✗");
  wrong.type = "button";
  wrong.setAttribute("aria-label", `${player.name} answered incorrectly`);
  wrong.addEventListener("click", () => judgeFinal(player.id, false));
  chip.appendChild(wrong);
  li.appendChild(chip);
  return li;
}

function judgeFinal(playerId, correct) {
  const wager = state.final.wagers[playerId] ?? 0;
  const delta = correct ? wager : -wager;
  // finalPlayed latches on the first verdict so Final can't be replayed (§8.3).
  setState({
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, score: p.score + delta } : p
    ),
    final: { ...state.final, judged: { ...state.final.judged, [playerId]: correct ? "correct" : "wrong" } },
    finalPlayed: true,
  });
}

function renderStandings(body) {
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  const topScore = ranked.length ? ranked[0].score : 0;

  const list = el("ol", "standings-list");
  ranked.forEach((player, i) => {
    const li = el("li");
    const isWinner = player.score === topScore;
    if (isWinner) li.classList.add("winner");
    li.appendChild(el("span", "rank", isWinner ? "👑" : String(i + 1)));
    li.appendChild(el("span", "standings-name", player.name));
    const score = el("span", "standings-score", formatMoney(player.score));
    if (player.score < 0) score.classList.add("negative");
    li.appendChild(score);
    list.appendChild(li);
  });
  body.appendChild(list);

  const actions = el("div", "final-actions");
  const again = el("button", "btn btn-gold btn-big", "Play Again");
  again.type = "button";
  again.addEventListener("click", newGame);
  actions.appendChild(again);

  const back = el("button", "btn btn-ghost", "Back to board");
  back.type = "button";
  back.addEventListener("click", () => setState({ final: null }));
  actions.appendChild(back);
  body.appendChild(actions);
}

/* ============ Event wiring & init ============ */

function wireStaticEvents() {
  $("add-player-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("player-name-input");
    addPlayer(input.value);
    input.value = "";
    input.focus();
  });

  $("btn-load-json").addEventListener("click", () => $("json-file-input").click());
  $("json-file-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) handleCustomFile(file);
    event.target.value = "";
  });

  $("btn-start").addEventListener("click", startGame);
  $("btn-new-game").addEventListener("click", newGame);
  $("btn-final").addEventListener("click", startFinal);
  $("btn-board-done").addEventListener("click", handleBoardDone);

  $("btn-reveal").addEventListener("click", revealAnswer);
  $("btn-skip").addEventListener("click", () => closeClue());
  $("btn-dd-go").addEventListener("click", lockDailyDoubleWager);
  $("dd-player").addEventListener("change", updateDailyDoubleNote);
  $("dd-wager").addEventListener("keydown", (event) => {
    if (event.key === "Enter") lockDailyDoubleWager();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.active && !(state.active.isDailyDouble && state.active.wagerLocked)) {
      closeClue();
    }
  });
}

async function init() {
  // Player mode: the phone-buzzer page. buzzer-player.js drives it; the host
  // game must not boot (no fetch, no state restore, no host rendering).
  if (new URLSearchParams(window.location.search).has("room")) {
    document.body.classList.add("player-mode");
    return;
  }
  wireStaticEvents();
  const gameParam = new URLSearchParams(window.location.search).get("game");
  const saved = loadSavedState();
  // A ?game= link pointing somewhere new is an explicit request for that game.
  const savedMatchesParam = !!saved && (!gameParam || saved.sourceUrl === gameParam);

  if (saved && savedMatchesParam && saved.phase !== "setup") {
    state = saved;
    render();
    return;
  }

  // On the setup screen: keep saved players (scores zeroed) and any uploaded
  // game, but re-fetch so edits to questions.json and ?game= links take effect.
  if (saved) {
    state = {
      ...freshState(),
      players: saved.players.map((p) => ({ ...p, score: 0 })),
      game: savedMatchesParam ? saved.game : null,
      source: savedMatchesParam ? saved.source : "loading…",
      sourceKind: savedMatchesParam ? saved.sourceKind : "default",
      sourceUrl: savedMatchesParam ? saved.sourceUrl : null,
    };
  }
  render();

  const fetched = await fetchGameData();
  // An uploaded file (restored or chosen while the fetch was in flight) wins.
  if (!state.game || state.sourceKind !== "upload") {
    setState({
      game: fetched.game,
      source: fetched.source,
      sourceKind: fetched.sourceKind,
      sourceUrl: fetched.sourceUrl,
    });
  } else {
    saveState();
  }
}

init();
