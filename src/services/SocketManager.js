const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore
} = require("baileys");

const NodeCache = require("node-cache");
const QRCode = require("qrcode");
const { randomBytes } = require("crypto");
const path = require("path");
const fs = require("fs-extra");

const PairingSessionManager = require("./pairingSessionManager");
const { encodeSession } = require("./sessionCodec");
const { baileysLogger, log, warn } = require("../utils/logger");
const { createPairingLink } = require("../utils/pairing");
const { createError } = require("../utils/errors");

const SESSIONS_ROOT = path.join(__dirname, "../sessions");

const envNum = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const CODE_TIMEOUT_MS = envNum("PAIRING_SESSION_TIMEOUT_MS", 10 * 60 * 1000);   // an unfinished code pairing is dropped after this
const QR_TIMEOUT_MS = envNum("QR_SESSION_TIMEOUT_MS", 3 * 60 * 1000);           // an unscanned QR is dropped after this
const COOLDOWN_MS = envNum("PAIRING_COOLDOWN_MS", 5000);                        // min gap between requests for the same number / same visitor's QR
const MAX_ACTIVE = envNum("MAX_PAIRINGS", 5);                                   // pairings in progress at once (each holds a WhatsApp socket)
const MAX_PER_IP_HOUR = envNum("PAIRING_MAX_PER_IP_HOUR", 10);                  // requests per IP per hour
const REPLACE_AFTER_MS = envNum("PAIRING_REPLACE_AFTER_MS", 60 * 1000);         // another IP may replace a waiting attempt only after this long
const EXTRACT_DELAY_MS = envNum("SESSION_EXTRACT_DELAY_MS", 3000);              // let Baileys finish writing creds.json
const CODE_FALLBACK_MS = envNum("CODE_FALLBACK_MS", 7000);                      // ask for the code anyway if no handshake event arrives
const FINAL_CLEANUP_MS = envNum("SESSION_FINAL_CLEANUP_MS", 60 * 1000);         // let Baileys' creds write queue drain before the folder is removed
const MAX_SOCKET_RETRIES = 5;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function removeFolderLater(folder, ms = 5000) {
    if (!folder) {
        return;
    }

    const timer = setTimeout(() => {
        fs.remove(folder).catch(() => {});
    }, ms);

    timer.unref?.();
}

class SocketManager {
    constructor() {
        this.attempts = new Map();        // key -> live attempt (socket + flags)
        this.operations = new Map();      // key -> promise chain (one operation per key at a time)
        this.lastRequestAt = new Map();   // key -> time of the last request
        this.ipHits = new Map();          // ip -> times of recent requests
        this.msgRetryCounterCache = new NodeCache({
            stdTTL: 5 * 60,
            checkperiod: 60,
            useClones: false
        });

        const housekeeping = setInterval(() => this.housekeeping(), 10 * 60 * 1000);
        housekeeping.unref?.();
    }

    /* ---------------------------------------------------------------- public API */

    /** Legacy API: pairing code for one phone number. */
    async createPairing(phone, ip = "api") {
        return this.beginAttempt({ mode: "code", phone, ip });
    }

    /**
     * Starts one pairing attempt.
     *   mode "code": resolves once WhatsApp issued the pairing code.
     *   mode "qr":   resolves as soon as the socket is started; the QR image shows up in the session record.
     */
    async beginAttempt({ mode, phone = null, ip = "unknown" }) {
        const key = mode === "code" ? phone : `qr:${ip}`;

        return this.withLock(key, async () => {
            await this.admit(key, ip);
            return this.startAttempt({ mode, phone, ip, key });
        });
    }

    async destroy(key) {
        return this.withLock(key, () => this.cleanup(key, { removeFiles: true, status: "closed" }));
    }

    async destroyBySessionId(sessionId) {
        const session = PairingSessionManager.getBySessionId(sessionId);
        if (!session || typeof session.createdAt === "string") {
            throw createError("SESSION_NOT_FOUND", "Pairing session not found", 404);
        }

        await this.destroy(session.key);
        return session;
    }

