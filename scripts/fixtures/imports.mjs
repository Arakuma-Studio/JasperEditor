// imports workstream fixtures (docs/wp-notes/imports.md). Everything is generated here (original work, never
// committed): still formats through ffmpeg (EXR half float, 16-bit TIFF, TGA with alpha, BMP, 10-bit DPX, JPEG XL),
// a HEIF still (an HEVC picture from libkvazaar in a HEIF container written below), a numbered PNG sequence with a gap,
// interlaced (top field first) and anamorphic (PAR 10:11) video, a premultiplied-alpha PNG, an SVG, a two-page PDF and
// the same document as `.ai`, a Lottie animation (`.json`) and its dotLottie (`.lottie`), and a layered Photoshop
// document written with ag-psd (blend modes, opacity, hidden layer, group, layer mask, clipping mask).
// The LGPL ffmpeg in vendor/ is preferred when present (it has libkvazaar and libjxl); without them the HEIF / JPEG XL
// fixtures are skipped with a notice.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function vendorFfmpeg(fallback) {
	const p = join(root, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`, 'ffmpeg');
	return existsSync(p) ? p : fallback;
}

function run(ff, args) {
	const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.slice(-400)}`);
}

const hasEncoder = (ff, name) =>
	new RegExp(`\\b${name}\\b`).test(spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '');

// ---------------------------------------------------------------- HEIF writer (ISO/IEC 23008-12, one image item)

function box(type, ...parts) {
	const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
	const head = Buffer.alloc(8);
	head.writeUInt32BE(8 + body.length, 0);
	head.write(type, 4, 'latin1');
	return Buffer.concat([head, body]);
}
const fullBox = (type, version, flags, ...parts) => {
	const vf = Buffer.alloc(4);
	vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
	return box(type, vf, ...parts);
};
const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => {
	const b = Buffer.alloc(2);
	b.writeUInt16BE(v);
	return b;
};
const u32 = (v) => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(v >>> 0);
	return b;
};

/** Annex B HEVC bitstream → NAL units (emulation prevention kept). */
function nalUnits(buf) {
	const out = [];
	let i = 0;
	const starts = [];
	while (i + 3 <= buf.length) {
		if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
			starts.push(i + 3);
			i += 3;
		} else i++;
	}
	for (let k = 0; k < starts.length; k++) {
		let end = k + 1 < starts.length ? starts[k + 1] - 3 : buf.length;
		while (end > starts[k] && buf[end - 1] === 0) end--;
		out.push(buf.subarray(starts[k], end));
	}
	return out;
}

/** RBSP (emulation prevention bytes removed). */
function rbsp(nal) {
	const out = [];
	for (let i = 0; i < nal.length; i++) {
		if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
		out.push(nal[i]);
	}
	return Buffer.from(out);
}

/** hvcC (ISO/IEC 14496-15 §8.3.3) from VPS / SPS / PPS; profile_tier_level copied from the SPS. */
function hvcC(vps, sps, pps) {
	const s = rbsp(sps);
	// NAL header (2 bytes), then sps_video_parameter_set_id(4) sps_max_sub_layers_minus1(3) temporal_id_nesting(1).
	const ptl = s.subarray(3, 3 + 12); // general profile/tier/level: 1 + 4 + 6 + 1 bytes
	const parts = [
		u8(1),
		ptl.subarray(0, 1), // profile_space, tier, profile_idc
		ptl.subarray(1, 5), // compatibility flags
		ptl.subarray(5, 11), // constraint flags
		ptl.subarray(11, 12), // level
		u16(0xf000),
		u8(0xfc),
		u8(0xfd), // chroma 4:2:0
		u8(0xf8), // luma bit depth 8
		u8(0xf8), // chroma bit depth 8
		u16(0),
		u8(0x0f), // constantFrameRate 0, numTemporalLayers 1, nested 1, lengthSizeMinusOne 3
		u8(3),
	];
	for (const [type, nal] of [
		[32, vps],
		[33, sps],
		[34, pps],
	]) {
		parts.push(u8(0x80 | type), u16(1), u16(nal.length), nal);
	}
	return box('hvcC', ...parts);
}

