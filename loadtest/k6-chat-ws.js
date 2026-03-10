import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ── custom metrics ────────────────────────────────────────────────
const msgDelivered = new Counter('messages_delivered');
const msgSent = new Counter('messages_sent');
const deliveryRate = new Rate('delivery_success_rate');
const deliveryLatency = new Trend('delivery_latency_ms', true);
const reconnects = new Counter('reconnect_count');
const historyFetched = new Counter('history_fetch_count');

// ── scenario matrix ───────────────────────────────────────────────
export const options = {
  scenarios: {
    // 1. Sustained senders across N rooms — stresses insert throughput,
    //    seq assignment under concurrency, and cross-room NOTIFY fanout.
    sustained_senders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 200 }, // ramp up
        { duration: '2m', target: 200 }, // hold — sustained concurrent inserts
        { duration: '30s', target: 0 }, // ramp down
      ],
      env: { SCENARIO: 'sender' },
    },

    // 2. Idle receivers — stay connected, never send, just receive.
    //    Stresses NOTIFY fanout: every sender message must be pushed
    //    to all these sockets. Reveals fanout bottleneck under load.
    idle_receivers: {
      executor: 'constant-vus',
      vus: 500,
      duration: '3m',
      env: { SCENARIO: 'receiver' },
      startTime: '10s', // let senders connect first
    },

    // 3. Churn — rapid connect/join/leave/disconnect in tight loops.
    //    Stresses ref count correctness, LISTEN/UNLISTEN cycling,
    //    presence upsert/delete throughput, and socket registry cleanup.
    churn: {
      executor: 'constant-arrival-rate',
      rate: 50, // 50 new connections per second
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 100,
      env: { SCENARIO: 'churn' },
      startTime: '15s',
    },

    // 4. Reconnect storm — simulate mass reconnect (e.g. server restart,
    //    network blip). Every VU connects, sends messages to get a seq,
    //    disconnects, waits, reconnects with last_seen_seq to exercise
    //    the history/cursor recovery path under load.
    reconnect_storm: {
      executor: 'constant-vus',
      vus: 100,
      duration: '2m',
      env: { SCENARIO: 'reconnect' },
      startTime: '30s',
    },

    // 5. Typing storm — all VUs spam typing_start/typing_stop.
    //    Stresses the typing upsert/delete path and NOTIFY fanout
    //    for ephemeral events. Reveals if typing indicators become
    //    a write bottleneck under concurrency.
    typing_storm: {
      executor: 'constant-vus',
      vus: 150,
      duration: '2m',
      env: { SCENARIO: 'typing' },
      startTime: '20s',
    },
  },

  thresholds: {
    delivery_success_rate: ['rate>0.99'], // 99%+ messages actually delivered
    delivery_latency_ms: ['p95<500'], // 95th percentile under 500ms
    ws_connecting: ['p95<1000'], // connections established under 1s
    ws_msgs_received: ['count>10000'], // meaningful receive volume
  },
};

// ── room pool — spread load across rooms ─────────────────────────
const ROOM_IDS = (__ENV.ROOM_IDS || '').split(',').filter(Boolean);
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);
const WS_URL = __ENV.WS_URL || 'ws://localhost/ws';
const NODE_URLS = (__ENV.NODE_URLS || WS_URL).split(','); // multiple nodes

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── scenario implementations ──────────────────────────────────────
export default function () {
  const scenario = __ENV.SCENARIO;
  const token = pickRandom(TOKENS);
  const roomId = pickRandom(ROOM_IDS);
  const nodeUrl = pickRandom(NODE_URLS); // round-robin across nodes manually
  const url = `${nodeUrl}?token=${encodeURIComponent(token)}`;

  if (scenario === 'sender') runSender(url, roomId);
  if (scenario === 'receiver') runReceiver(url, roomId);
  if (scenario === 'churn') runChurn(url, roomId);
  if (scenario === 'reconnect') runReconnect(url, roomId);
  if (scenario === 'typing') runTyping(url, roomId);
}

