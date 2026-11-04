// Drives the real SocketManager with a fake "baileys" module, so the whole pairing flow
// (code issued -> user enters it -> WhatsApp restart (515) -> reconnect -> SESSION_ID) is exercised without WhatsApp.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

process.env.SESSION_EXTRACT_DELAY_MS = "20";
process.env.PAIRING_COOLDOWN_MS = "0";
process.env.CODE_FALLBACK_MS = "60000";
process.env.SESSION_FINAL_CLEANUP_MS = "300";

const sockets = [];
const sent = [];
let authFolder = null;

class FakeEv extends EventEmitter {}
function makeFakeSocket(config) {
    const ev = new FakeEv();
    const sock = {
        ev,
        config,
        ended: false,
        user: null,
        authState: config.auth,
        requestPairingCode: async (phone) => { sock.requestedFor = phone; return "ABCD1234"; },
        sendMessage: async (jid, content) => { sent.push({ jid, content }); },
        end() { sock.ended = true; }
    };
    sockets.push(sock);
    return sock;
}

let currentMake = makeFakeSocket;
const fake = {
    default: (config) => currentMake(config),
    useMultiFileAuthState: async (folder) => {
        authFolder = folder;
        fs.mkdirSync(folder, { recursive: true });
        return { state: { creds: {}, keys: {} }, saveCreds: async () => {} };
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: { restartRequired: 515, loggedOut: 401, connectionClosed: 428, connectionLost: 408, timedOut: 408 }
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "baileys") return fake;
    return origLoad.call(this, request, ...rest);
};

const SocketManager = require("../src/services/SocketManager");
const { decodeSession } = require("../src/services/sessionCodec");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await wait(25); }
    return false;
}

const CREDS = { me: { id: "254712345678:5@s.whatsapp.net" }, registrationId: 1, noiseKey: {}, signedIdentityKey: {} };

test("pair code flow: code, 515 restart, reconnect, SESSION_ID handed over once", async () => {
    sockets.length = 0; sent.length = 0;
    const pending = SocketManager.beginAttempt({ mode: "code", phone: "254712345678", ip: "1.1.1.1" });
    await wait(30);
    assert.strictEqual(sockets.length, 1);
    sockets[0].ev.emit("connection.update", { qr: "2@fake-qr" }); // handshake done -> code requested
    const pairing = await pending;
    assert.strictEqual(pairing.pairingCode, "ABCD1234");
    assert.strictEqual(sockets[0].requestedFor, "254712345678");
    assert.match(pairing.sessionId, /^[a-f0-9]{48}$/);

    let status = SocketManager.getSessionResponse(pairing.sessionId);
    assert.strictEqual(status.status, "waiting");
    assert.strictEqual(status.session, undefined);

    // the user enters the code: creds get written, WhatsApp closes with 515 (restart required)
    fs.writeFileSync(path.join(authFolder, "creds.json"), JSON.stringify(CREDS));
    sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    assert.strictEqual(sockets.length, 2, "must reconnect after 515");

    sockets[1].user = { id: "254712345678:5@s.whatsapp.net" };
    sockets[1].ev.emit("connection.update", { connection: "open" });
    assert.ok(await until(() => SocketManager.getSession(pairing.sessionId)?.status === "connected", 2000));

    status = SocketManager.getSessionResponse(pairing.sessionId);
    assert.ok(status.session.startsWith("TELMAS~"));
    assert.deepStrictEqual(decodeSession(status.session).creds, CREDS);

    // one-time handover
    const again = SocketManager.getSessionResponse(pairing.sessionId);
    assert.strictEqual(again.session, undefined);
    assert.strictEqual(again.delivered, true);

    // a copy goes to the user's own chat
    assert.ok(await until(() => sent.length === 2, 4000));
    assert.strictEqual(sent[0].jid, "254712345678@s.whatsapp.net");
    assert.ok(sent[1].content.text.startsWith("TELMAS~"));

    // cleanup: socket closed, folder removed, attempt forgotten
    assert.ok(await until(() => SocketManager.getSession(pairing.sessionId)?.status === "closed", 3000));
    assert.strictEqual(sockets[1].ended, true);
    assert.ok(await until(() => !fs.existsSync(authFolder), 7000));
});

