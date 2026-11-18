import { processImage } from './processImage';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

describe('processImage', () => {
    it('should resize image', async () => {
        const image = await sharp({
            create: {
                width: 200,
                height: 100,
                channels: 3,
                background: { r: 35, g: 120, b: 220 },
            },
        }).jpeg().toBuffer();
        const result = await processImage(image);

        expect(result).toMatchObject({ width: 200, height: 100, format: 'jpeg' });
        expect(result.pixels).toHaveLength(100 * 50 * 4);
        expect(result.thumbhash.length).toBeGreaterThan(0);
    });
});
