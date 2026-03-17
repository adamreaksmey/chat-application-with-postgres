-- Shard room message NOTIFY channels to reduce LISTEN fanout overhead.
-- Uses N=4 shards: channel is `room_shard:{hash(room_id) % 4}`.
-- Presence and typing remain global channels.

CREATE OR REPLACE FUNCTION notify_new_message()
RETURNS trigger AS $$
DECLARE
  shard bigint;
  channel text;
BEGIN
  -- Deterministic 32-bit hash based on md5(room_id::text).
  -- Take first 8 hex chars => 0..(2^32-1) then mod by shard count (4).
  shard := mod(
    to_number(substr(md5(NEW.room_id::text), 1, 8), 'FMxxxxxxxx')::bigint,
    4
  );
  channel := format('room_shard:%s', shard);

  PERFORM pg_notify(
    channel,
    json_build_object(
      'id',         NEW.id,
      'seq',        NEW.seq,
      'room_id',    NEW.room_id,
      'user_id',    NEW.user_id,
      'username',   NEW.username,
      'content',    NEW.content,
      'created_at', NEW.created_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

