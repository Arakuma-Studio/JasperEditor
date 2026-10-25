// CMX 3600 edit decision lists (`.edl`).
//
// Read and written: `TITLE:`, `FCM:` (drop / non-drop, may change mid-list), cut / dissolve (`D nnn`) / wipe
// (`Wnnn nnn`) / key (`K B`, `K`, `K O`) events, audio channels (`V`, `A`, `A2`, `AA`, `B`, `AA/V`, `A2/V`, `A3`,
// `A4`, `AUD 3 4` lines), `M2` motion lines (speed, reverse, freeze), `BL` black, reel names up to 8 (strict) or
// 32 (extended) characters, and the comment extensions `* FROM CLIP NAME:`, `* TO CLIP NAME:`, `* SOURCE FILE:`,
// `* EFFECT NAME:` and `* LOC:` markers (with colour), plus `* CLIP NAME:` (Resolve), `*ASC_SOP`/`*ASC_SAT`
// (reported) and Avid's `>>> SOURCE` notes.
//
// EDLs carry no frame rate (ImportOptions.rate, else guessed) and no media identity beyond reels and comments.
// Source timecodes are absolute: on import each source's start timecode is assumed to be the hour of the first
// timecode the list uses for it (recorded as the media timecode with `jasper.timecodeGuess`, rebased against the
// real file's timecode when the engine links it); on export the media's start timecode is added back.
//
// Port of FilmCraft `crates/interchange/src/edl.rs` (MIT OR Apache-2.0), extended (marker colours on export and
// import, extended reels, start-timecode rebasing, per-track lists, Resolve/Avid comment dialects).
import type { LabelColor } from '@jasper/project';
import { fieldsToFrames } from '@jasper/project';
import { Builder, describeClip, frameOf, newClip, scaled } from './build.ts';
import { CONSTANT_POWER, CROSS_DISSOLVE, transitionFromName, transitionLabel } from './effects.ts';
import type { IClip, IMarker, IMedia, IProject, ISequence, ITrack, ITransition, Rate } from './model.ts';
import { DEFAULT_EDL_OPTIONS, type EdlOptions, type ExportOptions, type ImportOptions } from './options.ts';
import { fileName, fileStem, relativePath, relativeReference, resolvePath } from './paths.ts';
import { InterchangeError, parseError, type Report } from './report.ts';
import {
	flicksToFrames,
	formatTc,
	fps,
	framesToFlicks,
	onFrame,
	RATE_24,
	RATE_25,
	RATE_29_97,
	RATE_30,
	RATE_59_94,
	RATE_60,
	supportsDropFrame,
} from './time.ts';

const FORMAT = 'CMX 3600 EDL';

/** Heuristic: does this text look like an EDL? */
export function looksLikeEdl(head: string): boolean {
	return head
		.split(/\r\n|\r|\n/)
		.slice(0, 40)
		.some((l) => {
			const t = l.trimStart();
			return t.startsWith('TITLE:') || t.startsWith('FCM:') || parseEventLine(t) !== null;
		});
}

type Tc = { h: number; m: number; s: number; f: number; df: boolean };

function parseTcFields(s: string): Tc | null {
	const parts = s.split(/[:;.,]/);
	if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
	const n = parts.map(Number);
	return { h: n[0]!, m: n[1]!, s: n[2]!, f: n[3]!, df: s.includes(';') || s.includes(',') };
}

type Trans =
	| { kind: 'cut' }
	| { kind: 'dissolve' }
	| { kind: 'wipe'; code: number }
	| { kind: 'key-bg' }
	| { kind: 'key' }
	| { kind: 'key-out' };
type Ch = { v: true } | { a: number };
const chKey = (c: Ch) => ('v' in c ? 'V' : `A${c.a}`);

function parseChannels(s: string): Ch[] | null {
	const u = s.toUpperCase();
	if (u === 'B') return [{ v: true }, { a: 1 }];
	if (u === 'NONE') return [];
	const out: Ch[] = [];
	for (const part of u.split('/')) {
		if (part === 'V') out.push({ v: true });
		else if (part === 'A' || part === 'A1') out.push({ a: 1 });
		else if (part === 'AA') out.push({ a: 1 }, { a: 2 });
		else if (/^A\d{1,2}$/.test(part) && Number(part.slice(1)) >= 1) out.push({ a: Number(part.slice(1)) });
		else return null;
	}
	return out.length ? out : null;
}

type Line = { num: string; reel: string; chans: Ch[]; trans: Trans; dur: number; tcs: [Tc, Tc, Tc, Tc] };

