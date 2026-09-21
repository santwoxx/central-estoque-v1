// Gera build/icon.png (256x256) sem dependência nenhuma — só zlib do Node.
//
// Existe porque o instalador sem ícone próprio aparece com o átomo do Electron,
// e para quem recebe o programa por link isso parece coisa genérica ou
// suspeita. Um pneu (anel) sobre fundo escuro, com a marca de "fechado".
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const px = Buffer.alloc(SIZE * SIZE * 4);

// Cores (RGBA)
const BG = [15, 23, 42];       // slate-900
const RING = [212, 147, 33];   // dourado do sistema
const HUB = [30, 41, 59];      // slate-800
const CHECK = [52, 211, 153];  // verde

const cx = SIZE / 2;
const cy = SIZE / 2;
const radiusCorner = 52;

function inRoundedSquare(x, y) {
  const r = radiusCorner;
  const min = 0, max = SIZE - 1;
  const nx = Math.min(Math.max(x, min + r), max - r);
  const ny = Math.min(Math.max(y, min + r), max - r);
  return (x - nx) ** 2 + (y - ny) ** 2 <= r * r;
}

// Distância de um ponto a um segmento — para desenhar o "check" com espessura.
function distToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const px2 = x1 + t * dx, py2 = y1 + t * dy;
  return Math.hypot(x - px2, y - py2);
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (!inRoundedSquare(x, y)) {
      px[i + 3] = 0; // transparente fora do quadrado arredondado
      continue;
    }
    let color = BG;
    const d = Math.hypot(x - cx, y - cy);

    // Pneu: anel grosso com "sulcos" (dentes) na borda externa.
    const angle = Math.atan2(y - cy, x - cx);
    const tread = Math.cos(angle * 24) > 0.2 ? 6 : 0;
    if (d <= 92 + tread && d >= 58) color = RING;
    if (d < 58) color = HUB;

    // Check verde por cima do centro.
    const dc = Math.min(
      distToSegment(x, y, 100, 130, 122, 152),
      distToSegment(x, y, 122, 152, 160, 106)
    );
    if (dc <= 9) color = CHECK;

    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = 255;
  }
}

// ── PNG ──
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filtro "none" por linha
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log(`[icone] ${out} (${png.length} bytes)`);
