// Session ID generator API used by the website (src/web/index.html).
//
//   POST /api/request-code      { dial, number }  -> pairing code + secret token
//   POST /api/request-qr                          -> secret token (QR image arrives through the status poll)
//   GET  /api/session-status/:token               -> waiting | ready (with the SESSION_ID, once) | expired | error
//
// Everything is answered as JSON in the same { success, error: { code, message } } format as the rest of the API.
const express = require("express");

const router = express.Router();
const SocketManager = require("../services/SocketManager");
const { buildPhone } = require("../utils/phone");
const { formatPairingCode } = require("../utils/pairing");
const { createError, sendError } = require("../utils/errors");

router.post("/request-code", async (req, res) => {
    try {
        const body = req.body || {};
        // "phone" (full international number, like the legacy /pair endpoint) is still accepted
        const number = body.number ?? (body.phone ? `+${String(body.phone).replace(/^\++/, "")}` : "");
        const phone = buildPhone(body.dial, number);

        if (!phone.ok) {
            throw createError("INVALID_PHONE", phone.error, 400);
        }

        const pairing = await SocketManager.beginAttempt({ mode: "code", phone: phone.digits, ip: req.ip });

        return res.json({
            success: true,
            code: formatPairingCode(pairing.pairingCode),
            token: pairing.sessionId,
            expiresAt: pairing.expiresAt
        });
    } catch (err) {
        return sendError(res, err, "PAIRING_FAILED");
    }
});

router.post("/request-qr", async (req, res) => {
    try {
        const pairing = await SocketManager.beginAttempt({ mode: "qr", ip: req.ip });

        return res.json({
            success: true,
            token: pairing.sessionId,
            expiresAt: pairing.expiresAt,
            expiresIn: pairing.expiresIn
        });
    } catch (err) {
        return sendError(res, err, "PAIRING_FAILED");
    }
});

router.get("/session-status/:token", (req, res) => {
    const { token } = req.params;
    const gone = () => sendError(res, createError("SESSION_NOT_FOUND", "No active pairing session found. Please try again.", 404));

    if (!/^[a-f0-9]{48}$/.test(token)) {
        return gone();
    }

    const session = SocketManager.getSessionResponse(token);
    if (!session) {
        return gone();
    }

    // one-time handover of the SESSION_ID
    if (session.session) {
        return res.json({ success: true, status: "ready", session: session.session });
    }

    if (session.status === "connected") {
        return res.json({ success: true, status: "delivered" });
    }

    if (session.status === "error") {
        return res.json({
            success: false,
            status: "error",
            error: { code: "PAIRING_FAILED", message: session.error || "Pairing failed. Please try again." }
        });
    }

    if (session.status === "expired" || session.status === "closed") {
        return res.json({ success: true, status: session.status });
    }

    return res.json({
        success: true,
        status: "waiting",
        mode: session.mode,
        expiresAt: session.expiresAt,
        ...(session.mode === "qr" && session.qrImage ? { qr: session.qrImage } : {})
    });
});

module.exports = router;
