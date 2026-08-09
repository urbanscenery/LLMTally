INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
  ('asst-bad', 'ses-1', 300, 1500, '{"role":"assistant","broken json');

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
  ('prt-bad', 'user-1', 'ses-1', 103, 103, '{"type":"text","text":');
