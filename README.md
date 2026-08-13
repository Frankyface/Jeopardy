# Jeopardy — for GitHub Pages

A customizable Jeopardy game that runs entirely in the browser. No build step, no
server, no dependencies — just push it to GitHub Pages and play. Questions and
answers live in a single JSON file you can edit.

## Features

- **JSON-driven** — edit [questions.json](questions.json) to make your own game
- **Built-in question editor** — build a board right in the page and download it
  as `questions.json`, no hand-editing required
- **Players & scoring** — add up to 8 players, award or deduct points per clue,
  click any score to fix it manually
- **Daily Doubles** — mark any clue with `"dailyDouble": true` for a wager round
- **Final Jeopardy** — optional final round with per-player wagers
- **Answer timers** — TV-style red-block countdowns (set the lengths on the
  start screen, or 0 to turn them off); purely a visual cue — you still judge
  with the buttons
- **Saves your game** — state is kept in `localStorage`, so a refresh won't lose
  scores or the board
- **Works offline too** — open `index.html` straight from disk and it falls back
  to the built-in sample game

## Deploy to GitHub Pages

1. Create a new repository on GitHub and push these files to it:

   ```bash
   git init
   git add .
   git commit -m "feat: jeopardy game"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```

2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`,
   pick the `main` branch and the `/ (root)` folder, then save.
4. After a minute, your game is live at
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

## Customizing the questions

### The easy way: the built-in editor

Click **Question Editor** (top right, or from the start screen). It opens
prefilled with whatever game is currently loaded. From there you can:

- rename the game and categories, edit clues, answers, and values
- add or remove categories (up to 8) and clues (up to 8 per category)
- tick **DD** on any clue to make it a Daily Double
- toggle Final Jeopardy on or off

Your draft auto-saves in the browser as you type, so it survives a refresh.
When you're done:

- **Download JSON** validates the draft and saves it as `questions.json` —
  commit it to the repo (replacing the existing file) to make it the default
  game for everyone.
- **Use in game** loads it into the current session immediately, no download
  needed.

### The manual way: edit the JSON

Edit `questions.json`. The shape is:

```json
{
  "title": "My Custom Game",
  "categories": [
    {
      "name": "Category Name",
      "clues": [
        { "value": 200, "clue": "The host reads this.", "answer": "What is the answer?" },
        { "value": 400, "clue": "Another clue.", "answer": "Another answer.", "dailyDouble": true }
      ]
    }
  ],
  "finalJeopardy": {
    "category": "Final Category",
    "clue": "The final clue.",
    "answer": "The final answer."
  }
}
```

Rules:

| Field | Required | Notes |
|-------|----------|-------|
| `title` | no | Shown on the start screen and header |
| `categories` | yes | 1–8 categories |
| `categories[].name` | yes | Column header |
| `categories[].clues` | yes | 1–8 clues per category (5 is classic) |
| `clues[].value` | yes | Positive number — point value of the tile |
| `clues[].clue` | yes | What the host reads aloud |
| `clues[].answer` | yes | Revealed when the host clicks "Reveal Answer" |
| `clues[].dailyDouble` | no | `true` turns the tile into a Daily Double |
| `clues[].image` | no | Photo question — shown above the clue text (see below) |
| `clues[].imageAlt` | no | Screen-reader description of the clue image |
| `clues[].answerImage` | no | Second image revealed with the answer |
| `finalJeopardy` | no | Omit it entirely to skip the final round |
| `finalJeopardy.image` | no | Image shown with the final clue (never during wagers) |

Categories don't need the same number of clues — uneven columns are fine.

### Photo questions

Any clue (and Final Jeopardy) can carry an image. Two ways to add one:

- **In the editor** — each clue has a 📷 control: paste an image URL, or
  **Choose file…** to embed a photo straight into the JSON (it's downscaled
  and compressed in your browser, so the downloaded `questions.json` is
  fully self-contained — no image hosting needed). An "embedded images"
  meter warns you before browser storage limits become a problem; prefer
  URL images for image-heavy boards.
- **In the JSON** — set `image` to an `https://` URL, a repo-relative path
  (e.g. `images/mystery.jpg` committed next to `index.html`), or a
  `data:image/...` URI.

Board tiles stay classic dollar amounts; the image appears when the clue
opens (for Daily Doubles, after the wager is locked). Buzzer phones don't
receive images — players look at the host screen. Note: images loaded from
external URLs reveal viewers' IP addresses to that host, as with any web
image; embedded or repo-hosted images don't.

