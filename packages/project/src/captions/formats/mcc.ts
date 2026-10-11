// MacCaption MCC (`.mcc`): closed-caption data as text, one line per video frame, each line a SMPTE ST 334-2
// caption distribution packet (CDP) carrying CEA-608 byte pairs and CEA-708 (DTVCC) packets, written in hex with
// MacCaption's letter abbreviations. Ported from FilmCraft `crates/captions/src/mcc.rs`; see
// licenses/ported/captions.md.
//
// - Line: `timecode<TAB>data`; data is ancillary DID/SDID `61 01`, a byte count, then the CDP. Letters stand for
//   byte runs: `G`–`O` = 1–9 × `FA 00 00`, `P` = `FB 80 80`, `Q` = `FC 80 80`, `R` = `FD 80 80`, `S` = `96 69`,
//   `T` = `61 01`, `U` = `E1 00 00 00`, `Z` = `00`.
// - CDP: identifier `96 69`, length, frame-rate code, flags, sequence counter, a `cc_data` section (`72`,
//   `E0 | cc_count`, cc_count × (marker/valid/type, two bytes)), optional sections, footer `74`, the counter again
//   and a checksum that makes the packet's byte sum 0 mod 256.
// - Writing (29.97 fps, `30DF` or `30` labels): every frame from the first caption data to one frame after the
//   last carries a CDP with 20 cc_data triplets: field 1 CEA-608 pop-on data (the SCC schedule), a null field-2
//   pair, CEA-708 service 1 data and padding. The CEA-708 captions emulate pop-on with two windows.
// - Reading: channel 1 CEA-608 field-1 data is decoded with the SCC decoder when present, otherwise CEA-708
//   service 1. `Time Code Rate` 30DF / 30 → 29.97 fps, 60DF / 60 → 59.94, 24, 25, 50.
import type { Rational } from '../../time.ts';
import { withParity } from './cea608.ts';
import {
	type CaptionDocument,
	CaptionFormatError,
	type Cue,
	emptyCaptionDocument,
	plainCaptionText,
} from './core.ts';
import {
	fieldsToFrameCount,
	framesToFields,
	RATE_23_976,
	RATE_24,
	RATE_25,
	RATE_29_97,
	RATE_30,
	RATE_50,
	RATE_59_94,
	RATE_60,
	rateEquals,
	tickOf,
} from './rate.ts';
import { decodeCea608Pairs, sccFrameOf, scheduleCea608, wrapSccRows } from './scc.ts';

/** MCC files written by JasperEditor are 29.97 fps. */
export const MCC_RATE: Rational = RATE_29_97;
const CC_COUNT = 20;
/** cc_data triplets per frame left for CEA-708 (after the two CEA-608 fields). */
const DTVCC_PAIRS = CC_COUNT - 2;

const ABBREV: Array<[string, number[]]> = [
	['P', [0xfb, 0x80, 0x80]],
	['Q', [0xfc, 0x80, 0x80]],
	['R', [0xfd, 0x80, 0x80]],
	['S', [0x96, 0x69]],
	['T', [0x61, 0x01]],
	['U', [0xe1, 0x00, 0x00, 0x00]],
	['Z', [0x00]],
];

function startsWithAt(b: ArrayLike<number>, i: number, seq: number[]): boolean {
	if (i + seq.length > b.length) return false;
	for (let k = 0; k < seq.length; k++) if (b[i + k] !== seq[k]) return false;
	return true;
}

/** Bytes → MCC text (uppercase hex with abbreviations). */
export function mccCompress(b: ArrayLike<number>): string {
	let out = '';
	let i = 0;
	outer: while (i < b.length) {
		let n = 0;
		while (n < 9 && startsWithAt(b, i + 3 * n, [0xfa, 0x00, 0x00])) n++;
		if (n > 0) {
			out += String.fromCharCode(0x47 + n - 1);
			i += 3 * n;
			continue;
		}
		for (const [c, seq] of ABBREV) {
			if (startsWithAt(b, i, seq)) {
				out += c;
				i += seq.length;
				continue outer;
			}
		}
		out += b[i]!.toString(16).toUpperCase().padStart(2, '0');
		i++;
	}
	return out;
}