    /**
     * Status of one attempt by its secret id. When the SESSION_ID string is ready it is returned
     * ONCE (as `session`) and then dropped from memory; a copy was also sent to the user's own WhatsApp chat.
     */
    getSessionResponse(sessionId) {
        const session = PairingSessionManager.getBySessionId(sessionId);
        if (!session) {
            return null;
        }

        if (typeof session.createdAt === "string") {
            return session; // finished attempt: secret-free snapshot
        }

        const response = PairingSessionManager.serialize(session);

        if (session.status === "connected" && session.sessionString) {
            response.session = session.sessionString;
            session.sessionString = null;
            session.delivered = true;
            response.delivered = true;
        }

        return response;
    }

    getSession(sessionId) {
        return PairingSessionManager.getBySessionId(sessionId);
    }

    isActive(key) {
        return this.attempts.has(key) || PairingSessionManager.isActive(key);
    }

    has(key) {
        return this.isActive(key);
    }

    total() {
        return this.attempts.size;
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

    listActiveBots() {
        return PairingSessionManager.list().map((session) => ({
            phone: session.phone,
            connected: session.connected,
            connectedAt: session.connectedAt,
            sessionId: session.sessionId
        }));
    }

    async cleanupAll() {
        const keys = new Set([...this.attempts.keys(), ...PairingSessionManager.keys()]);
        await Promise.all(Array.from(keys, (key) => this.cleanup(key, { removeFiles: true, status: "closed" })));
    }

    /** Removes session folders left behind by an earlier crash/restart. */
    async sweepOldSessions() {
        try {
            await fs.ensureDir(SESSIONS_ROOT);
            for (const name of await fs.readdir(SESSIONS_ROOT)) {
                if (name === ".gitkeep") {
                    continue;
                }
                const target = path.join(SESSIONS_ROOT, name);
                const stat = await fs.stat(target);
                if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
                    await fs.remove(target);
                }
            }
        } catch {
            // best effort
        }
    }

    /* ------------------------------------------------------------ admission rules */

    housekeeping() {
        const cutoff = Date.now() - 3600 * 1000;

        for (const [ip, times] of this.ipHits) {
            const recent = times.filter((t) => t > cutoff);
            if (recent.length) {
                this.ipHits.set(ip, recent);
            } else {
                this.ipHits.delete(ip);
            }
        }

        for (const [key, time] of this.lastRequestAt) {
            if (time < cutoff) {
                this.lastRequestAt.delete(key);
            }
        }
    }

    async admit(key, ip) {
        const now = Date.now();
        const recent = (this.ipHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);

        if (recent.length >= MAX_PER_IP_HOUR) {
            throw createError("RATE_LIMITED", "Too many requests. Please try again later.", 429);
        }

        const previous = PairingSessionManager.get(key);
        const previousWaiting = Boolean(previous) && previous.status === "waiting";

        if (this.activePairingsTotal() - (previousWaiting ? 1 : 0) >= MAX_ACTIVE) {
            throw createError("SERVER_BUSY", "The server is busy right now. Please try again in a minute.", 429);
        }

        const since = now - (this.lastRequestAt.get(key) || 0);
        if (since < COOLDOWN_MS) {
            const wait = Math.ceil((COOLDOWN_MS - since) / 1000);
            throw createError("COOLDOWN", `Please wait ${wait}s before requesting again.`, 429, { retryAfter: wait });
        }

        // A wrong-code / expired / abandoned attempt must never block a new one: cancel it and carry on.
        // Only the SAME visitor (same IP) may replace an attempt right away; anyone else waits a minute,
        // so a stranger can't keep cancelling another person's pairing.
        if (previousWaiting) {
            if (previous.ip === ip || now - previous.createdAt > REPLACE_AFTER_MS) {
                await this.cleanup(key, { removeFiles: true, status: "closed" });
            } else {
                throw createError(
                    "PAIRING_IN_PROGRESS",
                    "A pairing for this number is already in progress. Please wait a minute and try again.",
                    409
                );
            }
        }

        this.lastRequestAt.set(key, now);
        recent.push(now);
        this.ipHits.set(ip, recent);
    }

