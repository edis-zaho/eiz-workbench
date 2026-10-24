export type ProductInput = {name:string;description:string;website:string;bookingUrl:string;archived:boolean};
export type AccountInput = {name:string;domain:string};

const ERR_INVALID_OBJECT = 'Eingabe muss ein Objekt sein.';
const ERR_INVALID_PROPS = 'Eingabe enthält ungültige oder fehlende Felder.';
const ERR_INVALID_TYPE = 'Ungültiger Datentyp für ein Feld.';
const ERR_INVALID_LENGTH = 'Ungültige Feldlänge.';
const ERR_INVALID_CHARS = 'Feld enthält ungültige Zeichen.';
const ERR_INVALID_URL = 'Ungültige URL.';
const ERR_INVALID_DOMAIN = 'Ungültige Domain.';

const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function validateGenericString(value: unknown, min: number, max: number, allowedControlChars: string): string {
    if (typeof value !== 'string') {
        throw new Error(ERR_INVALID_TYPE);
    }
    if (value.length < min || value.length > max) {
        throw new Error(ERR_INVALID_LENGTH);
    }
    const trimmed = value.trim();
    if (trimmed.length < min && value.length >=min) { // e.g., name='  '
        throw new Error(ERR_INVALID_LENGTH);
    }

    const forbiddenCharRegex = allowedControlChars ? CONTROL_CHARS_REGEX : /[\x00-\x1F\x7F]/;

    if (forbiddenCharRegex.test(value)) {
        throw new Error(ERR_INVALID_CHARS);
    }

    return trimmed;
}

function validateUrlField(value: string, fieldName: string): string {
    if (value === '') return '';

    if (/\s|[\x00-\x1F\x7F]/.test(value)) {
        throw new Error(ERR_INVALID_CHARS);
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(ERR_INVALID_URL);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(ERR_INVALID_URL);
    }

    if (url.username || url.password) {
        throw new Error(ERR_INVALID_URL);
    }

    if(url.href.length>2000)throw new Error(ERR_INVALID_LENGTH);
    return url.href;
}

function validateDomainField(value: string): string {
    if (value === '') return '';

    if (/[\s/:@?#\[\]\\%*]/.test(value)) {
        throw new Error(ERR_INVALID_CHARS);
    }

    const domainToParse = value.endsWith('.') ? value.slice(0, -1) : value;
    if (!domainToParse) throw new Error(ERR_INVALID_DOMAIN);

    // Reject IPs before URL parsing, which would normalize them
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domainToParse)) {
        throw new Error(ERR_INVALID_DOMAIN);
    }

    let hostname: string;
    try {
        // Use URL constructor for Punycode conversion and basic validation
        hostname = new URL(`https://` + domainToParse).hostname;
    } catch {
        throw new Error(ERR_INVALID_DOMAIN);
    }

    const labels = hostname.split('.');
    if(hostname.length>253)throw new Error(ERR_INVALID_LENGTH);
    if (labels.length < 2) {
        throw new Error(ERR_INVALID_DOMAIN);
    }

    for (const label of labels) {
        if (label.length < 1 || label.length > 63) {
            throw new Error(ERR_INVALID_DOMAIN);
        }
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
             throw new Error(ERR_INVALID_DOMAIN);
        }
    }

    if (/^\d+$/.test(labels[labels.length - 1])) {
        throw new Error(ERR_INVALID_DOMAIN);
    }

    return hostname;
}

export function validateProductInput(input: unknown): ProductInput {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) {
        throw new Error(ERR_INVALID_OBJECT);
    }

    const keys = Reflect.ownKeys(input);
    const expectedKeys = ['name', 'description', 'website', 'bookingUrl', 'archived'];
    if (keys.length !== expectedKeys.length || !keys.every(k => typeof k==='string' && expectedKeys.includes(k))) {
        throw new Error(ERR_INVALID_PROPS);
    }

    const { name, description, website, bookingUrl, archived } = input as ProductInput;

    const validatedName = validateGenericString(name, 1, 160, '');
    const validatedDescription = validateGenericString(description, 0, 12000, '\t\n\r');
    const validatedWebsiteRaw = validateGenericString(website, 0, 2000, '');
    const validatedBookingUrlRaw = validateGenericString(bookingUrl, 0, 2000, '');

    if (typeof archived !== 'boolean') {
        throw new Error(ERR_INVALID_TYPE);
    }

    return {
        name: validatedName,
        description: validatedDescription,
        website: validateUrlField(validatedWebsiteRaw, 'website'),
        bookingUrl: validateUrlField(validatedBookingUrlRaw, 'bookingUrl'),
        archived: archived,
    };
}

export function validateAccountInput(input: unknown): AccountInput {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) {
        throw new Error(ERR_INVALID_OBJECT);
    }

    const keys = Reflect.ownKeys(input);
    const expectedKeys = ['name', 'domain'];
    if (keys.length !== expectedKeys.length || !keys.every(k => typeof k==='string' && expectedKeys.includes(k))) {
        throw new Error(ERR_INVALID_PROPS);
    }

    const { name, domain } = input as AccountInput;

    const validatedName = validateGenericString(name, 1, 160, '');
    const validatedDomainRaw = validateGenericString(domain, 0, 253, '');

    return {
        name: validatedName,
        domain: validateDomainField(validatedDomainRaw),
    };
}
