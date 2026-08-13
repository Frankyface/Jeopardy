/* ============================================================
   Jeopardy — built-in question editor
   Lets the host build or tweak a game in the browser, download
   it as questions.json, or load it straight into the current
   session. The working draft auto-saves to localStorage under
   its own key so a refresh never loses work. Relies on globals
   from app.js: state, setState, validateGame, $, el, show,
   MAX_CATEGORIES, MAX_CLUES_PER_CATEGORY.
   ============================================================ */

"use strict";

const EDITOR_KEY = "gh-jeopardy-editor-v1";
const DEFAULT_CLUE_ROWS = 5;
const VALUE_STEP = 200;

let editorDraft = null;

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ============ Draft templates ============ */

function blankClue(row) {
  return { value: (row + 1) * VALUE_STEP, clue: "", answer: "" };
}

function blankCategory() {
  const clues = [];
  for (let row = 0; row < DEFAULT_CLUE_ROWS; row += 1) clues.push(blankClue(row));
  return { name: "", clues };
}

function blankDraft() {
  return {
    title: "My Jeopardy Game",
    categories: [blankCategory()],
    finalJeopardy: { category: "", clue: "", answer: "" },
  };
}

/* ============ Draft persistence ============ */

function saveDraft() {
  try {
    localStorage.setItem(EDITOR_KEY, JSON.stringify(editorDraft));
    setSaveWarning("");
  } catch (err) {
    console.warn("Could not save editor draft:", err);
    // Quota is the usual culprit once photos are embedded — say so visibly
    // instead of only logging (spec §10.4).
    setSaveWarning(
      "Draft too large to auto-save in this browser — usually embedded images. " +
      "Download JSON to keep your work, or remove large images / use image URLs instead."
    );
  }
}

function setSaveWarning(msg) {
  const el = $("editor-save-warning");
  if (el) el.textContent = msg || "";
}

/** Save the draft and refresh the embedded-image meter after any image edit. */
function onDraftChange() {
  saveDraft();
  renderImageMeter();
}

function renderImageMeter() {
  window.EditorMedia?.renderMeter(editorDraft, $("editor-image-meter"));
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(EDITOR_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft || !Array.isArray(draft.categories) || draft.categories.length === 0) {
      return null;
    }
    return draft;
  } catch (err) {
    console.warn("Ignoring corrupt editor draft:", err);
    return null;
  }
}

/* ============ Open / close ============ */

function openEditor() {
  editorDraft = loadDraft() || (state.game ? deepCopy(state.game) : blankDraft());
  document.body.classList.add("editor-open");
  show($("screen-editor"), true);
  renderEditor();
  $("editor-title").focus();
}

function closeEditor() {
  saveDraft();
  document.body.classList.remove("editor-open");
  show($("screen-editor"), false);
}

function resetDraft(draft) {
  editorDraft = draft;
  saveDraft();
  setEditorError("");
  renderEditor();
}

/* ============ Export ============ */

/** Normalized copy for export: drop helper nulls and false dailyDouble flags. */
function cleanDraft() {
  const out = deepCopy(editorDraft);
  out.categories.forEach((cat) => {
    cat.clues.forEach((clue) => {
      if (!clue.dailyDouble) delete clue.dailyDouble;
      pruneImageFields(clue);
    });
  });
  if (out.finalJeopardy) pruneImageFields(out.finalJeopardy);
  if (!out.finalJeopardy) delete out.finalJeopardy;
  return out;
}

/** Drop blank image fields so games without photos round-trip byte-for-byte. */
function pruneImageFields(obj) {
  for (const key of ["image", "answerImage", "imageAlt"]) {
    if (typeof obj[key] !== "string" || !obj[key].trim()) delete obj[key];
  }
}

function validateDraft() {
  try {
    validateGame(cleanDraft());
    setEditorError("");
    return true;
  } catch (err) {
    setEditorError(err.message);
    return false;
  }
}

