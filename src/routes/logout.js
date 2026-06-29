const express = require("express");

const router = express.Router();
const SocketManager = require("../services/SocketManager");
const { normalizePhone, isValidPhone } = require("../utils/phone");
const { createError, sendError } = require("../utils/errors");

router.delete("/", async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone || req.query?.phone);

        if (phone && !isValidPhone(phone)) {
            throw createError("INVALID_PHONE", "A valid phone number with country code is required", 400);
        }

        if (phone) {
            await SocketManager.destroy(phone);
            return res.json({
                success: true,
                phone,
                message: "Session cleared"
            });
        }

        await SocketManager.cleanupAll();

        return res.json({
            success: true,
            message: "All sessions cleared"
        });
    } catch (err) {
        return sendError(res, err, "LOGOUT_FAILED");
    }
});

module.exports = router;
