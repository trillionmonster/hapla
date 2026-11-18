import { describe, expect, it } from 'vitest';
import { isDirectMediaUrl } from './directMediaUrl';

describe('isDirectMediaUrl', () => {
    it('recognizes uploaded server media and browser-native URLs', () => {
        expect(isDirectMediaUrl('/files/public/users/u/chat-images/generated.png')).toBe(true);
        expect(isDirectMediaUrl('https://cdn.example.com/video.webm')).toBe(true);
        expect(isDirectMediaUrl('data:image/png;base64,AQID')).toBe(true);
        expect(isDirectMediaUrl('blob:https://app.example/id')).toBe(true);
    });

    it('does not mistake local absolute paths or protocol-relative hosts for server media', () => {
        expect(isDirectMediaUrl('/home/user/project/image.png')).toBe(false);
        expect(isDirectMediaUrl('/etc/passwd')).toBe(false);
        expect(isDirectMediaUrl('//evil.example/image.png')).toBe(false);
        expect(isDirectMediaUrl('./image.png')).toBe(false);
    });
});
