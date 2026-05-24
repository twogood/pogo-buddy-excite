# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

No build step. Serve `public/` with any static file server:

```bash
python3 -m http.server 8080 --directory public
# or
npx serve public
```

Open `http://localhost:8080`. The service worker only activates over HTTPS or `localhost`.

## Deployment

Push to `main` → `deploy-production.yml` deploys to Bunny Storage zone `pogo-buddy-excite` → live at `https://excite.2good.nu`.

PRs get a preview deploy at `https://pogo-buddy-excite-pr-{N}.b-cdn.net` (comment posted automatically by `deploy-preview.yml`). `deploy-cleanup.yml` deletes preview zones when a PR closes.

Required secret: `BUNNY_API_KEY` (account-level Bunny API key).

When adding new files to `public/`, also add them to `ASSETS` in `public/service-worker.js` and bump `CACHE_NAME` (e.g. `buddy-excite-v3`) to invalidate cached versions.

## Architecture

Everything runs in the browser. No framework, no build tool, no dependencies.

**`public/assets/app.js`** is the entire application — one file, plain JS, `'use strict'`. Key sections:

- `INTERACTION_TYPES` — defines the 9 loggable actions with their EP value and cooldown. Walk and route have `cooldownMin: 0` (distance/event-based, not time-based); all others use 30 min.
- `EP_LEVELS` — mood thresholds: Tired (0), Dull (1), Normal (2), Happy (4), Smile (8), Fun (16), Excited (32). Sprite index `null` = no image shown (Tired/Dull); indices 0–4 map left-to-right in `buddy-moods.webp`.
- `RULES` — `excitedThreshold: 32`, decay of 1 EP per 30 min of inactivity.
- `recalculate(now)` — pure function that replays `state.interactions` to compute current EP, respecting per-type cooldowns and applying decay. Mutates `counted`/`pointsAwarded` on interaction objects in place.
- `logInteraction(type)` — appends to `state.interactions`, saves to localStorage, then calls `recalculateAndRender()` and `scheduleNotifications()`.
- `render()` — full re-render on every state change; no virtual DOM or diffing.
- `scheduleNotifications()` — clears all pending `setTimeout`s and reschedules one notification at the earliest upcoming cooldown expiry.

**State** is a single JSON object in `localStorage` under key `buddy-excite`:

```js
{ version, mode, sessionStartedAt, excitedStartedAt, interactions[], settings }
```

Two modes: `'building'` and `'maintaining'`. The app never auto-transitions — the user must press "Buddy is excited now" to enter maintaining mode.

**`public/assets/buddy-moods.webp`** — 600×135px spritesheet, 5 sprites at 120×135 each. Rendered via `background-size: 500% auto` + `background-position` percentages in CSS class `.mood-sprite.sprite-{0-4}`.

**`public/index.html`** — static shell with all DOM IDs used by `app.js`. No content is in the HTML; everything is rendered by JS.

**`public/service-worker.js`** — cache-first strategy for offline support.

## `.gitignore`

`*.md` is gitignored. Requirements and reference docs live in the working directory but are never committed.
