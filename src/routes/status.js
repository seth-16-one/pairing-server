const express = require("express");

const router = express.Router();
const SocketManager = require("../services/SocketManager");
const { formatBytes, formatDuration } = require("../utils/format");
const packageJson = require("../../package.json");

router.get("/", (req, res) => {
    const memory = process.memoryUsage();

    res.json({
        success: true,
        onlineBots: SocketManager.connectedBotsTotal(),
        activePairings: SocketManager.activePairingsTotal(),
        uptime: formatDuration(process.uptime()),
        version: packageJson.version,
        memory: formatBytes(memory.rss),
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
