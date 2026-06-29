const express = require("express");
const cors = require("cors");

const pairRoute = require("./routes/pair");
const statusRoute = require("./routes/status");
const logoutRoute = require("./routes/logout");
const botsRoute = require("./routes/bots");
const { createError, sendError } = require("./utils/errors");
const packageJson = require("../package.json");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        success: true,
        server: "Telmass Pairing Server",
        version: packageJson.version
    });
});

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