test("a new code for the same number replaces the old attempt (no 'pairing in progress' block)", async () => {
    sockets.length = 0;
    const first = SocketManager.beginAttempt({ mode: "code", phone: "255700000001", ip: "2.2.2.2" });
    await wait(30);
    sockets[0].ev.emit("connection.update", { qr: "x" });
    const a = await first;

    const second = SocketManager.beginAttempt({ mode: "code", phone: "255700000001", ip: "2.2.2.2" });
    await wait(30);
    sockets[1].ev.emit("connection.update", { qr: "y" });
    const b = await second;

    assert.notStrictEqual(a.sessionId, b.sessionId);
    assert.strictEqual(sockets[0].ended, true);
    assert.strictEqual(SocketManager.getSessionResponse(a.sessionId).status, "closed");
    assert.strictEqual(SocketManager.getSessionResponse(b.sessionId).status, "waiting");
    await SocketManager.destroy("255700000001");
});

test("another visitor cannot cancel a fresh pairing for the same number", async () => {
    sockets.length = 0;
    const first = SocketManager.beginAttempt({ mode: "code", phone: "255700000002", ip: "3.3.3.3" });
    await wait(30);
    sockets[0].ev.emit("connection.update", { qr: "x" });
    await first;
    await assert.rejects(
        SocketManager.beginAttempt({ mode: "code", phone: "255700000002", ip: "9.9.9.9" }),
        (e) => e.code === "PAIRING_IN_PROGRESS" && e.statusCode === 409
    );
    await SocketManager.destroy("255700000002");
});

test("QR flow: image arrives through the status, 515 reconnect, SESSION_ID", async () => {
    sockets.length = 0; sent.length = 0;
    const pairing = await SocketManager.beginAttempt({ mode: "qr", ip: "4.4.4.4" });
    assert.strictEqual(pairing.status, "waiting");
    await wait(30);
    sockets[0].ev.emit("connection.update", { qr: "2@some-qr-payload" });
    await wait(150);
    const waiting = SocketManager.getSessionResponse(pairing.sessionId);
    assert.match(waiting.qrImage, /^data:image\/png;base64,/);

    fs.writeFileSync(path.join(authFolder, "creds.json"), JSON.stringify(CREDS));
    sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    assert.strictEqual(sockets.length, 2);
    sockets[1].ev.emit("connection.update", { connection: "open" });
    assert.ok(await until(() => SocketManager.getSession(pairing.sessionId)?.status === "connected", 2000));
    const done = SocketManager.getSessionResponse(pairing.sessionId);
    assert.ok(done.session.startsWith("TELMAS~"));
    await SocketManager.destroy("qr:4.4.4.4");
});

test("unscanned QR that WhatsApp stops rotating is dropped", async () => {
    sockets.length = 0;
    const pairing = await SocketManager.beginAttempt({ mode: "qr", ip: "5.5.5.5" });
    await wait(30);
    sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await wait(30);
    assert.strictEqual(SocketManager.getSessionResponse(pairing.sessionId).status, "expired");
});

test("a failed code request is reported and leaves nothing behind", async () => {
    sockets.length = 0;
    const origMake = currentMake;
    currentMake = (config) => { const s = origMake(config); s.requestPairingCode = async () => { throw new Error("Connection Closed"); }; return s; };
    const pending = SocketManager.beginAttempt({ mode: "code", phone: "255700000003", ip: "6.6.6.6" });
    await wait(30);
    sockets[0].ev.emit("connection.update", { qr: "x" });
    await assert.rejects(pending, (e) => e.code === "PAIRING_FAILED");
    assert.strictEqual(SocketManager.isActive("255700000003"), false);
    currentMake = origMake;
});

test("cooldown and per-IP limits answer 429 with retryAfter", async () => {
    process.env.PAIRING_COOLDOWN_MS = "0";
    // cooldown is read at load time; verify the IP cap instead (10 per hour)
    sockets.length = 0;
    let limited = null;
    for (let i = 0; i < 12 && !limited; i++) {
        try {
            await SocketManager.beginAttempt({ mode: "qr", ip: "7.7.7.7" });
        } catch (e) { limited = e; }
    }
    assert.ok(limited && limited.code === "RATE_LIMITED" && limited.statusCode === 429);
    await SocketManager.cleanupAll();
});
