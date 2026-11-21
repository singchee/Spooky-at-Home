# Spooky at Home

A browser gunship game set over **your own neighbourhood**. Type an address, and the game downloads the streets and buildings from OpenStreetMap and builds a mission there. Circle overhead, switch between guns and camera sensors, and get the survivors home past the zombies.

**Status:** phase 0 (scaffold) done; phase 1 (playable slice) next.

| Document | What's in it |
|---|---|
| [`PLAN.md`](PLAN.md) | Design, architecture, phases, connectors, risks |
| [`docs/CREW.md`](docs/CREW.md) | The agent team: who checks what, and how work flows |
| [`docs/QUALITY.md`](docs/QUALITY.md) | Release gates, budgets, test hooks |
| [`docs/AUTONOMY.md`](docs/AUTONOMY.md) | What the crew decides alone and what comes to you |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Hosting on Vercel |
| [`CLAUDE.md`](CLAUDE.md) | Rules for Claude working in this repo |

```bash
npm install
npm run dev
```

Map data © OpenStreetMap contributors, available under the Open Database Licence.