function writeHeif(hevc, width, height) {
	const nals = nalUnits(hevc);
	const type = (n) => (n[0] >> 1) & 0x3f;
	const vps = nals.find((n) => type(n) === 32);
	const sps = nals.find((n) => type(n) === 33);
	const pps = nals.find((n) => type(n) === 34);
	const slices = nals.filter((n) => type(n) < 32);
	if (!vps || !sps || !pps || !slices.length) throw new Error('HEVC bitstream without parameter sets');
	const data = Buffer.concat(slices.flatMap((n) => [u32(n.length), n]));
	const ftyp = box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('mif1heic'));
	const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from('pict'), Buffer.alloc(12), Buffer.from('\0'));
	const pitm = fullBox('pitm', 0, 0, u16(1));
	const infe = fullBox('infe', 2, 0, u16(1), u16(0), Buffer.from('hvc1'), Buffer.from('\0'));
	const iinf = fullBox('iinf', 0, 0, u16(1), infe);
	const ispe = fullBox('ispe', 0, 0, u32(width), u32(height));
	const ipco = box('ipco', hvcC(vps, sps, pps), ispe);
	const ipma = fullBox('ipma', 0, 0, u32(1), u16(1), u8(2), u8(0x81), u8(0x02));
	const iprp = box('iprp', ipco, ipma);
	// iloc v0: offset_size 4, length_size 4, base_offset_size 0; the offset is patched once the size is known.
	const ilocFor = (offset) =>
		fullBox('iloc', 0, 0, u8(0x44), u8(0x00), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(data.length));
	const metaFor = (offset) => fullBox('meta', 0, 0, hdlr, pitm, ilocFor(offset), iinf, iprp);
	const probe = metaFor(0);
	const offset = ftyp.length + probe.length + 8;
	return Buffer.concat([ftyp, metaFor(offset), box('mdat', data)]);
}

// ---------------------------------------------------------------- vector and Lottie sources (original work)

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 200 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff4060"/>
      <stop offset="1" stop-color="#4060ff"/>
    </linearGradient>
  </defs>
  <rect x="5" y="5" width="190" height="90" rx="12" fill="url(#g)"/>
  <circle cx="50" cy="50" r="30" fill="#ffffff" stroke="#202020" stroke-width="4"/>
  <path d="M110 25 L180 25 L145 80 Z" fill="#ffe040" stroke="#202020" stroke-width="2"/>
  <line x1="10" y1="95" x2="190" y2="95" stroke="#000000" stroke-width="0.5"/>
