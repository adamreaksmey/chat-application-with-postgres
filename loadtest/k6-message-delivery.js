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

// ── delivery-focused metrics ─────────────────────────────────────
const msgDelivered = new Counter('messages_delivered');
const msgSent = new Counter('messages_sent');
const deliveryRate = new Rate('delivery_success_rate');
const deliveryLatency = new Trend('delivery_latency_ms', true);
const payloadValidRate = new Rate('payload_valid_rate');
const seqDuplicateCount = new Counter('seq_duplicates');
const seqOutOfOrderCount = new Counter('seq_out_of_order');

export const options = {
  scenarios: {
    senders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: __ENV.SENDER_VUS || 120 },
        { duration: '2m30s', target: __ENV.SENDER_VUS || 120 },
        { duration: '15s', target: 0 },
      ],
      env: { SCENARIO: 'sender' },
    },
    receivers: {
      executor: 'constant-vus',
      vus: __ENV.RECEIVER_VUS || 300,
      duration: '3m',
      env: { SCENARIO: 'receiver' },
      startTime: '5s',
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

const ROOM_IDS_RAW = fixedRoomId || __ENV.ROOM_IDS || __ENV.ROOM_ID || '';
const ROOM_IDS = ROOM_IDS_RAW.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TOKENS_RAW = fixedUserTokens || __ENV.TOKENS || __ENV.ACCESS_TOKEN || '';
const TOKENS = TOKENS_RAW.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WS_URL = __ENV.WS_URL || 'ws://localhost/ws';
const NODE_URLS = (__ENV.NODE_URLS || WS_URL)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function pickRandom(arr) {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    return {
      valid: false,
      reason: 'Invalid token: payload is not valid base64url',
    };
  }
  let payload;
  try {
    payload = JSON.parse(payloadStr);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    return { valid: false, reason: 'Invalid token: payload is not valid JSON' };
  }
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'Invalid token: payload is not an object' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number') {
    if (payload.exp < now) {
      return {
        valid: false,
        reason: `Token has expired (exp=${payload.exp}, now=${now}). Get a fresh ACCESS_TOKEN (e.g. login again).`,
      };
    }
  }
  return { valid: true, payload };
}