// ── sender: sends messages, tracks delivery via echo-back ─────────
function runSender(url, roomId) {
  const pending = new Map(); // seq → sent_at timestamp

  ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          event: 'join_room',
          data: { room_id: roomId, last_seen_seq: null },
        }),
      );

      let sent = 0;
      const total = Number(__ENV.MESSAGES_PER_VU || 20);

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
        socket.setTimeout(sendLoop, Number(__ENV.MESSAGE_INTERVAL_MS || 100));
      };

      socket.setTimeout(sendLoop, 50);
    });

    // when we receive our own message back via NOTIFY fanout,
    // record latency — this proves end-to-end delivery works
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw);
        if (frame.event === 'new_message') {
          const sentAt = pending.get(frame.data.content);
          if (sentAt) {
            const latency = Date.now() - sentAt;
            deliveryLatency.add(latency);
            deliveryRate.add(true);
            msgDelivered.add(1);
            pending.delete(frame.data.content);
          }
        }
      } catch (error) {
        console.error('Error parsing message', error);
      }
    });

    socket.on('close', () => {
      // any pending messages that never came back = delivery failure
      pending.forEach(() => deliveryRate.add(false));
    });

    socket.setTimeout(() => socket.close(), 25000);
  });

  check(null, { 'sender completed': () => true });
}

// ── receiver: stays connected, counts received messages ───────────
function runReceiver(url, roomId) {
  let received = 0;

  ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          event: 'join_room',
          data: { room_id: roomId, last_seen_seq: null },
        }),
      );
    });

    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw);
        if (frame.event === 'new_message') {
          msgDelivered.add(1);
          received++;
        }
      } catch (error) {
        console.error('Error parsing message', error);
      }
    });

    // stay alive for the full scenario duration
    socket.setTimeout(() => socket.close(), 170000);
  });

  check(null, { 'receiver stayed alive': () => received > 0 });
}

// ── churn: rapid join/leave cycles ────────────────────────────────
function runChurn(url, roomId) {
  ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      // join
      socket.send(
        JSON.stringify({
          event: 'join_room',
          data: { room_id: roomId, last_seen_seq: null },
        }),
      );

      // leave after short stay, then close
      socket.setTimeout(
        () => {
          socket.send(
            JSON.stringify({
              event: 'leave_room',
              data: { room_id: roomId },
            }),
          );
          socket.setTimeout(() => socket.close(), 200);
        },
        300 + Math.random() * 500,
      );
    });
  });
}

// ── reconnect: connect → get seq → disconnect → reconnect with cursor
function runReconnect(url, roomId) {
  let lastSeenSeq = null;
  let cycleCount = 0;

  const doConnect = () => {
    ws.connect(url, {}, (socket) => {
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            event: 'join_room',
            data: { room_id: roomId, last_seen_seq: lastSeenSeq },
          }),
        );
      });

      socket.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw);
          // track highest seq seen for cursor-based reconnect
          if (
            frame.event === 'new_message' &&
            frame.data.seq > (lastSeenSeq ?? 0)
          ) {
            lastSeenSeq = frame.data.seq;
          }
          if (frame.event === 'history') {
            const msgs = frame.data.messages;
            if (msgs.length > 0) {
              historyFetched.add(msgs.length);
              lastSeenSeq = frame.data.next_cursor;
            }
          }
        } catch (error) {
          console.error('Error parsing message', error);
        }
      });

      // disconnect after a short window, reconnect again
      socket.setTimeout(
        () => {
          socket.close();
          cycleCount++;
          if (cycleCount < 5) {
            reconnects.add(1);
            sleep(0.5);
            doConnect();
          }
        },
        2000 + Math.random() * 1000,
      );
    });
  };

  doConnect();
}

// ── typing: spam typing_start / typing_stop ───────────────────────
function runTyping(url, roomId) {
  ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          event: 'join_room',
          data: { room_id: roomId, last_seen_seq: null },
        }),
      );

      let cycles = 0;
      const maxCycles = 30;

      const typeLoop = () => {
        if (cycles >= maxCycles) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({ event: 'typing_start', data: { room_id: roomId } }),
        );
        socket.setTimeout(
          () => {
            socket.send(
              JSON.stringify({
                event: 'typing_stop',
                data: { room_id: roomId },
              }),
            );
            cycles++;
            socket.setTimeout(typeLoop, 500 + Math.random() * 500);
          },
          1000 + Math.random() * 1000,
        );
      };

      socket.setTimeout(typeLoop, 200);
    });

    socket.setTimeout(() => socket.close(), 60000);
  });
}
