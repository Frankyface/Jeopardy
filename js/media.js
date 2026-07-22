/* ============================================================
   Jeopardy — photo-clue media layer (spec §10)
   The single security gate for question images: validateImageRef()
   is the ONE allowlist every path funnels through (validateGame in
   app.js AND the editor), and buildClueImage() is the only place an
   <img> is created for game rendering. No raw-HTML injection, ever —
   images are built programmatically with src + alt only, and a broken
   image swaps itself for a plain-text "failed to load" note.
   UMD like buzzer-net.js: attaches globalThis.Media in the browser AND
   sets module.exports in Node so node:test can import it directly for
   the U21 accept/reject matrix. Pure/DOM-guarded — loads fine in Node
   (buildClueImage/mountClueImage only touch document when called in a
   browser; validateImageRef is pure and has no DOM dependency).
   ============================================================ */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.Media = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ============ Limits (spec §10.2) ============ */

  // A generous cap that still fits a downscaled JPEG data URI (~1 MB typical)
  // while refusing anything that could be a denial-of-service payload.
  const MAX_IMAGE_REF_LEN = 2000000;

  // Default screen-reader description when the author gave no imageAlt.
  const DEFAULT_ALT = "Clue image";

  // A URL scheme per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":".
  // Anchored so only a leading scheme matches; a relative path like
  // "images/a:b.jpg" has "/" before any ":" and therefore matches no scheme.
  const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

  /** @typedef {{valid:boolean, error:string|null}} ImageRefResult */

  /** @param {string} error @returns {ImageRefResult} */
  function reject(error) {
    return { valid: false, error };
  }

  const ACCEPT = Object.freeze({ valid: true, error: null });

  /**
   * The single security gate for any image reference stored in a game
   * (clue.image / clue.answerImage / finalJeopardy.image). Allows ONLY:
   *   - https: / http: URLs,
   *   - data:image/* URIs (the MIME prefix is actually checked; svg+xml is
   *     fine — SVG-as-<img> is inert, scripts/handlers never run),
   *   - relative paths (no scheme, and NOT protocol-relative "//").
   * Everything else (javascript:, data:text/html, file:, blob:, non-strings,
   * empty, over-length) is rejected with a clear per-field message.
   * Pure — no DOM, safe to run in Node (spec §10.2 / U21).
   * @param {unknown} str
   * @returns {ImageRefResult}
   */
  function validateImageRef(str) {
    if (typeof str !== "string") return reject("Image reference must be a string.");
    if (str.length === 0) return reject("Image reference is empty.");
    if (str.length > MAX_IMAGE_REF_LEN) {
      return reject(`Image reference is too large (max ${MAX_IMAGE_REF_LEN.toLocaleString("en-US")} characters).`);
    }
    // Normalise the way the WHATWG URL parser would BEFORE detecting the scheme,
    // so tricks like "  javascript:…" or "jav\tascript:…" cannot smuggle a
    // disallowed scheme past the allowlist: strip all ASCII tab/newline chars,
    // then leading C0-control-or-space. (The length check above stays on the raw
    // string so the cap can't be dodged with padding whitespace.)
    const normalized = str.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "");
    // Protocol-relative "//host/x" inherits the page scheme and dodges the
    // allowlist — reject before scheme detection.
    if (normalized.slice(0, 2) === "//") {
      return reject("Protocol-relative references (//…) are not allowed — use https:// or a relative path.");
    }
    const schemeMatch = SCHEME_RE.exec(normalized);
    if (!schemeMatch) return ACCEPT; // no scheme → relative repo path
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "https" || scheme === "http") return ACCEPT;
    if (scheme === "data") {
      // data:[<mediatype>][;base64],<data> — require an image/* media type.
      if (normalized.slice(0, 11).toLowerCase() === "data:image/") return ACCEPT;
      return reject('Only "data:image/*" data URIs are allowed (not data:text/html or similar).');
    }
    return reject(`The "${scheme}:" scheme is not allowed. Use https, http, a data:image/* URI, or a relative path.`);
  }

  /* ============ Programmatic image building (spec §10.2/§10.3) ============ */

  /**
   * Build a clue <img> programmatically — no HTML strings. `decoding="async"`
   * keeps a large image off the render-blocking path; on a load error the
   * <img> replaces itself (in its parent) with a plain-text note instead of
   * showing a broken-image icon. Callers MUST pass a src that already passed
   * validateImageRef (game rendering never hands an unvalidated value here).
   * @param {string} src a validateImageRef-approved reference
   * @param {string} [alt] screen-reader description; defaults to "Clue image"
   * @returns {HTMLImageElement}
   */
  function buildClueImage(src, alt) {
    const img = document.createElement("img");
    img.className = "clue-image";
    img.decoding = "async";
    img.alt = typeof alt === "string" && alt.trim() ? alt : DEFAULT_ALT;
    img.src = src;
    img.addEventListener("error", function onError() {
      const note = document.createElement("p");
      note.className = "clue-image-failed";
      note.textContent = "⚠ image failed to load";
      if (img.parentNode) img.parentNode.replaceChild(note, img);
    });
    return img;
  }

  /**
   * Return a built <img> for `ref` iff it passes the gate, else null. The
   * validation seam for callers that append a node directly (e.g. the Final
   * modal's dynamically built body).
   * @param {unknown} ref
   * @param {string} [alt]
   * @returns {HTMLImageElement|null}
   */
  function buildValidatedImage(ref, alt) {
    if (typeof ref !== "string" || !validateImageRef(ref).valid) return null;
    return buildClueImage(ref, alt);
  }

  /**
   * Mount (or clear) an image inside a static container element. Clears the
   * container, then — only when `ref` passes the gate — appends a fresh
   * validated <img> and unhides the container; otherwise leaves it empty and
   * hidden. This is how renderClueModal keeps app.js lean: one call per slot,
   * with the security gate applied here rather than at the call site.
   * @param {HTMLElement|null} container
   * @param {unknown} ref
   * @param {string} [alt]
   */
  function mountClueImage(container, ref, alt) {
    if (!container) return;
    container.replaceChildren();
    const node = buildValidatedImage(ref, alt);
    container.classList.toggle("hidden", !node);
    if (node) container.appendChild(node);
  }

  return {
    MAX_IMAGE_REF_LEN,
    DEFAULT_ALT,
    validateImageRef,
    buildClueImage,
    buildValidatedImage,
    mountClueImage,
  };
});
