/* ============================================================
   Jeopardy — question-editor photo-clue controls (spec §10.4)
   The image UI for the editor: per-slot paste-URL / Choose file… /
   alt-text / thumbnail / Remove controls, the canvas downscale-and-
   embed pipeline (max 1024px long edge, JPEG q0.75 → data:image/jpeg),
   per-image size notes, and the running "embedded images: ~N MB"
   meter. Split out of editor.js so both stay well under the 800-line
   house cap. Relies on the same app.js globals editor.js uses (el,
   show) plus the media gate window.Media (validateImageRef /
   buildValidatedImage) — the SAME single security gate as game
   rendering, so nothing here can put an unvalidated value in front of
   Use-in-game / Download. Attaches window.EditorMedia; no exports for
   Node (this is browser-only DOM glue, unlike the pure media.js).
   ============================================================ */

"use strict";

(function () {
  "use strict";

  /* ============ Embed tuning (spec §10.4) ============ */

  const MAX_EMBED_DIM = 1024; // longest edge after downscale, px
  const EMBED_QUALITY = 0.75; // JPEG quality for the embedded data URI
  const IMG_WARN_BYTES = 2.5 * 1024 * 1024; // warn above ~2.5 MB embedded total

  /* ============ Byte estimation for the meter ============ */

  /**
   * Approximate decoded byte size of an image reference. Only embedded
   * (data:) URIs count toward the localStorage-pressure meter — linked http(s)
   * / relative refs cost nothing to store. base64 decodes to ~3/4 of its length.
   * @param {unknown} ref
   * @returns {number} estimated bytes (0 for non-embedded or junk)
   */
  function estimateRefBytes(ref) {
    if (typeof ref !== "string" || ref.slice(0, 5).toLowerCase() !== "data:") return 0;
    const comma = ref.indexOf(",");
    if (comma < 0) return 0;
    const meta = ref.slice(0, comma);
    const payload = ref.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
      return Math.max(0, Math.floor((payload.length * 3) / 4) - pad);
    }
    return payload.length; // percent-encoded text payload ≈ its own length
  }

  /**
   * Sum the estimated embedded bytes across every image slot in a draft
   * (each clue's image + answerImage, plus the Final Jeopardy image).
   * @param {object} draft
   * @returns {number}
   */
  function totalEmbeddedBytes(draft) {
    let total = 0;
    if (!draft || !Array.isArray(draft.categories)) return 0;
    for (const cat of draft.categories) {
      if (!cat || !Array.isArray(cat.clues)) continue;
      for (const clue of cat.clues) {
        if (!clue) continue;
        total += estimateRefBytes(clue.image) + estimateRefBytes(clue.answerImage);
      }
    }
    if (draft.finalJeopardy) total += estimateRefBytes(draft.finalJeopardy.image);
    return total;
  }

  /** Human-friendly size like "120 KB" / "1.4 MB". @returns {string} */
  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  /* ============ Canvas downscale + embed (spec §10.4) ============ */

  const HEIC_RE = /\.(heic|heif)$/i;

  /** iPhone HEIC/HEIF, which most browsers can't decode. @returns {boolean} */
  function looksHeic(file) {
    const type = (file && file.type) || "";
    return type === "image/heic" || type === "image/heif" || (!!file && HEIC_RE.test(file.name || ""));
  }

  /**
   * True when the drawn canvas is a single uniform color — the signature of a
   * `drawImage` that silently did nothing (mobile Safari's out-of-memory
   * failure on a large photo, which otherwise embeds a blank frame). Because
   * drawImage always covers the whole canvas when it succeeds, the only way the
   * result is perfectly uniform is a no-op draw, which leaves either the white
   * fill (white readback) OR a corrupted all-black frame — this catches both.
   * ANY real image varies pixel-to-pixel, so a small logo/subject on white is
   * NOT a false positive; only a genuinely solid-color (degenerate) image is
   * rejected, and the host is better off re-choosing it. Full scan with an
   * early exit on the first varying pixel (instant for real images). One
   * `getImageData` — can throw on a tainted canvas (never here, same-origin
   * file/bitmap) so we fail safe to false.
   * @returns {boolean}
   */
  function isBlankDraw(ctx, w, h) {
    try {
      const data = ctx.getImageData(0, 0, w, h).data;
      if (data.length < 8) return false; // 1px canvas — nothing to compare
      const r0 = data[0];
      const g0 = data[1];
      const b0 = data[2];
      for (let i = 4; i < data.length; i += 4) {
        if (Math.abs(data[i] - r0) > 4 || Math.abs(data[i + 1] - g0) > 4 || Math.abs(data[i + 2] - b0) > 4) {
          return false; // real pixel-to-pixel variation → a genuine image
        }
      }
      return true; // perfectly uniform → drawImage was a no-op
    } catch (err) {
      return false;
    }
  }

  /**
   * Draw a decoded source (ImageBitmap or <img>) downscaled onto a canvas and
   * return a JPEG data URI — or null if the draw came back blank. Paints an
   * OPAQUE WHITE background FIRST: JPEG has no alpha, so without it every
   * transparent pixel (a PNG cut-out, a logo) would encode as BLACK — the core
   * "just shows black photos" bug. @returns {string|null}
   */
  function encodeToJpeg(source, srcW, srcH) {
    const scale = Math.min(1, MAX_EMBED_DIM / (Math.max(srcW, srcH) || 1));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas 2d context");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    if (isBlankDraw(ctx, w, h)) return null;
    return canvas.toDataURL("image/jpeg", EMBED_QUALITY);
  }

  /**
   * Read an image file, downscale it to at most MAX_EMBED_DIM on its long edge,
   * and re-encode as a JPEG data URI (quality EMBED_QUALITY). Decodes via
   * `createImageBitmap` when available — it is memory-efficient for the 12–48 MP
   * phone photos that make mobile Safari hand back a blank canvas, and
   * `imageOrientation:"from-image"` keeps EXIF-rotated photos upright — and
   * falls back to a FileReader + <img> decode. All async work funnels through
   * the two callbacks; no globals mutated here.
   * @param {File} file
   * @param {(dataUrl:string)=>void} onDone
   * @param {(message:string)=>void} onError
   */
  function downscaleImageFile(file, onDone, onError) {
    const fail = (m) => { if (onError) onError(m); };
    if (!file || typeof file.type !== "string" || !/^image\//.test(file.type)) {
      if (looksHeic(file)) {
        fail("iPhone HEIC photos aren’t supported by browsers. Set the camera to “Most Compatible” (JPEG), screenshot the photo, or paste an image URL instead.");
        return;
      }
      fail("Please choose an image file.");
      return;
    }
    const finish = (source, w, h, close) => {
      let dataUrl = null;
      try {
        dataUrl = encodeToJpeg(source, w, h);
      } catch (err) {
        if (typeof console !== "undefined") console.warn("Image embed failed:", err);
        if (close) close();
        fail("Could not embed that image.");
        return;
      }
      if (close) close();
      if (dataUrl === null) {
        fail("That image came out blank — it may be too large for this device to process. Try a different or smaller photo, or paste an image URL instead.");
        return;
      }
      onDone(dataUrl);
    };
    // Two-arg then(onFulfilled, onRejected): the reject handler fires ONLY when
    // createImageBitmap itself rejects — NOT when finish()/onDone throws — so a
    // downstream throw (e.g. a localStorage quota error in the save-draft step)
    // can't re-trigger the fallback and fire the callbacks twice. The try/catch
    // guards a synchronous throw from an engine that dislikes the options dict.
    let bitmapPromise = null;
    if (typeof createImageBitmap === "function") {
      try {
        bitmapPromise = createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (err) {
        bitmapPromise = null;
      }
    }
    if (bitmapPromise) {
      bitmapPromise.then(
        (bmp) => finish(bmp, bmp.width, bmp.height, () => { if (bmp.close) bmp.close(); }),
        () => decodeViaImageElement(file, finish, fail)
      );
      return;
    }
    decodeViaImageElement(file, finish, fail);
  }

  /** FileReader + <img> decode fallback (no createImageBitmap, or it rejected). */
  function decodeViaImageElement(file, finish, fail) {
    const reader = new FileReader();
    reader.onerror = () => fail("Could not read that file.");
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => fail(looksHeic(file)
        ? "iPhone HEIC photos aren’t supported by browsers. Use a JPEG/PNG, or paste an image URL instead."
        : "That image could not be decoded.");
      img.onload = () => finish(img, img.naturalWidth, img.naturalHeight, null);
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  /* ============ Per-slot image control ============ */

  /**
   * Build the controls for one image slot (a clue image, an answer-reveal
   * image, or the Final image). Reads/writes `model[imgKey]` and, when
   * `altKey` is given, `model[altKey]`. Every mutation calls `onChange()` (the
   * editor's save-draft + meter refresh). The live thumbnail and the inline
   * error are gated by window.Media.validateImageRef — the same gate that
   * blocks Use-in-game / Download — so a bad ref shows an error, never a
   * silently-accepted value.
   * @param {{model:object, imgKey:string, altKey:string|null, label:string,
   *          onChange:()=>void}} opts
   * @returns {HTMLElement}
   */
  function buildImageControl(opts) {
    const { model, imgKey, altKey, label, onChange } = opts;
    const control = el("div", "editor-media-control");

    const head = el("div", "editor-media-head");
    head.appendChild(el("span", "editor-media-label", label));
    const remove = el("button", "btn btn-ghost btn-small", "Remove");
    remove.type = "button";
    head.appendChild(remove);
    control.appendChild(head);

    const feedback = el("div", "editor-media-feedback");

    const url = el("input", "editor-media-url");
    url.type = "text";
    url.placeholder = "Paste image URL, or embed a file →";
    url.autocomplete = "off";
    url.spellcheck = false;
    url.setAttribute("aria-label", `${label} URL`);
    url.value = typeof model[imgKey] === "string" ? model[imgKey] : "";

    const chooseWrap = el("div", "editor-media-choose");
    const choose = el("button", "btn btn-ghost btn-small", "Choose file…");
    choose.type = "button";
    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.hidden = true;
    chooseWrap.appendChild(choose);
    chooseWrap.appendChild(fileInput);

    const row = el("div", "editor-media-row");
    row.appendChild(url);
    row.appendChild(chooseWrap);
    control.appendChild(row);

    let altInput = null;
    if (altKey) {
      const altLabel = el("label", "editor-media-alt");
      altLabel.appendChild(el("span", null, "Alt text (screen readers)"));
      altInput = el("input");
      altInput.type = "text";
      altInput.maxLength = 200;
      altInput.autocomplete = "off";
      altInput.placeholder = "e.g. A rugby player mid-kick";
      altInput.value = typeof model[altKey] === "string" ? model[altKey] : "";
      altLabel.appendChild(altInput);
      control.appendChild(altLabel);
    }

    control.appendChild(feedback);

    /** Rebuild the thumbnail / size / error area from the current model value. */
    function refresh() {
      feedback.replaceChildren();
      const ref = model[imgKey];
      if (typeof ref !== "string" || ref.trim() === "") return;
      const media = window.Media;
      const res = media ? media.validateImageRef(ref) : { valid: true, error: null };
      if (!res.valid) {
        feedback.appendChild(el("p", "editor-media-error", res.error));
        return;
      }
      const thumb = media ? media.buildValidatedImage(ref, altKey ? model[altKey] : label) : null;
      if (thumb) {
        thumb.className = "editor-media-thumb";
        feedback.appendChild(thumb);
      }
      const bytes = estimateRefBytes(ref);
      if (bytes > 0) feedback.appendChild(el("span", "editor-media-size", `Embedded ~${formatBytes(bytes)}`));
    }

    function setRef(value) {
      if (typeof value === "string" && value.trim() !== "") model[imgKey] = value;
      else delete model[imgKey];
      refresh();
      onChange();
    }

    url.addEventListener("input", () => setRef(url.value));
    choose.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      feedback.replaceChildren(el("span", "editor-media-size", "Embedding…"));
      downscaleImageFile(
        file,
        (dataUrl) => { url.value = dataUrl; setRef(dataUrl); },
        (message) => { feedback.replaceChildren(el("p", "editor-media-error", message)); }
      );
    });
    if (altInput) {
      altInput.addEventListener("input", () => {
        if (altInput.value.trim() !== "") model[altKey] = altInput.value;
        else delete model[altKey];
        refresh();
        onChange();
      });
    }
    remove.addEventListener("click", () => {
      delete model[imgKey];
      if (altKey) delete model[altKey];
      url.value = "";
      if (altInput) altInput.value = "";
      refresh();
      onChange();
    });

    refresh();
    return control;
  }

  /* ============ Running size meter (spec §10.4) ============ */

  /**
   * Update the "Embedded images: ~N MB" meter for a draft. Above the warn
   * threshold the meter turns amber and appends an inline caution that
   * auto-save may fail. (Actual quota failures are surfaced separately by
   * editor.js's save-draft warning.)
   * @param {object} draft
   * @param {HTMLElement} meterEl
   */
  function renderMeter(draft, meterEl) {
    if (!meterEl) return;
    const bytes = totalEmbeddedBytes(draft);
    const over = bytes > IMG_WARN_BYTES;
    meterEl.classList.toggle("warn", over);
    meterEl.textContent = over
      ? `Embedded images: ~${formatBytes(bytes)} — large; auto-save may fail. Prefer pasting image URLs for big pictures.`
      : `Embedded images: ~${formatBytes(bytes)}`;
  }

  window.EditorMedia = {
    MAX_EMBED_DIM,
    EMBED_QUALITY,
    IMG_WARN_BYTES,
    estimateRefBytes,
    totalEmbeddedBytes,
    formatBytes,
    downscaleImageFile,
    buildImageControl,
    renderMeter,
  };
})();
