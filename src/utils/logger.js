const pino = require("pino");

const isDevelopment = process.env.NODE_ENV === "development";

const baileysLogger = pino({
    level: isDevelopment ? process.env.BAILEYS_LOG_LEVEL || "debug" : "silent"
});

function log(...args) {
    if (isDevelopment) {
        console.log(...args);
    }
}

function warn(...args) {
    if (isDevelopment) {
        console.warn(...args);
    }
}

function error(...args) {
    if (isDevelopment) {
        console.error(...args);
    }
}

module.exports = {
    baileysLogger,
    isDevelopment,
    log,
    warn,
    error
};
