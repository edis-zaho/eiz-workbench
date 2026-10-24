import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProductInput, validateAccountInput } from '../core/catalog-input';

const validProduct = {
    name: '  Mein Produkt  ',
    description: 'Eine Beschreibung.\nMit Zeilenumbruch.',
    website: 'https://example.com/path',
    bookingUrl: '',
    archived: false,
};

const validAccount = {
    name: '  Contoso Inc.  ',
    domain: '  contoso.com  ',
};

test('validateProductInput: should accept and trim valid input', () => {
    const result = validateProductInput(validProduct);
    assert.deepStrictEqual(result, {
        name: 'Mein Produkt',
        description: 'Eine Beschreibung.\nMit Zeilenumbruch.',
        website: 'https://example.com/path',
        bookingUrl: '',
        archived: false,
    });
});

test('validateAccountInput: should accept and trim valid input', () => {
    const result = validateAccountInput(validAccount);
    assert.deepStrictEqual(result, {
        name: 'Contoso Inc.',
        domain: 'contoso.com',
    });
});

test('Input validation: should reject non-object inputs', () => {
    const invalidInputs = [null, undefined, [], 'string', 123, () => {}];
    for (const input of invalidInputs) {
        assert.throws(() => validateProductInput(input), { message: 'Eingabe muss ein Objekt sein.' });
        assert.throws(() => validateAccountInput(input), { message: 'Eingabe muss ein Objekt sein.' });
    }
});

test('Input validation: should reject inputs with extra or missing properties', () => {
    assert.throws(() => validateProductInput({ ...validProduct, extra: 1 }), { message: 'Eingabe enthält ungültige oder fehlende Felder.' });
    assert.throws(() => validateAccountInput({ ...validAccount, id: '123' }), { message: 'Eingabe enthält ungültige oder fehlende Felder.' });
    const { name, ...productWithoutName } = validProduct;
    assert.throws(() => validateProductInput(productWithoutName), { message: 'Eingabe enthält ungültige oder fehlende Felder.' });
});

test('Input validation: should not mutate frozen inputs', () => {
    assert.doesNotThrow(() => validateProductInput(Object.freeze({ ...validProduct })));
    assert.doesNotThrow(() => validateAccountInput(Object.freeze({ ...validAccount })));
});

test('String validation: should reject invalid lengths and control characters', () => {
    assert.throws(() => validateProductInput({ ...validProduct, name: '' }), { message: 'Ungültige Feldlänge.' });
    assert.throws(() => validateProductInput({ ...validProduct, name: ' ' }), { message: 'Ungültige Feldlänge.' });
    assert.throws(() => validateProductInput({ ...validProduct, name: 'a'.repeat(161) }), { message: 'Ungültige Feldlänge.' });
    assert.throws(() => validateProductInput({ ...validProduct, name: 'nul\0char' }), { message: 'Feld enthält ungültige Zeichen.' });
    assert.throws(() => validateProductInput({ ...validProduct, description: 'desc\x01' }), { message: 'Feld enthält ungültige Zeichen.' });
    assert.doesNotThrow(() => validateProductInput({ ...validProduct, description: 'ok\t\n\r' }));
});

test('archived field validation: should only accept booleans', () => {
    assert.doesNotThrow(() => validateProductInput({ ...validProduct, archived: true }));
    assert.doesNotThrow(() => validateProductInput({ ...validProduct, archived: false }));
    for (const invalid of [0, 1, 'true', null, undefined]) {
        assert.throws(() => validateProductInput({ ...validProduct, archived: invalid }), { message: 'Ungültiger Datentyp für ein Feld.' });
    }
});

test('URL field validation: should validate protocol and reject credentials', () => {
    const p = { ...validProduct };
    assert.strictEqual(validateProductInput({ ...p, website: 'http://test.com' }).website, 'http://test.com/');
    assert.strictEqual(validateProductInput({ ...p, website: 'HTTPS://TEST.COM' }).website, 'https://test.com/');
    assert.throws(() => validateProductInput({ ...p, website: 'ftp://example.com' }), { message: 'Ungültige URL.' });
    assert.throws(() => validateProductInput({ ...p, website: 'user:pass@example.com' }), { message: 'Ungültige URL.' });
    assert.throws(() => validateProductInput({ ...p, website: 'http:// site.com' }), { message: 'Feld enthält ungültige Zeichen.' });
});

test('Domain field validation: should validate hostnames correctly', () => {
    const a = { ...validAccount };
    assert.strictEqual(validateAccountInput({ ...a, domain: '' }).domain, '');
    assert.strictEqual(validateAccountInput({ ...a, domain: ' test.com. ' }).domain, 'test.com');
    assert.strictEqual(validateAccountInput({ ...a, domain: 'müsli.de' }).domain, 'xn--msli-0ra.de');
    assert.strictEqual(validateAccountInput({ ...a, domain: 'sub.domain.co.uk' }).domain, 'sub.domain.co.uk');
});

test('Domain field validation: should reject invalid formats', () => {
    const a = { ...validAccount };
    const invalidDomains = [
        'localhost', // only one label
        '192.168.1.1', // IP address
        'a-.com', // label ends with hyphen
        '-a.com', // label starts with hyphen
        'a_b.com', // invalid character
        'a'.repeat(64) + '.com', // label too long
        'example.123', // numeric TLD
        '*.wildcard.com', // contains wildcard
        'test.com/path', // contains path
        'test@test.com', // contains credentials
    ];
    for (const domain of invalidDomains) {
        assert.throws(() => validateAccountInput({ ...a, domain }), `Failed for: ${domain}`);
    }
});
