const path = require("path");
const express = require("express");
const cors = require("cors");

const pairRoute = require("./routes/pair");
const statusRoute = require("./routes/status");
const logoutRoute = require("./routes/logout");
const botsRoute = require("./routes/bots");
const generatorRoute = require("./routes/generator");
const SocketManager = require("./services/SocketManager");
const { createError, sendError } = require("./utils/errors");
const packageJson = require("../package.json");

const app = express();

const WEB_DIR = path.join(__dirname, "web");

// Behind one proxy (Render, a panel host, Cloudflare Tunnel) req.ip must be the visitor, not the proxy.
// Set TRUST_PROXY=0 if the server is exposed directly.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
app.disable("x-powered-by");

// CORS stays open by default (the mobile app needs it). Restrict it with CORS_ORIGINS=https://a.com,https://b.com
const origins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));

app.use(express.json({ limit: "10kb" }));

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api") || req.path.startsWith("/pair")) {
        res.setHeader("Cache-Control", "no-store");
    }
    next();
});

// Browsers get the website; API clients (Accept: application/json or */*) still get the JSON health response.
app.get("/", (req, res) => {
    if (req.accepts(["json", "html"]) === "html") {
        res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
        );
        res.setHeader("Cache-Control", "no-store");
        return res.sendFile(path.join(WEB_DIR, "index.html"));
    }

    return res.json({
        success: true,
        server: "Telmass Pairing Server",
        version: packageJson.version
    });
});

app.get("/countries.js", (req, res) => res.sendFile(path.join(WEB_DIR, "countries.js")));

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        uptime: Math.floor(process.uptime()),
        activePairings: SocketManager.activePairingsTotal()
    });
});

app.use("/api", generatorRoute);
app.use("/pair", pairRoute);
app.use("/status", statusRoute);
app.use("/logout", logoutRoute);
app.use("/bots", botsRoute);

app.use((req, res) => {
    return sendError(res, createError("NOT_FOUND", "Endpoint not found", 404));
});

app.use((err, req, res, next) => {
    return sendError(res, err);
});

module.exports = app;
