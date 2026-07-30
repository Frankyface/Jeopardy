# Photo clues — verification & success states

What "photo clues work" actually means, how each claim is checked, and what is
proven vs. still unproven. Written 2026-07-30 after a report that photo clues
were not working.

The photo feature spans four separate paths, and "it doesn't work" can mean a
failure in any one of them:

1. **Authoring** — adding a photo in the Question Editor (embed a file, or paste a URL)
2. **Carrying** — the photo surviving export / reload / file load into the game
3. **Rendering** — the photo appearing on the board at the right moment
4. **Degrading** — what happens when a photo can't load or can't be saved

A success state below is a single sentence that is either true or false about
the running app, with a check that decides it. No state is "verified" because
the code looks right — only because a check ran and passed.

## How to run the checks

Automated (browser, ~40 s, 26 checks):

```bash
python -m http.server 8613 --directory "C:/Users/Cam/Documents/.ClaudeCode Projects/GithubJeopardy"
```

Then open <http://localhost:8613/tests/photo-harness.html>. The page drives the
**real** `index.html` in an iframe — real editor clicks, real file picks, real
board tiles — and prints PASS/FAIL per success state with the measured numbers.
Green summary line = every state below holds.

Pure-logic units (the security gate), 36 checks:

```bash
node --test tests/media.test.mjs tests/buzzer-protocol.test.mjs
```

> The harness re-fetches `index.html` and every JS/CSS file with `cache: "reload"`
> before each run. Without that it silently tested a **stale cached bundle** and
> reported on code that was no longer on disk. It now aborts if the app it loaded
> is stale, so a green run can be trusted.

## Success states

Status recorded from the run of 2026-07-30 on Chrome/desktop.

### Authoring

| # | Success state | Check | Status |
|---|---|---|---|
| P1 | Every clue exposes 📷 controls, plus one for Final Jeopardy | count `.editor-media-control` = clues×2 + 1 | PASS — 51 for 25 clues |
| P2 | A large real photo (3000×2000) embeds as a downscaled `data:image/jpeg` URI | long edge ≤ 1024, prefix is `data:image/jpeg;base64,` | PASS — 1024×683, 48 k chars |
| P2b | The embedded photo is a real image, **not** a black or blank frame | decode the result, require pixel variation and non-zero brightness | PASS — avg 134, range 26–255 |
| P2c | The per-image size note and the running total meter both update | text matches `Embedded ~…`, meter leaves `~0 B` | PASS — 35 KB |
| P3 | A **transparent** PNG embeds on white, never flattened to black | corner pixel of the result is ≥220 on all channels | PASS — corner 255,255,255 |
| P4 | A pasted URL or relative repo path previews in the editor | thumbnail reaches `naturalWidth > 0` | PASS — 800×600 |
| P5 | A dangerous reference is refused by the editor **and** by `validateGame` | `javascript:alert(1)` → inline error + `validateGame` throws | PASS |

### Carrying

| # | Success state | Check | Status |
|---|---|---|---|
| P6 | Export keeps photos, drops empty image keys, and re-validates | `cleanDraft()` → JSON → `validateGame`; photo-free clues keep only `value/clue/answer` | PASS |
| P13 | Photos survive a page reload mid-game | reload without clearing storage, reopen the clue, image still renders | PASS — 145 k chars restored |
| P15 | A `questions.json` file containing photos loads and renders them | drive the real "Load custom questions" file input | PASS — 142 KB file |
| P16 | `?game=URL` loads a photo game and renders its photos | boot with `?game=tests/fixtures/photo-game.json` | PASS |

### Rendering

| # | Success state | Check | Status |
|---|---|---|---|
| P7 | A photo clue shows its photo when the clue is opened | `#clue-image img` present, `complete`, `naturalWidth > 0`, container visible | PASS |
| P7b | The author's alt text reaches the rendered image | `img.alt` equals the authored value | PASS |
| P8 | The answer photo is hidden before the reveal, shown after | assert both sides of the reveal click | PASS |
| P9 | A Daily Double photo appears **only** after the wager locks | no `img` while `#dd-splash` is up; `img` after lock | PASS |
| P10 | The Final photo is hidden during wagers, shown with the clue | assert both stages | PASS |
| P12 | Phones never receive image data | build the real player messages, assert no image fields | PASS |
| P14 | Judging buttons stay reachable with photo + answer photo shown | scroll the card, assert `#judge-row` is inside the card box | PASS — 1175 px content in a scrollable 662 px card |
| P14b | At phone width the photo fits the card and judging stays reachable | same, at a 390×780 viewport | PASS — 303 px image in a 352 px card |

### Degrading

| # | Success state | Check | Status |
|---|---|---|---|
| P11 | An unreachable image shows a text note, and the clue stays playable | force a dead URL; expect `.clue-image-failed`, no broken-image icon, Reveal still available | PASS |
| P17 | When browser storage is full the game still plays **and the host is warned** | fault-inject `QuotaExceededError` on `Storage.prototype.setItem` | **was FAIL → fixed, now PASS** |
| P18 | The save warning does not cry wolf when saving works | banner hidden and empty during a normal photo game | PASS |
| P19 | A photo that rasterises into black bands is detected as corrupt | `classifyDraw` on a banded frame → `"striped"` | **new — PASS** |
| P19b | A normal photo and a letterboxed photo are **not** falsely rejected | both → `"ok"` | **new — PASS** |
| P19c | A uniform all-white / all-black no-op draw is still caught | both → `"blank"` | PASS (unchanged behaviour) |
| P20 | A photo that first rasterises in black bands still embeds **cleanly** | fault-inject a banded first `drawImage`; expect a clean image, not an error | **new — PASS**, recovered at 1024×683 |

