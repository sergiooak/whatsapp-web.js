'use strict';

/**
 * Message capture / logging tool (reverse-engineering helper).
 *
 * Hooks into a {@link Client}'s `message_create` event and dumps every message
 * to disk in a buffer-safe, human-readable JSON format. It is meant to be used
 * to inspect the raw Store `_data` of native messages (e.g. a sticker pack)
 * before reproducing them in the library.
 *
 * Usage:
 *
 *     const { Client, LocalAuth } = require('./index');
 *     const { attach } = require('./tools/messageCapture');
 *
 *     const client = new Client({ authStrategy: new LocalAuth() });
 *     attach(client); // start capturing
 *     client.initialize();
 *
 * Every captured message produces a `<type>_<timestamp>_<id>.json` file under
 * `./message-logs/`. Messages with media additionally produce a binary file
 * (e.g. a `.zip`); ZIP archives also get their inner file names listed inside
 * the JSON dump.
 *
 * This is a development/debugging tool and is NOT part of the public API.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), 'message-logs');

/**
 * Minimum length for a numeric-keyed object to be treated as a byte array.
 * Crypto material in the Store (messageSecret, mediaKey, *Sha256, ...) is
 * 32 bytes, so 16 is a safe lower bound that avoids misdetecting small
 * coordinate-like arrays.
 * @type {number}
 */
const BYTE_OBJECT_MIN_LENGTH = 16;

/**
 * @param {*} n
 * @returns {boolean} whether `n` is an integer in the byte range [0, 255].
 */
function isByteValue(n) {
    return Number.isInteger(n) && n >= 0 && n <= 255;
}

/**
 * Detects plain objects that are really byte arrays in disguise. A `Uint8Array`
 * such as `messageSecret` becomes `{ '0': 12, '1': 240, ... }` after crossing
 * the puppeteer boundary, and we want to compact it back into base64.
 * @param {object} obj
 * @returns {boolean}
 */
function looksLikeByteArrayObject(obj) {
    const keys = Object.keys(obj);
    if (keys.length < BYTE_OBJECT_MIN_LENGTH) return false;
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== String(i)) return false;
        if (!isByteValue(obj[i])) return false;
    }
    return true;
}

/**
 * @param {string} type
 * @param {Buffer} buf
 * @returns {{ __type: string, length: number, base64: string }}
 */
function encodeBytes(type, buf) {
    return { __type: type, length: buf.length, base64: buf.toString('base64') };
}

/**
 * Recursively converts an arbitrary value into a JSON-safe structure:
 *  - `Buffer` / typed arrays / `ArrayBuffer` => `{ __type, length, base64 }`
 *  - Node-serialized buffers (`{ type: 'Buffer', data: [...] }`) => base64
 *  - numeric-keyed byte objects (post-serialization typed arrays) => base64
 *  - circular references => `'[Circular]'`
 *  - functions => dropped, bigint => string
 * @param {*} value
 * @param {WeakSet<object>} seen
 * @returns {*}
 */
function sanitize(value, seen) {
    if (value === null || value === undefined) return value;

    const type = typeof value;
    if (type === 'bigint') return value.toString();
    if (type === 'function') return undefined;
    if (type !== 'object') return value;

    if (Buffer.isBuffer(value)) {
        return encodeBytes('Buffer', value);
    }
    if (ArrayBuffer.isView(value)) {
        const buf = Buffer.from(
            value.buffer,
            value.byteOffset,
            value.byteLength,
        );
        return encodeBytes(value.constructor.name, Buffer.from(buf));
    }
    if (value instanceof ArrayBuffer) {
        return encodeBytes('ArrayBuffer', Buffer.from(value));
    }
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
        return encodeBytes('Buffer', Buffer.from(value.data));
    }

    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => sanitize(item, seen));
    }

    if (looksLikeByteArrayObject(value)) {
        const bytes = Object.keys(value).map((key) => value[key]);
        return encodeBytes('BytesObject', Buffer.from(bytes));
    }

    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = sanitize(value[key], seen);
    }
    return out;
}

/**
 * Builds the public-facing view of a Message, skipping the raw `_data` (dumped
 * separately) and the non-enumerable `client` back-reference.
 * @param {import('../src/structures/Message')} message
 * @returns {object}
 */
function buildPublicView(message) {
    const seen = new WeakSet();
    const view = {};
    for (const key of Object.keys(message)) {
        if (key === '_data') continue;
        view[key] = sanitize(message[key], seen);
    }
    return view;
}

/**
 * Returns the list of file names contained in a ZIP buffer, or `null` if the
 * buffer is not a ZIP / cannot be parsed.
 * @param {Buffer} buffer
 * @returns {Promise<string[] | null>}
 */
