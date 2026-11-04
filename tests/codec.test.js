const test = require("node:test");
const assert = require("node:assert");

const { encodeSession, decodeSession, PREFIX } = require("../src/services/sessionCodec");
const { buildPhone, normalizePhone, isValidPhone } = require("../src/utils/phone");

test("session codec round-trips and is tolerant of wrapping/whitespace", () => {
    const creds = { me: { id: "255700000000:1@s.whatsapp.net" }, registrationId: 7 };
    const id = encodeSession(creds);
    assert.ok(id.startsWith(PREFIX));
    assert.deepStrictEqual(decodeSession(id).creds, creds);
    assert.deepStrictEqual(decodeSession(`  "${id.slice(0, 20)}\n${id.slice(20)}" `).creds, creds);
    assert.deepStrictEqual(decodeSession(`junk ${id}`).creds, creds);
});

test("session codec rejects bad input", () => {
    assert.strictEqual(decodeSession("").ok, false);
    assert.strictEqual(decodeSession("nope").ok, false);
    assert.strictEqual(decodeSession(`${PREFIX}***`).ok, false);
    assert.strictEqual(decodeSession(`${PREFIX}${Buffer.from("not json").toString("base64")}`).ok, false);
});

test("buildPhone joins dial code and number", () => {
    assert.deepStrictEqual(buildPhone("254", "0712 345 678"), { ok: true, digits: "254712345678" });
    assert.deepStrictEqual(buildPhone("+255", "778271055"), { ok: true, digits: "255778271055" });
    assert.deepStrictEqual(buildPhone("", "+255 778 271 055"), { ok: true, digits: "255778271055" });
    assert.strictEqual(buildPhone("", "778271055").ok, false);
    assert.strictEqual(buildPhone("254", "").ok, false);
    assert.strictEqual(buildPhone("254", "12").ok, false);
});

test("legacy phone helpers still behave", () => {
    assert.strictEqual(normalizePhone("+254 712-345-678"), "254712345678");
    assert.strictEqual(isValidPhone("254712345678"), true);
    assert.strictEqual(isValidPhone("0712345678"), false);
});
