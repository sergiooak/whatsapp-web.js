'use strict';

const path = require('path');
const Crypto = require('crypto');
const { tmpdir } = require('os');
const { PassThrough } = require('stream');
const archiver = require('archiver');
const ffmpeg = require('fluent-ffmpeg');
const webp = require('node-webpmux');
const fs = require('fs').promises;
const MessageMedia = require('../structures/MessageMedia');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Utility methods
 */
class Util {
    constructor() {
        throw new Error(
            `The ${this.constructor.name} class may not be instantiated.`,
        );
    }

    static generateHash(length) {
        var result = '';
        var characters =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var charactersLength = characters.length;
        for (var i = 0; i < length; i++) {
            result += characters.charAt(
                Math.floor(Math.random() * charactersLength),
            );
        }
        return result;
    }

    /**
     * Sets default properties on an object that aren't already specified.
     * @param {Object} def Default properties
     * @param {Object} given Object to assign defaults to
     * @returns {Object}
     * @private
     */
    static mergeDefault(def, given) {
        if (!given) return def;
        for (const key in def) {
            if (!has(given, key) || given[key] === undefined) {
                given[key] = def[key];
            } else if (given[key] === Object(given[key])) {
                given[key] = Util.mergeDefault(def[key], given[key]);
            }
        }

        return given;
    }

    /**
     * Formats a image to webp
     * @param {MessageMedia} media
     *
     * @returns {Promise<MessageMedia>} media in webp format
     */
    static async formatImageToWebpSticker(media, pupPage) {
        if (!media.mimetype.includes('image'))
            throw new Error('media is not a image');

        if (media.mimetype.includes('webp')) {
            return media;
        }

        return pupPage.evaluate((media) => {
            return window.WWebJS.toStickerData(media);
        }, media);
    }

    /**
     * Formats a video to webp
     * @param {MessageMedia} media
     *
     * @returns {Promise<MessageMedia>} media in webp format
     */
    static async formatVideoToWebpSticker(media) {
        if (!media.mimetype.includes('video'))
            throw new Error('media is not a video');

        const videoType = media.mimetype.split('/')[1];

        const tempFile = path.join(
            tmpdir(),
            `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`,
        );

        const stream = new (require('stream').Readable)();
        const buffer = Buffer.from(
            media.data.replace(`data:${media.mimetype};base64,`, ''),
            'base64',
        );
        stream.push(buffer);
        stream.push(null);

        await new Promise((resolve, reject) => {
            ffmpeg(stream)
                .inputFormat(videoType)
                .on('error', reject)
                .on('end', () => resolve(true))
                .addOutputOptions([
                    '-vcodec',
                    'libwebp',
                    '-vf',
                    // eslint-disable-next-line no-useless-escape
                    "scale='iw*min(300/iw\,300/ih)':'ih*min(300/iw\,300/ih)',format=rgba,pad=300:300:'(300-iw)/2':'(300-ih)/2':'#00000000',setsar=1,fps=10",
                    '-loop',
                    '0',
                    '-ss',
                    '00:00:00.0',
                    '-t',
                    '00:00:05.0',
                    '-preset',
                    'default',
                    '-an',
                    '-vsync',
                    '0',
                    '-s',
                    '512:512',
                ])
                .toFormat('webp')
                .save(tempFile);
        });

        const data = await fs.readFile(tempFile, 'base64');
        await fs.unlink(tempFile);

        return {
            mimetype: 'image/webp',
            data: data,
            filename: media.filename,
        };
    }

    /**
     * @param {Buffer} exif
     * @returns {Object|null}
     * @private
     */
    static _parseWebpExifJson(exif) {
        if (!exif) return null;

        const exifString = exif.toString('utf8');
        const jsonStart = exifString.indexOf('{');
        if (jsonStart === -1) return null;

        try {
            return JSON.parse(exifString.slice(jsonStart));
        } catch (ignoredError) {
            return null;
        }
    }

    /**
     * @param {Buffer} buffer
     * @returns {Promise<{metadata: Object|null, isAnimated: boolean}>}
     * @private
     */
    static async _inspectWebpSticker(buffer) {
        const img = new webp.Image();
        await img.load(buffer);

        return {
            metadata: Util._parseWebpExifJson(img.exif),
            isAnimated: Boolean(img.anim?.frames?.length),
        };
    }

