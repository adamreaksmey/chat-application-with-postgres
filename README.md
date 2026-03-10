## Postgres-native chat app

This project is a **horizontally scalable chat application** that deliberately avoids the usual “distributed systems zoo” (Kafka, Redis, separate message buses, bespoke pub/sub layers).

Instead, it uses:

- **A single NestJS monolith** as the application runtime.
- **PostgreSQL** as both:
  - The primary source of truth for all state (`users`, `rooms`, `messages`, `presence`, `typing`).
  - The **real-time message bus** via `LISTEN/NOTIFY`.
- **Raw WebSockets** (`ws` library) for client connections, with JSON-framed events.

The goal is to **show that you can build a high-performance, multi-node chat system without microservices or exotic infrastructure**, as long as you:

- Design your schema and triggers carefully.
- Treat Postgres as a first-class event system.
- Are disciplined about concurrency, backpressure, and failure modes.

High-level features:

- JWT-based auth and session management.
- Room CRUD and membership.
- Real-time messaging, presence, and typing indicators.
- Per-room monotonic `seq` for gapless history (clients use `last_seen_seq`).
- Multiple identical app instances behind Nginx with sticky WebSocket routing.
- k6 load testing to push the system under realistic chat workloads.

For the full architecture and rationale, see `plan/BLUEPRINT.md` and `plan/IMPLEMENTATION_PLAN.md`.

## Local development

- **Install dependencies**

```bash
npm install
```

- **Run the app (local Postgres already running on `DATABASE_URL`)**

```bash
# development
npm run start

# watch mode
npm run start:dev

# production mode
npm run start:prod
```

You will need a `.env` (or environment variables) that matches `.env.example` (at minimum: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`).

## Docker

Run Postgres + 3 app nodes + Nginx:

```bash
# Build and start
docker compose up -d --build

# Run DB migrations once (any app container)
docker compose run --rm app-1 node scripts/migrate.js

# Traffic: http://localhost (Nginx), WebSocket ws://localhost/ws (sticky via ip_hash)
# Health: http://localhost/health
```

Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in the environment or `.env` for production.

## Load testing with k6

This repo includes a basic [Grafana k6](https://k6.io/) script for stressing the WebSocket chat path.

- Script: `loadtest/k6-chat-ws.js`
- Assumptions:
  - You already have a test user and a `ROOM_ID` created.
  - You have a valid JWT access token for that user.
  - The WebSocket endpoint is reachable at `ws://localhost/ws` (via Nginx from the Docker setup above).

Run k6 via Docker:

```bash
# From the project root, with the Docker stack running

export ACCESS_TOKEN="YOUR_JWT_ACCESS_TOKEN"
export ROOM_ID="YOUR_ROOM_UUID"

docker run --rm --network host \
  -v "$(pwd)/loadtest:/scripts" \
  -e WS_URL=ws://localhost/ws \
  -e ACCESS_TOKEN="$ACCESS_TOKEN" \
  -e ROOM_ID="$ROOM_ID" \
  -e VUS=200 \
  -e DURATION=2m \
  -e MESSAGES_PER_VU=20 \
  -e MESSAGE_INTERVAL_MS=200 \
  grafana/k6 run /scripts/k6-chat-ws.js
```

This will open many WebSocket connections in parallel, have each virtual user join the same room, and send a configurable number of messages per user at a steady rate.
