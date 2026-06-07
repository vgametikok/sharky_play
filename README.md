# Sharky

TikTok-style feed of HTML mini-games. Built as a Telegram Mini App.

## Structure

```
sharky/
├── index.html          — App shell (UI, navigation, social)
├── .nojekyll           — Disables Jekyll on GitHub Pages
├── README.md
└── games/
    ├── manifest.json   — Game list (loaded at runtime)
    ├── tap.html
    ├── reaction.html
    ├── avoid.html
    ├── memory.html
    ├── guess.html
    ├── snake.html
    ├── stroop.html
    ├── simon.html
    ├── mathblitz.html
    ├── mole.html
    ├── flappy.html
    └── code.html
```

## Deploy to GitHub Pages

1. Create a new GitHub repository (e.g. `sharky`)
2. Upload **all files** keeping the folder structure intact
3. Go to **Settings → Pages**
4. Set Source: `Deploy from a branch`, Branch: `main`, Folder: `/ (root)`
5. Save — your URL will be `https://YOUR-USERNAME.github.io/sharky/`

## Connect to Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newapp` (or `/editapp` for existing bot)
3. Follow prompts, paste your GitHub Pages URL when asked for Web App URL
4. Alternatively: `/setmenubutton` → select your bot → paste URL

The app uses `Telegram.WebApp.expand()` to fill the screen and
`disableVerticalSwipes()` to prevent conflicts with the game swipe mechanic.

## How game loading works

- On launch, `index.html` fetches `games/manifest.json`
- Games are shuffled and the deck is built
- Each game runs in an isolated `<iframe>`
- **Pre-loading window:** current game + 2 ahead + 1 behind
- Communication via `postMessage`:
  - Shell → Game: `{ type: 'init' | 'start' | 'pause' }`
  - Game → Shell: `{ type: 'score' | 'gameover' | 'next' | 'ready' }`

## Add a new game

1. Create `games/YOUR-GAME.html` (see any existing game as template)
2. Add an entry to `games/manifest.json`:

```json
{
  "id": "your-game",
  "author": "sharky",
  "title": "Название",
  "accent": "#ff3c5f",
  "bg": "#0d080f",
  "scoreLabel": "очков",
  "emoji": "🎮",
  "plays": "0",
  "src": "games/your-game.html"
}
```

3. Push to GitHub — the new game appears in the feed automatically.

## Game file template

```html
<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
  :root { --ac: #ff3c5f; }
  body { width:100vw; height:100vh; overflow:hidden; background:#060608;
         font-family:system-ui,sans-serif; touch-action:none; }
  /* your styles */
</style></head><body>
<!-- your game HTML -->
<script>
// Receive from shell
window.addEventListener('message', e => {
  if (e.data.type === 'init') {
    document.documentElement.style.setProperty('--ac', e.data.accent);
  }
  if (e.data.type === 'start') start();
  if (e.data.type === 'pause') pause();
});

// Tell shell we're ready (shell sends 'start' in response)
window.addEventListener('load', () => {
  parent.postMessage({ type: 'ready' }, '*');
  setTimeout(start, 100); // fallback for standalone testing
});

// Send score update
function sendScore(n) { parent.postMessage({ type: 'score', value: n }, '*'); }

// On game over — show your own overlay, then optionally:
function sendGameOver(n) { parent.postMessage({ type: 'gameover', value: n }, '*'); }

// "Next game" button should call:
function goNext() { parent.postMessage({ type: 'next' }, '*'); }

function start() { /* your game logic */ }
function pause() { /* stop loops, timers */ }
</script></body></html>
```