    /**
     * @param {MessageMedia} webpMedia
     * @param {Object} metadata
     * @param {string} metadata.id
     * @param {string} metadata.name
     * @param {string} metadata.publisher
     * @param {string[]} [metadata.categories]
     * @param {boolean} [metadata.userCreatedPack]
     * @returns {Promise<MessageMedia>}
     * @private
     */
    static async _applyWebpStickerMetadata(webpMedia, metadata) {
        const img = new webp.Image();
        const json = {
            'sticker-pack-id': metadata.id,
            'sticker-pack-name': metadata.name,
            'sticker-pack-publisher': metadata.publisher,
        };

        if (Array.isArray(metadata.categories)) {
            json.emojis = metadata.categories;
        }

        if (metadata.userCreatedPack) {
            json['is-from-user-created-pack'] = 1;
        }

        const exifAttr = Buffer.from([
            0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41,
            0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
        ]);
        const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
        const exif = Buffer.concat([exifAttr, jsonBuffer]);
        exif.writeUIntLE(jsonBuffer.length, 14, 4);

        await img.load(Buffer.from(webpMedia.data, 'base64'));
        img.exif = exif;
        webpMedia.data = (await img.save(null)).toString('base64');

        return webpMedia;
    }

    /**
     * @param {{name: string, buffer: Buffer}[]} entries
     * @returns {Promise<Buffer>}
     * @private
     */
    static async _createStickerPackZip(entries) {
        return new Promise((resolve, reject) => {
            const archive = archiver('zip', { zlib: { level: 9 } });
            const stream = new PassThrough();
            const chunks = [];

            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
            archive.on('error', reject);
            archive.on('warning', reject);

            archive.pipe(stream);
            entries.forEach((entry) => {
                archive.append(entry.buffer, { name: entry.name });
            });
            archive.finalize();
        });
    }

    /**
     * Formats media into a native sticker pack payload.
     * @param {MessageMedia[]} mediaList
     * @param {Object} metadata
     * @param {string} metadata.name
     * @param {string} [metadata.publisher]
     * @param {string} [metadata.id]
     * @param {string[]} [metadata.categories]
     * @param {?MessageMedia} [metadata.trayIcon]
     * @param {?MessageMedia} [metadata.thumbnail] - Custom card preview image (overrides auto-generated grid)
     * @param {import('puppeteer').Page} pupPage
     * @returns {Promise<Object>}
     */
    static async formatToWebpStickerPack(mediaList, metadata, pupPage) {
        if (!Array.isArray(mediaList) || mediaList.length === 0) {
            throw new Error(
                'sendMediaAsStickerPack requires a non-empty array of MessageMedia',
            );
        }

        const stickerPackName = (metadata.name || '').trim();
        if (!stickerPackName) {
            throw new Error('stickerPackName is required');
        }

        const stickerPackId = metadata.id || Crypto.randomUUID();
        const stickerPackPublisher = metadata.publisher || '';
        const stickerCategories = Array.isArray(metadata.categories)
            ? metadata.categories
            : undefined;
        const trayIconFileName = `${stickerPackId}.png`;
        const stickers = [];

        for (const media of mediaList) {
            let webpMedia;

            if (media.mimetype.includes('image')) {
                webpMedia = await this.formatImageToWebpSticker(media, pupPage);
            } else if (media.mimetype.includes('video')) {
                webpMedia = await this.formatVideoToWebpSticker(media);
            } else {
                throw new Error('Invalid media format');
            }

            const originalWebpBuffer = Buffer.from(webpMedia.data, 'base64');
            const originalSticker =
                await this._inspectWebpSticker(originalWebpBuffer);
            const originalEmojis = originalSticker.metadata?.emojis;
            const emojis =
                stickerCategories ||
                (Array.isArray(originalEmojis) ? originalEmojis : []);

            webpMedia = await this._applyWebpStickerMetadata(webpMedia, {
                id: stickerPackId,
                name: stickerPackName,
                publisher: stickerPackPublisher,
                categories:
                    stickerCategories ||
                    (Array.isArray(originalEmojis)
                        ? originalEmojis
                        : undefined),
                userCreatedPack: true,
            });

            const buffer = Buffer.from(webpMedia.data, 'base64');
            const fileName = `${Crypto.createHash('sha256')
                .update(buffer)
                .digest('base64')
                .replace(/\//g, '-')}.webp`;
            const stickerInfo = await this._inspectWebpSticker(buffer);

            stickers.push({
                buffer,
                fileName,
                emojis,
                isAnimated: stickerInfo.isAnimated,
                mimetype: 'image/webp',
                isLottie: false,
                accessibilityLabel: '',
            });
        }

        const trayIconSource = metadata.trayIcon || {
            mimetype: 'image/webp',
            data: stickers[0].buffer.toString('base64'),
            filename: stickers[0].fileName,
        };
        const trayIcon = await pupPage.evaluate(
            (media) =>
                window.WWebJS.cropAndResizeImage(media, {
                    mimetype: 'image/png',
                    size: 64,
                }),
            trayIconSource,
        );
        trayIcon.filename = trayIconFileName;
        let thumbnail;
        if (metadata.thumbnail) {
            thumbnail = await pupPage.evaluate(
                (media) =>
                    window.WWebJS.cropAndResizeImage(media, {
                        mimetype: 'image/jpeg',
                        size: 252,
                        quality: 0.79,
                    }),
                metadata.thumbnail,
            );
        } else {
            thumbnail = await pupPage.evaluate(
                (mediaList) =>
                    window.WWebJS.createStickerPackPreview(mediaList, {
                        mimetype: 'image/jpeg',
                        size: 252,
                        quality: 0.79,
                    }),
                stickers.map((sticker) => ({
                    mimetype: 'image/webp',
                    data: sticker.buffer.toString('base64'),
                    filename: sticker.fileName,
                })),
            );
        }
        thumbnail.filename = `${stickerPackId}.jpg`;

        const trayIconBuffer = Buffer.from(trayIcon.data, 'base64');
        const thumbnailBuffer = Buffer.from(thumbnail.data, 'base64');
        const stickerPackSize =
            trayIconBuffer.length +
            stickers.reduce(
                (total, sticker) => total + sticker.buffer.length,
                0,
            );
        const zipBuffer = await this._createStickerPackZip([
            ...stickers.map((sticker) => ({
                name: sticker.fileName,
                buffer: sticker.buffer,
            })),
            {
                name: trayIconFileName,
                buffer: trayIconBuffer,
            },
        ]);

        return {
            media: new MessageMedia(
                'application/zip',
                zipBuffer.toString('base64'),
                stickerPackName,
                zipBuffer.length,
            ),
            thumbnail: new MessageMedia(
                'image/jpeg',
                thumbnail.data,
                thumbnail.filename,
                thumbnailBuffer.length,
            ),
            stickerPackId,
            stickerPackName,
            stickerPackPublisher,
            stickerPackDescription: '',
            stickerPackSize,
            trayIconFileName,
            stickers: stickers.map((sticker) => ({
                fileName: sticker.fileName,
                emojis: sticker.emojis,
                isLottie: sticker.isLottie,
                mimetype: sticker.mimetype,
                isAnimated: sticker.isAnimated,
                accessibilityLabel: sticker.accessibilityLabel,
            })),
        };
    }

