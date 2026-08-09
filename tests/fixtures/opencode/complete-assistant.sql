UPDATE message
SET
  time_updated = 2000,
  data = '{"role":"assistant","cost":0.05,"tokens":{"input":7,"output":9,"reasoning":2,"cache":{"write":0,"read":50}},"modelID":"gpt-5.6-luna","providerID":"opencode-go","variant":"max","time":{"created":150,"completed":1900000},"path":{"cwd":"/tmp/oc"},"parentID":"user-1"}'
WHERE id = 'asst-3';
