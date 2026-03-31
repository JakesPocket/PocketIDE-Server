# PocketIDE-Server
The remote execution engine and filesystem interface for PocketIDE. Designed for high-performance mobile development, providing a secure bridge between the PWA frontend and containerized development environments.

## Logging

- Runtime logs are written to `logs/server-YYYY-MM-DD.log` under this folder.
- Logs still print to console and are also mirrored into the file.
- Set `LOG_DIR` to change the log directory.
- Set `LOG_FILE` to force a specific filename.
- Chat requests now include tracing lines with a request id: request.start, request.success, request.failed, request.timeout, request.cancelled, request.aborted.
- SSE chat stream now emits progress checkpoints (`progress`) and heartbeats (`heartbeat`) for better client UX.
- If the client disconnects mid-request, the server aborts the in-flight chat task.
- Set `CHAT_REQUEST_TIMEOUT_MS` to tune the max chat timeout (default `300000`).

## Cloud Jobs

- Cloud tasks are now persisted to disk and restored after server restart.
- Default store path: `data/cloud-jobs.json`.
- Override with `CLOUD_JOBS_STORE_PATH`.
- Jobs that were `queued` or `running` when the server stopped are re-queued on startup.
