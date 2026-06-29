function createError(code, message, statusCode = 500, details = undefined) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    error.details = details;
    return error;
}

function errorCodeFromStatus(statusCode) {
    if (statusCode === 400) {
        return "BAD_REQUEST";
    }

    if (statusCode === 404) {
        return "NOT_FOUND";
    }

    return "INTERNAL_ERROR";
}

function sendError(res, error, fallbackCode = undefined) {
    const statusCode = error.statusCode || error.status || 500;
    const code = error.code || fallbackCode || errorCodeFromStatus(statusCode);

    return res.status(statusCode).json({
        success: false,
        error: {
            code,
            message: error.message || "Unexpected error"
        }
    });
}

module.exports = {
    createError,
    sendError
};
