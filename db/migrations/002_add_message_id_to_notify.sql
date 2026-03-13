-- Include message id in NOTIFY payload so clients receive a stable id when messages are broadcast.
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
      'content',    NEW.content,
      'created_at', NEW.created_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
