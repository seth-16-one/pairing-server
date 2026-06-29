const fs = require("fs-extra");
const { randomUUID } = require("crypto");

const HISTORY_TTL_MS = Number(process.env.SESSION_HISTORY_TTL_MS || 15 * 60 * 1000);

class PairingSessionManager {
    constructor() {
        this.sessions = new Map();
        this.sessionsById = new Map();
        this.history = new Map();
        this.TIMEOUT = Number(process.env.PAIRING_SESSION_TIMEOUT_MS || 2 * 60 * 1000);
    }

    create(phone, options = {}) {
        this.destroy(phone);

        const {
            socket,
            sessionPath,
            onTimeout,
            sessionId = randomUUID(),
            timeoutMs = this.TIMEOUT
        } = options;

        const timer = setTimeout(() => {
            const session = this.get(phone);
            if (session) {
                session.status = "expired";
            }

            Promise.resolve(onTimeout?.(phone, session)).catch((error) => {
                process.nextTick(() => {
                    throw error;
                });
            });
        }, timeoutMs);

        timer.unref?.();

        const session = {
            sessionId,
            phone,
            socket,
            timer,
            sessionPath,
            createdAt: Date.now(),
            expiresAt: Date.now() + timeoutMs,
            connectedAt: null,
            qr: null,
            pairingCode: null,
            pairingLink: null,
            connection: "created",
            status: "waiting"
        };

        this.sessions.set(phone, session);
        this.sessionsById.set(sessionId, phone);
        return session;
    }

    destroy(phone, status = "closed") {
        const session = this.sessions.get(phone);
        if (!session) {
            return false;
        }

        clearTimeout(session.timer);
        this.sessions.delete(phone);
        this.sessionsById.delete(session.sessionId);
        this.remember(session, status);
        return true;
    }

    isActive(phone) {
        return this.sessions.has(phone);
    }

    has(phone) {
        return this.isActive(phone);
    }

    get(phone) {
        return this.sessions.get(phone);
    }

    getBySessionId(sessionId) {
        const phone = this.sessionsById.get(sessionId);
        if (phone) {
            return this.get(phone);
        }

        return this.history.get(sessionId) || null;
    }

    update(phone, updates) {
        const session = this.get(phone);
        if (!session) {
            return null;
        }

        Object.assign(session, updates);
        return session;
    }

    async cleanup(phone) {
        const session = this.get(phone);
        this.destroy(phone);

        if (session?.sessionPath) {
            await fs.remove(session.sessionPath);
        }
    }

    remember(session, status) {
        const snapshot = this.serialize(session, status);
        this.history.set(session.sessionId, snapshot);

        const timer = setTimeout(() => {
            this.history.delete(session.sessionId);
        }, HISTORY_TTL_MS);

        timer.unref?.();
    }

    serialize(session, status = session.status) {
        return {
            sessionId: session.sessionId,
            phone: session.phone,
            status,
            connection: session.connection,
            connected: Boolean(session.connectedAt),
            connectedAt: session.connectedAt ? new Date(session.connectedAt).toISOString() : null,
            createdAt: new Date(session.createdAt).toISOString(),
            expiresAt: new Date(session.expiresAt).toISOString(),
            pairingCode: session.pairingCode || null,
            pairingLink: session.pairingLink || null,
            qr: session.qr || null
        };
    }

    list() {
        return Array.from(this.sessions.values(), (session) => this.serialize(session));
    }

    total() {
        return this.sessions.size;
    }

    phones() {
        return Array.from(this.sessions.keys());
    }
}

module.exports = new PairingSessionManager();