/** MCC text → bytes (null if malformed). */
export function mccExpand(s: string): number[] | null {
	const out: number[] = [];
	let hex: number | null = null;
	for (const ch of s) {
		if (/\s/.test(ch)) continue;
		if (/^[0-9a-fA-F]$/.test(ch)) {
			const d = Number.parseInt(ch, 16);
			if (hex !== null) {
				out.push((hex << 4) | d);
				hex = null;
			} else hex = d;
			continue;
		}
		if (hex !== null) return null;
		const c = ch.toUpperCase();
		if (c >= 'G' && c <= 'O') {
			for (let k = 0; k < c.charCodeAt(0) - 0x47 + 1; k++) out.push(0xfa, 0x00, 0x00);
			continue;
		}
		const a = ABBREV.find((x) => x[0] === c);
		if (!a) return null;
		out.push(...a[1]);
	}
	return hex !== null ? null : out;
}

/** One frame's caption data: a field-1 CEA-608 pair (no parity) and DTVCC pairs `[startOfPacket, b1, b2]`. */
export type MccFrameData = { f1: [number, number] | null; dtvcc: Array<[boolean, number, number]> };

function rateCode(r: Rational): number {
	const table: Array<[Rational, number]> = [
		[RATE_23_976, 1],
		[RATE_24, 2],
		[RATE_25, 3],
		[RATE_29_97, 4],
		[RATE_30, 5],
		[RATE_50, 6],
		[RATE_59_94, 7],
		[RATE_60, 8],
	];
	return table.find(([x]) => rateEquals(x, r))?.[1] ?? 4;
}

/** A CDP for one 29.97 fps frame, prefixed with the ancillary DID/SDID (`61 01`) and count. */
export function buildCdp(seq: number, data: MccFrameData): number[] {
	const cc: number[] = [];
	if (data.f1) cc.push(0xfc, withParity(data.f1[0]), withParity(data.f1[1]));
	else cc.push(0xfc, 0x80, 0x80);
	cc.push(0xfd, 0x80, 0x80);
	for (const [start, a, b] of data.dtvcc.slice(0, DTVCC_PAIRS)) cc.push(start ? 0xff : 0xfe, a, b);
	while (cc.length < CC_COUNT * 3) cc.push(0xfa, 0x00, 0x00);
	const len = 7 + 2 + cc.length + 4;
	const s1 = (seq >> 8) & 0xff;
	const s0 = seq & 0xff;
	const cdp = [0x96, 0x69, len & 0xff, (rateCode(MCC_RATE) << 4) | 0x0f, 0x43, s1, s0, 0x72, 0xe0 | CC_COUNT];
	cdp.push(...cc, 0x74, s1, s0);
	const sum = cdp.reduce((a, b) => a + b, 0);
	cdp.push((256 - (sum % 256)) % 256);
	return [0x61, 0x01, cdp.length & 0xff, ...cdp];
}

/** The cc_data triplets of one line's bytes (an ancillary packet with a CDP, or a bare CDP). */
export function ccTriplets(b: number[]): Array<[number, number, number]> | null {
	let cdp = b;
	if (b[0] === 0x61 && b[1] === 0x01) {
		if (b.length < 3) return null;
		cdp = b.slice(3);
	}
	if (cdp[0] !== 0x96 || cdp[1] !== 0x69) return null;
	if (cdp.length < 3) return null;
	cdp = cdp.slice(0, Math.min(cdp[2]!, cdp.length));
	let i = 7;
	const out: Array<[number, number, number]> = [];
	const at = (k: number) => {
		const v = cdp[k];
		if (v === undefined) throw new RangeError('short CDP');
		return v;
	};
	try {
		while (i < cdp.length) {
			const t = cdp[i]!;
			if (t === 0x71) i += 5;
			else if (t === 0x72) {
				const n = at(i + 1) & 0x1f;
				for (let k = 0; k < n; k++) {
					const p = i + 2 + 3 * k;
					out.push([at(p), at(p + 1), at(p + 2)]);
				}
				i += 2 + 3 * n;
			} else if (t === 0x73) i += 2 + 7 * (at(i + 1) & 0x0f);
			else if (t === 0x74) break;
			else if (t >= 0x75 && t <= 0xef) i += 2 + at(i + 1);
			else return null;
		}
	} catch {
		return null;
	}
	return out;
}

