/**
 * Load test for message delivery: senders send and verify messages, receivers count them.
 * No churn, typing, or reconnects. Users must be members of the room.
 *
 * Run with: ACCESS_TOKEN=... ROOM_ID=... npm run loadtest:delivery
 * Or via Docker using grafana/k6.
 */

import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import encoding from 'k6/encoding';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// ── metrics ───────────────────────────────────────────────────────
const msgDelivered = new Counter('messages_delivered');
const msgSent = new Counter('messages_sent');
const deliveryRate = new Rate('delivery_success_rate');
const deliveryLatency = new Trend('delivery_latency_ms', true);
const payloadValidRate = new Rate('payload_valid_rate');
const seqDuplicateCount = new Counter('seq_duplicates');
const seqOutOfOrderCount = new Counter('seq_out_of_order');

// ── options ───────────────────────────────────────────────────────
const SENDER_VUS = Number(__ENV.SENDER_VUS || 120);
const RECEIVER_VUS = Number(__ENV.RECEIVER_VUS || 300);

// Receivers start after senders have fully ramped up (15s ramp + small buffer).
// This prevents early delivery numbers being skewed by receivers that haven't
// connected yet when the first wave of senders starts firing.
const RECEIVER_START_DELAY = '20s';

export const options = {
  scenarios: {
    senders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: SENDER_VUS },
        { duration: '2m30s', target: SENDER_VUS },
        { duration: '15s', target: 0 },
      ],
      env: { SCENARIO: 'sender' },
    },
    receivers: {
      executor: 'constant-vus',
      vus: RECEIVER_VUS,
      duration: '3m',
      env: { SCENARIO: 'receiver' },
      startTime: RECEIVER_START_DELAY,
    },
  },

  thresholds: {
    delivery_success_rate: ['rate>0.98'],
    delivery_latency_ms: ['p(95)<800'],
    ws_connecting: ['p(95)<3000'],
    ws_msgs_received: ['count>5000'],
    payload_valid_rate: ['rate>0.99'],
    seq_duplicates: ['count==0'],
    seq_out_of_order: ['count==0'],
  },
};

// ── env ───────────────────────────────────────────────────────────
const fixedUserTokens = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMTljZmJhMS1lMTAyLTc5NDgtYTZlYi1mMjBlZWFlY2IzYmIiLCJ1c2VybmFtZSI6InRlc3RpbmdwZXJzb24xIiwiaWF0IjoxNzczNzQ4MjE2LCJleHAiOjE3NzQzNTMwMTZ9.JZ8fsjfe67z9JFa6I8AIeZ5iO50-oxS8g4P6vyWZTCY',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMTljZmJhMi02YzlhLTdmMGItOWRhMS1iM2VhZjA3YmNlMWMiLCJ1c2VybmFtZSI6InRlc3RpbmdwZXJzb24yIiwiaWF0IjoxNzczNzQ4MjUxLCJleHAiOjE3NzQzNTMwNTF9.ud_zIa3KjFmxH77P8Hyx_z7dGDptw1ZAYPHSaa-EG84',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMTljZmJhMi1iMWNhLTc4OTQtOTA2My1mN2ZhMWUwMTViNGMiLCJ1c2VybmFtZSI6InRlc3RpbmdwZXJzb24zIiwiaWF0IjoxNzczNzQ4MjY5LCJleHAiOjE3NzQzNTMwNjl9.EAVnHX_bRwAmP8OzC01Az_5ZszqbwwhtdzHAU_MGgJ8',
].join(',');
const fixedRoomId = '019cfba3-33f7-7ad2-9d14-9ec5f6edc7d9';

