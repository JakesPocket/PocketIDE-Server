# PocketCode Server

Backend server for PocketCode with GitHub Copilot SDK integration, terminal streaming via socket.io, and Codespace PWA support.

## Features

- **Node-PTY Terminal**: Real-time bash shell terminal with socket.io streaming
- **GitHub Copilot SDK**: Integrated chat endpoint using official GitHub Copilot subscription
- **Codespace Compatible**: CORS configured for `.app.github.dev` domains (PWA in Codespace)
- **Docker Ready**: Includes Dockerfile with Node.js, Python, Make, and C++ build tools
- **Docker Compose**: Quick setup with workspace mounting for `ds` workflow

## Prerequisites

- Node.js 18+ (for local development)
- Docker & Docker Compose (for containerized deployment)
- GitHub Token (for Copilot SDK)

## Getting Started

### Local Development

```bash
# Install dependencies
npm install

# Set GitHub token
export GITHUB_TOKEN=your_github_token

# Start server
npm start
# Server runs on http://localhost:3000
```

### Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up

# Or build manually
docker build -t pocketcode-server .
docker run -p 3000:3000 -v $(pwd):/workspace pocketcode-server
```

## Environment Variables

- `GITHUB_TOKEN`: GitHub personal access token (required for Copilot)
- `PORT`: Server port (default: 3000)
- `WORKSPACE`: Working directory for shell (default: /workspace)
- `REPO_CONTEXT`: Repository context for Copilot (optional)

## API Endpoints

### POST `/api/chat`
Chat with GitHub Copilot

```json
{
  "message": "How do I create a React component?",
  "context": { "repository": "my-repo" }
}
```

### GET `/api/health`
Health check

### Socket.io Events

- `output`: Terminal output stream
- `input`: Send input to terminal
- `resize`: Resize terminal (cols, rows)
- `exit`: Terminal exit signal

## CORS Configuration

Configured for:
- `*.app.github.dev` (Codespace PWA)
- `localhost` (local development)

## Docker Compose Workflow

Compatible with `ds` shortcut:

```bash
ds
docker-compose up
# Mounts current directory to /workspace
```

## License

ISC
