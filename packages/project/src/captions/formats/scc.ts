// Scenarist SCC (`.scc`): CEA-608 byte pairs with SMPTE timecodes at 29.97 fps.
// Ported from FilmCraft `crates/captions/src/scc.rs`; see licenses/ported/captions.md.
//
// A tab separates the timecode from the code words; each line's pairs are sent one per frame starting at its
// timecode. Reading runs a channel-1 CEA-608 decoder (pop-on, roll-up, paint-on; redundant control codes ignored)
// and emits a cue whenever the displayed memory changes. Writing produces pop-on captions: for each cue the load
// (RCL, ENM, PAC + tab offset per row, text) is scheduled into free frames before the cue so its End of Caption
// lands exactly on the cue start; an Erase Displayed Memory clears it at the cue end (omitted when the next
// caption replaces it). Rows are bottom-aligned (row 15 last), centred, wrapped at 32 columns; characters
// outside the 608 sets are dropped.
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';
import {
	basicChar,
	decodePac,
	EXT_12,
	EXT_13,
	encodeChar,
	encodePac,
	MISC,
	SPECIAL,
	withParity,
} from './cea608.ts';
import {
	type CaptionDocument,
	CaptionFormatError,
	type Cue,
	emptyCaptionDocument,
	plainCaptionText,
} from './core.ts';
import { fieldsToFrameCount, frameAt, framesToFields, RATE_29_97, snapNearest, tickOf } from './rate.ts';

/** SCC is always 29.97 fps. */
export const SCC_RATE: Rational = RATE_29_97;
const COLS = 32;
const HEADER = 'Scenarist_SCC V1.0';