function downloadDraft() {
  if (!validateDraft()) return;
  const json = JSON.stringify(cleanDraft(), null, 2) + "\n";
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "questions.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function useDraftInGame() {
  if (!validateDraft()) return;
  if (state.phase !== "setup") {
    const ok = window.confirm(
      "Use these questions now? The game in progress will be reset (players are kept)."
    );
    if (!ok) return;
  }
  setState({
    ...freshState(),
    game: cleanDraft(),
    source: "question editor",
    sourceKind: "upload",
    players: state.players.map((p) => ({ ...p, score: 0 })),
    settings: state.settings, // a mid-session reset must not revert timers (§12)
  });
  closeEditor();
}

function setEditorError(msg) {
  $("editor-error").textContent = msg || "";
}

/* ============ Rendering ============ */

function renderEditor() {
  $("editor-title").value = editorDraft.title || "";
  renderEditorCategories();
  renderEditorFinal();
  $("btn-add-category").disabled = editorDraft.categories.length >= MAX_CATEGORIES;
  renderImageMeter();
}

function renderEditorCategories() {
  const host = $("editor-categories");
  host.replaceChildren();
  editorDraft.categories.forEach((cat, c) => {
    host.appendChild(buildCategoryBlock(cat, c));
  });
}

function buildCategoryBlock(cat, c) {
  const block = el("div", "editor-cat");
  const head = el("div", "editor-cat-head");

  const nameLabel = el("label", "editor-field editor-cat-name", `Category ${c + 1}`);
  const nameInput = el("input");
  nameInput.type = "text";
  nameInput.maxLength = 60;
  nameInput.placeholder = "Category name";
  nameInput.autocomplete = "off";
  nameInput.value = cat.name;
  nameInput.addEventListener("input", () => {
    cat.name = nameInput.value;
    saveDraft();
  });
  nameLabel.appendChild(nameInput);
  head.appendChild(nameLabel);

  const removeCat = el("button", "btn btn-ghost btn-small", "Remove category");
  removeCat.type = "button";
  removeCat.disabled = editorDraft.categories.length <= 1;
  removeCat.addEventListener("click", () => {
    editorDraft.categories.splice(c, 1);
    saveDraft();
    renderEditor();
  });
  head.appendChild(removeCat);
  block.appendChild(head);

  const rows = el("div", "editor-clues");
  rows.appendChild(buildClueHeaderRow());
  cat.clues.forEach((clue, r) => rows.appendChild(buildClueRow(cat, clue, r)));
  block.appendChild(rows);

  const addClue = el("button", "btn btn-ghost btn-small", "+ Add clue");
  addClue.type = "button";
  addClue.disabled = cat.clues.length >= MAX_CLUES_PER_CATEGORY;
  addClue.addEventListener("click", () => {
    cat.clues.push(blankClue(cat.clues.length));
    saveDraft();
    renderEditor();
  });
  block.appendChild(addClue);
  return block;
}

function buildClueHeaderRow() {
  const head = el("div", "editor-clue-row editor-clue-labels");
  head.appendChild(el("span", null, "Value"));
  head.appendChild(el("span", null, "Clue (read aloud)"));
  head.appendChild(el("span", null, "Answer"));
  head.appendChild(el("span", null, "DD"));
  head.appendChild(el("span", null, ""));
  return head;
}

function buildClueRow(cat, clue, r) {
  const row = el("div", "editor-clue-row");

  const value = el("input");
  value.type = "number";
  value.min = "1";
  value.step = String(VALUE_STEP);
  value.inputMode = "numeric";
  value.value = String(clue.value);
  value.setAttribute("aria-label", `Clue ${r + 1} value`);
  value.addEventListener("input", () => {
    clue.value = Number.parseInt(value.value, 10) || 0;
    saveDraft();
  });
  row.appendChild(value);

  const text = el("textarea");
  text.rows = 2;
  text.placeholder = "Clue text";
  text.value = clue.clue;
  text.setAttribute("aria-label", `Clue ${r + 1} text`);
  text.addEventListener("input", () => {
    clue.clue = text.value;
    saveDraft();
  });
  row.appendChild(text);

  const answer = el("textarea");
  answer.rows = 2;
  answer.placeholder = "Answer";
  answer.value = clue.answer;
  answer.setAttribute("aria-label", `Clue ${r + 1} answer`);
  answer.addEventListener("input", () => {
    clue.answer = answer.value;
    saveDraft();
  });
  row.appendChild(answer);

  const dd = el("input", "editor-dd");
  dd.type = "checkbox";
  dd.checked = !!clue.dailyDouble;
  dd.title = "Daily Double";
  dd.setAttribute("aria-label", `Clue ${r + 1} is a Daily Double`);
  dd.addEventListener("change", () => {
    clue.dailyDouble = dd.checked;
    saveDraft();
  });
  row.appendChild(dd);

  const remove = el("button", "remove-btn", "✕");
  remove.type = "button";
  remove.disabled = cat.clues.length <= 1;
  remove.setAttribute("aria-label", `Remove clue ${r + 1}`);
  remove.addEventListener("click", () => {
    cat.clues.splice(r, 1);
    saveDraft();
    renderEditor();
  });
  row.appendChild(remove);

  // Wrap the value/clue/answer/DD grid row with its collapsible photo controls
  // (spec §10.4) so each clue can carry a clue image and an answer-reveal image.
  const cell = el("div", "editor-clue-cell");
  cell.appendChild(row);
  cell.appendChild(buildClueMedia(clue, r));
  return cell;
}

