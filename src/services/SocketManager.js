const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
    makeCacheableSignalKeyStore
} = require("baileys");

const { Boom } = require("@hapi/boom");
const NodeCache = require("node-cache");
const path = require("path");
const fs = require("fs-extra");

const PairingSessionManager = require("./pairingSessionManager");
const { baileysLogger, log, warn } = require("../utils/logger");
const { createPairingLink } = require("../utils/pairing");
const { createError } = require("../utils/errors");

const SESSIONS_ROOT = path.join(__dirname, "../sessions");
const SOCKET_READY_TIMEOUT_MS = Number(process.env.SOCKET_READY_TIMEOUT_MS || 30000);

function makeBoom(message, statusCode = DisconnectReason.timedOut) {
    return new Boom(message, { statusCode });
}

class SocketManager {
    constructor() {
        this.sockets = new Map();
        this.operations = new Map();
        this.msgRetryCounterCache = new NodeCache({
            stdTTL: 5 * 60,
            checkperiod: 60,
            useClones: false
        });
    }

    async create(phone) {
        return this.withPhoneLock(phone, () => this.createSocket(phone));
    }

    async createPairing(phone) {
        return this.withPhoneLock(phone, async () => {
            await this.createSocket(phone);
            return this.requestPairingCode(phone);
        });
    }

    async createSocket(phone) {
        await this.cleanup(phone, { removeFiles: true, status: "closed" });

        const sessionPath = this.getSessionPath(phone);
        await fs.ensureDir(SESSIONS_ROOT);
        await fs.remove(sessionPath);
        await fs.ensureDir(sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const logger = baileysLogger.child({ phone });

        const record = this.createRecord(phone, sessionPath);
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: Browsers.macOS("Telmass"),
            logger,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: Number(process.env.WA_CONNECT_TIMEOUT_MS || 30000),
            defaultQueryTimeoutMs: Number(process.env.WA_QUERY_TIMEOUT_MS || 60000),
            qrTimeout: Number(process.env.WA_QR_TIMEOUT_MS || 60000),
            msgRetryCounterCache: this.msgRetryCounterCache
        });

        record.socket = sock;
        this.sockets.set(phone, record);