function parseList(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ROOM_IDS = parseList(fixedRoomId || __ENV.ROOM_IDS || __ENV.ROOM_ID);
const TOKENS = parseList(fixedUserTokens || __ENV.TOKENS || __ENV.ACCESS_TOKEN);
const WS_URL = __ENV.WS_URL || 'ws://localhost/ws';
const NODE_URLS = parseList(__ENV.NODE_URLS || WS_URL);

const MESSAGES_PER_VU = Number(__ENV.MESSAGES_PER_VU || 80);
const MESSAGE_INTERVAL_MS = Number(__ENV.MESSAGE_INTERVAL_MS || 80);

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── JWT validation ────────────────────────────────────────────────
function validateJwt(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Token is missing or not a string' };
  }
  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return {
      valid: false,
      reason: 'Invalid token: not a valid JWT (expected 3 parts)',
    };
  }
  let payloadStr;
  try {
    payloadStr = encoding.b64decode(parts[1], 'rawurl', 's');
  } catch {
    return {
      valid: false,
      reason: 'Invalid token: payload is not valid base64url',
    };
  }
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return { valid: false, reason: 'Invalid token: payload is not valid JSON' };
  }
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'Invalid token: payload is not an object' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    return {
      valid: false,
      reason: `Token has expired (exp=${payload.exp}, now=${now}). Login again to get a fresh token.`,
    };
  }
  return { valid: true, payload };
}

// ── setup ─────────────────────────────────────────────────────────
export function setup() {
  if (!TOKENS.length) {
    throw new Error(
      'ACCESS_TOKEN (or TOKENS) is required. Set it before running the load test.',
    );
  }
  if (!ROOM_IDS.length) {
    throw new Error(
      'ROOM_ID (or ROOM_IDS) is required. Set it before running the load test.',
    );
  }
  for (let i = 0; i < TOKENS.length; i++) {
    const result = validateJwt(TOKENS[i]);
    if (!result.valid) {
      const label = TOKENS.length > 1 ? `Token at index ${i}` : 'ACCESS_TOKEN';
      throw new Error(`${label}: ${result.reason}`);
    }
  }
  return {};
}

// ── payload validation ────────────────────────────────────────────
function isValidMessagePayload(data) {
  if (!data || typeof data !== 'object') return false;
  return (
    typeof data.id === 'number' &&
    typeof data.seq === 'number' &&
    data.seq >= 1 &&
    typeof data.room_id === 'string' &&
    typeof data.user_id === 'string' &&
    typeof data.username === 'string' &&
    typeof data.content === 'string' &&
    (typeof data.created_at === 'string' || data.created_at instanceof Date)
  );
}

// ── main ──────────────────────────────────────────────────────────
export default function () {
  const scenario = __ENV.SCENARIO;
  const token = pickRandom(TOKENS);
  const roomId = pickRandom(ROOM_IDS);
  const nodeUrl = pickRandom(NODE_URLS);
  const url = `${nodeUrl}?token=${encodeURIComponent(token)}`;

  if (scenario === 'sender') runSender(url, roomId);
  if (scenario === 'receiver') runReceiver(url, roomId);
}

// ── sender ────────────────────────────────────────────────────────
function runSender(url, roomId) {
  // key: message content (unique per VU+iter+seq), value: sent timestamp
  const pending = new Map();
  let sendLoopStarted = false;
  let joinError = null;
  let sent = 0;

  // Track which content strings we sent so we can correctly count
  // undelivered messages on close regardless of batch vs single event.
  const sentContents = new Set();

  ws.connect(url, {}, (socket) => {
    const startSendLoop = () => {
      if (sendLoopStarted) return;
      sendLoopStarted = true;

      const sendLoop = () => {
        if (sent >= MESSAGES_PER_VU) return;

        // Content is unique per VU + iteration + position so we can match
        // echo-backs across both new_message and new_message_batch events.
        const content = `vu${__VU}-iter${__ITER}-seq${sent}`;
        pending.set(content, Date.now());
        sentContents.add(content);

        socket.send(
          JSON.stringify({
            event: 'send_message',
            data: { room_id: roomId, content },
          }),
        );

        msgSent.add(1);
        sent++;
        socket.setTimeout(sendLoop, MESSAGE_INTERVAL_MS);
      };

      socket.setTimeout(sendLoop, 1);
    };

    // Helper: process one received message object (from either event type).
    const processReceivedMessage = (msg) => {
      const valid = isValidMessagePayload(msg);
      payloadValidRate.add(valid);

      const content = msg && msg.content;
      const sentAt = pending.get(content);

      if (sentAt !== undefined) {
        deliveryLatency.add(Date.now() - sentAt);
        deliveryRate.add(valid);
        msgDelivered.add(1);
        pending.delete(content);
        sentContents.delete(content);
      }
    };

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          event: 'join_room',
          data: { room_id: roomId },
        }),
      );
    });

    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw);

        if (frame.event === 'error') {
          joinError = (frame.data && frame.data.message) || 'Unknown error';
          if (!sendLoopStarted) {
            console.error(
              `[sender] join_room failed: ${joinError}. Join the room first via POST /rooms/:roomId/join`,
            );
          }
          return;
        }

        // Start sending as soon as the server acknowledges we are in the room.
        if (frame.event === 'joined_room' || frame.event === 'history') {
          startSendLoop();
          return;
        }

        if (frame.event === 'new_message') {
          processReceivedMessage(frame.data);
          return;
        }

        if (frame.event === 'new_message_batch' && Array.isArray(frame.data)) {
          for (const msg of frame.data) {
            processReceivedMessage(msg);
          }
        }
      } catch (e) {
        console.error('[sender] Error parsing frame:', e);
      }
    });

    socket.on('close', () => {
      // Any content still in sentContents was never echo-backed before the
      // socket closed. Count each as a delivery failure so the metric
      // accurately reflects messages that did not make the round-trip,
      // not just messages where the pending map entry was left dangling.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _ of sentContents) {
        deliveryRate.add(false);
      }
      sentContents.clear();
      pending.clear();
    });

    socket.setTimeout(() => socket.close(), 120_000);
  });

  check(null, {
    'join_room succeeded (user must be room member)': () => !joinError,
    'sender completed': () => sendLoopStarted,
  });
}

