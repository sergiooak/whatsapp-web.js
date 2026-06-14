const { expect } = require('chai');
const unzipper = require('unzipper');

const Util = require('../src/util/Util');
const MessageMedia = require('../src/structures/MessageMedia');

const TINY_WEBP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const TINY_WEBP_ALT = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
const TINY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const TINY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';

describe('Util', function () {
    describe('formatToWebpStickerPack', function () {
        it('creates a native sticker pack payload', async function () {
            let cropCalls = 0;
            let previewArgs;
            const pupPage = {
                evaluate: async (_fn, arg) => {
                    cropCalls++;

                    if (cropCalls === 2) {
                        previewArgs = arg;
                        return {
                            mimetype: 'image/jpeg',
                            data: TINY_JPEG,
                        };
                    }

                    return {
                        mimetype: 'image/png',
                        data: TINY_PNG,
                    };
                },
            };
            const stickerPack = await Util.formatToWebpStickerPack(
                [
                    new MessageMedia('image/webp', TINY_WEBP),
                    new MessageMedia('image/webp', TINY_WEBP_ALT),
                ],
                {
                    id: 'test-pack-id',
                    name: 'Test Pack',
                    publisher: 'WWEBJS',
                    categories: ['robot'],
                },
                pupPage,
            );

            const zipBuffer = Buffer.from(stickerPack.media.data, 'base64');
            const zip = await unzipper.Open.buffer(zipBuffer);
            const zipEntries = zip.files.map((entry) => entry.path);

            expect(stickerPack.media.mimetype).to.equal('application/zip');
            expect(stickerPack.media.filename).to.equal('Test Pack');
            expect(stickerPack.thumbnail.mimetype).to.equal('image/jpeg');
            expect(stickerPack.thumbnail.filename).to.equal('test-pack-id.jpg');
            expect(previewArgs).to.have.lengthOf(2);
            expect(previewArgs[0].mimetype).to.equal('image/webp');
            expect(previewArgs[0].filename).to.equal(
                stickerPack.stickers[0].fileName,
            );
            expect(stickerPack.thumbnailHeight).to.equal(252);
            expect(stickerPack.thumbnailWidth).to.equal(252);
            expect(stickerPack.imageDataHash).to.equal(
                'a79eb19a5ca1bd283f74fff104dd749cdb2364e447a5e0c2369338a8ae76107e',
            );
            expect(stickerPack.stickerPackDescription).to.equal('');
            expect(stickerPack.stickerPackOrigin).to.equal(1);
            expect(stickerPack.trayIconFileName).to.equal('test-pack-id.png');
            expect(stickerPack.stickerPackSize).to.equal(
                zip.files.reduce(
                    (total, entry) => total + entry.uncompressedSize,
                    0,
                ),
            );
            expect(stickerPack.stickers).to.have.lengthOf(2);
            expect(stickerPack.stickers[0].emojis).to.deep.equal(['robot']);
            expect(stickerPack.stickers[0].fileName).to.match(/\.webp$/);
            expect(stickerPack.stickers[0].fileName).to.not.equal(
                stickerPack.stickers[1].fileName,
            );
            expect(zipEntries).to.deep.equal([
                stickerPack.stickers[0].fileName,
                stickerPack.stickers[1].fileName,
                'test-pack-id.png',
            ]);
        });
    });
});