    /* ------------------------------------------------------------- attempt engine */

    async startAttempt({ mode, phone, ip, key }) {
        await this.cleanup(key, { removeFiles: true, status: "closed" });

        const token = randomBytes(24).toString("hex");
        const folder = path.join(SESSIONS_ROOT, `${token}_${Date.now().toString(36)}`); // one folder PER ATTEMPT
        const tag = mode === "code" ? `+${phone.slice(0, 3)}***${phone.slice(-2)}` : `QR ${ip}`;

        const attempt = {
            key,
            token,
            mode,
            phone,
            ip,
            folder,
            tag,
            sock: null,
            done: false,        // no longer reacts to socket events
            cancelled: false,   // removed by cleanup()
            linked: false,
            codeRequested: false,
            retries: 0,
            settled: false,
            settleOk: null,
            settleErr: null
        };

        const outcome = new Promise((resolve, reject) => {
            attempt.settleOk = (value) => {
                if (!attempt.settled) {
                    attempt.settled = true;
                    resolve(value);
                }
            };
            attempt.settleErr = (error) => {
                if (!attempt.settled) {
                    attempt.settled = true;
                    reject(error);
                }
            };
        });

        this.attempts.set(key, attempt);

        PairingSessionManager.create(key, {
            sessionId: token,
            mode,
            phone,
            ip,
            sessionPath: folder,
            timeoutMs: mode === "code" ? CODE_TIMEOUT_MS : QR_TIMEOUT_MS,
            onTimeout: async () => {
                if (this.attempts.get(key) !== attempt) {
                    return;
                }
                warn(`Pairing attempt expired: ${tag}`);
                await this.cleanup(key, { removeFiles: true, status: "expired" });
            }
        });

        try {
            await fs.ensureDir(folder);
            const { state, saveCreds } = await useMultiFileAuthState(folder);
            const { version } = await fetchLatestBaileysVersion();
            const ctx = { state, saveCreds, version };

            this.openSocket(attempt, ctx);

            if (mode === "qr") {
                const session = PairingSessionManager.get(key);
                attempt.settleOk({
                    sessionId: token,
                    phone: null,
                    pairingCode: null,
                    pairingLink: null,
                    qr: null,
                    expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
                    expiresIn: Math.round(QR_TIMEOUT_MS / 1000),
                    status: "waiting"
                });
            }
        } catch (error) {
            warn(`Pairing attempt failed to start (${tag}):`, error?.message || error);
            this.giveUp(attempt, "Internal server error.", "INTERNAL_ERROR");
        }

        return outcome;
    }