</svg>
`;

/** A two-page PDF 1.4 with vector content (rectangles, a Bézier circle, strokes), xref offsets computed. */
function makePdf() {
	const page1 = [
		'0.2 0.6 1 rg 20 20 360 260 re f',
		'1 1 1 rg 200 150 m 200 205 155 250 100 250 c 45 250 0 205 0 150 c 0 95 45 50 100 50 c 155 50 200 95 200 150 c f',
		'1 0.3 0.2 RG 6 w 40 40 m 360 260 l S',
		'0 g 260 60 100 60 re f',
	].join('\n');
	const page2 = ['0.9 0.9 0.2 rg 0 0 300 200 re f', '0.1 0.1 0.1 rg 50 50 200 100 re f'].join('\n');
	const objs = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R /Resources << >> >>',
		`<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << >> >>',
		`<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
	];
	let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
	const offsets = [];
	objs.forEach((o, i) => {
		offsets.push(Buffer.byteLength(out, 'latin1'));
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, 'latin1');
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

const ease = { o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } };
/** A 3 s, 30 fps, 512×512 Lottie animation: a square slides across, a star spins, a ring is drawn on. */
function makeLottie() {
	const tr = (p) => ({
		ty: 'tr',
		p: { a: 0, k: p },
		a: { a: 0, k: [0, 0] },
		s: { a: 0, k: [100, 100] },
		r: { a: 0, k: 0 },
		o: { a: 0, k: 100 },
		sk: { a: 0, k: 0 },
		sa: { a: 0, k: 0 },
	});
	const ks = (p, r) => ({
		o: { a: 0, k: 100 },
		r,
		p: { a: 0, k: p },
		a: { a: 0, k: [0, 0, 0] },
		s: { a: 0, k: [100, 100, 100] },
	});
	return {
		v: '5.12.0',
		fr: 30,
		ip: 0,
		op: 90,
		w: 512,
		h: 512,
		nm: 'Imports test animation',
		ddd: 0,
		assets: [],
		layers: [
			{
				ddd: 0,
				ind: 1,
				ty: 4,
				nm: 'Square',
				sr: 1,
				ks: {
					...ks([0, 0, 0], { a: 0, k: 0 }),
					p: {
						a: 1,
						k: [
							{ t: 0, s: [96, 128, 0], ...ease },
							{ t: 89, s: [416, 128, 0] },
						],
					},
				},
				ao: 0,
				shapes: [
					{
						ty: 'gr',
						nm: 'Box',
						it: [
							{ ty: 'rc', nm: 'R', d: 1, s: { a: 0, k: [96, 96] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 12 } },
							{ ty: 'fl', nm: 'F', c: { a: 0, k: [1, 0.25, 0.35, 1] }, o: { a: 0, k: 100 }, r: 1 },
							tr([0, 0]),
						],
					},
				],
				ip: 0,
				op: 90,
				st: 0,
				bm: 0,
			},
			{
				ddd: 0,
				ind: 2,
				ty: 4,
				nm: 'Star',
				sr: 1,
				ks: ks([256, 340, 0], {
					a: 1,
					k: [
						{ t: 0, s: [0], o: { x: [0.33], y: [0.33] }, i: { x: [0.67], y: [0.67] } },
						{ t: 89, s: [360] },
					],
				}),
				ao: 0,
				shapes: [
					{
						ty: 'gr',
						nm: 'Star',
						it: [
							{
								ty: 'sr',
								nm: 'S',
								sy: 1,
								d: 1,
								pt: { a: 0, k: 5 },
								p: { a: 0, k: [0, 0] },
								r: { a: 0, k: 0 },
								ir: { a: 0, k: 40 },
								is: { a: 0, k: 0 },
								or: { a: 0, k: 90 },
								os: { a: 0, k: 0 },
							},
							{
								ty: 'fl',
								nm: 'F',
								c: {
									a: 1,
									k: [
										{ t: 0, s: [1, 0.85, 0.1, 1], ...ease },
										{ t: 89, s: [0.1, 0.6, 1, 1] },
									],
								},
								o: { a: 0, k: 100 },
								r: 1,
							},
							tr([0, 0]),
						],
					},
				],
				ip: 0,
				op: 90,
				st: 0,
				bm: 0,
			},
			{
				ddd: 0,
				ind: 3,
				ty: 4,
				nm: 'Ring',
				sr: 1,
				ks: ks([256, 256, 0], { a: 0, k: 0 }),
				ao: 0,
				shapes: [
					{ ty: 'el', nm: 'E', d: 1, s: { a: 0, k: [420, 420] }, p: { a: 0, k: [0, 0] } },
					{
						ty: 'st',
						nm: 'S',
						c: { a: 0, k: [0.15, 0.15, 0.2, 1] },
						o: { a: 0, k: 100 },
						w: { a: 0, k: 16 },
						lc: 2,
						lj: 2,
					},
					{
						ty: 'tm',
						nm: 'T',
						s: { a: 0, k: 0 },
						e: {
							a: 1,
							k: [
								{ t: 0, s: [0], ...ease },
								{ t: 60, s: [100] },
							],
						},
						o: { a: 0, k: 0 },
						m: 1,
					},
				],
				ip: 0,
				op: 90,
				st: 0,
				bm: 0,
			},
		],
		markers: [],
	};
}

let CRC;
function crc32(data) {
	if (!CRC) {
		CRC = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			CRC[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP with deflated entries (dotLottie). */
function zip(files) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const f of files) {
		const name = Buffer.from(f.name);
		const comp = deflateRawSync(f.data);
		const crc = crc32(f.data);
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(0x04034b50, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt16LE(8, 8);
		loc.writeUInt32LE(crc, 14);
		loc.writeUInt32LE(comp.length, 18);
		loc.writeUInt32LE(f.data.length, 22);
		loc.writeUInt16LE(name.length, 26);
		locals.push(loc, name, comp);
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(8, 10);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(comp.length, 20);
		cen.writeUInt32LE(f.data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, name);
		offset += 30 + name.length + comp.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------- PSD (ag-psd writer)

/** RGBA pixels of a w×h layer filled by `f(x, y) → [r, g, b, a]` (0…255). */
function pixels(w, h, f) {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const [r, g, b, a] = f(x, y);
			const k = (y * w + x) * 4;
			data[k] = r;
			data[k + 1] = g;
			data[k + 2] = b;
			data[k + 3] = a;
		}
	return { width: w, height: h, data };
}

/**
 * 320×240: white background; a red square (normal); a blue disc (multiply, 70 %); a hidden yellow bar; a group
 * "Badge" (normal, 80 %) with a green square and a clipped stripe pattern on it; a layer with a gradient layer mask.
 */
export function makePsd(agPsd) {
	const W = 320;
	const H = 240;
	const layer = (name, left, top, w, h, f, extra = {}) => ({
		name,
		left,
		top,
		right: left + w,
		bottom: top + h,
		imageData: pixels(w, h, f),
		blendMode: 'normal',
		opacity: 1,
		...extra,
	});
	const disc = (w, h, rgb) => (x, y) => {
		const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) - w / 2;
		const a = Math.max(0, Math.min(1, 0.5 - d));
		return [...rgb, Math.round(a * 255)];
	};
	const maskW = 80;
	const maskH = 80;
	const psd = {
		width: W,
		height: H,
		children: [
			layer('Background', 0, 0, W, H, () => [255, 255, 255, 255]),
			layer('Red', 20, 20, 100, 100, () => [220, 40, 40, 255]),
			layer('Blue', 70, 60, 120, 120, disc(120, 120, [40, 80, 220]), { blendMode: 'multiply', opacity: 0.7 }),
			layer('Hidden', 0, 200, 320, 20, () => [250, 220, 0, 255], { hidden: true }),
			{
				name: 'Badge',
				blendMode: 'normal',
				opacity: 0.8,
				opened: true,
				children: [
					layer('Green', 200, 30, 90, 90, () => [30, 180, 60, 255]),
					layer('Stripes', 180, 10, 130, 130, (x) => (Math.floor(x / 10) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]), {
						clipping: true,
					}),
				],
			},
			layer('Masked', 220, 150, maskW, maskH, () => [160, 60, 200, 255], {
				mask: {
					left: 220,
					top: 150,
					right: 220 + maskW,
					bottom: 150 + maskH,
					defaultColor: 0,
					imageData: pixels(maskW, maskH, (x) => {
						const v = Math.round((x / (maskW - 1)) * 255);
						return [v, v, v, 255];
					}),
				},
			}),
		],
	};
	return Buffer.from(agPsd.writePsdBuffer(psd, { generateThumbnail: false }));
}

export async function fixtures(ctx) {
	const ff = vendorFfmpeg(ctx.ffmpeg);
	const jxl = hasEncoder(ff, 'libjxl');
	const kvazaar = hasEncoder(ff, 'libkvazaar');
	const require = createRequire(join(root, 'apps', 'engine', 'package.json'));
	const pattern = 'testsrc2=size=320x240:rate=30:duration=1';
	const still = (name, extra, recipe = 'v1') => ({
		name,
		recipe: `${name}:${recipe}:${JSON.stringify(extra)}`,
		make: (out) => {
			const tmp = `${out}${name.slice(name.lastIndexOf('.'))}`;
			run(ff, ['-f', 'lavfi', '-i', pattern, '-frames:v', '1', ...extra, tmp]);
			writeFileSync(out, readFileSync(tmp));
			rmSync(tmp, { force: true });
		},
	});
	const list = [
		still('imports-still.exr', ['-vf', 'format=gbrapf32le', '-c:v', 'exr', '-format', 'half', '-compression', 'zip1']),
		still('imports-still-16.tif', ['-vf', 'format=rgb48le', '-c:v', 'tiff']),
		still('imports-still.tga', [
			'-vf',
			"format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,160),255,96)'",
			'-c:v',
			'targa',
		]),
		still('imports-still.bmp', ['-vf', 'format=bgr24', '-c:v', 'bmp']),
		still('imports-still.dpx', ['-vf', 'format=gbrp10le', '-c:v', 'dpx']),
		// Premultiplied over black: colour already multiplied by alpha (the right half is half transparent).
		still('imports-premul.png', [
			'-vf',
			"format=rgba,geq=r='r(X,Y)*if(lt(X,160),1,0.5)':g='g(X,Y)*if(lt(X,160),1,0.5)':b='b(X,Y)*if(lt(X,160),1,0.5)':a='if(lt(X,160),255,128)'",
			'-c:v',
			'png',
		]),
		{
			name: 'imports-seq',
			recipe: 'imports-seq:v1:12 frames, 0007 missing',
			make: (out) => {
				mkdirSync(out, { recursive: true });
				for (let n = 1; n <= 12; n++) {
					if (n === 7) continue;
					const shade = (n * 20).toString(16).padStart(2, '0');
					run(ff, [
						'-f',
						'lavfi',
						'-i',
						`color=c=0x${shade}4080:size=160x90:duration=1`,
						'-frames:v',
						'1',
						'-vf',
						`drawbox=x=${n * 10}:y=10:w=10:h=70:color=white:t=fill`,
						join(out, `shot_${String(n).padStart(4, '0')}.png`),
					]);
				}
			},
		},
		{
			name: 'imports-interlaced.mkv',
			recipe: 'imports-interlaced:v3',
			// Two fields 1/60 s apart woven into each frame (a box moving 8 px per field: combing on edges).
			make: (out) =>
				run(ff, [
					'-f',
					'lavfi',
					'-i',
					'color=c=0x204060:size=320x120:rate=60:duration=1',
					'-f',
					'lavfi',
					'-i',
					'color=c=white:size=60x60:rate=60:duration=1',
					'-filter_complex',
					"[0][1]overlay=x='t*480':y=30,weave=first_field=top,setfield=tff",
					'-c:v',
					'ffv1',
					'-f',
					'matroska',
					out,
				]),
		},
		{
			name: 'imports-anamorphic.mkv',
			recipe: 'imports-anamorphic:v1',
			make: (out) =>
				run(ff, [
					'-f',
					'lavfi',
					'-i',
					'testsrc2=size=720x480:rate=30:duration=1',
					'-vf',
					'setsar=10/11',
					'-c:v',
					'ffv1',
					'-f',
					'matroska',
					out,
				]),
		},
		{ name: 'imports-logo.svg', recipe: `svg:${SVG.length}`, make: (out) => writeFileSync(out, SVG) },
		{ name: 'imports-doc.pdf', recipe: 'pdf:v1', make: (out) => writeFileSync(out, makePdf()) },
		{ name: 'imports-doc.ai', recipe: 'ai:v1', make: (out) => writeFileSync(out, makePdf()) },
		{
			name: 'imports-anim.json',
			recipe: 'lottie:v1',
			make: (out) => writeFileSync(out, JSON.stringify(makeLottie())),
		},
		{
			name: 'imports-anim.lottie',
			recipe: 'dotlottie:v1',
			make: (out) =>
				writeFileSync(
					out,
					zip([
						{
							name: 'manifest.json',
							data: Buffer.from(JSON.stringify({ version: '1', animations: [{ id: 'spin' }] })),
						},
						{ name: 'animations/spin.json', data: Buffer.from(JSON.stringify(makeLottie())) },
					]),
				),
		},
		{
			name: 'imports-layers.psd',
			recipe: 'psd:v2',
			make: (out) => writeFileSync(out, makePsd(require('ag-psd'))),
		},
	];
	if (jxl) list.push(still('imports-still.jxl', ['-c:v', 'libjxl', '-distance', '0']));
	else console.log('skip   imports-still.jxl (no libjxl encoder)');
	if (kvazaar)
		list.push({
			name: 'imports-still.heic',
			recipe: 'heic:v1',
			make: (out) => {
				const tmp = `${out}.hevc`;
				run(ff, ['-f', 'lavfi', '-i', pattern, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libkvazaar', '-f', 'hevc', tmp]);
				writeFileSync(out, writeHeif(readFileSync(tmp), 320, 240));
				rmSync(tmp, { force: true });
			},
		});
	else console.log('skip   imports-still.heic (no libkvazaar encoder)');
	return list;
}
