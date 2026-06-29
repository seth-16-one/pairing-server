# Telmass WhatsApp Pairing Server

Backend service for generating WhatsApp companion-device pairing codes with Baileys v7. The API is designed for a React Native client: all responses are JSON, CORS is enabled, sessions are tracked by `sessionId`, and sockets/session files are cleaned up automatically.

## Features

- WhatsApp pairing code generation with Baileys.
- One active pairing session per phone number.
- Session status polling by `sessionId`.
- Explicit disconnect endpoint.
- Active bot/session listing.
- JSON-only error responses.
- Automatic timeout and filesystem cleanup.
- Development-only verbose logging.

## Requirements

- Node.js 20+ recommended.
- npm.
- Network access to WhatsApp Web endpoints.

## Installation

```bash
npm install
```

Create an environment file:

```bash
copy .env.example .env
```

Start the server:

```bash
npm start
```

Development mode:

```bash
npm run dev
```

Default URL:

```text
http://localhost:3000
```

## Environment Variables

| Name | Default | Description |
| --- | ---: | --- |
| `PORT` | `3000` | HTTP server port. |
| `NODE_ENV` | unset | Set to `development` for verbose development logs. |
| `PAIRING_SESSION_TIMEOUT_MS` | `120000` | Time before an unpaired session expires. |
| `SOCKET_READY_TIMEOUT_MS` | `30000` | Max wait before requesting the pairing code. |
| `WA_CONNECT_TIMEOUT_MS` | `30000` | Baileys websocket connect timeout. |
| `WA_QUERY_TIMEOUT_MS` | `60000` | Baileys query timeout. |
| `WA_QR_TIMEOUT_MS` | `60000` | Baileys QR payload timeout. |
| `SESSION_HISTORY_TTL_MS` | `900000` | How long closed/expired session metadata remains pollable. |
| `BAILEYS_LOG_LEVEL` | `debug` | Used only when `NODE_ENV=development`. |

## API Overview

Base URL examples use `http://localhost:3000`.

All error responses use:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

### Health

```http
GET /
```

Response `200`:

```json
{
  "success": true,
  "server": "Telmass Pairing Server",
  "version": "1.0.0"
}
```

### Create Pairing Session

```http
POST /pair
Content-Type: application/json
```

Body:

```json
{
  "phone": "2547xxxxxxxx"
}
```

The phone number must include the country code and digits only. Formatting characters are stripped before validation.

Response `200`:

```json
{
  "success": true,
  "sessionId": "5be742a2-7ed5-40c5-a94e-620ff5d7eb0f",
  "phone": "2547xxxxxxxx",
  "pairingCode": "1F9W6P9T",
  "pairingLink": "https://wa.me/2547xxxxxxxx?text=1F9W-6P9T",
  "qr": null,
  "expiresAt": "2026-06-29T14:33:30.041Z",
  "status": "waiting"
}
```

Notes:

- `qr` is returned only when Baileys exposes a QR payload.
- `pairingCode` is the raw code from Baileys.
- `pairingLink` uses a human-readable grouped code.
- Re-requesting pairing for the same phone replaces the previous active session.

Possible errors:

| Status | Code | Meaning |
| ---: | --- | --- |
| `400` | `INVALID_PHONE` | Missing or invalid phone number. |
| `409` | `ALREADY_REGISTERED` | Baileys reports the socket credentials are already registered. |
| `500` | `PAIRING_FAILED` | Pairing failed unexpectedly. |

### Get Pairing Session Status

```http
GET /pair/:sessionId
```

Response `200`:

```json
{
  "success": true,
  "session": {
    "sessionId": "5be742a2-7ed5-40c5-a94e-620ff5d7eb0f",
    "phone": "2547xxxxxxxx",
    "status": "waiting",
    "connection": "close",
    "connected": false,
    "connectedAt": null,
    "createdAt": "2026-06-29T14:31:30.041Z",
    "expiresAt": "2026-06-29T14:33:30.041Z",
    "pairingCode": "1F9W6P9T",
    "pairingLink": "https://wa.me/2547xxxxxxxx?text=1F9W-6P9T",
    "qr": null
  }
}
```

Session statuses:

| Status | Meaning |
| --- | --- |
| `waiting` | Pairing code was issued and the user has not connected yet. |
| `connected` | WhatsApp pairing completed and Baileys opened the connection. |
| `expired` | The pairing session timed out. |
| `closed` | The session was disconnected or cleaned up. |

Possible errors:

| Status | Code | Meaning |
| ---: | --- | --- |
| `404` | `SESSION_NOT_FOUND` | Session does not exist or history expired. |

### Disconnect Pairing Session

```http
DELETE /pair/:sessionId
```

Response `200`:

```json
{
  "success": true,
  "sessionId": "5be742a2-7ed5-40c5-a94e-620ff5d7eb0f",
  "phone": "2547xxxxxxxx",
  "status": "closed",
  "message": "Session disconnected and removed"
}
```

This closes the Baileys socket, removes session files, and clears memory.

Possible errors:

| Status | Code | Meaning |
| ---: | --- | --- |
| `404` | `SESSION_NOT_FOUND` | Session does not exist. |

### Active Bots

```http
GET /bots
```

Response `200`:

```json
{
  "success": true,
  "bots": [
    {
      "phone": "2547xxxxxxxx",
      "connected": false,
      "connectedAt": null,
      "sessionId": "5be742a2-7ed5-40c5-a94e-620ff5d7eb0f"
    }
  ]
}
```

### Server Status

```http
GET /status
```

Response `200`:

```json
{
  "success": true,
  "onlineBots": 0,
  "activePairings": 0,
  "uptime": "1m 7s",
  "version": "1.0.0",
  "memory": "74.1 MB",
  "timestamp": "2026-06-29T14:32:09.893Z"
}
```

### Legacy Logout

```http
DELETE /logout
```

Optional body:

```json
{
  "phone": "2547xxxxxxxx"
}
```

If `phone` is provided, only that phone session is cleared. If omitted, all active sessions are cleared.

Response `200`:

```json
{
  "success": true,
  "message": "All sessions cleared"
}
```

## React Native Flow

1. Call `POST /pair` with the customer phone number.
2. Show `pairingCode` to the customer.
3. Store `sessionId` locally while pairing is in progress.
4. Poll `GET /pair/:sessionId` every few seconds.
5. Stop polling when status becomes `connected`, `expired`, or `closed`.
6. Call `DELETE /pair/:sessionId` when the user cancels pairing.

## Project Structure

```text
src/
  app.js
  index.js
  routes/
    bots.js
    logout.js
    pair.js
    status.js
  services/
    SocketManager.js
    pairingSessionManager.js
  utils/
    errors.js
    format.js
    logger.js
    pairing.js
    phone.js
  sessions/
```

## Production Notes

- Do not commit `.env`.
- Do not commit `src/sessions/*`; it contains WhatsApp credentials.
- Put the service behind HTTPS in production.
- Restrict CORS origins before public deployment if the API is not meant to be public.
- Run with a process manager such as PM2, Docker, or systemd.
- Monitor memory and active session counts through `GET /status`.

## GitHub Push Checklist

```bash
node --check src/index.js
node --check src/app.js
node --check src/routes/pair.js
node --check src/routes/status.js
node --check src/routes/bots.js
node --check src/routes/logout.js
node --check src/services/SocketManager.js
node --check src/services/pairingSessionManager.js
npm install
npm start
```

Before pushing:

- Confirm `.env` is ignored.
- Confirm `node_modules/` is ignored.
- Confirm `src/sessions/` contains no committed credentials.
- Confirm generated `*.log` files are ignored.

