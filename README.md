# PocketIDE-Server
The remote execution engine and filesystem interface for PocketIDE. Designed for high-performance mobile development, providing a secure bridge between the PWA frontend and containerized development environments.

## Logging

- Runtime logs are written to `logs/server-YYYY-MM-DD.log` under this folder.
- Logs still print to console and are also mirrored into the file.
- Set `LOG_DIR` to change the log directory.
- Set `LOG_FILE` to force a specific filename.