async function listZipEntries(buffer) {
    // ZIP local file header signature: PK\x03\x04
    if (
        buffer.length < 4 ||
        buffer[0] !== 0x50 ||
        buffer[1] !== 0x4b ||
        buffer[2] !== 0x03 ||
        buffer[3] !== 0x04
    ) {
        return null;
    }

    try {
        const unzipper = require('unzipper');
        const directory = await unzipper.Open.buffer(buffer);
        return directory.files.map((file) => file.path);
    } catch {
        // Fall back to a minimal scan of local file headers for the names only.
        return scanZipNames(buffer);
    }
}

/**
 * Dependency-free fallback: scans local file header signatures and reads the
 * file names. Good enough to confirm the archive layout.
 * @param {Buffer} buffer
 * @returns {string[]}
 */
function scanZipNames(buffer) {
    const names = [];
    let offset = 0;
    while (offset + 30 <= buffer.length) {
        if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const nameStart = offset + 30;
        names.push(buffer.toString('utf8', nameStart, nameStart + nameLength));
        offset = nameStart + nameLength + extraLength + compressedSize;
    }
    return names;
}

/**
 * Maps a mimetype to a sensible file extension for the saved binary.
 * @param {string} mimetype
 * @returns {string}
 */
function extensionForMime(mimetype) {
    if (!mimetype) return 'bin';
    if (mimetype.includes('zip')) return 'zip';
    const subtype = mimetype.split('/')[1];
    return (subtype || 'bin').split(';')[0];
}

/**
 * @param {string} value
 * @returns {string} a filesystem-safe token.
 */
function safeToken(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_');
}

/**
 * Attaches the capture logger to a client's `message_create` event.
 * @param {import('../src/Client')} client
 * @param {object} [options]
 * @param {string} [options.outputDir] Directory for the dumps. Defaults to
 *   `./message-logs`.
 * @param {boolean} [options.downloadMedia] Whether to download and save media.
 *   Defaults to `true`.
 * @param {(message: object) => boolean} [options.filter] Optional predicate to
 *   capture only some messages (e.g. `(m) => m.type === 'sticker-pack'`).
 * @param {string} [options.label] Label written into each dump.
 * @returns {import('../src/Client')} the same client, for chaining.
 */
function attach(client, options = {}) {
    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    const downloadMedia = options.downloadMedia !== false;
    const filter = typeof options.filter === 'function' ? options.filter : null;
    const label = options.label || null;

    fs.mkdirSync(outputDir, { recursive: true });

    client.on('message_create', async (message) => {
        try {
            if (filter && !filter(message)) return;

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const baseName = `${safeToken(message.type)}_${timestamp}_${safeToken(
                message.id && message.id.id,
            )}`;
            const seen = new WeakSet();

            const dump = {
                capturedAt: new Date().toISOString(),
                label,
                top: {
                    type: message.type,
                    from: message.from,
                    to: message.to,
                    author: message.author,
                    fromMe: message.fromMe,
                    hasMedia: message.hasMedia,
                    body: message.body,
                },
                rawData: sanitize(message._data, seen),
                publicView: buildPublicView(message),
                media: null,
            };

            if (downloadMedia && message.hasMedia) {
                dump.media = await captureMedia(message, outputDir, baseName);
            }

            const jsonPath = path.join(outputDir, `${baseName}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(dump, null, 2));
            console.log(`[messageCapture] saved ${jsonPath}`);
        } catch (error) {
            console.error('[messageCapture] failed to capture message:', error);
        }
    });

    console.log(
        `[messageCapture] attached${label ? ` (${label})` : ''}. Dumps will be written to ${outputDir}`,
    );
    return client;
}

/**
 * Downloads a message's media, saves the binary, and (for ZIPs) lists the
 * inner file names. Never throws — returns an error descriptor instead.
 * @param {import('../src/structures/Message')} message
 * @param {string} outputDir
 * @param {string} baseName
 * @returns {Promise<object>}
 */
async function captureMedia(message, outputDir, baseName) {
    try {
        const media = await message.downloadMedia();
        if (!media || !media.data) {
            return { downloaded: false, reason: 'no media returned' };
        }

        const buffer = Buffer.from(media.data, 'base64');

        // A sticker-pack download has no mimetype, so sniff the ZIP signature
        // to pick the right extension instead of falling back to `.bin`.
        const zipEntries = await listZipEntries(buffer);
        const extension = zipEntries ? 'zip' : extensionForMime(media.mimetype);
        const binaryName = `${baseName}.${extension}`;
        const binaryPath = path.join(outputDir, binaryName);
        fs.writeFileSync(binaryPath, buffer);

        const result = {
            downloaded: true,
            mimetype: media.mimetype,
            filename: media.filename,
            filesize: media.filesize,
            savedAs: binaryName,
            byteLength: buffer.length,
        };

        if (zipEntries) {
            result.zipEntries = zipEntries;
        }

        return result;
    } catch (error) {
        return { downloaded: false, reason: String(error && error.message) };
    }
}

module.exports = { attach };
