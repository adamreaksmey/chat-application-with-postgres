# Post–load test verification

Run through this after executing the k6 chat WebSocket load test.

---

## 0. Output ends abruptly (“sudden drop”)

If the run stops mid-way with **no final summary** (e.g. last line is a `running (2m1x.xs)...` progress line):

- **Likely cause:** The k6 process or Docker container was killed before graceful shutdown (e.g. **OOM**, Docker memory limit, or `SIGKILL`).
- **What to do:**
  - **Increase Docker memory** (Docker Desktop → Settings → Resources → Memory), or
  - **Reduce load:** lower `VUS`, fewer scenarios, or shorter `DURATION`, then re-run.
- **Partial results:** If k6 exited normally at least once, check `loadtest/summary.txt` for the last written summary. The script also writes `--out json=/scripts/k6-result.json`; you can inspect that for metrics up to the point of failure.

---

## 1. Run outcome

| Check | What to do |
|-------|------------|
| **Exit code** | k6 exited with `0`. Non-zero means at least one threshold failed. |
| **Failed thresholds** | If any failed, note which: `delivery_success_rate`, `delivery_latency_ms`, `ws_connecting`, `ws_msgs_received`, `payload_valid_rate`, `seq_duplicates`, `seq_out_of_order`. |

---

## 2. Metric-by-metric

**delivery_success_rate**  
Senders get their own message back via NOTIFY. Rate must be &gt;99%.  
If lower: possible lost messages, slow fanout, or socket/connection problems.

**delivery_latency_ms**  
95th percentile of send → echo-back latency. Should be &lt;500 ms.  
If higher: database or NOTIFY path is likely the bottleneck.

**ws_connecting**  
Time to establish a WebSocket connection. p95 should be &lt;1 s.  
Spikes: connection pool or auth (e.g. JWT) slowdown.

**ws_msgs_received**  
Total messages received by all VUs. For a ~3 minute run, expect well over 10 000.  
Low count: not enough traffic or many receivers missing messages.

**payload_valid_rate**  
Share of `new_message` frames whose payload has the expected shape (`id`, `seq`, `room_id`, `user_id`, `content`, `created_at`) and `seq` ≥ 1. Must be &gt;99%.  
Lower: corrupt or truncated payloads under load.

**seq_duplicates**  
Count of times a receiver saw the same `seq` twice in one room. Must be 0.  
Non-zero: duplicate NOTIFY or client-side bug.

**seq_out_of_order**  
Count of times a receiver saw `seq` ≤ previous seq in one room. Must be 0.  
Non-zero: out-of-order delivery or seq assignment bug under concurrency.

---

## 3. Application

- **Logs**  
  No repeated Postgres LISTEN/reconnect errors. No `"Invalid WS frame"` or auth failures.

- **Process**  
  App processes still up and responsive after the test.

---

## 4. Database

- **messages**  
  Row count in line with number of sent messages (no duplicate inserts per send).

- **Consistency**  
  `room_sequences` and `room_members` look consistent (no orphaned or obviously wrong rows).

- **Connections**  
  After the test, `pg_stat_activity` shows no suspicious connection buildup (no leaks).

---

## 5. Multi-node (if applicable)

If you ran with multiple app instances via `NODE_URLS`:

- NOTIFY fanout reaches receivers on **every** node.
- Senders and receivers can hit different nodes; messages should still be delivered.