export function setup() {
  if (!TOKENS.length) {
    throw new Error(
      'ACCESS_TOKEN (or TOKENS) is required and must be non-empty. ' +
        'Set it before running the load test (e.g. export ACCESS_TOKEN=...).',
    );
  }
  if (!ROOM_IDS.length) {
    throw new Error(
      'ROOM_ID (or ROOM_IDS) is required and must be non-empty. ' +
        'Set it before running the load test (e.g. export ROOM_ID=...).',
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

function isValidNewMessagePayload(data) {
  if (!data || typeof data !== 'object') return false;
  const d = data;
  return (
    typeof d.id === 'number' &&
    typeof d.seq === 'number' &&
    d.seq >= 1 &&
    typeof d.room_id === 'string' &&
    typeof d.user_id === 'string' &&
    typeof d.username === 'string' &&
    typeof d.content === 'string' &&
    (typeof d.created_at === 'string' || d.created_at instanceof Date)
  );
}

export default function () {
  const scenario = __ENV.SCENARIO;
  const token = pickRandom(TOKENS);
  const roomId = pickRandom(ROOM_IDS);
  const nodeUrl = pickRandom(NODE_URLS);
  const url = `${nodeUrl}?token=${encodeURIComponent(token)}`;

  if (scenario === 'sender') runSender(url, roomId);
  if (scenario === 'receiver') runReceiver(url, roomId);
}

function runSender(url, roomId) {
  const pending = new Map();
  let sendLoopStarted = false;
  let joinError = null;
  let sent = 0;
  const total = Number(__ENV.MESSAGES_PER_VU || 80);

  ws.connect(url, {}, (socket) => {
    const startSendLoop = () => {
      if (sendLoopStarted) return;
      sendLoopStarted = true;
      const sendLoop = () => {
        if (sent >= total) return;
        const content = `vu${__VU}-iter${__ITER}-seq${sent}`;
        pending.set(content, Date.now());
        socket.send(
          JSON.stringify({
            event: 'send_message',
            data: { room_id: roomId, content },
          }),
        );
        msgSent.add(1);
        sent++;
        socket.setTimeout(sendLoop, Number(__ENV.MESSAGE_INTERVAL_MS || 80));
      };
      socket.setTimeout(sendLoop, 1);
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
              `[sender] join_room failed: ${joinError}. Join the room first: POST /rooms/:roomId/join`,
            );
          }
          return;
        }
        if (frame.event === 'joined_room' || frame.event === 'history') {
          startSendLoop();
        }
        if (frame.event === 'new_message') {
          const valid = isValidNewMessagePayload(frame.data);
          payloadValidRate.add(valid);
          const sentAt = pending.get(frame.data && frame.data.content);
          if (sentAt) {
            deliveryLatency.add(Date.now() - sentAt);
            deliveryRate.add(valid);
            msgDelivered.add(1);
            pending.delete(frame.data && frame.data.content);
          }
        }
        if (frame.event === 'new_message_batch' && Array.isArray(frame.data)) {
          for (const msg of frame.data) {
            const valid = isValidNewMessagePayload(msg);
            payloadValidRate.add(valid);
            const sentAt = pending.get(msg && msg.content);
            if (sentAt) {
              deliveryLatency.add(Date.now() - sentAt);
              deliveryRate.add(valid);
              msgDelivered.add(1);
              pending.delete(msg && msg.content);
            }
          }
        }
      } catch (e) {
        console.error('Error parsing message', e);
      }
    });

    socket.on('close', () => {
      pending.forEach(() => deliveryRate.add(false));
    });

    socket.setTimeout(() => socket.close(), 120_000);
  });

  check(null, {
    'join_room succeeded (user must be room member)': () => !joinError,
    'sender completed': () => sendLoopStarted,
  });
}

function runReceiver(url, roomId) {
  let received = 0;
  let lastSeq = 0;
  let joinError = null;
  const seenSeqs = new Set();

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
              `[receiver] join_room failed: ${joinError}. Join the room first: POST /rooms/:roomId/join`,
            );
          }
          return;
        }
        if (frame.event === 'new_message') {
          const valid = isValidNewMessagePayload(frame.data);
          payloadValidRate.add(valid);
          msgDelivered.add(1);
          received++;
          if (valid && frame.data) {
            const seq = frame.data.seq;
            if (seenSeqs.has(seq)) seqDuplicateCount.add(1);
            else seenSeqs.add(seq);
            if (seq <= lastSeq) seqOutOfOrderCount.add(1);
            else lastSeq = seq;
          }
        }
        if (frame.event === 'new_message_batch' && Array.isArray(frame.data)) {
          for (const msg of frame.data) {
            const valid = isValidNewMessagePayload(msg);
            payloadValidRate.add(valid);
            msgDelivered.add(1);
            received++;
            if (valid && msg) {
              const seq = msg.seq;
              if (seenSeqs.has(seq)) seqDuplicateCount.add(1);
              else seenSeqs.add(seq);
              if (seq <= lastSeq) seqOutOfOrderCount.add(1);
              else lastSeq = seq;
            }
          }
        }
      } catch (e) {
        console.error('Error parsing message', e);
      }
    });

    socket.setTimeout(() => socket.close(), 90_000);
  });

  check(null, {
    'join_room succeeded (user must be room member)': () => !joinError,
    'receiver received messages': () => received > 0,
  });
}

export function handleSummary(data) {
  const opts = { indent: ' ', enableColors: false };
  return {
    stdout: textSummary(data, opts),
    'summary-delivery.txt': textSummary(data, opts),
  };
}
