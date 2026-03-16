-- Add username to messages (denormalized from users for broadcast/history).
-- 1. Add column and backfill existing rows from users table.
-- 2. Trigger sets username on INSERT so app does not need to pass it.
-- 3. NOTIFY payload includes username so clients receive it.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS username TEXT;

UPDATE messages m
SET username = u.username
FROM users u
WHERE m.user_id = u.id
  AND m.username IS NULL;

ALTER TABLE messages
  ALTER COLUMN username SET NOT NULL;

-- Set username on every new insert from users table.
CREATE OR REPLACE FUNCTION set_message_username()
RETURNS trigger AS $$
BEGIN
  SELECT u.username INTO NEW.username
  FROM users u
  WHERE u.id = NEW.user_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_message_username_trigger ON messages;
CREATE TRIGGER set_message_username_trigger
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION set_message_username();

-- Include username in NOTIFY payload for client broadcasts.
CREATE OR REPLACE FUNCTION notify_new_message()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'room:' || NEW.room_id::text,
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