    /**
     * Sticker metadata.
     * @typedef {Object} StickerMetadata
     * @property {string} [name]
     * @property {string} [author]
     * @property {string[]} [categories]
     */

    /**
     * Formats a media to webp
     * @param {MessageMedia} media
     * @param {StickerMetadata} metadata
     *
     * @returns {Promise<MessageMedia>} media in webp format
     */
    static async formatToWebpSticker(media, metadata, pupPage) {
        let webpMedia;

        if (media.mimetype.includes('image'))
            webpMedia = await this.formatImageToWebpSticker(media, pupPage);
        else if (media.mimetype.includes('video'))
            webpMedia = await this.formatVideoToWebpSticker(media);
        else throw new Error('Invalid media format');

        if (metadata.name || metadata.author) {
            const img = new webp.Image();
            const hash = this.generateHash(32);
            const stickerPackId = hash;
            const packname = metadata.name;
            const author = metadata.author;
            const categories = metadata.categories || [''];
            const json = {
                'sticker-pack-id': stickerPackId,
                'sticker-pack-name': packname,
                'sticker-pack-publisher': author,
                emojis: categories,
            };
            let exifAttr = Buffer.from([
                0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
                0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00,
                0x00, 0x00,
            ]);
            let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
            let exif = Buffer.concat([exifAttr, jsonBuffer]);
            exif.writeUIntLE(jsonBuffer.length, 14, 4);
            await img.load(Buffer.from(webpMedia.data, 'base64'));
            img.exif = exif;
            webpMedia.data = (await img.save(null)).toString('base64');
        }

        return webpMedia;
    }

    /**
     * Configure ffmpeg path
     * @param {string} path
     */
    static setFfmpegPath(path) {
        ffmpeg.setFfmpegPath(path);
    }
}

module.exports = Util;