function parseEventLine(l: string): Line | null {
	const toks = l.split(/\s+/).filter(Boolean);
	if (toks.length < 8 || !/^\d+$/.test(toks[0]!)) return null;
	const n = toks.length;
	const tcs = [
		parseTcFields(toks[n - 4]!),
		parseTcFields(toks[n - 3]!),
		parseTcFields(toks[n - 2]!),
		parseTcFields(toks[n - 1]!),
	];
	if (tcs.some((t) => !t)) return null;
	const chans = parseChannels(toks[2]!);
	if (!chans) return null;
	const mid = toks.slice(3, n - 4);
	const first = (mid[0] ?? '').toUpperCase();
	const numAt = (i: number) => (mid[i] !== undefined && /^\d+$/.test(mid[i]!) ? Number(mid[i]) : null);
	let trans: Trans;
	let dur = 0;
	if (first === 'C') trans = { kind: 'cut' };
	else if (first === 'D') {
		trans = { kind: 'dissolve' };
		dur = numAt(1) ?? 0;
	} else if (first === 'K') {
		const s = (mid[1] ?? '').toUpperCase();
		if (s === 'B') trans = { kind: 'key-bg' };
		else if (s === 'O') {
			trans = { kind: 'key-out' };
			dur = numAt(2) ?? 0;
		} else {
			trans = { kind: 'key' };
			dur = numAt(1) ?? 0;
		}
	} else if (first === 'KB') trans = { kind: 'key-bg' };
	else if (first === 'KO') {
		trans = { kind: 'key-out' };
		dur = numAt(1) ?? 0;
	} else if (/^W\d+$/.test(first)) {
		trans = { kind: 'wipe', code: Number(first.slice(1)) };
		dur = numAt(1) ?? 0;
	} else return null;
	return { num: toks[0]!, reel: toks[1]!, chans, trans, dur, tcs: tcs as [Tc, Tc, Tc, Tc] };
}

type Event = {
	lines: Line[];
	fromClip: string | null;
	toClip: string | null;
	files: string[];
	effect: string | null;
	m2: { reel: string; fps: number }[];
	locs: { tc: Tc; color: string; name: string }[];
	df: boolean;
};

type Parsed = { title: string | null; events: Event[]; anyDf: boolean; maxFf: number };

const MARKER_COLORS: Record<string, LabelColor> = {
	RED: 'rose',
	GREEN: 'green',
	BLUE: 'blue',
	CYAN: 'teal',
	MAGENTA: 'magenta',
	YELLOW: 'yellow',
	WHITE: 'lavender',
	BLACK: 'brown',
	ORANGE: 'mango',
	PURPLE: 'purple',
	PINK: 'rose',
};

function colorWord(l: LabelColor): string {
	switch (l) {
		case 'rose':
			return 'RED';
		case 'green':
		case 'forest':
			return 'GREEN';
		case 'blue':
		case 'iris':
		case 'cerulean':
			return 'BLUE';
		case 'teal':
		case 'caribbean':
			return 'CYAN';
		case 'magenta':
		case 'violet':
			return 'MAGENTA';
		case 'purple':
			return 'PURPLE';
		case 'lavender':
			return 'WHITE';
		case 'brown':
			return 'BLACK';
		case 'mango':
		case 'tan':
			return 'ORANGE';
		case 'yellow':
			return 'YELLOW';
	}
}

function parse(text: string, report: Report): Parsed {
	const p: Parsed = { title: null, events: [], anyDf: false, maxFf: 0 };
	let df = false;
	for (const raw of text.split(/\r\n|\r|\n/)) {
		const l = raw.trim();
		if (!l) continue;
		const upper = l.toUpperCase();
		if (upper.startsWith('TITLE:')) {
			p.title = l.slice(6).trim();
			continue;
		}
		if (upper.startsWith('FCM:')) {
			df = upper.includes('DROP') && !upper.includes('NON');
			p.anyDf ||= df;
			continue;
		}
		if (l.startsWith('*')) {
			const c = l.slice(1).trim();
			const ev = p.events[p.events.length - 1];
			if (!ev) continue;
			const cu = c.toUpperCase();
			const value = (prefix: string) => c.slice(prefix.length).trim();
			if (cu.startsWith('FROM CLIP NAME:')) ev.fromClip = value('FROM CLIP NAME:');
			else if (cu.startsWith('TO CLIP NAME:')) ev.toClip = value('TO CLIP NAME:');
			else if (cu.startsWith('CLIP NAME:')) ev.fromClip ??= value('CLIP NAME:');
			else if (cu.startsWith('SOURCE FILE:')) ev.files.push(value('SOURCE FILE:'));
			else if (cu.startsWith('EFFECT NAME:')) ev.effect = value('EFFECT NAME:');
			else if (cu.startsWith('LOC:')) {
				const rest = value('LOC:').split(/\s+/).filter(Boolean);
				const tc = rest[0] ? parseTcFields(rest[0]) : null;
				if (tc) {
					const rest2 = rest.slice(1);
					const isColor = rest2[0] && MARKER_COLORS[rest2[0].toUpperCase()];
					ev.locs.push({
						tc,
						color: isColor ? rest2[0]! : '',
						name: (isColor ? rest2.slice(1) : rest2).join(' '),
					});
				}
			} else if (cu.startsWith('ASC_SOP') || cu.startsWith('ASC_SAT'))
				report.info('EDL colour decision (ASC CDL) comments are not applied');
			continue;
		}
		if (upper.startsWith('M2')) {
			const toks = l.split(/\s+/).filter(Boolean);
			if (toks.length >= 3) {
				let fi = -1;
				for (let i = toks.length - 1; i >= 2; i--)
					if (!parseTcFields(toks[i]!) && Number.isFinite(Number(toks[i]))) {
						fi = i;
						break;
					}
				if (fi < 0) fi = 2;
				const reel = toks.slice(1, Math.max(2, fi)).join(' ');
				const fps = Number(toks[fi]);
				const ev = p.events[p.events.length - 1];
				if (Number.isFinite(fps) && ev) ev.m2.push({ reel, fps });
			}
			continue;
		}
		if (upper.startsWith('AUD')) {
			const extra = l
				.split(/\s+/)
				.slice(1)
				.filter((t) => /^\d+$/.test(t))
				.map((t): Ch => ({ a: Number(t) }));
			const ev = p.events[p.events.length - 1];
			ev?.lines[ev.lines.length - 1]?.chans.push(...extra);
			continue;
		}
		if (upper.startsWith('SPLIT:')) {
			report.warn('EDL split (L-cut / J-cut) lines are not supported; the split was ignored');
			continue;
		}
		const line = parseEventLine(l);
		if (line) {
			for (const tc of line.tcs) {
				p.maxFf = Math.max(p.maxFf, tc.f);
				p.anyDf ||= tc.df;
			}
			const last = p.events[p.events.length - 1];
			if (last && last.lines[last.lines.length - 1]?.num === line.num) last.lines.push(line);
			else
				p.events.push({
					lines: [line],
					fromClip: null,
					toClip: null,
					files: [],
					effect: null,
					m2: [],
					locs: [],
					df,
				});
			continue;
		}
		if (upper.startsWith('>>>') || upper.startsWith('REM') || upper.startsWith('FINISH')) continue;
		report.warn(`unrecognised EDL line ignored: ${l.slice(0, 60)}`);
	}
	return p;
}

