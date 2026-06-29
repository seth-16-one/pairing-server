function formatPairingCode(code) {
    if (!code) {
        return "";
    }

    return String(code).replace(/(.{4})(?=.)/g, "$1-");
}

function createPairingLink(phone, pairingCode) {
    const code = encodeURIComponent(formatPairingCode(pairingCode));
    return `https://wa.me/${phone}?text=${code}`;
}

module.exports = {
    createPairingLink,
    formatPairingCode
};