/** Parse `HH:MM:SS:FF` / `HH:MM:SS;FF` (drop-frame when any separator is `;`, `.` or `,`). */
export function parseSccTimecode(s: string): number | null {
	const df = /[;.,]/.test(s);
	const parts = s.split(/[:;.,]/);
	if (parts.length !== 4) return null;
	const n = parts.map((p) => (p.length >= 1 && p.length <= 3 && /^[0-9]+$/.test(p) ? Number(p) : null));
	if (n.some((x) => x === null)) return null;
	return fieldsToFrameCount(n[0]!, n[1]!, n[2]!, n[3]!, SCC_RATE, df);
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function formatSccTimecode(frame: number, dropFrame: boolean): string {
	const [h, m, s, f] = framesToFields(Math.max(0, frame), SCC_RATE, dropFrame);
	return `${p2(h)}:${p2(m)}:${p2(s)}${dropFrame ? ';' : ':'}${p2(f)}`;
}

/** Frame of flicks `t` on the SCC grid (nearest frame). */
export function sccFrameOf(t: number): number {
	return frameAt(snapNearest(t, SCC_RATE), SCC_RATE);
}

// ------------------------------------------------------------------------------------------------ decoder

type Row = Array<string | null>;
type Memory = Row[];
const blankRow = (): Row => new Array<string | null>(COLS).fill(null);
const blankMemory = (): Memory => Array.from({ length: 15 }, blankRow);

function memoryText(m: Memory): string {
	return m
		.map((r) =>
			r
				.map((c) => c ?? ' ')
				.join('')
				.trim(),
		)
		.filter((r) => r.length > 0)
		.join('\n');
}

type Mode = { kind: 'pop' } | { kind: 'roll'; rows: number } | { kind: 'paint' };

/** Channel-1 CEA-608 decoder (pop-on, roll-up, paint-on). */
export class Cea608Decoder {
	private displayed: Memory = blankMemory();
	private hidden: Memory = blankMemory();
	private mode: Mode = { kind: 'pop' };
	private row = 14;
	private col = 0;
	private lastCtrl: [number, number] | null = null;
	private ch1 = true;
	open: { start: number; text: string } | null = null;
	readonly cues: Array<{ start: number; end: number; text: string }> = [];

	private target(): Memory {
		return this.mode.kind === 'pop' ? this.hidden : this.displayed;
	}

	private put(c: string): void {
		const col = Math.min(this.col, COLS - 1);
		this.target()[this.row]![col] = c;
		this.col = Math.min(this.col + 1, COLS - 1);
	}

	/** Displayed memory may have changed at frame `f`: close/open cues. */
	private sync(f: number): void {
		const now = memoryText(this.displayed);
		const cur = this.open?.text ?? '';
		if (now === cur) return;
		const o = this.open;
		this.open = null;
		if (o && f > o.start) this.cues.push({ start: o.start, end: f, text: o.text });
		if (now) this.open = { start: f, text: now };
	}

	pair(f: number, rb1: number, rb2: number): void {
		const b1 = rb1 & 0x7f;
		const b2 = rb2 & 0x7f;
		if (b1 >= 0x10 && b1 <= 0x1f) {
			if (this.lastCtrl && this.lastCtrl[0] === b1 && this.lastCtrl[1] === b2) {
				this.lastCtrl = null;
				return;
			}
			this.lastCtrl = [b1, b2];
			this.ch1 = (b1 & 0x08) === 0;
			if (!this.ch1) return;
			this.control(f, b1 & 0x17, b2);
			return;
		}
		this.lastCtrl = null;
		if (!this.ch1) return;
		for (const b of [b1, b2]) {
			const c = basicChar(b);
			if (c !== null) this.put(c);
		}
		if (this.mode.kind !== 'pop') this.sync(f);
	}

	private control(f: number, b1: number, b2: number): void {
		// b1 has the channel bit cleared; 0x14/0x15 both carry misc codes (field 1 / 2 variants)
		if ((b1 === 0x14 || b1 === 0x15) && b2 >= 0x20 && b2 <= 0x2f) {
			switch (b2) {
				case MISC.RCL:
					this.mode = { kind: 'pop' };
					break;
				case MISC.RDC:
					this.mode = { kind: 'paint' };
					break;
				case MISC.RU2:
				case MISC.RU3:
				case MISC.RU4: {
					const n = b2 - MISC.RU2 + 2;
					if (this.mode.kind !== 'roll') {
						this.displayed = blankMemory();
						this.row = 14;
					}
					this.mode = { kind: 'roll', rows: n };
					this.col = 0;
					break;
				}
				case MISC.BS: {
					this.col = Math.max(0, this.col - 1);
					this.target()[this.row]![this.col] = null;
					break;
				}
				case MISC.DER: {
					const r = this.target()[this.row]!;
					for (let x = this.col; x < COLS; x++) r[x] = null;
					break;
				}
				case MISC.EDM:
					this.displayed = blankMemory();
					break;
				case MISC.ENM:
					this.hidden = blankMemory();
					break;
				case MISC.EOC: {
					const d = this.displayed;
					this.displayed = this.hidden;
					this.hidden = d;
					this.mode = { kind: 'pop' };
					break;
				}
				case MISC.CR: {
					if (this.mode.kind === 'roll') {
						const n = this.mode.rows;
						const top = this.row + 1 - Math.min(n, this.row + 1);
						for (let r = top; r < this.row; r++) this.displayed[r] = [...this.displayed[r + 1]!];
						if (top > 0) this.displayed[top - 1] = blankRow();
						this.displayed[this.row] = blankRow();
						this.col = 0;
					}
					break;
				}
			}
			this.sync(f);
			return;
		}
		if (b1 === 0x17 && b2 >= 0x21 && b2 <= 0x23) {
			this.col = Math.min(this.col + (b2 - 0x20), COLS - 1);
			return;
		}
		if (b1 === 0x11 && b2 >= 0x30 && b2 <= 0x3f) {
			this.put(SPECIAL[b2 - 0x30]!);
			if (this.mode.kind !== 'pop') this.sync(f);
			return;
		}
		if ((b1 === 0x12 || b1 === 0x13) && b2 >= 0x20 && b2 <= 0x3f) {
			// extended characters replace the preceding (fallback) character
			this.col = Math.max(0, this.col - 1);
			const set = b1 === 0x12 ? EXT_12 : EXT_13;
			this.put(set[b2 - 0x20]!);
			if (this.mode.kind !== 'pop') this.sync(f);
			return;
		}
		if (b1 === 0x11 && b2 >= 0x20 && b2 <= 0x2f) {
			// mid-row style change: shown as a space
			this.put(' ');
			return;
		}
		const pac = decodePac(b1, b2);
		if (pac) {
			const row = pac.row - 1;
			if (this.mode.kind === 'roll' && row !== this.row) {
				// roll-up window moves with the base row
				const old = this.displayed;
				this.displayed = blankMemory();
				for (let k = 0; k < this.mode.rows; k++) {
					if (this.row >= k && row >= k) this.displayed[row - k] = [...old[this.row - k]!];
				}
			}
			this.row = row;
			this.col = pac.indent;
		}
	}
}

/**
 * Decode channel-1 CEA-608 byte pairs `(frame, b1, b2)` (with or without parity; frames ascending) into cues at
 * `rate`. A caption still showing after the last pair stays up for one second more.
 */
export function decodeCea608Pairs(pairs: Iterable<[number, number, number]>, rate: Rational): Cue[] {
	const dec = new Cea608Decoder();
	let lastFrame = 0;
	for (const [f, b1, b2] of pairs) {
		dec.pair(f, b1, b2);
		lastFrame = Math.max(lastFrame, f + 1);
	}
	const oneSecond = Math.max(1, frameAt(FLICKS_PER_SECOND, rate));
	if (dec.open) {
		const o = dec.open;
		dec.open = null;
		dec.cues.push({ start: o.start, end: Math.max(lastFrame, o.start + 1) + oneSecond, text: o.text });
	}
	return dec.cues.map((c) => ({ start: tickOf(c.start, rate), end: tickOf(c.end, rate), text: c.text }));
}

export function parseScc(text: string): CaptionDocument {
	const lines = text
		.split('\n')
		.map((l, n) => ({ l, n }))
		.filter((x) => x.l.trim().length > 0);
	if (!lines.length || !lines[0]!.l.trim().startsWith('Scenarist_SCC'))
		throw new CaptionFormatError('not a Scenarist SCC file');
	const dec = new Cea608Decoder();
	let lastFrame = 0;
	const doc = emptyCaptionDocument();
	for (const { l, n } of lines.slice(1)) {
		const words = l.split(/\s+/).filter(Boolean);
		const tc = words[0];
		if (!tc) continue;
		const frame = parseSccTimecode(tc);
		if (frame === null) throw new CaptionFormatError(`bad timecode "${tc}"`, n + 1);
		words.slice(1).forEach((w, k) => {
			if (!/^[0-9a-fA-F]{1,4}$/.test(w)) {
				doc.warnings.push(`line ${n + 1}: bad code word "${w}"`);
				return;
			}
			const v = Number.parseInt(w, 16);
			const f = frame + k;
			dec.pair(f, v >> 8, v & 0xff);
			lastFrame = Math.max(lastFrame, f + 1);
		});
	}
	// a caption still showing at the end of the file stays up for 1 s more
	if (dec.open) {
		const o = dec.open;
		dec.open = null;
		dec.cues.push({ start: o.start, end: Math.max(lastFrame, o.start + 1) + 30, text: o.text });
	}
	doc.cues = dec.cues.map((c) => ({
		start: tickOf(c.start, SCC_RATE),
		end: tickOf(c.end, SCC_RATE),
		text: c.text,
	}));
	return doc;
}

// ------------------------------------------------------------------------------------------------ encoder

/** Wrap plain text into rows of at most 32 columns (word wrap, hard-splitting long words); at most 15 rows. */
export function wrapSccRows(text: string, cols = COLS): string[] {
	const rows: string[] = [];
	for (const line of text.split('\n')) {
		let cur = '';
		for (const w of line.split(/\s+/).filter(Boolean)) {
			let word = [...w];
			for (;;) {
				const need = cur ? [...cur].length + 1 + word.length : word.length;
				if (need <= cols) {
					cur = cur ? `${cur} ${word.join('')}` : word.join('');
					break;
				}
				if (cur) {
					rows.push(cur);
					cur = '';
					continue;
				}
				rows.push(word.slice(0, cols).join(''));
				word = word.slice(cols);
				if (!word.length) break;
			}
		}
		if (cur) rows.push(cur);
	}
	return rows.slice(0, 15);
}

/** Byte pairs (without parity) that load `text` into non-displayed memory. */
function loadPairs(text: string): Array<[number, number]> {
	const rows = wrapSccRows(plainCaptionText(text));
	const out: Array<[number, number]> = [
		[0x14, MISC.RCL],
		[0x14, MISC.RCL],
		[0x14, MISC.ENM],
		[0x14, MISC.ENM],
	];
	const firstRow = 16 - rows.length;
	rows.forEach((row, i) => {
		const encoded = [...row].map(encodeChar).filter((e) => e !== null);
		const width = Math.min(encoded.length, COLS);
		const col = Math.floor((COLS - width) / 2);
		const pac = encodePac(firstRow + i, col);
		out.push(pac, pac);
		if (col % 4 !== 0) {
			const to: [number, number] = [0x17, 0x20 + (col % 4)];
			out.push(to, to);
		}
		let pending: number | null = null;
		for (const e of encoded.slice(0, COLS)) {
			if (e.kind === 'basic') {
				if (pending !== null) {
					out.push([pending, e.b]);
					pending = null;
				} else pending = e.b;
			} else {
				if (e.fallback !== null) {
					if (pending !== null) {
						out.push([pending, e.fallback]);
						pending = null;
					} else out.push([e.fallback, 0x00]);
				} else if (pending !== null) {
					out.push([pending, 0x00]);
					pending = null;
				}
				out.push([e.b1, e.b2], [e.b1, e.b2]);
			}
		}
		if (pending !== null) out.push([pending, 0x00]);
	});
	return out;
}

/** The parity-coded SCC code word of a byte pair. */
export function sccCodeWord(p: [number, number]): number {
	return (withParity(p[0]) << 8) | withParity(p[1]);
}

/**
 * Schedule pop-on CEA-608 byte pairs (without parity), one pair per 29.97 fps frame, so each caption's End of
 * Caption lands on its start frame. Returns frame → pair, ascending.
 */
export function scheduleCea608(doc: CaptionDocument): Map<number, [number, number]> {
	const occ = new Map<number, [number, number]>();
	let cursor = 0;
	let prevEnd: number | null = null;
	const edm: [number, number] = [0x14, MISC.EDM];
	const eoc: [number, number] = [0x14, MISC.EOC];
	const placeFreeFrom = (start: number, p: [number, number]) => {
		let f = start;
		while (occ.has(f)) f++;
		occ.set(f, p);
		return f;
	};
	const cues = doc.cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
	for (const c of cues) {
		const s = Math.max(sccFrameOf(c.start), cursor);
		const e = sccFrameOf(c.end);
		// clear the previous caption if there is a gap before this one
		if (prevEnd !== null && prevEnd < s) {
			const f = placeFreeFrom(prevEnd, edm);
			if (!occ.has(f + 1) && f + 1 < s) occ.set(f + 1, edm);
		}
		prevEnd = null;
		const load = loadPairs(c.text);
		const n = load.length;
		// Doubled codes must stay adjacent, so the load is one contiguous run of free frames: the latest run ending
		// by `s`, else the first run after `cursor` (delaying the caption).
		const runFree = (b: number) => {
			for (let f = b; f < b + n; f++) if (occ.has(f)) return false;
			return true;
		};
		let b: number | null = null;
		for (let x = s - n; x >= cursor; x--) {
			if (runFree(x)) {
				b = x;
				break;
			}
		}
		if (b === null) {
			let x = cursor;
			while (!runFree(x)) x++;
			b = x;
		}
		load.forEach((p, k) => occ.set(b! + k, p));
		let d = Math.max(s, b + n);
		while (occ.has(d)) d++;
		occ.set(d, eoc);
		let next = d + 1;
		if (!occ.has(next)) {
			occ.set(next, eoc);
			next++;
		}
		cursor = next;
		prevEnd = Math.max(e, next);
	}
	if (prevEnd !== null) {
		const f = placeFreeFrom(prevEnd, edm);
		occ.set(f + 1, edm);
	}
	return new Map([...occ.entries()].sort((a, b) => a[0] - b[0]));
}

export function writeScc(doc: CaptionDocument, dropFrame: boolean): string {
	const occ = scheduleCea608(doc);
	let out = `${HEADER}\n\n`;
	let line: { start: number; words: string[] } | null = null;
	let last = Number.NEGATIVE_INFINITY;
	for (const [f, p] of occ) {
		if (f !== last + 1 && line) {
			out += `${formatSccTimecode(line.start, dropFrame)}\t${line.words.join(' ')}\n\n`;
			line = null;
		}
		if (!line) line = { start: f, words: [] };
		line.words.push(sccCodeWord(p).toString(16).padStart(4, '0'));
		last = f;
	}
	if (line) out += `${formatSccTimecode(line.start, dropFrame)}\t${line.words.join(' ')}\n\n`;
	return out;
}
