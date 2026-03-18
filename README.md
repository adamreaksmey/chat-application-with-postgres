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
- Multiple identical app instances behind Nginx.
- k6 load testing to push the system under realistic chat workloads.

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

Run Postgres + 5 app nodes + Nginx:

```bash
# Build and start
docker compose up -d --build

# Run DB migrations once (recommended if you change migrations)
docker compose run --rm app-1 node scripts/migrate.js

# Traffic: http://localhost (Nginx), WebSocket ws://localhost/ws
# Health: http://localhost/health
```

Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in the environment or `.env` for production.

## Load testing with k6

The script `loadtest/k6-chat-ws.js` stresses the WebSocket chat path (senders, receivers, churn, reconnect, typing). A **message-delivery–focused** test is in `loadtest/k6-message-delivery.js`: only senders and receivers, tuned for delivery success rate and latency (`npm run loadtest:delivery`). Both run inside Docker and need a running app plus at least one **JWT access token** and one **room id** that the token’s user is a member of.

Notes:

- Server message fanout batches room messages into ~20ms windows and sends `new_message_batch` frames (array of messages) to reduce per-message overhead. Clients/tests should handle both `new_message` and `new_message_batch`.

### What you need before running

1. **App and API reachable**  
   Start the stack (e.g. `docker compose up -d`) or run the app locally. The script will connect to `WS_URL` (default `ws://localhost/ws`) and, for the npm script, expects the app on the host (e.g. Nginx on port 80 or the dev server on 3000).

2. **At least one JWT access token**  
   From a user that exists in the app (register or login).

   - **Register:**  
     `POST /auth/register` with JSON body:  
     `{ "username": "loadtest", "email": "loadtest@example.com", "password": "yourpassword" }`  
     Response includes `tokens.accessToken` — that’s your access token.
   - **Login:**  
     `POST /auth/login` with JSON body:  
     `{ "email": "loadtest@example.com", "password": "yourpassword" }`  
     Response includes `tokens.accessToken`.

3. **At least one room id**  
   The user above must be a **member** of the room (create and/or join via the API).

   - **Create a room (requires auth):**  
     `POST /rooms` with header `Authorization: Bearer YOUR_ACCESS_TOKEN` and body:  
     `{ "name": "Load test room", "description": "optional" }`  
     Response includes `id` — that’s the room id.
   - **Join an existing room:**  
     `POST /rooms/:id/join` with header `Authorization: Bearer YOUR_ACCESS_TOKEN`  
     Use the room `id` from `GET /rooms` (with the same auth) if you didn’t create it.

### Quick setup (curl)

With the app running (e.g. at `http://localhost` or `http://localhost:3000`):

```bash
# 1. Register and get token (save accessToken from the response)
curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"loadtest","email":"loadtest@example.com","password":"password123"}' | jq -r '.tokens.accessToken'

# 2. Create a room (use the token from step 1)
curl -s -X POST http://localhost:3000/rooms \
  -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"name":"Load test room"}' | jq -r '.id'

# If using an existing room, join it first (creator is already a member):
# curl -X POST http://localhost:3000/rooms/ROOM_ID/join -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# 3. Run load test (user must be room member or join_room returns error and no messages are sent)
export ACCESS_TOKEN="paste_access_token_here"
export ROOM_ID="paste_room_id_here"
npm run loadtest
```

If the app is behind Nginx on port 80, use `http://localhost` instead of `http://localhost:3000`. Without `jq`, read `accessToken` and `id` from the JSON response by hand.

### Environment variables the script uses

| Variable | Required | Description |
|----------|----------|-------------|
| `ACCESS_TOKEN` or `TOKENS` | Yes (one of them) | JWT access token. `TOKENS` = comma-separated list for multiple users. |
| `ROOM_ID` or `ROOM_IDS` | Yes (one of them) | Room UUID. `ROOM_IDS` = comma-separated list to spread load. |
| `WS_URL` | No | WebSocket URL (default: `ws://localhost/ws`). Use quotes: `"ws://localhost/ws"`. |
| `NODE_URLS` | No | Comma-separated WebSocket URLs for multi-node; default is `WS_URL`. |
| `MESSAGES_PER_VU` | No | Messages per sender VU (default: 20). |
| `MESSAGE_INTERVAL_MS` | No | Delay between sends in ms (default: 100). |

Scenarios (senders, receivers, churn, reconnect, typing) and thresholds are defined inside the script; you only need to supply token(s) and room(s).

### Run with npm (single token, single room)

From the project root:

```bash
export ACCESS_TOKEN="YOUR_JWT_ACCESS_TOKEN"
export ROOM_ID="YOUR_ROOM_UUID"

npm run loadtest
```

This uses `WS_URL=ws://localhost/ws` by default and passes your token and room into the k6 container.

### Run with Docker directly (same single token/room)

```bash
docker run --rm --network host \
  -v "$(pwd)/loadtest:/scripts" \
  -e "WS_URL=ws://localhost/ws" \
  -e "ACCESS_TOKEN=YOUR_JWT_ACCESS_TOKEN" \
  -e "ROOM_ID=YOUR_ROOM_UUID" \
  grafana/k6 run /scripts/k6-chat-ws.js
```

### Run with multiple tokens or rooms

Use comma-separated lists; the script picks at random per VU:

```bash
export TOKENS="token1,token2,token3"
export ROOM_IDS="room-uuid-1,room-uuid-2"
docker run --rm --network host \
  -v "$(pwd)/loadtest:/scripts" \
  -e "WS_URL=ws://localhost/ws" \
  -e "TOKENS=$TOKENS" \
  -e "ROOM_IDS=$ROOM_IDS" \
  grafana/k6 run /scripts/k6-chat-ws.js
```

After the run, see `loadtest/POST-RUN-CHECKLIST.md` for what to verify. If the run stops abruptly with no summary (e.g. OOM), check that doc and `loadtest/summary.txt` (written when k6 exits normally).