// ── receiver ──────────────────────────────────────────────────────
function runReceiver(url, roomId) {
  let received = 0;
  let joinError = null;

  // Per-sender sequence tracking.
  // The room seq is monotonic across ALL senders, so checking a single
  // global lastSeq against arrival order produces false positives when
  // messages from concurrent senders interleave on the wire.
  // Instead we track the highest seq seen per sender (user_id) and only
  // flag out-of-order if a message from the SAME sender arrives with a
  // lower seq than a previous one from that sender.
  const lastSeqPerSender = new Map();
  const seenSeqs = new Set();

  const processMessage = (msg) => {
    const valid = isValidMessagePayload(msg);
    payloadValidRate.add(valid);
    msgDelivered.add(1);
    received++;

    if (!valid || !msg) return;

    const seq = msg.seq;
    const sender = msg.user_id;

    // Duplicate detection: global seq must be unique across the whole room.
    if (seenSeqs.has(seq)) {
      seqDuplicateCount.add(1);
    } else {
      seenSeqs.add(seq);
    }

    // Out-of-order detection: per-sender, not global.
    // A lower seq from a different sender is normal interleaving, not an error.
    const lastForSender = lastSeqPerSender.get(sender) ?? 0;
    if (seq <= lastForSender) {
      seqOutOfOrderCount.add(1);
    } else {
      lastSeqPerSender.set(sender, seq);
    }
  };

  ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          event: 'join_room',
          data: { room_id: roomId },
        }),
      );
    });

    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw);

        if (frame.event === 'error') {
          joinError = (frame.data && frame.data.message) || 'Unknown error';
          if (received === 0) {
            console.error(
              `[receiver] join_room failed: ${joinError}. Join the room first via POST /rooms/:roomId/join`,
            );
          }
          return;
        }

        if (frame.event === 'new_message') {
          processMessage(frame.data);
          return;
        }

        if (frame.event === 'new_message_batch' && Array.isArray(frame.data)) {
          for (const msg of frame.data) {
            processMessage(msg);
          }
        }
      } catch (e) {
        console.error('[receiver] Error parsing frame:', e);
      }
    });

    socket.setTimeout(() => socket.close(), 90_000);
  });

  check(null, {
    'join_room succeeded (user must be room member)': () => !joinError,
    'receiver received messages': () => received > 0,
  });
}

// ── summary ───────────────────────────────────────────────────────
export function handleSummary(data) {
  const opts = { indent: ' ', enableColors: false };
  return {
    stdout: textSummary(data, opts),
    'summary-delivery.txt': textSummary(data, opts),
  };
}