function guessRate(p: Parsed): Rate {
	if (p.anyDf) return p.maxFf >= 30 ? RATE_59_94 : RATE_29_97;
	if (p.maxFf >= 30) return RATE_60;
	if (p.maxFf >= 25) return RATE_30;
	if (p.maxFf >= 24) return RATE_25;
	return RATE_24;
}

class EdlImporter {
	readonly track = (kind: 'video' | 'audio', i: number): ITrack => {
		this.b.ensureTracks(this.seq, kind, i + 1);
		return this.seq[kind][i]!;
	};
	hasVideo = false;
	hasAudio = false;
	/** Per media: the lowest absolute source frame the list uses (the start timecode guess is its hour). */
	readonly firstSrc = new Map<string, number>();

	constructor(
		readonly b: Builder,
		readonly seq: ISequence,
		readonly rate: Rate,
		readonly startTc: number,
		readonly opts: ImportOptions,
		readonly report: Report,
	) {}

	frames(tc: Tc, df: boolean): number {
		return fieldsToFrames(tc.h, tc.m, tc.s, tc.f, this.rate, {
			dropFrame: (tc.df || df) && supportsDropFrame(this.rate),
		});
	}
	rec(tc: Tc, df: boolean): number {
		return framesToFlicks(this.frames(tc, df) - this.startTc, this.rate);
	}
	/** Absolute source time (flicks of the source timecode). */
	src(tc: Tc, df: boolean): number {
		return framesToFlicks(this.frames(tc, df), this.rate);
	}

	media(reel: string, clip: string | null, file: string | null, chans: Ch[]): string {
		const video = chans.some((c) => 'v' in c) || this.hasVideo;
		const audio = chans.some((c) => 'a' in c) || this.hasAudio;
		const spec = {
			...(video ? { video: { width: this.seq.width, height: this.seq.height, rate: this.rate } } : {}),
			...(audio ? { audio: { sampleRate: 48000, channels: 2 } } : {}),
			kind: (video ? 'video' : 'audio') as IMedia['kind'],
			reel,
		};
		if (file) {
			const path = resolvePath(file, this.opts.baseDir);
			return this.b.media(
				`file:${path}`,
				{ ...spec, name: fileName(path), path, relativePath: relativeReference(file) },
				this.b.p.root,
			);
		}
		const name = clip || reel;
		this.report.info(
			`source "${name}" (reel ${reel}) has no SOURCE FILE comment; it is imported offline for relinking`,
			{
				subject: { kind: 'media', name },
				instead: 'an offline media item named after the clip',
			},
		);
		return this.b.media(`reel:${reel}|${name}`, { ...spec, name, path: null, offline: true }, this.b.p.root);
	}

	/** Overwrites a clip for `line` on each of its channels; returns the clips per channel key. */
	lay(
		line: Line,
		mediaId: string,
		name: string,
		start: number,
		dur: number,
		srcAbs: number,
		m2: number | null,
		videoBase: number,
	): Map<string, IClip> {
		const out = new Map<string, IClip>();
		const chans = [...new Map(line.chans.map((c) => [chKey(c), c])).values()];
		const link = chans.length > 1 ? this.b.id('l') : null;
		this.firstSrc.set(mediaId, Math.min(this.firstSrc.get(mediaId) ?? Number.POSITIVE_INFINITY, srcAbs));
		for (const ch of chans) {
			const clip = newClip({
				id: this.b.id('c'),
				name,
				start,
				duration: dur,
				sourceIn: srcAbs,
				source: { type: 'media', mediaId },
			});
			if (link) clip.link = link;
			if (m2 !== null) {
				if (m2 === 0) clip.hold = srcAbs;
				else {
					// M2 holds the playback rate in fps with one decimal: snap to the nearest percent within that precision.
					const exact = Math.abs(m2) / fps(this.rate);
					const pct = Math.round(exact * 100) / 100;
					clip.speed =
						Math.abs(pct - exact) <= 0.051 / fps(this.rate) + 1e-9 ? pct : Math.round(exact * 10000) / 10000;
					clip.reverse = m2 < 0;
				}
			}
			const t = 'v' in ch ? this.track('video', videoBase) : this.track('audio', ch.a - 1);
			this.b.overwrite(t, clip);
			out.set(chKey(ch), clip);
		}
		return out;
	}

