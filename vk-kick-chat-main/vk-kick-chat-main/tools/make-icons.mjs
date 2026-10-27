// Рисует иконки extension/icons/{16,32,48,128}.png без сторонних библиотек.
// Скруглённый квадрат: слева зелёный Kick, справа синий VK, по центру белый «пузырь» чата.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
};

function png(size) {
    const S = 4; // суперсэмплинг для сглаживания
    const raw = Buffer.alloc((size * 4 + 1) * size);
    const r = size * 0.22;
    const inRounded = (x, y) => {
        const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    };
    const inBubble = (x, y) => {
        const bx = size * 0.5, by = size * 0.46, rx = size * 0.3, ry = size * 0.22;
        if (((x - bx) / rx) ** 2 + ((y - by) / ry) ** 2 <= 1) return true;
        // хвостик
        const tx = x - size * 0.34, ty = y - size * 0.6;
        return tx >= 0 && ty >= 0 && tx + ty * 0.9 <= size * 0.14;
    };
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            let a = 0, R = 0, G = 0, B = 0;
            for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
                const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
                if (!inRounded(px, py)) continue;
                a++;
                let c;
                if (inBubble(px, py)) c = [255, 255, 255];
                else c = px + py * 0.35 < size * 0.68 ? [83, 252, 24] : [45, 140, 255];
                R += c[0]; G += c[1]; B += c[2];
            }
            const o = y * (size * 4 + 1) + 1 + x * 4;
            raw[o] = a ? R / a : 0; raw[o + 1] = a ? G / a : 0; raw[o + 2] = a ? B / a : 0;
            raw[o + 3] = Math.round(255 * a / (S * S));
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
}

for (const s of [16, 32, 48, 128]) writeFileSync(join(out, `${s}.png`), png(s));
console.log('Иконки готовы:', out);