/** G2 characters we write / read (after EXT1). */
const G2: Array<[number, string]> = [
	[0x25, '…'],
	[0x2a, 'Š'],
	[0x2c, 'Œ'],
	[0x31, '‘'],
	[0x32, '’'],
	[0x33, '“'],
	[0x34, '”'],
	[0x35, '•'],
	[0x39, '™'],
	[0x3a, 'š'],
	[0x3c, 'œ'],
	[0x3d, '℠'],
	[0x3f, 'Ÿ'],
	[0x76, '⅛'],
	[0x77, '⅜'],
	[0x78, '⅝'],
	[0x79, '⅞'],
];

/** Service-data atoms for a character. */
function charAtom(c: string): number[] {
	if (c === '♪') return [0x7f];
	const cp = c.codePointAt(0)!;
	if (cp >= 0x20 && cp <= 0x7e) return [cp];
	if (cp >= 0xa0 && cp <= 0xff) return [cp];
	const g = G2.find((x) => x[1] === c);
	return g ? [0x10, g[0]] : [0x3f];
}

/** Atoms that define window `win` hidden and load `rows` into it. */
function loadAtoms(win: number, rows: string[]): number[][] {
	const rc = Math.min(12, Math.max(1, rows.length)) - 1;
	const cols = Math.min(42, Math.max(1, ...rows.map((r) => [...r].length), 1)) - 1;
	const v: number[][] = [
		// DefineWindow: hidden, row/column lock, relative position 90 % down / 50 % across, anchored at its bottom
		// centre, rows / columns, window style 1, pen style 1
		[0x98 + win, 0x18, 0x80 | 90, 50, (7 << 4) | rc, cols, (1 << 3) | 1],
		[0x88, 1 << win], // ClearWindows
	];
	rows.forEach((r, i) => {
		if (i > 0) v.push([0x0d]);
		for (const ch of r) v.push(charAtom(ch));
	});
	return v;
}

/** Pack atoms into DTVCC packets for service 1 (each ≤ 34 bytes, so one fits in a frame). */
function packets(atoms: number[][], seq: { n: number }): number[][] {
	const blocks: number[][] = [];
	let cur: number[] = [];
	for (const a of atoms) {
		if (cur.length + a.length > 31) {
			blocks.push(cur);
			cur = [];
		}
		cur.push(...a);
	}
	if (cur.length) blocks.push(cur);
	return blocks.map((b) => {
		const p = [0, (1 << 5) | b.length, ...b];
		if (p.length % 2 === 1) p.push(0);
		p[0] = ((seq.n & 3) << 6) | (p.length / 2);
		seq.n = (seq.n + 1) & 0xff;
		return p;
	});
}

function pairsOf(packet: number[]): Array<[boolean, number, number]> {
	const out: Array<[boolean, number, number]> = [];
	for (let i = 0; i < packet.length; i += 2) out.push([i === 0, packet[i]!, packet[i + 1] ?? 0]);
	return out;
}

/** Schedule CEA-708 service 1 pop-on captions. */
function schedule708(doc: CaptionDocument): Map<number, Array<[boolean, number, number]>> {
	const frames = new Map<number, Array<[boolean, number, number]>>();
	const room = (f: number) => DTVCC_PAIRS - (frames.get(f)?.length ?? 0);
	const place = (start: number, packet: number[]) => {
		const pairs = pairsOf(packet);
		let f = start;
		while (room(f) < pairs.length) f++;
		const list = frames.get(f) ?? [];
		list.push(...pairs);
		frames.set(f, list);
		return f;
	};
	const seq = { n: 0 };
	let cursor = 0;
	const cues = doc.cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
	cues.forEach((c, i) => {
		const win = i % 2;
		const s = Math.max(sccFrameOf(c.start), cursor);
		const e = sccFrameOf(c.end);
		const rows = wrapSccRows(plainCaptionText(c.text));
		const load = packets(loadAtoms(win, rows), seq);
		let f = Math.max(s - load.length, cursor);
		let last = f;
		for (const p of load) {
			last = place(f, p);
			f = last;
		}
		const show = packets(
			[
				[0x8a, 1 << (1 - win)],
				[0x89, 1 << win],
			],
			seq,
		);
		const shown = place(Math.max(s, last), show[0]!);
		cursor = shown + 1;
		const next = cues[i + 1];
		const nextStart = next ? sccFrameOf(next.start) : null;
		if (nextStart !== e) {
			const hide = packets([[0x8a, 1 << win]], seq);
			place(Math.max(e, cursor), hide[0]!);
		}
	});
	return frames;
}