**Troubleshooting embeds:** transparent PNGs are flattened onto a white
background (JPEG has no transparency). Very large phone photos or HEIC files
(iPhone's default) may not embed on every device — if you see an error, use a
smaller JPEG/PNG or paste an image URL. iPhone: set the camera to Settings →
Camera → Formats → **Most Compatible** to shoot JPEGs.

**If a photo comes out as black bands** instead of the picture, the device ran
out of memory processing it; the app now retries with a browser-side downscale,
so just add it again. If it still can't, it will say so and you can use a
smaller copy (a screenshot of the photo works) or paste an image URL.

**If a photo doesn't show up at all:** work down the triage list in
[docs/photo-clue-verification.md](docs/photo-clue-verification.md) — the usual
causes are a stale cached page (hard-refresh), a link to the *page* a picture
sits on rather than the image itself, a host that blocks hotlinking (embed the
file instead of linking it), or the gold "can't save your game" banner, which
means browser storage is full of embedded photos and a refresh would lose them.
That file also defines the 26 success states the feature is checked against;
run them from `tests/photo-harness.html` over a local server.

> **Tip:** after editing `questions.json`, also update `js/data.js` if you want
> the same questions when opening `index.html` directly from disk (it's the
> fallback used when the JSON can't be fetched). On GitHub Pages only
> `questions.json` matters.

### Loading questions without editing the repo

Two more ways to use custom questions:

- **Upload a file** — on the start screen, click *"Load custom questions
  (.json)"* and pick any JSON file from your computer.
- **Link to a URL** — append `?game=URL` to the page address to fetch questions
  from any JSON URL (it must allow cross-origin requests, e.g. a GitHub Gist
  raw URL): `https://you.github.io/repo/?game=https://gist.githubusercontent.com/...`

## How to host a game

1. Add players on the start screen and hit **Start Game**.
2. Click a dollar amount to open the clue. Read it out.
3. Click **Reveal Answer**, then mark each player ✓ (adds points, closes the
   clue) or ✗ (deducts points; other players can still answer).
4. **No one got it — close** ends the clue with no score change.
5. Daily Doubles ask who's answering and their wager before showing the clue.
6. When the board is cleared, the game offers **Final Jeopardy**: lock in
   per-player wagers, reveal the clue and answer, and judge each player.
7. **New Game** (top right) returns to the start screen with the same players,
   scores reset and a fresh board.

Scoring follows house rules, not TV rules — e.g. players at $0 or less can
still play Final Jeopardy (with a $0 wager).

### Answer timers

The start screen has two timer settings under **Timers** (saved with your
game; set either to **0 to turn it off**):

- **Answer timer** — a strip of red blocks, straight off the TV podium, counts
  down once someone is *on the spot*: the moment a phone player **wins the
  buzz** (buzzer rooms), or the moment a **Daily Double wager locks**. It does
  not run while you read the clue, and regular clues without a buzzer room
  aren't timed.
- **Final Jeopardy** — the same blocks under the Final clue while players
  write; wagering is never timed.

Blocks go dark in pairs from the outside in and the strip flashes at zero —
and that's all it does. **The timer never scores, closes, or locks anything**;
you still rule with ✓ / ✗ at your own pace, so a slow answer can still earn
the points if you allow it. Phones show a matching bar: the buzzed-in player
(and everyone watching them) during a clue, and every phone during Final
Jeopardy. A phone that reconnects mid-countdown picks up the remaining time,
not a fresh clock.

## Buzzer rooms (optional)

Turn phones into real buzzers. It's completely optional — if you never open a
room, the game behaves exactly as above and makes no network calls beyond
loading `questions.json`.

### How it works

- On the start screen, under **Players**, click **Open buzzer room**. You get a
  big 4-letter **room code** and a join link.
- Each player opens the **same site URL on their phone** and taps
  **Join a buzzer room** (under Players on the start screen), then types the
  4-letter code — or uses the direct `?room=CODE` join link, which prefills
  it. They enter their name and get a full-screen buzzer button. Their name
  links to a scoreboard player (a new one is added automatically if the name
  is new).
- The moment you open a regular clue, every phone's buzzer turns **red**
  ("Wait for it…") — and it's live, just like the show: **tapping while it's
  red locks that player out of the clue** ("Too soon!"), and the buzz bar
  shows you who jumped the gun. Finish reading, then click **Arm buzzers** —
  or just press the **Spacebar** (it toggles arm/disarm, no mouse hunt) —
  and the surviving buzzers flip **green** ("BUZZ!").
- The first green-light tap wins; you see their name with ✓ / ✗ buttons right
  there (same scoring as usual). ✗ locks that player out and re-arms the
  rest; ✓ closes the clue. Early and wrong-answer lockouts both clear on the
  next clue. Daily Doubles and Final Jeopardy never show a buzz bar (no trap
  there), and Space only does anything while that bar is live.
- On the board screen a small `CODE · n 🔔` chip in the top bar toggles the room
  panel (join link, connected players, kick, close). **New Game** keeps the room
  open. If you refresh, the room auto-reopens with the same code so phones
  reconnect on their own.

### What you need to know

- **Needs internet.** Signaling uses the free public **PeerJS** cloud broker
  (pinned build `peerjs@1.5.5` from cdnjs, loaded lazily only when you first
  open a room or a phone visits `?room=`). After that, phone ↔ host traffic is
  peer-to-peer WebRTC. **No game data ever touches any server** — only the
  room-code handshake goes through the broker.
- `?room=CODE` takes precedence over `?game=URL`: a page opened with `?room=` is
  always the player buzzer, never the host game.
- **Troubleshooting:** strict corporate/school networks sometimes block WebRTC —
  buzzers won't connect there. If the room code collides on open, the app
  regenerates and retries automatically. Offline? The feature is simply
  unavailable; the game itself is unaffected.
- **Early buzzes are host-judged by arrival**: a tap that reaches the host
  while the buzzer is still red locks that player out of the clue; a tap that
  arrives after you arm counts, even if their screen hadn't flipped green yet
  (network skew forgives knife-edge timing). There's no timed penalty window
  like the TV show's — going early costs you the whole clue.

### Phone wagers & answers (Daily Double + Final Jeopardy)

Connected phones double as contestant podiums. **Mixed mode is fully
supported** — any player without a connected phone keeps the normal
host-driven flow, and the host can always override a phone player (handy if a
battery dies mid-Final).

- **Daily Double.** When you open a Daily Double and the player picked in the
  "Who's answering?" dropdown has a connected phone, that phone shows a wager
  pad (with the legal range) and the splash notes they're wagering on their
  phone. Their submitted wager locks the Daily Double exactly as a typed wager
  would; an out-of-range wager is bounced back to the phone with the reason.
  Changing the dropdown re-prompts the newly selected player. The manual wager
  box stays usable the whole time — typing and locking it yourself wins.
- **Secret Final wagers.** Every connected player wagers on their own phone.
  Their wager arrives pre-filled on the host's wager list but **masked**
  (shown as dots, `🔒 from phone`) so nothing leaks on a projector — a genuine
  secret wager, unlike the manual boxes. An **Unlock** button hands the input
  back to you for a manual override. Players without phones use the normal
  editable boxes.
- **Typed Final answers.** After you lock the wagers, phones show the Final
  clue and a text box. Answers land in the host's judge rows verbatim, in
  quotes, for **you to read and rule on with the usual ✓ / ✗** — the app never
  auto-checks an answer, never auto-scores, and never advances on its own; you
  drive the pace. An "Answers in: n/m" line just tells you how many are in.
  Players may edit and resubmit until you reveal. As you rule each verdict,
  that player's phone shows their result and new score.
- **Final Jeopardy is one-shot.** Once you have judged Final, it can't be
  replayed — the Final Jeopardy button and end-of-board banner route to the
  standings instead, so wagers are never applied to scores twice. (Backing out
  of Final *before* judging anything is still fine and re-prompts phones.)

## Project layout

```
index.html               page structure
css/styles.css           all styling
css/buzzer.css           buzzer host panel + player phone screen styles
css/timer.css            answer-timer red blocks + settings styles
js/app.js                game logic (vanilla JS, no dependencies)
js/editor.js             in-page question editor
js/data.js               built-in sample game (offline fallback)
js/timer-core.js         pure countdown math (block stages, settings bounds)
js/timer.js              answer-timer bars (host modals + phone screens)
js/buzzer-protocol.js    pure buzzer core (room codes, validation, reducers)
js/buzzer-host.js        host side: PeerJS load, room lifecycle, buzzer UI
js/buzzer-wagers.js      host side: phone Daily-Double + Final wagers & answers
js/buzzer-player.js      player side: phone join, buzzer, wager & answer screens
questions.json           the questions GitHub Pages serves — edit this one
tests/                   node:test unit tests + in-browser harnesses (buzzer, photo clues)
```

The buzzer feature loads PeerJS lazily from a pinned, SRI-verified cdnjs URL
(`peerjs@1.5.5`) only when a room is opened or a phone joins — the core game
never requests it.