	layCut(ev: Event, l: Line, videoBase: number): void {
		if (l.reel.toUpperCase() === 'BL') return; // black filler: a gap
		const t0 = this.rec(l.tcs[2], ev.df);
		const t1 = this.rec(l.tcs[3], ev.df);
		if (t1 <= t0) return;
		const clip = videoBase > 0 ? (ev.toClip ?? ev.fromClip) : ev.fromClip;
		const file = videoBase > 0 && ev.files.length > 1 ? ev.files[1]! : (ev.files[0] ?? null);
		const m = this.media(l.reel, clip, file, l.chans);
		this.lay(l, m, clip ?? l.reel, t0, t1 - t0, this.src(l.tcs[0], ev.df), this.m2For(ev, l.reel), videoBase);
	}

	m2For(ev: Event, reel: string): number | null {
		return ev.m2.find((x) => x.reel === reel)?.fps ?? null;
	}

	event(ev: Event): void {
		const [l1, l2] = ev.lines;
		if (ev.lines.length === 2 && l1 && l2 && (l2.trans.kind === 'dissolve' || l2.trans.kind === 'wipe')) {
			const t0 = this.rec(l2.tcs[2], ev.df);
			const t1 = this.rec(l2.tcs[3], ev.df);
			const d = framesToFlicks(l2.dur, this.rate);
			const toBlack = l2.reel.toUpperCase() === 'BL';
			const fromBlack = l1.reel.toUpperCase() === 'BL';
			let placed = new Map<string, IClip>();
			if (!toBlack) {
				const file = ev.files.length >= 2 ? ev.files[1]! : (ev.files[0] ?? null);
				const clip = ev.toClip ?? (fromBlack ? ev.fromClip : null);
				const m = this.media(l2.reel, clip, file, l2.chans);
				placed = this.lay(
					l2,
					m,
					clip ?? l2.reel,
					t0,
					t1 - t0,
					this.src(l2.tcs[0], ev.df),
					this.m2For(ev, l2.reel),
					0,
				);
			}
			if (l2.trans.kind === 'wipe' && !ev.effect && l2.trans.code > 2)
				this.report.info(`SMPTE wipe ${String(l2.trans.code).padStart(3, '0')} imported as a plain Wipe`);
			for (const ch of new Map(l2.chans.map((c) => [chKey(c), c])).values()) {
				const kind = 'v' in ch ? 'video' : 'audio';
				const t = 'v' in ch ? this.track('video', 0) : this.track('audio', ch.a - 1);
				const to = placed.get(chKey(ch)) ?? null;
				const from = fromBlack ? null : (t.clips.find((c) => c.start + c.duration === t0) ?? null);
				let alignment: ITransition['alignment'] = 'start-at-cut';
				if (toBlack) {
					// Fade out: the outgoing clip runs through the transition.
					if (from && !t.clips.some((o) => o !== from && o.start < t0 + d && o.start + o.duration > t0))
						from.duration += d;
					alignment = 'end-at-cut';
				}
				if (!from && !to) continue;
				const audio = kind === 'audio';
				const effectId = audio
					? CONSTANT_POWER
					: ev.effect
						? transitionFromName(ev.effect, false, this.report)
						: l2.trans.kind === 'wipe'
							? 'jasper.wipe'
							: CROSS_DISSOLVE;
				t.transitions.push({
					id: this.b.id('t'),
					effectId,
					from: from?.id ?? null,
					to: to?.id ?? null,
					start: t0,
					duration: d,
					alignment,
					params: {},
				});
				t.transitions.sort((a, b) => a.start - b.start);
			}
			return;
		}
		if (
			ev.lines.length === 2 &&
			l1 &&
			l2 &&
			l1.trans.kind === 'key-bg' &&
			(l2.trans.kind === 'key' || l2.trans.kind === 'key-out')
		) {
			this.report.info('EDL key events were imported as background on V1 and foreground on V2');
			if (l2.trans.kind === 'key-out') this.report.warn('an EDL key-out fade was imported as a plain key');
			this.layCut(ev, l1, 0);
			this.layCut(ev, l2, 1);
			return;
		}
		if (ev.lines.length > 1)
			this.report.warn(
				`EDL event ${ev.lines[0]!.num} has ${ev.lines.length} lines; they were imported as separate cuts`,
			);
		for (const l of ev.lines) {
			if (l.trans.kind === 'key' || l.trans.kind === 'key-out') {
				this.layCut(ev, l, 1);
				continue;
			}
			if (l.trans.kind !== 'cut' && l.trans.kind !== 'key-bg')
				this.report.warn(
					`EDL event ${l.num}: a transition without an outgoing source line was imported as a cut`,
				);
			this.layCut(ev, l, 0);
		}
	}
}

