require("dotenv").config({ quiet: true });

const app = require("./app");
const SocketManager = require("./services/SocketManager");

// A crash-proof process: one rejected promise or stray exception must never take the server down.
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.on("uncaughtException", (error) => console.error("Uncaught exception:", error));

const PORT = process.env.PORT || 3000;

SocketManager.sweepOldSessions();

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Telmass Pairing Server running on http://localhost:${PORT}`);
});
