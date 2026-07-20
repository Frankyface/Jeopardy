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
| `finalJeopardy` | no | Omit it entirely to skip the final round |

Categories don't need the same number of clues — uneven columns are fine.

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

## Buzzer rooms (optional)

Turn phones into real buzzers. It's completely optional — if you never open a
room, the game behaves exactly as above and makes no network calls beyond
loading `questions.json`.

### How it works

- On the start screen, under **Players**, click **Open buzzer room**. You get a
  big 4-letter **room code** and a join link.
- Each player opens the **same site URL on their phone** and appends
  `?room=CODE` (or just types the code on the join screen), enters their name,
  and gets a full-screen buzzer button. Their name links to a scoreboard player
  (a new one is added automatically if the name is new).
- During a regular clue, finish reading, then click **Arm buzzers** — or just
  press the **Spacebar** (it toggles arm/disarm the instant you finish reading,
  no mouse hunt). The first player to tap wins; you see their name with ✓ / ✗
  buttons right there (same scoring as usual). ✗ locks that player out and
  re-arms the rest; ✓ closes the clue. Daily Doubles and Final Jeopardy never
  show a buzz bar, and Space only does anything while that bar is live.
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
- Not built (yet): early-buzz penalty timing windows are a possible future
  addition; today a player can only buzz once the host arms.

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
js/app.js                game logic (vanilla JS, no dependencies)
js/editor.js             in-page question editor
js/data.js               built-in sample game (offline fallback)
js/buzzer-protocol.js    pure buzzer core (room codes, validation, reducers)
js/buzzer-host.js        host side: PeerJS load, room lifecycle, buzzer UI
js/buzzer-wagers.js      host side: phone Daily-Double + Final wagers & answers
js/buzzer-player.js      player side: phone join, buzzer, wager & answer screens
questions.json           the questions GitHub Pages serves — edit this one
tests/                   node:test unit tests + in-browser loopback harness
```

The buzzer feature loads PeerJS lazily from a pinned, SRI-verified cdnjs URL
(`peerjs@1.5.5`) only when a room is opened or a phone joins — the core game
never requests it.