export function importEdl(text: string, opts: ImportOptions, report: Report): IProject {
	const parsed = parse(text, report);
	if (!parsed.events.length) throw parseError(FORMAT, 'no events found');
	let rate = opts.rate ?? null;
	if (!rate) {
		rate = guessRate(parsed);
		report.info(
			`the EDL has no frame rate; ${(rate.num / rate.den).toFixed(3)} fps was assumed (choose the rate in the import options to override)`,
		);
	}
	const title = parsed.title || opts.name || 'EDL Sequence';
	const dropFrame = (opts.dropFrame ?? parsed.anyDf) && supportsDropFrame(rate);
	const b = new Builder(title);
	const seq = b.sequence(
		{ name: title, rate, dropFrame, width: 1920, height: 1080, sampleRate: 48000, startTimecode: 0 },
		{ top: true },
	);
	const probe = new EdlImporter(b, seq, rate, 0, opts, report);
	let firstRec = Number.POSITIVE_INFINITY;
	for (const ev of parsed.events)
		for (const l of ev.lines) {
			firstRec = Math.min(firstRec, probe.frames(l.tcs[2], ev.df));
		}
	// Sequence start: the hour of the first record timecode.
	const hourFrames = (f: number) => {
		const h = Number(formatTc(Math.max(0, f), rate!, dropFrame).split(/[:;]/)[0]);
		return fieldsToFrames(h, 0, 0, 0, rate!, { dropFrame });
	};
	const startTc = Number.isFinite(firstRec) ? Math.min(firstRec, hourFrames(firstRec)) : 0;
	seq.startTimecode = Math.max(0, startTc);
	const imp = new EdlImporter(b, seq, rate, seq.startTimecode, opts, report);
	for (const ev of parsed.events)
		for (const l of ev.lines) {
			imp.hasVideo ||= l.chans.some((c) => 'v' in c);
			imp.hasAudio ||= l.chans.some((c) => 'a' in c);
		}
	for (const ev of parsed.events) {
		imp.event(ev);
		for (const loc of ev.locs)
			seq.markers.push({
				start: imp.rec(loc.tc, ev.df),
				duration: 0,
				name: loc.name,
				comment: '',
				color: MARKER_COLORS[loc.color.toUpperCase()] ?? 'green',
			});
	}
	seq.markers.sort((a, b2) => a.start - b2.start);
	b.ensureTracks(seq, 'video', 1);
	b.ensureTracks(seq, 'audio', 1);
	// Source timecodes → media time: each source starts at the hour of the first timecode used.
	const shift = new Map<string, number>();
	for (const [mid, src] of imp.firstSrc) {
		const f = flicksToFrames(src, rate);
		const tc = hourFrames(f);
		const m = b.p.media[mid]!;
		m.timecode = { frames: tc, rate, dropFrame };
		m.jasper = { ...m.jasper, timecodeGuess: true };
		shift.set(mid, framesToFlicks(tc, rate));
	}
	if (shift.size)
		report.info(
			'EDL source timecodes were converted to media time assuming each source starts at the hour of its first timecode; linking the files corrects this from their real start timecode',
		);
	for (const t of [...seq.video, ...seq.audio])
		for (const c of t.clips) {
			if (c.source.type !== 'media') continue;
			const s = shift.get(c.source.mediaId) ?? 0;
			c.sourceIn -= s;
			if (c.hold != null) c.hold -= s;
		}
	return b.finish();
}

type OutLine = {
	media: IMedia | null;
	reel: string;
	chan: string;
	trans: string;
	dur: number | null;
	src: [number, number];
	rec: [number, number];
};
type OutEvent = {
	lines: OutLine[];
	comments: string[];
	m2: { reel: string; fps: number; entry: number; media: IMedia | null } | null;
	merge: string | null;
	channels: Set<string>;
	order: [number, number];
};

const CHAN_CODES: [string, string][] = [
	['V', 'V'],
	['A1,V', 'B'],
	['A1,A2,V', 'AA/V'],
	['A2,V', 'A2/V'],
	['A1', 'A'],
	['A2', 'A2'],
	['A1,A2', 'AA'],
	['A3', 'A3'],
	['A4', 'A4'],
	['A3,A4', 'A3/A4'],
];

function chanCode(set: Set<string>): string | null {
	const key = [...set].sort().join(',');
	return CHAN_CODES.find(([k]) => k === key)?.[1] ?? null;
}

function sanitizeReel(s: string, max: number): string {
	const r = [...s]
		.map((c) => (/[A-Za-z0-9_-]/.test(c) ? c.toUpperCase() : '_'))
		.join('')
		.slice(0, max);
	return r || 'AX';
}