    /** (Re)opens the WhatsApp socket of an attempt on its own folder. Called again after "restart required". */
    openSocket(attempt, ctx) {
        const logger = baileysLogger.child({ attempt: attempt.token.slice(0, 8) });

        const sock = makeWASocket({
            version: ctx.version,
            auth: {
                creds: ctx.state.creds,
                keys: makeCacheableSignalKeyStore(ctx.state.keys, logger)
            },
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            logger,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: envNum("WA_CONNECT_TIMEOUT_MS", 30000),
            defaultQueryTimeoutMs: envNum("WA_QUERY_TIMEOUT_MS", 60000),
            qrTimeout: envNum("WA_QR_TIMEOUT_MS", 60000),
            msgRetryCounterCache: this.msgRetryCounterCache
        });

        attempt.sock = sock;

        sock.ev.on("creds.update", ctx.saveCreds);

        // Safety net: the first QR event normally arrives within a second or two and triggers the code request.
        if (attempt.mode === "code" && !attempt.codeRequested) {
            const timer = setTimeout(() => this.requestCodeOnce(attempt, sock), CODE_FALLBACK_MS);
            timer.unref?.();
        }

        sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(attempt, ctx, update));
    }

    handleConnectionUpdate(attempt, ctx, update) {
        if (attempt.done || this.attempts.get(attempt.key) !== attempt) {
            return;
        }

        const { key, mode } = attempt;
        const { connection, lastDisconnect, qr } = update;

        if (connection) {
            PairingSessionManager.update(key, { connection });
            log(`Connection update for ${attempt.tag}: ${connection}`);
        }

        if (qr) {
            PairingSessionManager.update(key, { qr });

            if (mode === "qr") {
                QRCode.toDataURL(qr, { margin: 1, width: 320 })
                    .then((image) => {
                        if (!attempt.done && this.attempts.get(key) === attempt) {
                            PairingSessionManager.update(key, { qrImg: image });
                        }
                    })
                    .catch(() => {});
            } else {
                // the first QR event means the WhatsApp handshake is done: now a pairing code can be requested
                this.requestCodeOnce(attempt, attempt.sock);
            }
        }

        if (connection === "open") {
            this.onLinked(attempt, attempt.sock);
            return;
        }

        if (connection !== "close" || attempt.linked) {
            return;
        }

        const reason = lastDisconnect?.error?.output?.statusCode;

        if (reason === DisconnectReason.restartRequired) {
            // Normal right after the user enters the code / scans the QR: reconnect with the same credentials.
            log(`Restart required for ${attempt.tag}. Reconnecting...`);
            this.openSocket(attempt, ctx);
        } else if (reason === DisconnectReason.loggedOut) {
            this.giveUp(attempt, "WhatsApp refused the pairing. Please try again.");
        } else if (mode === "qr" && !ctx.state.creds.me) {
            // nobody scanned it: WhatsApp stopped rotating QR codes
            this.cleanup(key, { removeFiles: true, status: "expired" }).catch(() => {});
        } else if (
            reason === DisconnectReason.connectionLost ||
            reason === DisconnectReason.connectionClosed ||
            reason === DisconnectReason.timedOut
        ) {
            if (++attempt.retries > MAX_SOCKET_RETRIES) {
                this.giveUp(attempt, "The connection to WhatsApp kept dropping. Please try again.");
            } else {
                // growing pause, never a tight loop
                const timer = setTimeout(() => {
                    if (!attempt.done && this.attempts.get(key) === attempt) {
                        this.openSocket(attempt, ctx);
                    }
                }, 2000 * attempt.retries);
                timer.unref?.();
            }
        } else {
            warn(`Connection closed for ${attempt.tag}: ${reason}`);
        }
    }

    async requestCodeOnce(attempt, sock) {
        if (attempt.codeRequested || attempt.done || attempt.cancelled || !sock) {
            return;
        }

        attempt.codeRequested = true;

        try {
            const pairingCode = await sock.requestPairingCode(attempt.phone);

            if (attempt.done || this.attempts.get(attempt.key) !== attempt) {
                return;
            }

            const pairingLink = createPairingLink(attempt.phone, pairingCode);
            const session = PairingSessionManager.update(attempt.key, { pairingCode, pairingLink });
            log(`Pairing code issued for ${attempt.tag}`);

            attempt.settleOk({
                sessionId: attempt.token,
                phone: attempt.phone,
                pairingCode,
                pairingLink,
                qr: session?.qr || null,
                expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
                status: "waiting"
            });
        } catch (error) {
            warn(`Failed to request a code for ${attempt.tag}:`, error?.message || error);
            this.giveUp(attempt, "Failed to generate a pairing code. Make sure the number is registered on WhatsApp.");
        }
    }

    /** The account is linked and the socket is open: read creds.json, build the SESSION_ID, send it to the user's own chat. */
    onLinked(attempt, sock) {
        if (attempt.linked) {
            return;
        }

        attempt.linked = true;
        log(`Linked: ${attempt.tag}. Extracting session ID...`);

        let tries = 0;

        const extract = async () => {
            if (attempt.cancelled || this.attempts.get(attempt.key) !== attempt) {
                return;
            }

            tries += 1;

            let creds = null;
            try {
                creds = JSON.parse(await fs.readFile(path.join(attempt.folder, "creds.json"), "utf8"));
            } catch {
                // not written yet
            }

            if (!creds?.me?.id) {
                if (tries < 8) {
                    const retry = setTimeout(extract, 1000);
                    retry.unref?.();
                    return;
                }
                this.giveUp(attempt, "Linked, but the credentials could not be read. Please try again.");
                return;
            }

            const sessionString = encodeSession(creds);

            PairingSessionManager.update(attempt.key, {
                status: "connected",
                connection: "open",
                connectedAt: Date.now(),
                sessionString
            });
            log(`Session ID generated for ${attempt.tag}`);

            await this.sendToOwnChat(sock, creds, sessionString);

            attempt.done = true;
            this.endSocket(attempt);
            this.finalCleanupLater(attempt, FINAL_CLEANUP_MS);
        };

        const timer = setTimeout(extract, EXTRACT_DELAY_MS);
        timer.unref?.();
    }

    async sendToOwnChat(sock, creds, sessionString) {
        try {
            const me = String(sock?.user?.id || creds.me.id).split(":")[0].split("@")[0];
            const jid = `${me}@s.whatsapp.net`;
            const botName = process.env.BOT_NAME || "Telmas";

            await sock.sendMessage(jid, {
                text: `*${botName}: SESSION GENERATED*\n\n> Never share this ID with anyone. It works as your WhatsApp login.\n\nCopy the ID below and set it as the SESSION_ID variable on your bot host:`
            });
            await delay(800);
            await sock.sendMessage(jid, { text: sessionString });
            await delay(1500); // let the socket flush before it closes
        } catch (error) {
            warn("Could not send the session to the user's chat:", error?.message || error);
        }
    }

    giveUp(attempt, message, code = "PAIRING_FAILED") {
        if (attempt.done || attempt.cancelled) {
            return;
        }

        attempt.done = true;
        this.endSocket(attempt);
        removeFolderLater(attempt.folder);

        if (!attempt.settled) {
            // the client never received a token, so there is nothing for it to poll
            if (this.attempts.get(attempt.key) === attempt) {
                this.attempts.delete(attempt.key);
            }
            PairingSessionManager.destroy(attempt.key, "closed");
            attempt.settleErr(createError(code, message, 500));
            return;
        }

        PairingSessionManager.update(attempt.key, { status: "error", error: message });
        this.finalCleanupLater(attempt, 2 * 60 * 1000);
    }

    finalCleanupLater(attempt, ms) {
        const timer = setTimeout(() => {
            if (this.attempts.get(attempt.key) === attempt) {
                this.cleanup(attempt.key, { removeFiles: true, status: "closed" }).catch(() => {});
            }
        }, ms);

        timer.unref?.();
    }

    endSocket(attempt) {
        const sock = attempt.sock;
        attempt.sock = null;

        if (!sock) {
            return;
        }

        try {
            sock.ev?.removeAllListeners?.("connection.update");
            sock.ev?.removeAllListeners?.("creds.update");
        } catch {
            // ignore
        }

        try {
            sock.end?.(undefined);
        } catch {
            // ignore
        }
    }

    async cleanup(key, options = {}) {
        const { removeFiles = true, status = "closed" } = options;
        const attempt = this.attempts.get(key);

        this.attempts.delete(key);
        PairingSessionManager.destroy(key, status);

        if (!attempt) {
            return;
        }

        attempt.cancelled = true;
        attempt.done = true;
        this.endSocket(attempt);
        attempt.settleErr?.(createError("PAIRING_CANCELLED", "Superseded by a newer request.", 409));

        if (removeFiles) {
            removeFolderLater(attempt.folder); // delayed so any pending credential write drains first
        }
    }

    async withLock(key, action) {
        const previous = this.operations.get(key) || Promise.resolve();

        const operation = previous
            .catch(() => {})
            .then(action)
            .finally(() => {
                if (this.operations.get(key) === operation) {
                    this.operations.delete(key);
                }
            });

        this.operations.set(key, operation);
        return operation;
    }
}

module.exports = new SocketManager();