## The defects these states found

**P19/P20 — a corrupt photo was embedded silently.** This is the reported symptom:
*"I added the photo but it turned into a bunch of black lines, not the image."*

A browser that runs out of memory rasterising a big photo does not throw — it
hands back a canvas that only partly contains the image. The existing guard,
`isBlankDraw`, only recognised the *uniform* shape of that failure (a draw that
did nothing at all). The other shape — the image landing in bands, with rows of
pure black between them — has plenty of pixel-to-pixel variation, so it sailed
through the check and got embedded and played.

Two changes, both in `js/editor-media.js`:

- `isBlankDraw` → `classifyDraw`, returning `"ok" | "blank" | "striped"`. The
  striped test counts full-width *pure*-black rows (the canvas is pre-filled
  white, so those can only come from the failed draw) and the number of
  black↔image switches down the image. Contiguous black bars — letterboxing, a
  dark border — give about two switches and stay `"ok"`; a banded frame gives
  many. Thresholds: ≥12% black rows **and** ≥6 switches (P19b guards this).
- **Recovery, not just detection.** On a bad first draw the photo is decoded a
  second time with `createImageBitmap(..., {resizeWidth|resizeHeight: 1024})`,
  which makes the *browser* downscale during decode — the bitmap handed back is
  already small and never needs the memory that failed. Only retried when the
  photo is larger than the cap, and only once. P20 fault-injects a banded first
  draw and confirms a clean 1024×683 image comes out the other side.

If the retry also fails, the error now names what happened ("black bands …
this device ran out of memory") instead of the old generic "came out blank".

**P17 — silent save failure.** `saveState()` caught a full-storage error and only
called `console.warn`. Nothing on screen changed, so the host kept playing with a
game that was **not being saved**; the next refresh restored the last state that
*did* save, which looks exactly like "my photos disappeared". Embedded photos are
by far the most likely reason storage fills, and mobile Safari caps localStorage
at ~5 MB.

Fixed by adding a persistent banner (`#save-warning`, painted by
`setGameSaveWarning` in `js/app.js`) that names the cause, says the game still
works, warns against refreshing, and points at Download JSON. The editor already
did this for its draft; the game state did not.

Note the app-global function is named `setGameSaveWarning`, **not**
`setSaveWarning` — `editor.js` already declares a global `setSaveWarning` and
loads after `app.js`, so the shorter name would have been silently overwritten.

## Not proven — manual gates

These need Cam's real hardware and real inputs; the harness cannot stand in.

- **The reported failure itself, on the machine that produced it.** P19/P20 are
  driven by *simulated* banding — a `drawImage` patched to rasterise in bands. That
  proves the detector and the recovery work; it does not prove they fire on the
  real photo, real device, and real browser that produced the black lines. **Top
  gate: re-add that exact photo on that exact device.** Expected outcomes are now
  (a) a clean picture, because the retry rescued it, or (b) a specific error naming
  black bands and memory. A third outcome — black lines again, no error — means the
  corruption happens somewhere the detector doesn't look, and the next thing to
  capture is the photo file itself plus the device/browser.
- **Real camera-roll photos generally.** The harness uses a generated 3000×2000
  JPEG. The device-specific modes are mobile-Safari canvas OOM on 12–48 MP photos
  and HEIC files browsers can't decode. Gate: embed ~5 real photos straight off the
  iPhone and confirm each previews, plays, and is neither black nor banded.
- **A real projector / TV.** P14 proves the controls are reachable by scrolling,
  not that a 55vh photo plus clue text reads well from across a room.
- **A real phone as a buzzer during a photo clue.** P12 proves no image data is in
  the payload; it does not prove the phone screen looks right at that moment.
- **Storage limits on a real device.** P17 fault-injects the error. The real
  threshold on iOS Safari (~5 MB, and the game state and the editor draft each
  hold their own full copy of every embedded photo) is untested.

## Triage: if a photo still doesn't show

Work down this list — each step maps to a success state above.

1. **Hard-refresh the page** (Ctrl+Shift+R). A cached older bundle is a real
   failure mode; it fooled this very harness until the cache-reload was added.
   If the editor shows no 📷 controls at all, this is what it is. This also
   applies after a fix ships: the browser will happily keep the old `app.js`.
2. **Black lines / bands instead of the picture (P19, P20).** The device ran out
   of memory processing that photo. The app now retries with a browser-side
   downscale, so re-adding the photo should just work; if it can't, it says so
   explicitly. Fallback: use a smaller copy (a screenshot of the photo is an easy
   way to get one) or paste an image URL.
3. **Look at the editor thumbnail (P4).** No thumbnail there means the reference
   is wrong, not the game. A pasted link must be the **image** URL, ending in
   `.jpg`/`.png` — a link to the *page* the picture sits on will pass validation
   and then fail to load.
4. **Look for "⚠ image failed to load" on the board (P11).** That is the image
   host refusing the request — common with hotlink-blocked search-result URLs.
   Fix: use Choose file… to embed it instead of linking it.
5. **Look for the gold "can't save your game" banner (P17).** If it is up, photos
   will vanish on the next refresh. Download JSON now, and switch big photos to
   pasted URLs.
6. **Check it's a Daily Double (P9)** — the photo is deliberately withheld until
   the wager is locked, and Final's photo until wagers are locked (P10).
