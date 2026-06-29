function normalizePhone(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        return "";
    }

    return String(value).replace(/\D/g, "");
}

function isValidPhone(phone) {
    return /^[1-9]\d{7,14}$/.test(phone);
}

module.exports = {
    normalizePhone,
    isValidPhone
};
