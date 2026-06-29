const express = require("express");

const router = express.Router();
const SocketManager = require("../services/SocketManager");

router.get("/", (req, res) => {
    return res.json({
        success: true,
        bots: SocketManager.listActiveBots()
    });
});

module.exports = router;
