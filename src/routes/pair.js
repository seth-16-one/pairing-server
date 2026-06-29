const express = require("express");
const router = express.Router();

const SocketManager = require("../services/SocketManager");
const { normalizePhone, isValidPhone } = require("../utils/phone");
const { createError, sendError } = require("../utils/errors");

router.post("/", async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone);

        if (!isValidPhone(phone)) {
            throw createError("INVALID_PHONE", "A valid phone number with country code is required", 400);
        }

        const pairing = await SocketManager.createPairing(phone);

        return res.json({
            success: true,
            sessionId: pairing.sessionId,
            phone,
            pairingCode: pairing.pairingCode,
            pairingLink: pairing.pairingLink,
            qr: pairing.qr,
            expiresAt: pairing.expiresAt,
            status: pairing.status
        });
    } catch (err) {
        return sendError(res, err, "PAIRING_FAILED");
    }
});

router.get("/:sessionId", (req, res) => {
    const session = SocketManager.getSessionResponse(req.params.sessionId);

    if (!session) {
        return sendError(res, createError("SESSION_NOT_FOUND", "Pairing session not found", 404));
    }

    return res.json({
        success: true,
        session
    });
});

router.delete("/:sessionId", async (req, res) => {
    try {
        const session = await SocketManager.destroyBySessionId(req.params.sessionId);

        return res.json({
            success: true,
            sessionId: session.sessionId,
            phone: session.phone,
            status: "closed",
            message: "Session disconnected and removed"
        });
    } catch (err) {
        return sendError(res, err, "DISCONNECT_FAILED");
    }
});

module.exports = router;
