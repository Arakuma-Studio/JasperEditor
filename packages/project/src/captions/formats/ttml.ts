// TTML (W3C Timed Text Markup Language): IMSC1 Text profile (`.ttml`, written per TTML2 / IMSC 1.1 Text) and
// DFXP (`.dfxp`, TTML1's Distribution Format Exchange Profile). Ported from FilmCraft
// `crates/captions/src/ttml.rs`; see licenses/ported/captions.md.
//
// Writing: one `<p>` per cue inside `body/div`, lines separated by `<br/>`; `<i>`, `<b>` and `<u>` become
// `<span>`s with `tts:fontStyle="italic"`, `tts:fontWeight="bold"` and `tts:textDecoration="underline"`. IMSC1
// files signal `ttp:profile`, a bottom region and a default style. With a frame rate, IMSC1 times are frame
// offsets (`123f`) at `ttp:frameRate` / `ttp:frameRateMultiplier`, which are exact; without one, and always for
// DFXP, times are clock times with milliseconds.
//
// Reading is namespace-agnostic (TTML1, the 2006 `ttaf1` drafts and TTML2): clock times (`HH:MM:SS`, `.fraction`,
// `:FF` frames and `.subframes`), offset times (`h`, `m`, `s`, `ms`, `f`, `t` with `ttp:tickRate`), `begin` /
// `end` / `dur`, nested time containers, timed `<span>`s inside an untimed `<p>`, `<br/>`, whitespace collapsing,
// styles referenced by id (italic / bold / underline) and `ttm:agent` / `xml:id`.
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';
import {
	type CaptionDocument,
	CaptionFormatError,
	type Cue,
	emptyCaptionDocument,
	FLICKS_PER_MS,
} from './core.ts';
import { frameAt, tickOf, timecodeBase } from './rate.ts';
import { parseXml, type XmlElement, xmlAttr, xmlDescendants, xmlElements } from './xml.ts';

export type TtmlFlavor = 'imsc1' | 'dfxp';

const NS_TT = 'http://www.w3.org/ns/ttml';
const NS_TTP = 'http://www.w3.org/ns/ttml#parameter';
const NS_TTS = 'http://www.w3.org/ns/ttml#styling';
const NS_TTM = 'http://www.w3.org/ns/ttml#metadata';
export const IMSC1_TEXT_PROFILE = 'http://www.w3.org/ns/ttml/profile/imsc1/text';
export const DFXP_PROFILE = 'http://www.w3.org/ns/ttml/profile/dfxp-presentation';

function esc(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
	);
}

const p2 = (n: number) => String(n).padStart(2, '0');

