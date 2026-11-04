# Telmass WhatsApp Pairing Server

Backend service for linking WhatsApp companion devices with Baileys v7 and turning the result into a `SESSION_ID` for your bot. Two parts share one engine:

- **A website** (open the server URL in a browser) with two ways to pair: **Pair code** and **QR code**. When the account is linked, the page shows the `SESSION_ID` once and the same ID is sent to the user's own WhatsApp chat.
- **The JSON API** used by the React Native app (`/pair`, `/status`, `/bots`, `/logout`), unchanged and now able to hand over the `SESSION_ID` too.

All responses are JSON, CORS is enabled, attempts are tracked by a random secret id, and sockets/session files are cleaned up automatically.

## Features

- Pair code and QR code pairing (website and API).
- `TELMAS~<base64>` SESSION_ID built from the linked credentials, shown once and sent to the user's own chat.
- Reconnects automatically after the "restart required" WhatsApp sends once the account is linked.
- A new code can be requested at any time with the same number; a wrong or abandoned attempt never blocks it.
- Abuse limits: per-IP hourly cap, cap on pairings in progress, per-number cooldown.
- Session status polling by a random secret id.
- Explicit disconnect endpoint and active listing.
- JSON-only error responses.
- Automatic timeout and filesystem cleanup.
- Development-only verbose logging.

## Requirements

- Node.js 20 or newer.
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
| `BOT_NAME` | `Telmas` | Name shown in the WhatsApp message that carries the SESSION_ID. |
| `TRUST_PROXY` | `1` | Proxies in front of the server (so the visitor's IP is used for limits). `0` if exposed directly. |
| `CORS_ORIGINS` | open | Comma-separated allowed origins. |
| `MAX_PAIRINGS` | `5` | Pairings in progress at once (each holds a WhatsApp socket). |
| `PAIRING_MAX_PER_IP_HOUR` | `10` | Requests per IP per hour. |
| `PAIRING_COOLDOWN_MS` | `5000` | Minimum gap between requests for the same number / same visitor's QR. |
| `PAIRING_REPLACE_AFTER_MS` | `60000` | Another IP may replace a waiting attempt for the same number only after this long. |
| `PAIRING_SESSION_TIMEOUT_MS` | `600000` | Time before an unfinished code pairing expires. |
| `QR_SESSION_TIMEOUT_MS` | `180000` | Time before an unscanned QR expires. |
| `SESSION_HISTORY_TTL_MS` | `900000` | How long finished attempts stay pollable (as `expired`/`closed`). |
| `WA_CONNECT_TIMEOUT_MS` | `30000` | Baileys websocket connect timeout. |
| `WA_QUERY_TIMEOUT_MS` | `60000` | Baileys query timeout. |
| `WA_QR_TIMEOUT_MS` | `60000` | Baileys QR payload timeout. |
| `BAILEYS_LOG_LEVEL` | `debug` | Used only when `NODE_ENV=development`. |

## Website and generator API

Open the server URL in a browser. Both tabs end the same way: the account is linked, the page shows the `SESSION_ID` once, and the same ID arrives in the user's own WhatsApp chat. Set it as `SESSION_ID` on the bot host (or put it in `session.txt` next to the bot's `index.js`).

```http
POST /api/request-code      { "dial": "254", "number": "712345678" }
POST /api/request-qr
GET  /api/session-status/:token
```

- `request-code` returns `{ success, code, token, expiresAt }`. A `number` starting with `+` is used as typed; `{ "phone": "2547xxxxxxxx" }` is also accepted.
- `request-qr` returns `{ success, token, expiresAt, expiresIn }`. The QR image arrives through the status poll.
- `session-status` answers `{ success, status }`: `waiting` (QR attempts also carry `qr`, a data URL), `ready` (carries `session`, the SESSION_ID, **once**), `delivered`, `expired`, `closed` or `error`.
- Errors use the standard format. Rate limits answer `429` with `error.retryAfter` (seconds) where it applies.
- A browser opening `GET /` gets the website; API clients (`Accept: application/json` or `*/*`) still get the JSON health response.

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
- Re-requesting pairing for the same phone replaces the previous active session (from the same IP, or after `PAIRING_REPLACE_AFTER_MS` from another one).
- When the account is linked, the status response carries the SESSION_ID once, in `session`.

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
| `connected` | WhatsApp pairing completed; the SESSION_ID is in `session` on the first read. |
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
5. Stop polling when status becomes `connected` (read `session`, the SESSION_ID, now: it is handed over once), `expired`, or `closed`.
6. Call `DELETE /pair/:sessionId` when the user cancels pairing.

## Project Structure

```text
src/
  app.js
  index.js
  routes/
    bots.js
    generator.js
    logout.js
    pair.js
    status.js
  services/
    SocketManager.js
    pairingSessionManager.js
    sessionCodec.js
  web/
    index.html
    countries.js
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
- Restrict CORS origins (`CORS_ORIGINS`) before public deployment if the API is not meant to be public.
- The SESSION_ID works as a WhatsApp login: it is shown once, never logged, and never kept after the attempt is cleaned up.
- Run with a process manager such as PM2, Docker, or systemd.
- Monitor memory and active session counts through `GET /status`.

## GitHub Push Checklist

```bash
node --check src/index.js
node --check src/app.js
node --check src/routes/generator.js
npm test
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

