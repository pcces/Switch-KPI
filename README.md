# Switch KPI

Switch KPI is a live production analytics dashboard for Blackmagic Design ATEM
switchers. It watches M/E 1 and M/E 2, records how sources and transitions are
used, and turns a show into a live dashboard and post-show report.

## What it tracks

- Program source airtime and usage counts
- Cuts, mixes, wipes, transition rates, and recent takes
- M/E 1 and M/E 2 activity
- Per-show start, pause, resume, and stop controls
- Mid-show and final reports with charts and award history
- Operator achievements, bingo levels, sequence awards, and diversity windows
- A separate full-screen display designed for a 16:9 screen

Black is retained as operational data but excluded from competitive airtime
rankings.

## Requirements

- Node.js 22.13 or newer
- An ATEM switcher reachable from the computer running Switch KPI
- Network access to UDP port 9910 on the ATEM

## Run locally

```bash
npm install
npm run dev
```

Open the dashboard at `http://localhost:3000`. The report server uses port 3001,
the shading view uses port 3002, and the LAN gateway uses port 8080.

Set the ATEM IP address from the dashboard before starting a show. The dashboard
is exposed on the host computer's LAN interfaces so other devices on the same
network can open it using the host computer's IP address.

## Commands

- `npm run dev` — start the monitor and all dashboard services
- `npm run build` — create a production build
- `npm test` — build and run the rendered-page checks
- `npm run lint` — run ESLint
- `npm run package:mac` — build an Apple Silicon DMG
- `npm run package:win` — build a Windows x64 ZIP
- `npm run package:desktop` — build both desktop packages

## Show data and privacy

Runtime data is written beneath `data/` and generated reports beneath `output/`.
Those folders are intentionally excluded from Git because they can contain show
timings, source names, switcher addresses, and production history. Back up these
folders separately if the records need to be retained.

The repository also excludes installers, compiled output, temporary files, and
local environment files.

## Desktop builds

The Electron wrapper starts the same monitor and dashboard services locally.
macOS packages are currently built for Apple Silicon. Production distribution
may require platform signing and notarisation.

## Technology

Switch KPI uses React, vinext/Vite, Electron, `atem-connection`, and PDFKit.

## Status

This is an early public release. Test it on a non-critical network before using
it during a production, and keep the ATEM control network appropriately isolated.
