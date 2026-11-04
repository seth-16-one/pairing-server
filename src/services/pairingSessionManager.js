const { randomBytes } = require("crypto");
const { warn } = require("../utils/logger");

const HISTORY_TTL_MS = Number(process.env.SESSION_HISTORY_TTL_MS || 15 * 60 * 1000);

/**
 * Holds one record per pairing attempt, keyed by `key`:
 *   - code pairing  -> the phone number (digits)
 *   - QR pairing    -> "qr:<visitor ip>"
 * `sessionId` is the random secret the client polls with (never the phone number).
 */
class PairingSessionManager {
    constructor() {
        this.sessions = new Map();
        this.sessionsById = new Map();
        this.history = new Map();
        this.TIMEOUT = Number(process.env.PAIRING_SESSION_TIMEOUT_MS || 10 * 60 * 1000);
    }

    create(key, options = {}) {
        this.destroy(key);

        const {
            sessionPath,
            onTimeout,
            mode = "code",
            phone = null,
            ip = null,
            sessionId = randomBytes(24).toString("hex"),
            timeoutMs = this.TIMEOUT
        } = options;

        const session = {
            sessionId,
            key,
            mode,
            phone,
            ip,
            sessionPath,
            timer: null,
            createdAt: Date.now(),
            expiresAt: Date.now() + timeoutMs,
            connectedAt: null,
            qr: null,
            qrImg: null,
            pairingCode: null,
            pairingLink: null,
            sessionString: null,
            delivered: false,
            error: null,
            connection: "created",
            status: "waiting"
        };

        // Only an attempt that is still waiting can expire; a linked or failed one is cleaned up by its owner.
        session.timer = setTimeout(() => {
            if (this.sessions.get(key) !== session || session.status !== "waiting") {
                return;
            }

            session.status = "expired";

            Promise.resolve(onTimeout?.(key, session)).catch((error) => {
                warn(`Pairing timeout handler failed for ${key}:`, error?.message || error);
            });
        }, timeoutMs);

        session.timer.unref?.();

        this.sessions.set(key, session);
        this.sessionsById.set(sessionId, key);
        return session;
    }

    destroy(key, status = "closed") {
        const session = this.sessions.get(key);
        if (!session) {
            return false;
        }

        clearTimeout(session.timer);
        this.sessions.delete(key);
        this.sessionsById.delete(session.sessionId);
        this.remember(session, status);
        return true;
    }

    isActive(key) {
        return this.sessions.has(key);
    }

    has(key) {
        return this.isActive(key);
    }

    get(key) {
        return this.sessions.get(key);
    }

    getBySessionId(sessionId) {
        const key = this.sessionsById.get(sessionId);
        if (key !== undefined) {
            return this.get(key);
        }

        return this.history.get(sessionId) || null;
    }

    update(key, updates) {
        const session = this.get(key);
        if (!session) {
            return null;
        }

        Object.assign(session, updates);
        return session;
    }

    /** Keeps a small, secret-free snapshot so a client polling a finished attempt gets "expired"/"closed", not a 404. */
    remember(session, status) {
        const snapshot = this.serialize(session, status);
        snapshot.qr = null;
        snapshot.qrImage = null;
        snapshot.pairingCode = null;
        snapshot.pairingLink = null;
        this.history.set(session.sessionId, snapshot);

        const timer = setTimeout(() => {
            this.history.delete(session.sessionId);
        }, HISTORY_TTL_MS);

        timer.unref?.();
    }

    /** Never includes the SESSION_ID string: that is handed over once through SocketManager.getSessionResponse(). */
    serialize(session, status = session.status) {
        return {
            sessionId: session.sessionId,
            mode: session.mode,
            phone: session.phone,
            status,
            connection: session.connection,
            connected: Boolean(session.connectedAt),
            connectedAt: session.connectedAt ? new Date(session.connectedAt).toISOString() : null,
            createdAt: new Date(session.createdAt).toISOString(),
            expiresAt: new Date(session.expiresAt).toISOString(),
            pairingCode: session.pairingCode || null,
            pairingLink: session.pairingLink || null,
            qr: session.qr || null,
            qrImage: session.qrImg || null,
            delivered: Boolean(session.delivered),
            error: session.error || null
        };
    }

    list() {
        return Array.from(this.sessions.values(), (session) => this.serialize(session));
    }

    total() {
        return this.sessions.size;
    }

    keys() {
        return Array.from(this.sessions.keys());
    }

    phones() {
        return this.keys();
    }
}

module.exports = new PairingSessionManager();
