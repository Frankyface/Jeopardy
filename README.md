# Jeopardy — for GitHub Pages

A customizable Jeopardy game that runs entirely in the browser. No build step, no
server, no dependencies — just push it to GitHub Pages and play. Questions and
answers live in a single JSON file you can edit.

## Features

- **JSON-driven** — edit [questions.json](questions.json) to make your own game
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

## Project layout

```
index.html        page structure
css/styles.css    all styling
js/app.js         game logic (vanilla JS, no dependencies)
js/data.js        built-in sample game (offline fallback)
questions.json    the questions GitHub Pages serves — edit this one
```
