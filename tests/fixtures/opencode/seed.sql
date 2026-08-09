INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
  ('user-1', 'ses-1', 100, 100, '{"role":"user","time":{"created":100}}');

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
  ('prt-1', 'user-1', 'ses-1', 100, 100, '{"type":"text","text":"first part"}'),
  ('prt-2', 'user-1', 'ses-1', 101, 101, '{"type":"text","text":"second part"}'),
  ('prt-3', 'user-1', 'ses-1', 102, 102, '{"type":"tool","tool":"bash"}');

INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
  ('asst-1', 'ses-1', 200, 1000, '{"role":"assistant","cost":0.5,"tokens":{"total":147593,"input":3,"output":119,"reasoning":64,"cache":{"write":2137,"read":145270}},"modelID":"gpt-5.6-luna","providerID":"opencode-go","variant":"max","time":{"created":200,"completed":900000},"path":{"cwd":"/tmp/oc","root":"/tmp/oc"},"parentID":"user-1"}'),
  ('asst-2', 'ses-1', 250, 1000, '{"role":"assistant","cost":0.125,"tokens":{"input":10,"output":20,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"kimi-k3","providerID":"opencode-go","variant":"high","time":{"created":250,"completed":950000},"path":{"cwd":"/tmp/oc"},"parentID":"user-1"}'),
  ('asst-3', 'ses-1', 150, 500, '{"role":"assistant","tokens":{"input":1},"modelID":"gpt-5.6-luna","providerID":"opencode-go","time":{"created":150},"parentID":"user-1"}');