function clock(t: number): string {
	const ms = Math.floor((Math.max(0, t) + FLICKS_PER_MS / 2) / FLICKS_PER_MS);
	return `${p2(Math.floor(ms / 3_600_000))}:${p2(Math.floor(ms / 60_000) % 60)}:${p2(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
}

/** Time expression: frames at `rate` when `t` is on a frame boundary, else clock time. */
function timeExpr(t: number, rate: Rational | null): string {
	if (rate) {
		const f = frameAt(t, rate);
		if (tickOf(f, rate) === t) return `${f}f`;
	}
	return clock(t);
}

/** Caption text (`\n` lines, `<i>`/`<b>`/`<u>` tags) → TTML inline content. */
function inline(text: string): string {
	let out = '';
	const open: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] === '<') {
			const end = text.indexOf('>', i + 1);
			if (end >= 0) {
				const tag = text
					.slice(i + 1, end)
					.trim()
					.toLowerCase();
				const closing = tag.startsWith('/');
				const name = closing ? tag.slice(1).trim() : (tag.split(/\s+/)[0] ?? '');
				const attr =
					name === 'i'
						? 'tts:fontStyle="italic"'
						: name === 'b'
							? 'tts:fontWeight="bold"'
							: name === 'u'
								? 'tts:textDecoration="underline"'
								: null;
				if (attr) {
					if (closing) {
						const pos = open.lastIndexOf(attr);
						if (pos >= 0) {
							// close spans opened after it, then it, then reopen the inner ones
							const inner = open.splice(pos).slice(1);
							for (let k = 0; k <= inner.length; k++) out += '</span>';
							for (const x of inner) {
								out += `<span ${x}>`;
								open.push(x);
							}
						}
					} else {
						out += `<span ${attr}>`;
						open.push(attr);
					}
				}
				i = end + 1;
				continue;
			}
		}
		const ch = String.fromCodePoint(text.codePointAt(i)!);
		out += ch === '\n' ? '<br/>' : esc(ch);
		i += ch.length;
	}
	for (let k = 0; k < open.length; k++) out += '</span>';
	return out;
}

const isNcName = (s: string) => /^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(s);

/** `ttm:agent` refers to an agent id; we write the speaker name itself, made an NCName. */
function agentId(s: string): string {
	const v = [...s].map((c) => (/[\p{L}\p{N}.-]/u.test(c) ? c : '_')).join('');
	return /^[\p{L}_]/u.test(v) ? v : `_${v}`;
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.max(1, Math.abs(a)) : gcd(b, a % b));

/** Write TTML. `rate` (IMSC1 only) makes times exact frame offsets; `lang` is `xml:lang`. */
export function writeTtml(
	doc: CaptionDocument,
	flavor: TtmlFlavor,
	seqRate: Rational | null,
	lang: string,
): string {
	let o = '<?xml version="1.0" encoding="UTF-8"?>\n';
	const rate = flavor === 'imsc1' ? seqRate : null;
	o += `<tt xmlns="${NS_TT}" xmlns:ttp="${NS_TTP}" xmlns:tts="${NS_TTS}" xmlns:ttm="${NS_TTM}"`;
	o += ` ttp:profile="${flavor === 'imsc1' ? IMSC1_TEXT_PROFILE : DFXP_PROFILE}" ttp:timeBase="media"`;
	if (rate) {
		const base = timecodeBase(rate);
		o += ` ttp:frameRate="${base}"`;
		// effective rate = base × multiplier
		const mn = rate.num;
		const md = rate.den * base;
		const g = gcd(mn, md);
		if (mn / g !== 1 || md / g !== 1) o += ` ttp:frameRateMultiplier="${mn / g} ${md / g}"`;
	}
	o += ` xml:lang="${esc(lang || 'en')}">\n`;
	o += '  <head>\n';
	o +=
		'    <styling>\n      <style xml:id="s1" tts:color="white" tts:fontFamily="proportionalSansSerif" tts:fontSize="100%" tts:textAlign="center"/>\n    </styling>\n';
	o +=
		'    <layout>\n      <region xml:id="r1" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after"/>\n    </layout>\n';
	o += '  </head>\n  <body region="r1" style="s1">\n    <div>\n';
	doc.cues.forEach((c, i) => {
		const id = c.id && isNcName(c.id) ? c.id : `c${i + 1}`;
		const agent = c.speaker ? ` ttm:role="x-speaker" ttm:agent="${esc(agentId(c.speaker))}"` : '';
		o += `      <p xml:id="${esc(id)}" begin="${timeExpr(c.start, rate)}" end="${timeExpr(c.end, rate)}"${agent}>${inline(c.text)}</p>\n`;
	});
	o += '    </div>\n  </body>\n</tt>\n';
	return o;
}

// ------------------------------------------------------------------------------------------------ reader

type Timing = { rate: Rational; subFrameRate: number; tickRate: number };

function positiveInteger(s: string): number | null {
	const t = s.trim();
	if (!/^[0-9]{1,15}$/.test(t)) return null;
	const v = Number(t);
	return v > 0 ? v : null;
}

function timing(root: XmlElement): Timing {
	const invalid = (name: string) => new CaptionFormatError(`invalid TTML timing parameter ${name}`);
	const integer = (name: string, def: number) => {
		const v = xmlAttr(root, name);
		if (v === null) return def;
		const n = positiveInteger(v);
		if (n === null) throw invalid(name);
		return n;
	};
	const base = integer('frameRate', 30);
	let mn = 1;
	let md = 1;
	const mult = xmlAttr(root, 'frameRateMultiplier');
	if (mult !== null) {
		const parts = mult.split(/\s+/).filter(Boolean).map(positiveInteger);
		if (parts.length !== 2 || parts[0] === null || parts[1] === null) throw invalid('frameRateMultiplier');
		mn = parts[0]!;
		md = parts[1]!;
	}
	if (!Number.isSafeInteger(base * mn)) throw invalid('frameRateMultiplier');
	const sub = integer('subFrameRate', 1);
	const tr = xmlAttr(root, 'tickRate');
	let tickRate = 1;
	if (tr !== null) {
		const n = positiveInteger(tr);
		if (n === null) throw invalid('tickRate');
		tickRate = n;
	} else if (xmlAttr(root, 'frameRate') !== null) tickRate = base * sub;
	return { rate: { num: base * mn, den: md }, subFrameRate: sub, tickRate };
}

const TPS = BigInt(FLICKS_PER_SECOND);

/** Seconds as an exact decimal string → flicks (bigint). */
function decimalTicks(int: string, frac: string, unit: bigint): bigint | null {
	if (int && !/^[0-9]+$/.test(int)) return null;
	let t = (int ? BigInt(int) : 0n) * unit;
	if (frac) {
		if (frac.length > 12 || !/^[0-9]+$/.test(frac)) return null;
		t += (BigInt(frac) * unit) / 10n ** BigInt(frac.length);
	}
	return t;
}

/** Parse a TTML time expression into flicks. */
export function parseTtmlTime(input: string, tm: Timing): number | null {
	const s = input.trim();
	if (!s) return null;
	const frameFlicks = BigInt(tickOf(1, tm.rate));
	if (s.includes(':')) {
		const parts = s.split(':');
		const num = (p: string | undefined) => (p && p.length <= 6 && /^[0-9]+$/.test(p) ? BigInt(p) : null);
		const h = num(parts[0]);
		const m = num(parts[1]);
		const secPart = parts[2];
		if (h === null || m === null || secPart === undefined) return null;
		const dot = secPart.indexOf('.');
		const si = dot >= 0 ? secPart.slice(0, dot) : secPart;
		const sf = dot >= 0 ? secPart.slice(dot + 1) : '';
		const sec = decimalTicks(si, sf, TPS);
		if (sec === null) return null;
		let t = (h * 3600n + m * 60n) * TPS + sec;
		if (parts.length > 4) return null;
		const fp = parts[3];
		if (fp !== undefined) {
			const d = fp.indexOf('.');
			const fi = num(d >= 0 ? fp.slice(0, d) : fp);
			const fsRaw = d >= 0 ? fp.slice(d + 1) : '';
			const fs = fsRaw ? num(fsRaw) : 0n;
			if (fi === null || fs === null) return null;
			// frames at the effective rate; sub-frames divide a frame
			t += fi * frameFlicks + (fs * frameFlicks) / BigInt(Math.max(1, tm.subFrameRate));
		}
		return safe(t);
	}
	const unitStart = s.search(/[A-Za-z]/);
	if (unitStart < 0) return null;
	const v = s.slice(0, unitStart);
	const unit = s.slice(unitStart);
	const dot = v.indexOf('.');
	const vi = dot >= 0 ? v.slice(0, dot) : v;
	const vf = dot >= 0 ? v.slice(dot + 1) : '';
	if (!/^[0-9]*$/.test(vi) || vi.length > 15) return null;
	let t: bigint | null;
	switch (unit) {
		case 'h':
			t = decimalTicks(vi, vf, TPS * 3600n);
			break;
		case 'm':
			t = decimalTicks(vi, vf, TPS * 60n);
			break;
		case 's':
			t = decimalTicks(vi, vf, TPS);
			break;
		case 'ms':
			t = decimalTicks(vi, vf, TPS / 1000n);
			break;
		case 'f': {
			if (!vi) return null;
			const whole = BigInt(tickOf(Number(vi), tm.rate));
			const frac = decimalTicks('0', vf, frameFlicks);
			t = frac === null ? null : whole + frac;
			break;
		}
		case 't': {
			if (!vi || vf) return null;
			t = (BigInt(vi) * TPS) / BigInt(Math.max(1, tm.tickRate));
			break;
		}
		default:
			return null;
	}
	return t === null ? null : safe(t);
}

function safe(t: bigint): number | null {
	return t <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(t) : null;
}

type Fmt = { italic: boolean; bold: boolean; underline: boolean };

function ownFmt(n: XmlElement, f: Fmt): void {
	const fs = xmlAttr(n, 'fontStyle');
	if (fs !== null) f.italic = fs.trim() === 'italic' || fs.trim() === 'oblique';
	const fw = xmlAttr(n, 'fontWeight');
	if (fw !== null) f.bold = fw.trim() === 'bold';
	const td = xmlAttr(n, 'textDecoration');
	if (td !== null) {
		const v = td.trim();
		if (v.includes('noUnderline') || v === 'none') f.underline = false;
		else if (v.includes('underline')) f.underline = true;
	}
}

function styleOf(n: XmlElement, styles: Map<string, Fmt>, parent: Fmt): Fmt {
	const f = { ...parent };
	const refs = xmlAttr(n, 'style');
	if (refs !== null) {
		for (const r of refs.split(/\s+/).filter(Boolean)) {
			const s = styles.get(r);
			if (s) {
				f.italic ||= s.italic;
				f.bold ||= s.bold;
				f.underline ||= s.underline;
			}
		}
	}
	ownFmt(n, f);
	return f;
}

/** Text collected from a `<p>`: whitespace collapses to one space, written before the next visible content. */
class Out {
	s = '';
	pending = false;
	flush(): void {
		if (this.pending && this.s && !this.s.endsWith('\n')) this.s += ' ';
		this.pending = false;
	}
}

function collect(n: XmlElement, styles: Map<string, Fmt>, fmt: Fmt, out: Out): void {
	for (const c of n.children) {
		if (c.kind === 'text') {
			for (const ch of c.text) {
				if (/\s/.test(ch)) out.pending = true;
				else {
					out.flush();
					out.s += ch;
				}
			}
		} else if (c.local === 'br') {
			out.pending = false;
			out.s += '\n';
		} else if (c.local === 'span') {
			const f = styleOf(c, styles, fmt);
			const tags = (
				[
					[f.italic && !fmt.italic, 'i'],
					[f.bold && !fmt.bold, 'b'],
					[f.underline && !fmt.underline, 'u'],
				] as const
			)
				.filter((x) => x[0])
				.map((x) => x[1]);
			if (tags.length) out.flush();
			for (const t of tags) out.s += `<${t}>`;
			collect(c, styles, f, out);
			for (const t of [...tags].reverse()) out.s += `</${t}>`;
		} else collect(c, styles, fmt, out);
	}
}

const clean = (s: string) =>
	s
		.split('\n')
		.map((l) => l.trim())
		.join('\n')
		.trim();

export function parseTtml(text: string): CaptionDocument {
	const root = parseXml(text);
	if (root.local !== 'tt') throw new CaptionFormatError('not a TTML file');
	const tm = timing(root);
	const styles = new Map<string, Fmt>();
	for (const s of xmlDescendants(root)) {
		if (s.local !== 'style') continue;
		const id = xmlAttr(s, 'id');
		if (id !== null) {
			const f: Fmt = { italic: false, bold: false, underline: false };
			ownFmt(s, f);
			styles.set(id, f);
		}
	}
	const doc = emptyCaptionDocument();
	const body = xmlElements(root).find((e) => e.local === 'body');
	if (!body) return doc;
	walk(body, 0, tm, styles, { italic: false, bold: false, underline: false }, doc);
	doc.cues.sort((a, b) => a.start - b.start || a.end - b.end);
	return doc;
}

function times(
	n: XmlElement,
	parent: number,
	tm: Timing,
	doc: CaptionDocument,
): { begin: number | null; end: number | null } {
	const p = (k: string) => {
		const v = xmlAttr(n, k);
		if (v === null) return null;
		const t = parseTtmlTime(v, tm);
		if (t === null) doc.warnings.push(`bad time expression "${v}"`);
		return t;
	};
	const b = p('begin');
	const begin = b === null ? null : parent + b;
	const e = p('end');
	const d = p('dur');
	const end = e !== null ? parent + e : d !== null ? (begin ?? parent) + d : null;
	return { begin, end };
}

function walk(
	n: XmlElement,
	parent: number,
	tm: Timing,
	styles: Map<string, Fmt>,
	fmt: Fmt,
	doc: CaptionDocument,
): void {
	for (const c of xmlElements(n)) {
		const f = styleOf(c, styles, fmt);
		if (c.local === 'div') {
			const { begin } = times(c, parent, tm, doc);
			walk(c, begin ?? parent, tm, styles, f, doc);
		} else if (c.local === 'p') {
			const { begin, end } = times(c, parent, tm, doc);
			const agent = xmlAttr(c, 'agent');
			const speaker = agent !== null ? agent.trim().replace(/^_+/, '').replaceAll('_', ' ') : null;
			const id = xmlAttr(c, 'id');
			if (begin !== null && end !== null) {
				const o = new Out();
				const tags = (
					[
						[f.italic, 'i'],
						[f.bold, 'b'],
						[f.underline, 'u'],
					] as const
				)
					.filter((x) => x[0])
					.map((x) => x[1]);
				for (const t of tags) o.s += `<${t}>`;
				collect(c, styles, f, o);
				for (const t of [...tags].reverse()) o.s += `</${t}>`;
				const text = clean(o.s);
				if (end > begin && text) {
					const cue: Cue = { start: begin, end, text };
					if (speaker !== null) cue.speaker = speaker;
					if (id !== null) cue.id = id;
					doc.cues.push(cue);
				}
			} else {
				// untimed paragraph: its timed spans are the cues
				const base = begin ?? parent;
				for (const sp of xmlElements(c)) {
					if (sp.local !== 'span') continue;
					const st = times(sp, base, tm, doc);
					if (st.begin !== null && st.end !== null) {
						const o = new Out();
						collect(sp, styles, styleOf(sp, styles, f), o);
						const text = clean(o.s);
						if (st.end > st.begin && text) {
							const cue: Cue = { start: st.begin, end: st.end, text };
							if (speaker !== null) cue.speaker = speaker;
							doc.cues.push(cue);
						}
					}
				}
			}
		}
	}
}
