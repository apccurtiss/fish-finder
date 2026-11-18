# Fish finder

A real-time multiplayer sonar fishing game. No login: pick a captain name and set sail.

- **Steer**: WASD / arrow keys, or hold the mouse or a finger on the water
- **Ping** (`E`): sends a sonar pulse that reveals the fish around you. Other captains see your ring, and they get a faint look at what you found.
- **Cast** (`Space` / right-click): drops your net just ahead of the bow

Sardines (+1), mackerel (+3), and bluefin tuna (+8) swim in schools that scatter when boats get close. A rare Goldfin (+30) surfaces now and then, and jellyfish cost you 5 each. Rounds last 3 minutes and take place on a freshly generated seabed. Bots fill the water whenever fewer than 4 humans are playing.

## Stack
- `server.js`: Node HTTP + WebSocket (`ws`) server running an authoritative 30 Hz simulation that sends 15 Hz snapshots
- `db.js`: Postgres (`pg`) storing round scores and all-time species totals. It falls back to memory when `DATABASE_URL` is unset.
- `public/`: dependency-free canvas client (Chrome, Firefox, Safari, Edge; desktop and touch)

## Run locally
```
npm install
npm start          # http://localhost:3000
```
Optional env: `DATABASE_URL`, `PGSSL=true` (for external DB URLs), `ROUND_SECONDS`, `MIN_BOATS`.

## Deploy on Render
Push this repo to GitHub/GitLab. In Render, go to **New > Blueprint** and select the repo. `render.yaml` creates:
- `fish-finder`: web service (Node, health check `/healthz`)
- `fish-finder-db`: Postgres database, wired in through `DATABASE_URL` (tables are created on boot)