        PairingSessionManager.create(phone, {
            socket: sock,
            sessionPath,
            onTimeout: async () => {
                warn(`Pairing session expired: ${phone}`);
                await this.cleanup(phone, { removeFiles: true, status: "expired" });
            }
        });

        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(phone, update));

        return sock;
    }

    async requestPairing(phone) {
        return this.withPhoneLock(phone, () => this.requestPairingCode(phone));
    }

    async requestPairingCode(phone) {
        const record = this.getRecord(phone);
        if (!record?.socket) {
            throw createError("SESSION_NOT_FOUND", `No active socket for ${phone}`, 404);
        }

        const sock = record.socket;
        if (sock.authState.creds.registered) {
            throw createError("ALREADY_REGISTERED", `Phone ${phone} is already registered`, 409);
        }

        await this.waitForPairingReady(phone);

        const pairingCode = await sock.requestPairingCode(phone);
        const pairingLink = createPairingLink(phone, pairingCode);
        const session = PairingSessionManager.update(phone, { pairingCode, pairingLink });

        return {
            sessionId: session?.sessionId || null,
            phone,
            pairingCode,
            pairingLink,
            expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
            status: session?.status || "waiting",
            qr: record.qr || PairingSessionManager.get(phone)?.qr || null
        };
    }

    async destroy(phone) {
        return this.withPhoneLock(phone, () => this.cleanup(phone, { removeFiles: true, status: "closed" }));
    }

    async destroyBySessionId(sessionId) {
        const session = PairingSessionManager.getBySessionId(sessionId);
        if (!session || typeof session.createdAt === "string") {
            throw createError("SESSION_NOT_FOUND", "Pairing session not found", 404);
        }

        await this.destroy(session.phone);
        return session;
    }

    isActive(phone) {
        return this.sockets.has(phone) || PairingSessionManager.isActive(phone);
    }

    get(phone) {
        return this.getRecord(phone)?.socket;
    }

    has(phone) {
        return this.isActive(phone);
    }

    async cleanup(phone, options = {}) {
        const { removeFiles = true, status = "closed" } = options;
        const record = this.sockets.get(phone);

        this.sockets.delete(phone);
        PairingSessionManager.destroy(phone, status);

        if (record?.socket) {
            record.socket.ev?.removeAllListeners?.("connection.update");
            record.socket.ev?.removeAllListeners?.("creds.update");

            try {
                await record.socket.end?.();
            } catch {}
        }

        this.rejectReady(record, makeBoom("Socket cleaned up", DisconnectReason.connectionClosed));

        if (removeFiles) {
            await fs.remove(this.getSessionPath(phone));
        }
    }

    remove(phone) {
        this.sockets.delete(phone);
    }

    total() {
        return this.sockets.size;
    }

    sessionsTotal() {
        return PairingSessionManager.total();
    }

    activePairingsTotal() {
        return PairingSessionManager.list().filter((session) => session.status === "waiting").length;
    }

    connectedBotsTotal() {
        return PairingSessionManager.list().filter((session) => session.connected).length;
    }

    getSession(sessionId) {
        return PairingSessionManager.getBySessionId(sessionId);
    }

    getSessionResponse(sessionId) {
        const session = PairingSessionManager.getBySessionId(sessionId);
        if (!session) {
            return null;
        }

        if (typeof session.createdAt === "string") {
            return session;
        }

        return PairingSessionManager.serialize(session);
    }

    listActiveBots() {
        return PairingSessionManager.list()
            .map((session) => ({
                phone: session.phone,
                connected: session.connected,
                connectedAt: session.connectedAt,
                sessionId: session.sessionId
            }));
    }

    async cleanupAll() {
        const phones = new Set([
            ...this.sockets.keys(),
            ...PairingSessionManager.phones()
        ]);

        await Promise.all(Array.from(phones, (phone) => this.cleanup(phone, { removeFiles: true })));
    }

    getSessionPath(phone) {
        return path.join(SESSIONS_ROOT, phone);
    }

    getRecord(phone) {
        return this.sockets.get(phone);
    }

    createRecord(phone, sessionPath) {
        let resolveReady;
        let rejectReady;

        const ready = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        ready.catch(() => {});

        return {
            phone,
            sessionPath,
            socket: null,
            connection: "created",
            qr: null,
            ready,
            resolveReady,
            rejectReady,
            readySettled: false
        };
    }

    handleConnectionUpdate(phone, update) {
        const record = this.getRecord(phone);
        if (!record) {
            return;
        }

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            record.qr = qr;
            PairingSessionManager.update(phone, { qr });
        }

        if (connection) {
            record.connection = connection;
            PairingSessionManager.update(phone, { connection });
            log(`Connection update for ${phone}: ${connection}`);
        }

        if (connection === "connecting" || connection === "open") {
            this.resolveReady(record);
        }

        if (connection === "open") {
            PairingSessionManager.update(phone, {
                status: "connected",
                connectedAt: Date.now()
            });

            setTimeout(() => {
                this.cleanup(phone, { removeFiles: true, status: "closed" }).catch(() => {});
            }, 5000).unref?.();
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const session = PairingSessionManager.get(phone);
            this.rejectReady(record, lastDisconnect?.error || makeBoom("Connection closed", DisconnectReason.connectionClosed));
            this.sockets.delete(phone);

            if (session?.pairingCode && session.status === "waiting") {
                PairingSessionManager.update(phone, { connection: "close" });
                return;
            }

            PairingSessionManager.destroy(phone, "closed");

            const shouldRemoveFiles = ![
                DisconnectReason.restartRequired,
                DisconnectReason.connectionClosed,
                DisconnectReason.connectionLost,
                DisconnectReason.timedOut
            ].includes(reason);

            if (shouldRemoveFiles) {
                fs.remove(this.getSessionPath(phone)).catch(() => {});
            }
        }
    }

    async waitForPairingReady(phone) {
        const record = this.getRecord(phone);
        if (!record?.socket) {
            throw createError("SESSION_NOT_FOUND", `No active socket for ${phone}`, 404);
        }

        if (record.connection === "connecting" || record.connection === "open") {
            return;
        }

        await Promise.race([
            record.ready,
            new Promise((_, reject) => {
                const timer = setTimeout(() => {
                    reject(makeBoom(`Timed out waiting for WhatsApp socket for ${phone}`));
                }, SOCKET_READY_TIMEOUT_MS);
                timer.unref?.();
            })
        ]);

        if (!record.socket.ws?.isOpen) {
            await record.socket.waitForSocketOpen();
        }
    }

    resolveReady(record) {
        if (record && !record.readySettled) {
            record.readySettled = true;
            record.resolveReady();
        }
    }

    rejectReady(record, error) {
        if (record && !record.readySettled) {
            record.readySettled = true;
            record.rejectReady(error);
        }
    }

    async withPhoneLock(phone, action) {
        const previous = this.operations.get(phone) || Promise.resolve();

        const operation = previous
            .catch(() => {})
            .then(action)
            .finally(() => {
                if (this.operations.get(phone) === operation) {
                    this.operations.delete(phone);
                }
            });

        this.operations.set(phone, operation);
        return operation;
    }
}

module.exports = new SocketManager();