type Win = { defined: boolean; visible: boolean; rows: string[] };
const newWin = (): Win => ({ defined: false, visible: false, rows: [] });

/** CEA-708 decoder state for service 1. */
class Dec708 {
	win: Win[] = Array.from({ length: 8 }, newWin);
	cur = 0;
	packet: number[] = [];
	want = 0;
	open: { start: number; text: string } | null = null;
	cues: Array<{ start: number; end: number; text: string }> = [];

	visibleText(): string {
		const lines: string[] = [];
		for (const w of this.win)
			if (w.defined && w.visible) lines.push(...w.rows.map((r) => r.trim()).filter((r) => r.length > 0));
		return lines.join('\n');
	}
	sync(f: number): void {
		const now = this.visibleText();
		if ((this.open && this.open.text === now) || (!this.open && !now)) return;
		const o = this.open;
		this.open = null;
		if (o && f > o.start) this.cues.push({ start: o.start, end: f, text: o.text });
		if (now) this.open = { start: f, text: now };
	}
	pair(f: number, start: boolean, a: number, b: number): void {
		if (start) {
			this.packet = [];
			const size = a & 0x3f;
			this.want = size === 0 ? 128 : size * 2;
		} else if (this.want === 0) return;
		this.packet.push(a, b);
		if (this.packet.length >= this.want) {
			const p = this.packet;
			this.packet = [];
			this.want = 0;
			this.serviceBlocks(p.slice(1));
			this.sync(f);
		}
	}
	serviceBlocks(input: number[]): void {
		let b = input;
		while (b.length > 0) {
			const h = b[0]!;
			if (h === 0) break;
			let svc = h >> 5;
			const len = h & 0x1f;
			let skip = 1;
			if (svc === 7) {
				svc = (b[1] ?? 0) & 0x3f;
				skip = 2;
			}
			const data = b.slice(skip, skip + len);
			if (svc === 1) this.serviceData(data);
			b = b.slice(skip + len);
		}
	}
	w(): Win {
		return this.win[this.cur]!;
	}
	put(c: string): void {
		const w = this.w();
		if (w.rows.length) w.rows[w.rows.length - 1] += c;
		else w.rows.push(c);
	}
	bitmap(m: number, fn: (w: Win, i: number) => void): void {
		this.win.forEach((w, i) => {
			if (m & (1 << i)) fn(w, i);
		});
	}
	serviceData(d: number[]): void {
		let i = 0;
		const arg = (k: number) => d[k] ?? 0;
		while (i < d.length) {
			const c = d[i]!;
			i++;
			if (c === 0x03 || c === 0x00) continue;
			if (c === 0x08) {
				const w = this.w();
				if (w.rows.length) w.rows[w.rows.length - 1] = [...w.rows[w.rows.length - 1]!].slice(0, -1).join('');
			} else if (c === 0x0c) this.w().rows = [''];
			else if (c === 0x0d) this.w().rows.push('');
			else if (c === 0x0e) {
				const w = this.w();
				if (w.rows.length) w.rows[w.rows.length - 1] = '';
			} else if (c === 0x10) {
				const x = arg(i);
				i++;
				if (x <= 0x07) {
					/* C2 single byte */
				} else if (x <= 0x0f) i += 1;
				else if (x <= 0x17) i += 2;
				else if (x <= 0x1f) i += 3;
				else if (x === 0x20 || x === 0x21) this.put(' ');
				else if (x <= 0x7f) {
					const g = G2.find((y) => y[0] === x);
					if (g) this.put(g[1]);
				} else if (x <= 0x87) i += 4;
				else if (x <= 0x8f) i += 5;
				else if (x <= 0x9f) i += 1 + (arg(i) & 0x1f);
			} else if (c >= 0x11 && c <= 0x17) i += 1;
			else if (c >= 0x18 && c <= 0x1f) i += 2;
			else if (c >= 0x20 && c <= 0x7e) this.put(String.fromCharCode(c));
			else if (c === 0x7f) this.put('♪');
			else if (c >= 0x80 && c <= 0x87) this.cur = c - 0x80;
			else if (c === 0x88) {
				this.bitmap(arg(i), (w) => {
					w.rows = [''];
				});
				i++;
			} else if (c === 0x89) {
				this.bitmap(arg(i), (w) => {
					w.visible = true;
				});
				i++;
			} else if (c === 0x8a) {
				this.bitmap(arg(i), (w) => {
					w.visible = false;
				});
				i++;
			} else if (c === 0x8b) {
				this.bitmap(arg(i), (w) => {
					w.visible = !w.visible;
				});
				i++;
			} else if (c === 0x8c) {
				this.bitmap(arg(i), (_w, k) => {
					this.win[k] = newWin();
				});
				i++;
			} else if (c === 0x8d) i += 1;
			else if (c === 0x8e || c === 0x8f || (c >= 0x93 && c <= 0x96)) {
				/* no params */
			} else if (c === 0x90 || c === 0x92) i += 2;
			else if (c === 0x91) i += 3;
			else if (c === 0x97) i += 4;
			else if (c >= 0x98 && c <= 0x9f) {
				const n = c - 0x98;
				const vis = (arg(i) & 0x20) !== 0;
				const w = this.win[n]!;
				if (!w.defined) this.win[n] = { defined: true, visible: vis, rows: [''] };
				else w.visible = vis;
				this.cur = n;
				i += 6;
			} else if (c >= 0xa0) this.put(String.fromCharCode(c));
		}
	}
}

