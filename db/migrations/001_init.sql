-- Requires PostgreSQL 18+ for native uuidv7() support.
-- Enable any additional extensions you need here.

-- Users
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  username    TEXT UNIQUE NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,           -- bcrypt hash
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions (multiple login support)
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  refresh_token   TEXT UNIQUE NOT NULL,  -- hashed
  device_info     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ            -- soft revoke
);

-- Rooms
CREATE TABLE IF NOT EXISTS rooms (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Room Members
CREATE TABLE IF NOT EXISTS room_members (
  room_id     UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

-- Messages (append-only, never update/delete)
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  room_id     UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_room_id_created_at_idx
  ON messages (room_id, created_at DESC);

-- Presence (each node writes its connected clients here)
CREATE TABLE IF NOT EXISTS presence (
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  room_id     UUID REFERENCES rooms(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,              -- identifies which app instance
  last_seen   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, room_id)
);

-- Typing indicators (ephemeral, short TTL)
CREATE TABLE IF NOT EXISTS typing (
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  room_id     UUID REFERENCES rooms(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, room_id)
);

-- Migration tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- THE MAGIC: trigger that fires NOTIFY on every new message
CREATE OR REPLACE FUNCTION notify_new_message()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'room:' || NEW.room_id::text,
    json_build_object(
      'id',         NEW.id,
      'room_id',    NEW.room_id,
      'user_id',    NEW.user_id,
      'content',    NEW.content,
      'created_at', NEW.created_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_new_message ON messages;

CREATE TRIGGER on_new_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_new_message();

-- Presence notify
CREATE OR REPLACE FUNCTION notify_presence()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('presence', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_presence_change ON presence;

CREATE TRIGGER on_presence_change
  AFTER INSERT OR UPDATE ON presence
  FOR EACH ROW EXECUTE FUNCTION notify_presence();

-- Typing notify
CREATE OR REPLACE FUNCTION notify_typing()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('typing', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_typing_change ON typing;

CREATE TRIGGER on_typing_change
  AFTER INSERT OR UPDATE ON typing
  FOR EACH ROW EXECUTE FUNCTION notify_typing();