export function exportEdl(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): string {
	const s = p.sequences[sequenceId];
	if (!s) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const o: EdlOptions = { ...DEFAULT_EDL_OPTIONS, ...opts.edl };
	const rate = s.rate;
	const df = s.dropFrame && supportsDropFrame(rate);
	const reels = new Map<string, string>();
	const usedReels = new Map<string, string>();
	const max = Math.max(1, Math.min(128, o.reelLength));
	const reelOf = (c: IClip): string => {
		if (c.source.type === 'none') return 'AX';
		if (c.source.type === 'sequence') return 'AX';
		const m = p.media[c.source.mediaId];
		if (!m) return 'AX';
		const known = reels.get(m.id);
		if (known) return known;
		let r: string;
		if (m.generator) {
			if (m.generator.kind === 'black') r = 'BL';
			else {
				report.warn(`generator "${m.name}" is written to the EDL as reel AX`, {
					subject: { kind: 'media', id: m.id, name: m.name },
					instead: 'reel AX',
				});
				r = 'AX';
			}
		} else if (o.reelMode === 'ax') r = 'AX';
		else if (o.reelMode === 'clip-name') r = sanitizeReel(m.name, max);
		else {
			const src = m.reel || (m.path ? fileStem(m.path) : m.name);
			const base = sanitizeReel(src, max);
			r = base;
			let k = 1;
			while (usedReels.has(r) && usedReels.get(r) !== m.id) {
				k++;
				const suffix = String(k);
				r = `${base.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
			}
			usedReels.set(r, m.id);
		}
		reels.set(m.id, r);
		return r;
	};
	const mediaOf = (c: IClip) => (c.source.type === 'media' ? (p.media[c.source.mediaId] ?? null) : null);
	const srcFrames = (m: IMedia | null, t: number, reel: string) => {
		const start =
			m?.timecode && reel !== 'BL'
				? flicksToFrames(framesToFlicks(m.timecode.frames, m.timecode.rate), rate)
				: 0;
		return start + flicksToFrames(t, rate);
	};
	const recFrames = (t: number) => s.startTimecode + flicksToFrames(t, rate);
	const fileComment = (m: IMedia | null) => {
		if (!m?.path) return null;
		return o.sourceFiles
			? opts.relativeTo
				? (relativePath(m.path, opts.relativeTo) ?? m.path)
				: m.path
			: null;
	};

	const events: OutEvent[] = [];
	const tracks: { kind: 'video' | 'audio'; idx: number; ch: string }[] = [];
	if (o.videoTrack !== null && o.videoTrack < s.video.length)
		tracks.push({ kind: 'video', idx: o.videoTrack, ch: 'V' });
	for (const a of o.audioTracks) {
		if (a >= s.audio.length) continue;
		if (a >= 4) {
			if (s.audio[a]!.clips.length)
				report.warn(`EDLs carry at most four audio channels; A${a + 1} was not exported`, {
					subject: { kind: 'track', name: `A${a + 1}` },
					instead: 'nothing',
				});
			continue;
		}
		tracks.push({ kind: 'audio', idx: a, ch: `A${a + 1}` });
	}
	if (o.videoTrack !== null)
		s.video.forEach((t, i) => {
			if (i !== o.videoTrack && t.clips.length)
				report.warn(`EDLs hold one video track; V${i + 1} was not exported (export one list per track)`, {
					subject: { kind: 'track', name: `V${i + 1}` },
					instead: 'nothing',
				});
		});
	for (const [ai, t] of s.audio.entries())
		if (!o.audioTracks.includes(ai) && t.clips.length && ai < 4)
			report.info(`A${ai + 1} was not selected for the EDL`);
	if (s.captions?.length)
		report.warn(`the captions of "${s.name}" are not carried by EDLs`, {
			instead: 'nothing (export a sidecar file)',
		});

	for (const { kind, idx, ch } of tracks) {
		const track = s[kind][idx]!;
		if (
			kind === 'audio' &&
			(track.volumeDb?.keyframes.length ||
				(track.volumeDb && track.volumeDb.value !== 0) ||
				track.pan?.keyframes.length ||
				(track.pan && track.pan.value !== 0))
		)
			report.warn(
				`the volume and pan of track ${ch} (and their automation) cannot be represented in an EDL`,
				{
					subject: { kind: 'track', name: track.name ?? ch },
					instead: 'unity level',
				},
			);
		const chs = ch === 'V' ? 'V' : ch === 'A1' ? 'A' : ch;
		for (const c of track.clips) {
			const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: frameOf(c.start, rate) };
			if (!onFrame(c.start, rate) || !onFrame(c.duration, rate))
				report.info('sub-frame clip positions were rounded to frames', { subject: where });
			const reel = reelOf(c);
			if (c.source.type === 'none')
				report.warn(`${describeClip(c, rate)} cannot be represented in an EDL`, {
					subject: where,
					instead: `an ordinary event (reel ${reel})`,
				});
			if (c.source.type === 'sequence')
				report.warn(`${describeClip(c, rate)} is written as a single source`, {
					subject: where,
					instead: 'an event with reel AX',
				});
			if (!c.enabled)
				report.warn(`disabled clip "${c.name}" is written as a normal event`, {
					subject: where,
					instead: 'an enabled event',
				});
			for (const e of c.effects)
				report.warn(`effect "${e.effectId}" on clip "${c.name}" cannot be represented in an EDL`, {
					subject: { ...where, kind: 'effect', name: e.effectId },
					instead: 'nothing',
				});
			if (kind === 'video' && hasMotion(c, s, p))
				report.warn(`the Motion / Opacity of clip "${c.name}" cannot be represented in an EDL`, {
					subject: where,
					instead: 'the clip without them',
				});
			if (
				kind === 'audio' &&
				((c.volumeDb && (c.volumeDb.value || c.volumeDb.keyframes.length)) ||
					(c.pan && (c.pan.value || c.pan.keyframes.length)) ||
					c.gainDb)
			)
				report.warn(`the levels of clip "${c.name}" cannot be represented in an EDL`, {
					subject: where,
					instead: 'unity level',
				});
			const m = mediaOf(c);
			const trIn = track.transitions.find((x) => x.to === c.id);
			const trOut = track.transitions.find((x) => x.from === c.id);
			let rec0 = c.start;
			let rec1 = c.start + c.duration;
			let src0 = c.hold ?? c.sourceIn;
			if (trOut) rec1 = Math.max(rec0, Math.min(rec1, trOut.start));
			const speed = c.hold != null ? 0 : c.speed;
			const lines: OutLine[] = [];
			const comments: string[] = [];
			let transName: string | null = null;
			if (trIn) {
				const st = trIn.start;
				const from = trIn.from ? track.clips.find((x) => x.id === trIn.from) : undefined;
				const fromReel = from ? reelOf(from) : 'BL';
				const fromSrc = from
					? (from.hold ?? from.sourceIn) + (from.hold != null ? 0 : scaled(st - from.start, from.speed))
					: 0;
				lines.push({
					media: from ? mediaOf(from) : null,
					reel: fromReel,
					chan: chs,
					trans: 'C',
					dur: null,
					src: [fromSrc, fromSrc],
					rec: [st, st],
				});
				src0 = c.hold ?? c.sourceIn - scaled(c.start - st, c.speed);
				if (src0 < 0) {
					report.warn(
						`the transition into clip "${c.name}" needs media before its start; the source in was clamped to 0`,
						{ subject: where },
					);
					src0 = 0;
				}
				rec0 = st;
				const { code, name } = edlTransition(trIn, report);
				transName = name;
				lines.push({
					media: m,
					reel,
					chan: chs,
					trans: code,
					dur: flicksToFrames(trIn.duration, rate),
					src: [src0, src0 + (rec1 - rec0)],
					rec: [rec0, rec1],
				});
				if (o.clipNames) {
					if (from) comments.push(`FROM CLIP NAME: ${from.name}`);
					comments.push(`TO CLIP NAME: ${c.name}`);
				}
				if (o.sourceFiles) {
					const ff = from ? fileComment(mediaOf(from)) : null;
					if (ff) comments.push(`SOURCE FILE: ${ff}`);
					const f = fileComment(m);
					if (f) comments.push(`SOURCE FILE: ${f}`);
				}
			} else {
				lines.push({
					media: m,
					reel,
					chan: chs,
					trans: 'C',
					dur: null,
					src: [src0, src0 + (rec1 - rec0)],
					rec: [rec0, rec1],
				});
				if (o.clipNames) comments.push(`FROM CLIP NAME: ${c.name}`);
				const f = fileComment(m);
				if (f) comments.push(`SOURCE FILE: ${f}`);
			}
			if (o.effectNames && transName) comments.push(`EFFECT NAME: ${transName}`);
			const m2 =
				speed !== 1 || c.reverse
					? {
							reel,
							fps: c.hold != null ? 0 : speed * fps(rate) * (c.reverse ? -1 : 1),
							entry: src0,
							media: m,
						}
					: null;
			const simple = !trIn && !m2;
			events.push({
				merge:
					simple && c.link
						? `${c.link}|${JSON.stringify(c.source)}|${rec0}|${rec1}|${src0}|${c.enabled}`
						: null,
				lines,
				comments,
				m2,
				channels: new Set([ch]),
				order: [rec0, kind === 'video' ? 0 : 1 + idx],
			});
			// Fade to black after this clip.
			if (trOut && !trOut.to) {
				const st = trOut.start;
				const aSrc = (c.hold ?? c.sourceIn) + (c.hold != null ? 0 : scaled(st - c.start, c.speed));
				const { code, name } = edlTransition(trOut, report);
				const cm: string[] = [];
				if (o.clipNames) cm.push(`FROM CLIP NAME: ${c.name}`);
				if (o.effectNames) cm.push(`EFFECT NAME: ${name}`);
				events.push({
					lines: [
						{ media: m, reel, chan: chs, trans: 'C', dur: null, src: [aSrc, aSrc], rec: [st, st] },
						{
							media: null,
							reel: 'BL',
							chan: chs,
							trans: code,
							dur: flicksToFrames(trOut.duration, rate),
							src: [0, trOut.duration],
							rec: [st, st + trOut.duration],
						},
					],
					comments: cm,
					m2: null,
					merge: null,
					channels: new Set([ch]),
					order: [st, kind === 'video' ? 0 : 1 + idx],
				});
			}
		}
	}

	// Merge identical linked cut events across channels (V + A → B, A + A2 → AA …).
	const merged: OutEvent[] = [];
	for (const ev of events) {
		const prev = ev.merge ? merged.find((x) => x.merge === ev.merge) : undefined;
		if (prev) {
			const set = new Set([...prev.channels, ...ev.channels]);
			const code = chanCode(set);
			if (code) {
				prev.channels = set;
				for (const l of prev.lines) l.chan = code;
				continue;
			}
		}
		merged.push(ev);
	}
	merged.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);

	const out: string[] = [`TITLE: ${opts.name ?? s.name}`, df ? 'FCM: DROP FRAME' : 'FCM: NON-DROP FRAME'];
	const w = Math.max(8, max);
	const markers = o.markers ? [...s.markers].sort((a, b) => a.start - b.start) : [];
	if (!o.markers && s.markers.length)
		report.info(
			`the ${s.markers.length} sequence marker(s) of "${s.name}" are not written (Markers is off)`,
			{
				instead: 'nothing',
			},
		);
	let mi = 0;
	merged.forEach((ev, i) => {
		out.push('');
		const num = String(i + 1).padStart(3, '0');
		for (const l of ev.lines) {
			const dur = l.dur !== null ? String(l.dur).padStart(3, '0') : '';
			out.push(
				`${num}  ${l.reel.padEnd(w)} ${l.chan.padEnd(5)} ${l.trans.padEnd(4)} ${dur.padStart(3)} ${formatTc(srcFrames(l.media, l.src[0], l.reel), rate, df)} ${formatTc(srcFrames(l.media, l.src[1], l.reel), rate, df)} ${formatTc(recFrames(l.rec[0]), rate, df)} ${formatTc(recFrames(l.rec[1]), rate, df)}`,
			);
		}
		if (ev.m2) {
			const sign = ev.m2.fps < 0 ? '-' : '';
			out.push(
				`M2   ${ev.m2.reel.padEnd(w)}       ${sign}${Math.abs(ev.m2.fps).toFixed(1).padStart(5, '0')}                ${formatTc(srcFrames(ev.m2.media, ev.m2.entry, ev.m2.reel), rate, df)}`,
			);
		}
		for (const c of ev.comments) out.push(`* ${c}`);
		const end = ev.lines[ev.lines.length - 1]!.rec[1];
		while (mi < markers.length && (markers[mi]!.start < end || i + 1 === merged.length)) {
			const m = markers[mi++]!;
			if (m.duration) report.info('marker durations are not carried by EDL locators');
			out.push(`* LOC: ${formatTc(recFrames(m.start), rate, df)} ${colorWord(m.color).padEnd(7)} ${m.name}`);
		}
	});
	if (!merged.length)
		for (const m of markers)
			out.push(`* LOC: ${formatTc(recFrames(m.start), rate, df)} ${colorWord(m.color).padEnd(7)} ${m.name}`);
	return `${out.join('\n')}\n`;
}

/** One list per non-empty video track ("V1", "V2", …); audio goes in the V1 list (Premiere's per-track export). */
export function exportEdlPerTrack(
	p: IProject,
	sequenceId: string,
	opts: ExportOptions,
	report: Report,
): { suffix: string; text: string }[] {
	const s = p.sequences[sequenceId];
	if (!s) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const base = { ...DEFAULT_EDL_OPTIONS, ...opts.edl };
	const out: { suffix: string; text: string }[] = [];
	s.video.forEach((t, i) => {
		if (!t.clips.length) return;
		const edl: EdlOptions = { ...base, videoTrack: i, audioTracks: out.length ? [] : base.audioTracks };
		// Per-track lists name their own track only: suppress the "one video track" warning for the others.
		const r = new (report.constructor as new () => Report)();
		const text = exportEdl(p, sequenceId, { ...opts, edl: edl }, r);
		for (const e of r.entries)
			if (!/^EDLs hold one video track/.test(e.message))
				for (let k = 0; k < e.count; k++)
					report.push(e.level, e.message, {
						...(e.subject ? { subject: e.subject } : {}),
						...(e.instead !== undefined ? { instead: e.instead } : {}),
					});
		out.push({ suffix: `V${i + 1}`, text });
	});
	if (!out.length) out.push({ suffix: 'V1', text: exportEdl(p, sequenceId, opts, report) });
	return out;
}

function hasMotion(c: IClip, s: ISequence, p: IProject): boolean {
	const t = c.transform;
	const opacity = c.opacity && (c.opacity.value !== 100 || c.opacity.keyframes.length > 0);
	if (opacity) return true;
	if (!t) return false;
	let box = { width: s.width, height: s.height };
	if (c.source.type === 'media') {
		const m = p.media[c.source.mediaId];
		if (m?.video) box = { width: m.video.width, height: m.video.height };
	}
	return (
		[t.position, t.anchor, t.scale, t.scaleWidth, t.rotation].some((a) => a.keyframes.length > 0) ||
		t.position.value[0] !== s.width / 2 ||
		t.position.value[1] !== s.height / 2 ||
		t.anchor.value[0] !== box.width / 2 ||
		t.anchor.value[1] !== box.height / 2 ||
		t.scale.value !== 100 ||
		(!t.uniformScale && t.scaleWidth.value !== 100) ||
		t.rotation.value !== 0 ||
		t.flipH ||
		t.flipV
	);
}

/** EDL transition code and EFFECT NAME. */
function edlTransition(t: ITransition, report: Report): { code: string; name: string } {
	const name = transitionLabel(t.effectId).toUpperCase();
	if (
		[
			CROSS_DISSOLVE,
			CONSTANT_POWER,
			'jasper.constant-gain',
			'jasper.film-dissolve',
			'jasper.additive-dissolve',
			'jasper.non-additive-dissolve',
			'jasper.dip-to-black',
		].includes(t.effectId)
	)
		return { code: 'D', name };
	if (t.effectId === 'jasper.wipe') return { code: 'W001', name };
	if (Object.keys(t.params ?? {}).length > 0)
		report.warn(
			`the parameters of transition "${transitionLabel(t.effectId)}" (${Object.keys(t.params).join(', ')}) are not carried by an EDL`,
			{
				subject: { kind: 'transition', id: t.id, name: transitionLabel(t.effectId) },
				instead: 'the transition with its default parameters',
			},
		);
	report.info(
		`transition "${transitionLabel(t.effectId)}" is written as a dissolve with an EFFECT NAME comment`,
		{
			subject: { kind: 'transition', id: t.id, name: transitionLabel(t.effectId) },
			instead: 'a dissolve',
		},
	);
	return { code: 'D', name };
}

export type { IMarker };
