function normalizePhone(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        return "";
    }

    return String(value).replace(/\D/g, "");
}

function isValidPhone(phone) {
    return /^[1-9]\d{7,14}$/.test(phone);
}

/**
 * Turns what the pairing form sends (country dial code + the number the user typed)
 * into the digits-only international number Baileys needs for a pairing code.
 * A leading "+" in `number` means "this already includes the country code";
 * otherwise leading zeros (trunk prefix) are dropped and `dial` is prepended.
 *
 * @returns {{ ok: true, digits: string } | { ok: false, error: string }}
 */
function buildPhone(dial, number) {
    const dialDigits = String(dial || "").replace(/\D/g, "");
    const raw = String(number ?? "").trim();
    const numDigits = raw.replace(/\D/g, "");

    if (!numDigits) {
        return { ok: false, error: "Enter your WhatsApp number." };
    }

    let digits;
    if (raw.startsWith("+")) {
        digits = numDigits;
    } else {
        if (!dialDigits) {
            return { ok: false, error: "Choose your country." };
        }
        digits = dialDigits + numDigits.replace(/^0+/, "");
    }

    if (!isValidPhone(digits)) {
        return { ok: false, error: "That number does not look valid. Check the country and number." };
    }

    return { ok: true, digits };
}

module.exports = {
    normalizePhone,
    isValidPhone,
    buildPhone
};
