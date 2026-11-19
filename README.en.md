# Token Calendar

**English** | [日本語](README.md)

**📖 User guide: https://alonecraft.github.io/TokenCalender/en/**

A desktop app that totals your **Claude Code** and **OpenAI Codex** token usage from local logs and shows it in a calendar and charts.
It checks the totals against the official usage-window percentages and estimates the **effective capacity** of your weekly limit: how many tokens (or how many dollars at API prices) a weekly window amounts to for the way you actually work.

## Download

**[Get the latest version (Releases)](https://github.com/AloneCraft/TokenCalender/releases/latest)**: Windows installer `Token-Calendar-Setup-x.y.z.exe`

1. Download `Token-Calendar-Setup-x.y.z.exe` from "Assets" on the Releases page and run it.
2. Choose an install location and continue (no administrator rights needed).
3. If Windows shows "Windows protected your PC", choose "More info" → "Run anyway". The app is not code-signed.

No separate installation of Node.js or anything else is required. macOS and Linux builds are not distributed because they are unverified.

Licensed under MIT ([LICENSE.txt](LICENSE.txt)).

## Four kinds of numbers, kept apart

| Kind | Meaning |
| --- | --- |
| Logged usage | Token counts recorded in logs on your machine (normalized, duplicates removed) |
| API cost equivalent | What the same tokens would cost at API prices. A reference value, not an actual bill |
| Official usage rate | The usage-window percentage at the time it was captured, from Codex logs, the Claude status line, or manual entries |
| Estimate | Effective capacity, supplementary estimates and forecasts computed from the three above. Not an official limit |

## Features

- **Usage-window dashboard** (the first screen): official remaining amount, time until reset, how much you can still use today (a per-day budget), the expected remainder at reset and the chance the window lasts, how many more requests fit at the current model and effort, the window most likely to stop your work next, suggestions with their grounds, and a simulator for trying different usage patterns.
- **Consumption by model**: for a chosen period, estimates how much of the official window each model × effort combination uses (per request, per million tokens, per session, with ranges). API prices are not used.
- **Display language** follows the OS language (Japanese, English, Korean, Simplified/Traditional Chinese, Spanish, Portuguese (Brazil), French, German, Russian, Ukrainian; English otherwise) and can be switched from a selector with flags. To add a language, see [docs/i18n.md](docs/i18n.md) (Japanese).
- **Monthly calendar**: one vertical bar per day. Daily usage, or cumulative usage within the reset cycle (light = total up to the previous day, dark = that day).
- **Timeline page**: N-day buckets over the past M days, 5-hour buckets over the past M windows, or calendar weeks. The upper chart shows usage per interval; the lower chart shows cumulative usage that returns to 0 at each reset. With N-day buckets every date is shown, each cycle (reset to reset) is drawn as a band, and the small number under each date is the day within the cycle. A cycle shortened by a reset that came earlier than scheduled is drawn as a red band.
- **Recent usage**: current turn, session total, breakdown, and state (running / partial / recorded / waiting for update).
- **Usage windows and estimates**: official usage rate (with capture time), effective-capacity estimate (range, and why data was included or excluded), remaining amount and pace.
- **Analysis**: pick from a registry of charts (`src/renderer/charts/registry.ts`), such as weekday × hour-of-day and cache ratio.
- Data-source status, adding folders, WSL detection, account linking, billing-type settings.
- Manual entries (usage rate and reset time read from the official screen), CSV/JSON export, importing exports from other machines, data deletion, and a demo mode.

## Assumptions and privacy

- No separate Node.js installation is needed for users (Electron bundles Node and SQLite).
- Logs are never sent anywhere. The app makes no network requests. Original logs are only read.
- Claude Code's settings (statusLine) are changed only after you consent both on screen and in a confirmation dialog.

## Run (Windows)

Double-click `run.bat`. On first run it installs dependencies, fetches Electron, builds, and starts the app.
`run.bat dev` starts development mode (UI changes are reflected immediately). Node.js 22.15 or later is required.

## Development

Requires Node.js 22.15 or later (development only).

```bash
npm ci
```

```bash
node node_modules/electron/install.js
```

npm 11 and later do not run install scripts automatically, so fetch the Electron binary with the command above.

```bash
npm run dev
```

To start with a different data location (the default is the OS user-data folder):

```bash
TOKEN_CALENDAR_DATA_DIR=D:/CodexTemp/TokenCalendar/dev-data npm run dev
```

## Verification

Run checks from the one closest to your change outward.

| Stage | Command | Pass condition |
| --- | --- | --- |
| Types (also catches missing translations) | `npm run typecheck` | No errors |
| Static analysis | `npm run lint` | No errors |
| Unit tests | `npm run test` | All pass |
| End-to-end UI | `npm run e2e` | All pass. Reads only test logs (`TOKEN_CALENDAR_HOME`) |

More checks (real-log ingestion, independent verification of Codex totals, query timing, consistency between calendar / timeline / raw events, packaged-app startup) are listed in the Japanese [README.md](README.md) and [docs/verification.md](docs/verification.md).

## Build the installer

```bash
npm run dist:win
```

This produces a Windows x64 installer in `release/`. macOS (`dist:mac`) and Linux (`dist:linux`) settings exist but are unverified ([docs/support-matrix.md](docs/support-matrix.md)).

Third-party license notices can be regenerated with `node scripts/gen-notices.cjs` ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## Documents (Japanese)

- [docs/research.md](docs/research.md): references, adopted versions, dates checked
- [docs/data-formats.md](docs/data-formats.md): supported log formats and how they are read, DB tables
- [docs/estimation.md](docs/estimation.md): how estimation works and its limits
- [docs/support-matrix.md](docs/support-matrix.md): supported OSes and data sources
- [docs/verification.md](docs/verification.md): test and performance results, what was and was not confirmed

## Layout

```
src/core/      Electron-independent logic (normalization, aggregation, pricing, estimation, time)
src/db/        SQLite tables and reads/writes
src/ingest/    discovery, incremental reads, watching (separate thread)
src/query/     queries from the UI (separate thread)
src/main/      Electron main, preload, status-line integration
src/renderer/  UI (React + ECharts)
tests/         unit tests, end-to-end tests, test-log builders
scripts/       development scripts for ingestion, verification and notice generation
```