/** Collapsible per-clue image controls: clue image + answer-reveal image. */
function buildClueMedia(clue, r) {
  const details = el("details", "editor-clue-media");
  if (clue.image || clue.answerImage) details.open = true;
  details.appendChild(el("summary", "editor-clue-media-summary", `📷 Clue ${r + 1} images`));
  if (window.EditorMedia) {
    details.appendChild(window.EditorMedia.buildImageControl({
      model: clue, imgKey: "image", altKey: "imageAlt", label: "Clue image", onChange: onDraftChange,
    }));
    details.appendChild(window.EditorMedia.buildImageControl({
      model: clue, imgKey: "answerImage", altKey: null, label: "Answer-reveal image", onChange: onDraftChange,
    }));
  }
  return details;
}

function renderEditorFinal() {
  const enabled = !!editorDraft.finalJeopardy;
  $("editor-final-enabled").checked = enabled;
  show($("editor-final-fields"), enabled);
  if (!enabled) return;
  $("editor-final-category").value = editorDraft.finalJeopardy.category || "";
  $("editor-final-clue").value = editorDraft.finalJeopardy.clue || "";
  $("editor-final-answer").value = editorDraft.finalJeopardy.answer || "";

  const media = $("editor-final-media");
  media.replaceChildren();
  if (window.EditorMedia) {
    media.appendChild(window.EditorMedia.buildImageControl({
      model: editorDraft.finalJeopardy, imgKey: "image", altKey: "imageAlt",
      label: "Final Jeopardy image", onChange: onDraftChange,
    }));
  }
}

/* ============ Event wiring ============ */

function wireEditorEvents() {
  $("btn-editor").addEventListener("click", openEditor);
  $("btn-editor-setup").addEventListener("click", openEditor);
  $("btn-editor-close").addEventListener("click", closeEditor);
  $("btn-editor-download").addEventListener("click", downloadDraft);
  $("btn-editor-use").addEventListener("click", useDraftInGame);

  $("editor-title").addEventListener("input", (event) => {
    editorDraft.title = event.target.value;
    saveDraft();
  });

  $("btn-add-category").addEventListener("click", () => {
    editorDraft.categories.push(blankCategory());
    saveDraft();
    renderEditor();
  });

  $("btn-editor-reset").addEventListener("click", () => {
    if (!state.game) return;
    const ok = window.confirm("Replace your draft with the currently loaded game?");
    if (ok) resetDraft(deepCopy(state.game));
  });

  $("btn-editor-blank").addEventListener("click", () => {
    const ok = window.confirm("Discard your draft and start blank?");
    if (ok) resetDraft(blankDraft());
  });

  $("editor-final-enabled").addEventListener("change", (event) => {
    editorDraft.finalJeopardy = event.target.checked
      ? { category: "", clue: "", answer: "" }
      : null;
    saveDraft();
    renderEditorFinal();
  });

  for (const key of ["category", "clue", "answer"]) {
    $(`editor-final-${key}`).addEventListener("input", (event) => {
      if (!editorDraft.finalJeopardy) return;
      editorDraft.finalJeopardy[key] = event.target.value;
      saveDraft();
    });
  }
}

wireEditorEvents();
