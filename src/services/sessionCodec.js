// Encodes Baileys' creds.json into one portable string (and back), so a logged-in
// WhatsApp session can be carried as the SESSION_ID variable of the bot.
// Pure functions, no I/O. The bot (lib/sessionLoader.js) uses the same prefix.
const PREFIX = "TELMAS~";

function encodeSession(credsObject) {
    const json = JSON.stringify(credsObject);
    return PREFIX + Buffer.from(json, "utf8").toString("base64");
}

/**
 * Tolerant: trims, strips wrapping quotes and any whitespace/newlines, and finds the
 * prefix even if something was pasted before it.
 * @returns {{ ok: true, creds: object, normalized: string } | { ok: false, error: string }}
 */
function decodeSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
        return { ok: false, error: "empty SESSION_ID" };
    }

    const cleaned = sessionId.trim().replace(/^["']+|["']+$/g, "").replace(/\s+/g, "");
    const at = cleaned.indexOf(PREFIX);
    if (at === -1) {
        return { ok: false, error: `SESSION_ID does not start with "${PREFIX}"` };
    }

    const b64 = cleaned.slice(at + PREFIX.length);
    if (!b64 || !/^[A-Za-z0-9+/=_-]+$/.test(b64)) {
        return { ok: false, error: "SESSION_ID contains characters that are not valid base64" };
    }

    try {
        const json = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        const creds = JSON.parse(json);
        if (!creds || typeof creds !== "object") {
            return { ok: false, error: "decoded SESSION_ID is not a valid object" };
        }
        return { ok: true, creds, normalized: PREFIX + b64 };
    } catch {
        return { ok: false, error: "SESSION_ID could not be decoded: it is incomplete or corrupted" };
    }
}

module.exports = { encodeSession, decodeSession, PREFIX };