/** Write `doc` as MCC with CEA-608 field 1 and/or CEA-708 service 1. */
export function writeMcc(
	doc: CaptionDocument,
	dropFrame: boolean,
	opts: { cea608?: boolean; cea708?: boolean } = {},
): string {
	const f1 = opts.cea608 === false ? new Map<number, [number, number]>() : scheduleCea608(doc);
	const dtv = opts.cea708 === false ? new Map<number, Array<[boolean, number, number]>>() : schedule708(doc);
	let out = 'File Format=MacCaption_MCC V1.0\n\n';
	out += '///////////////////////////////////////////////////////////////////////////////////\n';
	out += '// Closed captions written by JasperEditor: SMPTE ST 334-2 caption distribution packets\n';
	out += '// carrying CEA-608 field 1 and CEA-708 service 1 data, one packet per frame.\n';
	out += '///////////////////////////////////////////////////////////////////////////////////\n\n';
	// deterministic UUID from the cue times (FNV-1a style mix)
	let h = 0xcbf29ce484222325n ^ BigInt(doc.cues.length);
	const M = (1n << 64n) - 1n;
	for (const c of doc.cues) {
		const end = BigInt(Math.round(c.end)) & M;
		const rot = ((end << 17n) | (end >> 47n)) & M;
		h = ((h ^ (BigInt(Math.round(c.start)) & M) ^ rot) * 0x100000001b3n) & M;
	}
	const hex = (v: bigint, n: number) => v.toString(16).toUpperCase().padStart(n, '0');
	const rot29 = ((h << 29n) | (h >> 35n)) & M;
	out += `UUID=${hex(h >> 32n, 8)}-${hex((h >> 16n) & 0xffffn, 4)}-4${hex(h & 0xfffn, 3)}-8${hex((h >> 20n) & 0xfffn, 3)}-${hex(rot29 & 0xffffffffffffn, 12)}\n`;
	out += 'Creation Program=JasperEditor\n';
	out += `Time Code Rate=${dropFrame ? '30DF' : '30'}\n\n`;
	const keys = [...f1.keys(), ...dtv.keys()];
	if (keys.length) {
		const a = keys.reduce((x, y) => Math.min(x, y));
		const b = keys.reduce((x, y) => Math.max(x, y));
		let seq = 0;
		for (let f = a; f <= b + 1; f++) {
			const data: MccFrameData = { f1: f1.get(f) ?? null, dtvcc: dtv.get(f) ?? [] };
			const [hh, mm, ss, ff] = framesToFields(f, MCC_RATE, dropFrame);
			const p2 = (n: number) => String(n).padStart(2, '0');
			out += `${p2(hh)}:${p2(mm)}:${p2(ss)}${dropFrame ? ';' : ':'}${p2(ff)}\t${mccCompress(buildCdp(seq & 0xffff, data))}\n`;
			seq++;
		}
	}
	return out;
}

function tcRate(v: string): { rate: Rational; drop: boolean } | null {
	switch (v.trim().toUpperCase()) {
		case '30DF':
			return { rate: RATE_29_97, drop: true };
		case '30':
			return { rate: RATE_29_97, drop: false };
		case '60DF':
			return { rate: RATE_59_94, drop: true };
		case '60':
			return { rate: RATE_59_94, drop: false };
		case '24':
			return { rate: RATE_24, drop: false };
		case '25':
			return { rate: RATE_25, drop: false };
		case '50':
			return { rate: RATE_50, drop: false };
	}
	return null;
}

export function parseMcc(text: string): CaptionDocument {
	const lines = text.split('\n');
	let idx = lines.findIndex((l) => l.trim().length > 0);
	if (idx < 0 || !lines[idx]!.trim().startsWith('File Format=MacCaption_MCC'))
		throw new CaptionFormatError('not a MacCaption MCC file');
	idx++;
	let rate = { rate: MCC_RATE, drop: true };
	const doc = emptyCaptionDocument();
	const f1: Array<[number, number, number]> = [];
	const dtv: Array<[number, boolean, number, number]> = [];
	let any608 = false;
	for (let n = idx; n < lines.length; n++) {
		const l = lines[n]!.trimEnd();
		if (!l.trim() || l.startsWith('//')) continue;
		if (l.startsWith('Time Code Rate=')) {
			const v = l.slice('Time Code Rate='.length);
			const r = tcRate(v);
			if (!r) throw new CaptionFormatError(`unsupported time code rate "${v}"`, n + 1);
			rate = r;
			continue;
		}
		if (l.includes('=')) continue; // other key=value header lines
		const t = l.trimStart();
		const sp = t.search(/[\t ]/);
		if (sp < 0) continue;
		const tcRaw = t.slice(0, sp);
		const data = t.slice(sp + 1);
		const tc = tcRaw.split('.')[0] ?? tcRaw;
		const parts = tc
			.split(/[:;]/)
			.filter((p) => /^[0-9]+$/.test(p))
			.map(Number);
		if (parts.length !== 4) throw new CaptionFormatError(`bad timecode "${tc}"`, n + 1);
		const frame = fieldsToFrameCount(
			parts[0]!,
			parts[1]!,
			parts[2]!,
			parts[3]!,
			rate.rate,
			rate.drop || tc.includes(';'),
		);
		const bytes = mccExpand(data);
		if (!bytes) {
			doc.warnings.push(`line ${n + 1}: bad caption data`);
			continue;
		}
		const trips = ccTriplets(bytes);
		if (!trips) {
			doc.warnings.push(`line ${n + 1}: not a caption distribution packet`);
			continue;
		}
		for (const [m0, a, b] of trips) {
			if ((m0 & 0x04) === 0) continue;
			const type = m0 & 0x03;
			if (type === 0) {
				any608 ||= (a & 0x7f) !== 0 || (b & 0x7f) !== 0;
				f1.push([frame, a, b]);
			} else if (type !== 1) dtv.push([frame, type === 3, a, b]);
		}
	}
	if (any608) doc.cues = decodeCea608Pairs(f1, rate.rate);
	else {
		const d = new Dec708();
		let last = 0;
		for (const [f, start, a, b] of dtv) {
			d.pair(f, start, a, b);
			last = f + 1;
		}
		if (d.open) {
			d.cues.push({ start: d.open.start, end: Math.max(last, d.open.start + 1), text: d.open.text });
			d.open = null;
		}
		doc.cues = d.cues.map(
			(c): Cue => ({ start: tickOf(c.start, rate.rate), end: tickOf(c.end, rate.rate), text: c.text }),
		);
	}
	return doc;
}
