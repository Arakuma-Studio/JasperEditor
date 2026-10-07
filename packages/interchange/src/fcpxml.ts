// FCPXML 1.9–1.11 import and export (Final Cut Pro 10.4–11, DaVinci Resolve; older 1.5–1.8 documents are read).
//
// Mapping between JasperEditor's tracks and FCPXML's magnetic model:
// - V1 is the primary storyline (`spine`): clips, `gap`s and `transition`s. Other video tracks are connected clips
//   with `lane` = track index (V2 → lane 1); audio-only clips on audio track n are connected clips on lane −n. A
//   video clip whose linked audio sits on the same-numbered audio track with identical timing is one clip carrying
//   both; otherwise `srcEnable="video"` / `"audio"`. Every clip has a role (`videoRole="video.video-N"`,
//   `audioRole="dialogue.dialogue-N"`); on import roles keep the audio track assignment stable.
// - Times are rational seconds (`1001/24000s`) and map exactly onto flicks.
// - `adjust-transform` (position and anchor in percent of the frame height, y up; scale x/y — non-uniform scale is
//   carried; rotation counter-clockwise), `adjust-blend` (amount, blend mode), `adjust-volume` (dB),
//   `adjust-panner` (amount) and `adjust-crop` (trim) with keyframes; constant speed, reverse and freeze frames
//   are two-point `timeMap`s; compound clips are `ref-clip`s of `media` sequences; captions are `caption`
//   elements with `iTT` roles.
// - Markers on primary-storyline elements are sequence markers (Final Cut has no timeline markers; markers belong
//   to the primary storyline), markers on connected clips are clip markers. `chapter-marker` ↔ chapter markers.
//
// Port of FilmCraft `crates/interchange/src/fcpxml.rs` (MIT OR Apache-2.0), extended (non-uniform scale, anchor,
// blend modes, pan, crop, roles, captions, keyframe easing, effects with their params, generators reported).
import type { Animatable, Keyframe, Transform, Vec2 } from '@jasper/project';
import { blendFromFcpxml, fcpxmlBlend } from './blend.ts';
import {
	Builder,
	describeClip,
	frameOf,
	multicamAudibleTracks,
	multicamOf,
	sequenceDuration,
} from './build.ts';
import { effectSpecOf, transitionFromName, transitionLabel } from './effects.ts';
import type { IClip, IMarker, IMedia, IProject, ISequence, ITrack, ITransition, Rate } from './model.ts';
import type { ExportOptions, ImportOptions } from './options.ts';
import { isAbsolutePath, kindFromExtension, pathToFileUrl, resolvePath } from './paths.ts';
import { InterchangeError, parseError, type Report } from './report.ts';
import {
	flicksToFrames,
	flicksToRationalSeconds,
	framesToFlicks,
	rationalSecondsToFlicks,
	reduceRate,
} from './time.ts';
import { child, children, elements, escapeXml, parseXml, text, XmlError, type XNode } from './xml.ts';

const FORMAT = 'FCPXML';
const MAX_NEST = 64;

export function sniffFcpxml(head: string): boolean {
	return /<fcpxml[\s>]/.test(head);
}

// ---------------------------------------------------------------- rational time

/** `"1001/24000s"`, `"5s"`, `"0s"`, `"3.5s"` → flicks. */
export function parseTime(s: string | undefined | null): number | null {
	if (s === undefined || s === null) return null;
	let t = s.trim();
	if (t.endsWith('s')) t = t.slice(0, -1);
	if (!t) return null;
	try {
		if (t.includes('/')) {
			const [a, b] = t.split('/');
			if (!/^-?\d+$/.test(a!.trim()) || !/^-?\d+$/.test(b!.trim())) return null;
			const d = BigInt(b!.trim());
			if (d === 0n) return null;
			return rationalSecondsToFlicks(BigInt(a!.trim()), d).flicks;
		}
		if (/^-?\d+$/.test(t)) return rationalSecondsToFlicks(BigInt(t), 1n).flicks;
	} catch {
		return null;
	}
	const v = Number(t);
	return Number.isFinite(v) ? Math.round(v * 705_600_000) : null;
}

/** Flicks → FCPXML time, frame-based at `rate` when on a frame (`1001/24000s`), else reduced seconds. */
export function fmtTime(t: number, rate: Rate): string {
	if (t === 0) return '0s';
	const f = flicksToFrames(t, rate, 'floor');
	if (framesToFlicks(f, rate) === t) {
		const n = BigInt(f) * BigInt(rate.den);
		const d = BigInt(rate.num);
		if (n % d === 0n) return `${n / d}s`;
		return `${n}/${d}s`;
	}
	const [a, b] = flicksToRationalSeconds(t);
	return b === 1n ? `${a}s` : `${a}/${b}s`;
}

function rateFromFrameDuration(s: string | undefined): Rate | null {
	if (!s) return null;
	const t = s.trim().replace(/s$/, '');
	const [a, b] = t.includes('/') ? t.split('/') : [t, '1'];
	const n = Number(a);
	const d = Number(b);
	if (!Number.isInteger(n) || !Number.isInteger(d) || n <= 0 || d <= 0) return null;
	return reduceRate({ num: d, den: n });
}

function parseAudioRate(s: string | undefined): number | null {
	if (!s) return null;
	const t = s.trim();
	const v = t.endsWith('k') ? Number(t.slice(0, -1)) * 1000 : Number(t);
	return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

const audioRateStr = (sr: number) => (sr % 1000 === 0 ? `${sr / 1000}k` : `${sr / 1000}k`);

const at = (n: XNode, name: string) => parseTime(n.attrs[name]);
const flag = (n: XNode, name: string): boolean | null => {
	const v = n.attrs[name];
	return v === undefined ? null : v === '1' || v.toLowerCase() === 'true';
};

function pair(v: string): [number, number] {
	const p = v.trim().split(/\s+/).map(Number).filter(Number.isFinite);
	return [p[0] ?? 0, p[1] ?? p[0] ?? 0];
}

function parseDb(v: string): number {
	const n = Number(
		v
			.trim()
			.replace(/d[bB]$/, '')
			.trim(),
	);
	return Number.isFinite(n) ? n : 0;
}

function kf<T>(time: number, value: T, interpolation: Keyframe<T>['interpolation']): Keyframe<T> {
	const slope = interpolation === 'bezier' ? 0 : 1;
	return {
		id: `kf${time}`,
		time,
		value,
		interpolation,
		easeIn: { influence: 1 / 3, slope },
		easeOut: { influence: 1 / 3, slope },
	};
}

const anim = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });

// ---------------------------------------------------------------- import

type AssetInfo = { media: string; start: number; hasVideo: boolean; hasAudio: boolean };

export function importFcpxml(text0: string, opts: ImportOptions, report: Report): IProject {
	let root: XNode;
	try {
		root = parseXml(text0);
	} catch (e) {
		if (e instanceof XmlError) throw parseError(FORMAT, e.message);
		throw e;
	}
	if (root.name !== 'fcpxml') throw parseError(FORMAT, 'the root element is not <fcpxml>');
	const v = root.attrs.version ?? '';
	const minor = Number(v.split('.')[1] ?? 0);
	if (!v.startsWith('1.') || minor > 11)
		report.info(`FCPXML version ${v || '(none)'} is not 1.5–1.11; unknown elements were ignored`);
	const lib = child(root, 'library');
	const name = child(lib, 'event')?.attrs.name ?? opts.name ?? 'Imported FCPXML';
	const imp = new FcpxmlImporter(new Builder(name), opts, report);
	const res = child(root, 'resources');
	for (const r of elements(res)) {
		const id = r.attrs.id;
		if (!id) continue;
		if (r.name === 'format') {
			imp.formats.set(id, {
				rate: rateFromFrameDuration(r.attrs.frameDuration) ?? { num: 24, den: 1 },
				width: Number(r.attrs.width) || 1920,
				height: Number(r.attrs.height) || 1080,
			});
		} else if (r.name === 'asset') imp.assetNodes.set(id, r);
		else if (r.name === 'media') imp.mediaNodes.set(id, r);
		else if (r.name === 'effect') imp.effects.set(id, { name: r.attrs.name ?? '', uid: r.attrs.uid ?? '' });
	}
	const events = [...children(lib, 'event'), ...children(root, 'event')];
	for (const ev of events) {
		const bin = imp.b.bin(ev.attrs.name || 'Event');
		for (const c of elements(ev)) {
			if (c.name === 'project') {
				const s = child(c, 'sequence');
				if (s) {
					const id = imp.sequence(s, c.attrs.name || 'Project', bin, 0);
					if (id) imp.b.p.top.push(id);
				}
			} else if ((c.name === 'asset-clip' || c.name === 'clip') && c.attrs.ref) imp.asset(c.attrs.ref, bin);
			else if (c.name === 'ref-clip' && c.attrs.ref) imp.media(c.attrs.ref, bin, 0);
		}
	}
	for (const p of children(root, 'project')) {
		const s = child(p, 'sequence');
		if (s) {
			const id = imp.sequence(s, p.attrs.name || 'Project', imp.b.p.root, 0);
			if (id) imp.b.p.top.push(id);
		}
	}
	const p = imp.b.finish();
	if (!Object.keys(p.sequences).length && !Object.keys(p.media).length)
		throw new InterchangeError('EMPTY', 'the FCPXML document contains no project or clip');
	return p;
}

type Ctx = { seq: ISequence; rate: Rate; frame: { width: number; height: number }; depth: number };
/** A laid-out storyline element: timeline span and the clip on its own track. */
type Laid = { start: number; end: number; clip: IClip | null; track: number };

class FcpxmlImporter {
	readonly formats = new Map<string, { rate: Rate; width: number; height: number }>();
	readonly assetNodes = new Map<string, XNode>();
	readonly mediaNodes = new Map<string, XNode>();
	readonly effects = new Map<string, { name: string; uid: string }>();
	readonly assets = new Map<string, AssetInfo>();
	readonly medias = new Map<string, string>();
	readonly multicams = new Map<string, string>();
	readonly building = new Set<string>();

	constructor(
		readonly b: Builder,
		readonly opts: ImportOptions,
		readonly report: Report,
	) {}

	asset(
		id: string,
		bin: ReturnType<Builder['bin']> | null,
		fallbackRate: Rate = { num: 24, den: 1 },
	): AssetInfo | null {
		const known = this.assets.get(id);
		if (known) return known;
		const n = this.assetNodes.get(id);
		if (!n) return null;
		const name = n.attrs.name || 'Asset';
		const src = child(n, 'media-rep')?.attrs.src ?? n.attrs.src ?? null;
		const fmt = n.attrs.format ? this.formats.get(n.attrs.format) : undefined;
		let hasVideo = flag(n, 'hasVideo') ?? false;
		const hasAudio = flag(n, 'hasAudio') ?? false;
		const ext = kindFromExtension(src ?? name);
		if (!hasVideo && !hasAudio) hasVideo = ext !== 'audio';
		const start = at(n, 'start') ?? 0;
		const rate = fmt?.rate ?? fallbackRate;
		const isUrl = !!src && /^(https?|s3|gs):/i.test(src);
		const path = src && !isUrl ? resolvePath(src, this.opts.baseDir) : null;
		if (!src)
			this.report.warn(`asset "${name}" has no media; imported offline`, {
				subject: { kind: 'media', name },
				instead: 'an offline media item',
			});
		const media = this.b.media(
			src ? `file:${path ?? src}` : `asset:${id}`,
			{
				name,
				kind: !hasVideo ? 'audio' : ext === 'image' ? 'image' : 'video',
				path,
				url: isUrl ? src : null,
				duration: at(n, 'duration'),
				...(hasVideo ? { video: { width: fmt?.width ?? 1920, height: fmt?.height ?? 1080, rate } } : {}),
				...(hasAudio
					? {
							audio: {
								sampleRate: parseAudioRate(n.attrs.audioRate) ?? 48000,
								channels: Number(n.attrs.audioChannels) || 2,
								...(Number(n.attrs.audioSources) > 1 ? { streams: Number(n.attrs.audioSources) } : {}),
							},
						}
					: {}),
				...(n.attrs.start !== undefined
					? { timecode: { frames: flicksToFrames(start, rate), rate, dropFrame: n.attrs.tcFormat === 'DF' } }
					: {}),
				offline: !src,
			},
			bin,
		);
		const info = { media, start, hasVideo, hasAudio };
		this.assets.set(id, info);
		return info;
	}

	/** A compound clip's sequence (`<media>` resource). */
	media(id: string, bin: ReturnType<Builder['bin']> | null, depth: number): string | null {
		const known = this.medias.get(id);
		if (known) return known;
		const n = this.mediaNodes.get(id);
		const s = child(n, 'sequence');
		if (!n || !s || this.building.has(id)) {
			if (this.building.has(id)) this.report.warn('a recursive compound clip was ignored');
			return null;
		}
		this.building.add(id);
		const sid = this.sequence(s, n.attrs.name || 'Compound Clip', bin, depth + 1);
		this.building.delete(id);
		if (sid) this.medias.set(id, sid);
		return sid;
	}

	/**
	 * A multicam clip's source (`<media>` holding a `<multicam>`): a multi-camera source sequence whose cameras are
	 * the `<mc-angle>`s, each laid out like a storyline onto its own video track (picture) and audio tracks.
	 */
	multicam(id: string, depth: number): string | null {
		const known = this.multicams.get(id);
		if (known) return known;
		const n = this.mediaNodes.get(id);
		const mc = child(n, 'multicam');
		if (!n || !mc || this.building.has(id) || depth > MAX_NEST) return null;
		this.building.add(id);
		const fmt = (mc.attrs.format && this.formats.get(mc.attrs.format)) || {
			rate: { num: 24, den: 1 },
			width: 1920,
			height: 1080,
		};
		const tc0 = at(mc, 'tcStart') ?? 0;
		const init = {
			name: n.attrs.name || 'Multicam',
			rate: fmt.rate,
			dropFrame: mc.attrs.tcFormat === 'DF',
			width: fmt.width,
			height: fmt.height,
			sampleRate: 48000,
			startTimecode: Math.max(0, flicksToFrames(tc0, fmt.rate)),
		};
		const seq = this.b.sequence(init, { bin: this.b.p.root });
		const angles: NonNullable<ISequence['multicam']>['angles'] = [];
		const used = new Set<string>();
		for (const [i, a] of children(mc, 'mc-angle').entries()) {
			const tmp = this.b.sequence({ ...init, name: 'angle' }, { bin: null });
			const ctx: Ctx = { seq: tmp, rate: fmt.rate, frame: { width: fmt.width, height: fmt.height }, depth };
			this.storyline(ctx, a, -tc0, 0, true, depth + 1);
			delete this.b.p.sequences[tmp.id];
			const video: number[] = [];
			const audio: number[] = [];
			for (const t of tmp.video)
				if (t.clips.length) {
					seq.video.push(t);
					video.push(seq.video.length - 1);
				}
			for (const t of tmp.audio)
				if (t.clips.length) {
					seq.audio.push(t);
					audio.push(seq.audio.length - 1);
				}
			if (video.length > 1)
				this.report.info(
					`camera "${a.attrs.name ?? i + 1}" of "${init.name}" has connected clips: they are kept on extra tracks`,
				);
			let aid = a.attrs.angleID || `angle${i + 1}`;
			while (used.has(aid)) aid = `${aid}_`;
			used.add(aid);
			if (!video.length && !audio.length) continue;
			angles.push({
				id: aid,
				name: a.attrs.name || `Camera ${i + 1}`,
				video: video[0] ?? null,
				audio,
				enabled: true,
			});
		}
		this.b.ensureTracks(seq, 'video', 1);
		this.b.ensureTracks(seq, 'audio', 1);
		if (angles.some((x) => x.video !== null)) seq.multicam = { angles, audio: 'switch' };
		this.building.delete(id);
		this.multicams.set(id, seq.id);
		return seq.id;
	}

	sequence(s: XNode, name: string, bin: ReturnType<Builder['bin']> | null, depth: number): string | null {
		if (depth > MAX_NEST) return null;
		const fmt = (s.attrs.format && this.formats.get(s.attrs.format)) || {
			rate: { num: 24, den: 1 },
			width: 1920,
			height: 1080,
		};
		const tc0 = at(s, 'tcStart') ?? 0;
		const seq = this.b.sequence(
			{
				name,
				rate: fmt.rate,
				dropFrame: s.attrs.tcFormat === 'DF',
				width: fmt.width,
				height: fmt.height,
				sampleRate: parseAudioRate(s.attrs.audioRate) ?? 48000,
				startTimecode: Math.max(0, flicksToFrames(tc0, fmt.rate)),
			},
			{ bin },
		);
		this.b.ensureTracks(seq, 'video', 1);
		this.b.ensureTracks(seq, 'audio', 1);
		const ctx: Ctx = { seq, rate: fmt.rate, frame: { width: fmt.width, height: fmt.height }, depth };
		const spine = child(s, 'spine');
		if (spine) this.storyline(ctx, spine, -tc0, 0, true, 0);
		seq.markers.sort((a, b) => a.start - b.start);
		if (seq.captions)
			for (const c of seq.captions) {
				c.cues.sort((a, b) => a.start - b.start);
				for (let i = 1; i < c.cues.length; i++) {
					const p = c.cues[i - 1]!;
					if (p.start + p.duration > c.cues[i]!.start) p.duration = Math.max(0, c.cues[i]!.start - p.start);
				}
				c.cues = c.cues.filter((q) => q.duration > 0);
			}
		return seq.id;
	}

	/** Lays out a storyline: timeline = origin + offset; `lane` is the storyline's lane (0 = primary). */
	storyline(ctx: Ctx, spine: XNode, origin: number, lane: number, primary: boolean, depth: number): void {
		if (depth > MAX_NEST) return;
		const laid: Laid[] = [];
		const transitions: { pos: number; el: XNode }[] = [];
		for (const el of elements(spine)) {
			if (el.name === 'transition') {
				transitions.push({ pos: laid.length, el });
				continue;
			}
			const t0 = origin + (at(el, 'offset') ?? 0);
			laid.push(this.element(ctx, el, t0, lane, primary, depth));
		}
		for (const { pos, el } of transitions) {
			const start = origin + (at(el, 'offset') ?? 0);
			const dur = at(el, 'duration') ?? 0;
			if (dur <= 0) continue;
			const fv = child(el, 'filter-video');
			const nm =
				(fv?.attrs.ref ? this.effects.get(fv.attrs.ref)?.name : undefined) ||
				fv?.attrs.name ||
				el.attrs.name ||
				'Cross Dissolve';
			const prev = pos > 0 ? laid[pos - 1] : undefined;
			const next = laid[pos];
			const from = prev?.clip && prev.end >= start ? prev : undefined;
			const to = next?.clip && next.start <= start + dur ? next : undefined;
			if (lane < 0) {
				this.report.warn(`transition "${nm}" on an audio storyline is not supported and was skipped`, {
					subject: { kind: 'transition', name: nm },
				});
				continue;
			}
			if (!from && !to) continue;
			const cut = to ? to.start : from!.end;
			const effectId = transitionFromName(nm, false, this.report);
			const track = (from ?? to)!.track;
			const t = ctx.seq.video[track];
			if (!t) continue;
			t.transitions.push({
				id: this.b.id('t'),
				effectId,
				from: from?.clip?.id ?? null,
				to: to?.clip?.id ?? null,
				start,
				duration: dur,
				alignment: cut === start ? 'start-at-cut' : cut === start + dur ? 'end-at-cut' : 'center',
				params: {},
			});
			t.transitions.sort((a, b) => a.start - b.start);
		}
	}

	/** Lays out one storyline element at timeline time `t0`. */
	element(ctx: Ctx, el: XNode, t0: number, lane: number, primary: boolean, depth: number): Laid {
		const dur = at(el, 'duration') ?? 0;
		const local = at(el, 'start') ?? 0;
		const name = el.attrs.name || 'Clip';
		let src:
			| { kind: 'media'; id: string; origin: number; v: boolean; a: boolean }
			| { kind: 'seq'; id: string; origin: number; a: boolean }
			| null = null;
		let mcSel: { video: string | undefined; audio: string | undefined; vNode: XNode | null } | null = null;
		switch (el.name) {
			case 'asset-clip': {
				const a = el.attrs.ref ? this.asset(el.attrs.ref, this.b.p.root, ctx.rate) : null;
				if (a) {
					src = { kind: 'media', id: a.media, origin: a.start, v: a.hasVideo, a: a.hasAudio };
					const tc = this.b.p.media[a.media]!.timecode;
					if (tc && el.attrs.tcFormat === 'DF') tc.dropFrame = true;
				} else this.missingRef(el, name);
				break;
			}
			case 'clip': {
				// A clip wraps video/audio/asset-clip children that reference the asset.
				const inner = elements(el).find(
					(c) => (c.name === 'video' || c.name === 'audio' || c.name === 'asset-clip') && c.attrs.ref,
				);
				const a = inner?.attrs.ref ? this.asset(inner.attrs.ref, this.b.p.root, ctx.rate) : null;
				if (a && inner) {
					const shift = (at(inner, 'start') ?? 0) - (at(inner, 'offset') ?? 0);
					const v = a.hasVideo && inner.name !== 'audio';
					const au = a.hasAudio && (inner.name !== 'video' || elements(el).some((x) => x.name === 'audio'));
					src = { kind: 'media', id: a.media, origin: a.start - shift, v, a: au };
				} else if (inner) this.missingRef(inner, name);
				break;
			}
			case 'ref-clip': {
				const sid = el.attrs.ref ? this.media(el.attrs.ref, this.b.p.root, ctx.depth) : null;
				if (sid) {
					const s = this.b.p.sequences[sid]!;
					src = {
						kind: 'seq',
						id: sid,
						origin: framesToFlicks(s.startTimecode, s.rate),
						a: s.audio.some((t) => t.clips.length),
					};
				}
				break;
			}
			case 'mc-clip': {
				const sid = el.attrs.ref ? this.multicam(el.attrs.ref, ctx.depth + 1) : null;
				if (sid) {
					const s = this.b.p.sequences[sid]!;
					src = {
						kind: 'seq',
						id: sid,
						origin: framesToFlicks(s.startTimecode, s.rate),
						a: s.audio.some((t) => t.clips.length),
					};
					const angles = s.multicam?.angles ?? [];
					const srcs = children(el, 'mc-source');
					const has = (x: XNode, k: string) => [k, 'all'].includes(x.attrs.srcEnable ?? 'all');
					const vNode = srcs.find((x) => has(x, 'video')) ?? null;
					const aNode = srcs.find((x) => has(x, 'audio')) ?? null;
					const firstV = angles.find((x) => x.video !== null)?.id;
					const known = (id: string | undefined) => (id && angles.some((x) => x.id === id) ? id : undefined);
					if (s.multicam)
						mcSel = {
							video: known(vNode?.attrs.angleID) ?? (srcs.length ? undefined : firstV),
							audio: known(aNode?.attrs.angleID) ?? (srcs.length ? undefined : firstV),
							vNode,
						};
				} else this.missingRef(el, name);
				break;
			}
			case 'sync-clip':
			case 'title':
			case 'video':
			case 'audio':
			case 'live-drawing':
				this.report.warn(
					`FCPXML <${el.name}> "${name}" at ${(t0 / 705_600_000).toFixed(3)} s is not supported and was skipped`,
					{
						subject: { kind: 'clip', name, frame: frameOf(t0, ctx.rate) },
						instead: 'nothing',
					},
				);
				break;
			case 'caption':
				this.caption(ctx, el, t0);
				return { start: t0, end: t0 + dur, clip: null, track: 0 };
		}
		const tm = timeMap(el, local);
		let vclip: IClip | null = null;
		let vtrack = 0;
		if (src && dur > 0) {
			const srcIn = tm.base - src.origin;
			const enable = el.attrs.srcEnable ?? 'all';
			const wantV =
				(src.kind === 'seq' || src.v) && enable !== 'audio' && lane >= 0 && (!mcSel || !!mcSel.video);
			const wantA = src.a && enable !== 'video' && (!mcSel || !!mcSel.audio);
			const link = wantV && wantA ? this.b.id('l') : null;
			const role = /(\d+)\s*$/.exec(el.attrs.audioRole ?? '');
			for (const kind of ['video', 'audio'] as const) {
				if (kind === 'video' ? !wantV : !wantA) continue;
				const clip: IClip = {
					id: this.b.id('c'),
					name,
					start: t0,
					duration: dur,
					sourceIn: Math.max(0, srcIn),
					speed: tm.speed,
					reverse: tm.reverse,
					...(tm.hold ? { hold: Math.max(0, srcIn), speed: 1, reverse: false } : {}),
					enabled: flag(el, 'enabled') ?? true,
					...(link ? { link } : {}),
					source:
						src.kind === 'seq'
							? { type: 'sequence', sequenceId: src.id }
							: { type: 'media', mediaId: src.id },
					markers: [],
					effects: [],
					...(mcSel
						? { multicam: { enabled: true, angle: (kind === 'video' ? mcSel.video : mcSel.audio)! } }
						: {}),
				};
				this.adjustments(clip, kind === 'video' && mcSel?.vNode ? mcSel.vNode : el, local, ctx, kind);
				if (!primary || kind === 'audio') clip.markers = this.markers(el, local, clip, ctx.rate);
				const pref =
					kind === 'video'
						? Math.max(0, lane)
						: lane < 0
							? -lane - 1
							: role && Number(role[1]) >= 1
								? Number(role[1]) - 1
								: lane;
				const used = this.b.place(ctx.seq, kind, pref, clip);
				if (kind === 'video') {
					vclip = clip;
					vtrack = used;
				}
			}
		}
		if (primary)
			for (const m of this.markers(el, local, null, ctx.rate))
				ctx.seq.markers.push({ ...m, start: t0 + m.start });
		// Connected clips, captions and secondary storylines.
		for (const c of elements(el)) {
			if (c.attrs.lane === undefined) continue;
			const l = Number(c.attrs.lane);
			if (!Number.isInteger(l)) continue;
			const ct0 = t0 + ((at(c, 'offset') ?? 0) - local);
			const clane = lane > 0 && l > 0 ? lane + l : l;
			if (c.name === 'spine') {
				const first = elements(c).find((x) => x.name !== 'transition');
				const off = first ? (at(first, 'offset') ?? 0) : 0;
				this.storyline(ctx, c, ct0 - off, clane, false, depth + 1);
			} else this.element(ctx, c, ct0, clane, false, depth + 1);
		}
		return { start: t0, end: t0 + dur, clip: vclip, track: vtrack };
	}

	missingRef(el: XNode, name: string): void {
		this.report.warn(`clip "${name}" refers to a resource the document does not define; it was skipped`, {
			subject: { kind: 'clip', name },
		});
		void el;
	}

	caption(ctx: Ctx, el: XNode, t0: number): void {
		const role = el.attrs.role ?? '';
		const lang = /captionFormat=[A-Za-z0-9]+\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)/.exec(role)?.[1];
		const caps = (ctx.seq.captions ??= []);
		const base = role.split('?')[0] ?? '';
		const name =
			base && base !== 'iTT' && base !== 'SRT' && base !== 'CEA-608'
				? base
				: lang
					? `Captions (${lang})`
					: 'Captions';
		let track = caps.find((c) => c.name === name);
		if (!track) {
			track = { name, ...(lang ? { language: lang } : {}), enabled: flag(el, 'enabled') ?? true, cues: [] };
			caps.push(track);
		}
		const textNode = child(el, 'text');
		const lines = textNode
			? textNode.children.map((x) => (typeof x === 'string' ? x : text(x))).join('')
			: (el.attrs.name ?? '');
		const dur = at(el, 'duration') ?? 0;
		if (dur > 0 && lines.trim()) track.cues.push({ start: t0, duration: dur, text: lines.trim() });
	}

	markers(el: XNode, local: number, clip: IClip | null, rate: Rate): IMarker[] {
		const out: IMarker[] = [];
		for (const m of elements(el)) {
			if (m.name !== 'marker' && m.name !== 'chapter-marker') continue;
			const rel = (at(m, 'start') ?? 0) - local;
			// Clip markers live in content time.
			const start = clip ? clip.sourceIn + Math.round(rel * clip.speed) : rel;
			const d = at(m, 'duration') ?? 0;
			const chapter = m.name === 'chapter-marker';
			out.push({
				start,
				// FCP writes one frame for a point marker.
				duration: d <= framesToFlicks(1, rate) ? 0 : d,
				name: m.attrs.value ?? '',
				comment: m.attrs.note ?? '',
				color: chapter
					? 'mango'
					: m.attrs.completed === '1'
						? 'green'
						: m.attrs.completed === '0'
							? 'rose'
							: 'blue',
				...(chapter ? { type: 'chapter' as const } : {}),
			});
		}
		return out;
	}

	adjustments(clip: IClip, el: XNode, local: number, ctx: Ctx, kind: 'video' | 'audio'): void {
		// keyframe time (element-local) → content time
		const kt = (t: number) => clip.sourceIn + Math.round((t - local) * clip.speed);
		const fw = ctx.frame.width;
		const fh = ctx.frame.height;
		let src = ctx.frame;
		if (clip.source.type === 'media') {
			const m = this.b.p.media[clip.source.mediaId];
			if (m?.video) src = { width: m.video.width, height: m.video.height };
		} else if (clip.source.type === 'sequence') {
			const s = this.b.p.sequences[clip.source.sequenceId];
			if (s) src = { width: s.width, height: s.height };
		}
		for (const a of elements(el)) {
			if (kind === 'video' && a.name === 'adjust-transform') {
				const t: Transform = {
					position: anim<Vec2>([fw / 2, fh / 2]),
					anchor: anim<Vec2>([src.width / 2, src.height / 2]),
					scale: anim(100),
					scaleWidth: anim(100),
					uniformScale: true,
					rotation: anim(0),
					flipH: false,
					flipV: false,
				};
				const toPx = (v: string, cx: number, cy: number): Vec2 => {
					const [x, y] = pair(v);
					return [r9(cx + (x * fh) / 100), r9(cy - (y * fh) / 100)];
				};
				const pos = this.kparam(a, 'position', kt, (v) => toPx(v, fw / 2, fh / 2));
				if (pos) t.position = pos;
				const anc = this.kparam(a, 'anchor', kt, (v) => toPx(v, src.width / 2, src.height / 2));
				if (anc) t.anchor = anc;
				const sx = this.kparam(a, 'scale', kt, (v) => r9(pair(v)[0] * 100));
				const sy = this.kparam(a, 'scale', kt, (v) => r9(pair(v)[1] * 100));
				if (sx && sy) {
					t.scale = sy;
					t.scaleWidth = sx;
					t.uniformScale = JSON.stringify(sx) === JSON.stringify(sy);
					// Negative factors are flips.
					if (sx.value < 0 && sx.keyframes.length === 0) {
						t.flipH = true;
						t.scaleWidth = anim(-sx.value);
					}
					if (sy.value < 0 && sy.keyframes.length === 0) {
						t.flipV = true;
						t.scale = anim(-sy.value);
					}
					if (t.flipH || t.flipV) t.uniformScale = JSON.stringify(t.scale) === JSON.stringify(t.scaleWidth);
				}
				const rot = this.kparam(a, 'rotation', kt, (v) => r9(-Number(v.trim()) || 0));
				if (rot) t.rotation = rot;
				clip.transform = t;
			} else if (kind === 'video' && a.name === 'adjust-blend') {
				const am = this.kparam(a, 'amount', kt, (v) => r9((Number(v.trim()) || 0) * 100));
				if (am) clip.opacity = am;
				if (a.attrs.mode) {
					const b = blendFromFcpxml(a.attrs.mode);
					if (b) {
						if (b !== 'normal') clip.blendMode = b;
					} else
						this.report.warn(`blend mode "${a.attrs.mode}" of clip "${clip.name}" is not supported`, {
							subject: { kind: 'clip', name: clip.name },
							instead: 'Normal',
						});
				}
			} else if (kind === 'video' && a.name === 'adjust-crop') {
				const tr = child(a, 'trim-rect') ?? child(a, 'crop-rect');
				if (tr) {
					const params: Record<string, Animatable<unknown>> = {};
					for (const k of ['left', 'right', 'top', 'bottom'] as const) {
						const v = Number(tr.attrs[k] ?? 0);
						if (v) params[k] = anim(v);
					}
					clip.effects.push({
						id: this.b.id('fx'),
						effectId: 'jasper.crop',
						effectVersion: 1,
						enabled: true,
						params: params as never,
					});
				}
			} else if (kind === 'audio' && a.name === 'adjust-volume') {
				const v = this.kparam(a, 'amount', kt, (x) => parseDb(x));
				if (v) clip.volumeDb = v;
			} else if (kind === 'audio' && a.name === 'adjust-panner') {
				const v = this.kparam(a, 'amount', kt, (x) => Number(x) || 0);
				if (v) clip.pan = v;
			} else if (
				(kind === 'video' && a.name === 'filter-video') ||
				(kind === 'audio' && a.name === 'filter-audio')
			) {
				const eff = a.attrs.ref ? this.effects.get(a.attrs.ref) : undefined;
				const nm = eff?.name || a.attrs.name || '';
				const uid = eff?.uid ?? '';
				const spec = effectSpecOf(uid.replace(/^jasper:/, ''), kind) ?? effectSpecOf(nm, kind);
				if (!spec) {
					this.report.warn(`effect "${nm}" on clip "${clip.name}" is not supported and was skipped`, {
						subject: { kind: 'effect', name: nm },
					});
					continue;
				}
				const params: Record<string, Animatable<unknown>> = {};
				for (const p of children(a, 'param')) {
					const k = p.attrs.key ?? p.attrs.name;
					const ps = spec.params.find(
						(x) => x.name === k || x.label.toLowerCase() === (k ?? '').toLowerCase(),
					);
					if (!ps) continue;
					if (ps.type === 'number') {
						const v = this.kparam(a, p.attrs.name ?? k!, kt, (x) => Number(x) || 0);
						if (v) params[ps.name] = v;
					} else if (ps.type === 'boolean')
						params[ps.name] = anim(p.attrs.value === '1' || p.attrs.value === 'true');
					else if (ps.type === 'vec2' && p.attrs.value) params[ps.name] = anim(pair(p.attrs.value));
					else if ((ps.type === 'enum' || ps.type === 'string') && p.attrs.value !== undefined)
						params[ps.name] = anim(p.attrs.value);
					else if (ps.type === 'color' && p.attrs.value) {
						const c = p.attrs.value.trim().split(/\s+/).map(Number);
						if (c.length >= 3) params[ps.name] = anim([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1]);
					}
				}
				clip.effects.push({
					id: this.b.id('fx'),
					effectId: spec.id,
					effectVersion: spec.version,
					enabled: flag(a, 'enabled') ?? true,
					params: params as never,
				});
			}
		}
	}

	/** A parameter from an adjustment attribute, with `<param name><keyframeAnimation>` keys. */
	kparam<T>(a: XNode, name: string, kt: (t: number) => number, map: (v: string) => T): Animatable<T> | null {
		const pnode = children(a, 'param').find((p) => p.attrs.name === name || p.attrs.key === name);
		const raw = a.attrs[name] ?? pnode?.attrs.value;
		if (raw === undefined && !pnode) return null;
		const out: Animatable<T> = { value: map(raw ?? '0'), keyframes: [] };
		const ka = child(pnode, 'keyframeAnimation');
		for (const k of children(ka, 'keyframe')) {
			const t = at(k, 'time');
			if (t === null || k.attrs.value === undefined) continue;
			const ip = (k.attrs.interp ?? 'linear').toLowerCase();
			out.keyframes.push(
				kf(kt(t), map(k.attrs.value), ip === 'hold' ? 'hold' : ip === 'linear' ? 'linear' : 'bezier'),
			);
		}
		out.keyframes.sort((x, y) => x.time - y.time);
		out.keyframes = out.keyframes.filter((k, i, l) => i === l.length - 1 || l[i + 1]!.time !== k.time);
		for (const k of out.keyframes) k.id = `kf${k.time}`;
		if (out.keyframes[0]) out.value = out.keyframes[0].value;
		return out;
	}
}

/** (speed, reverse, freeze, source time at the element's local start) of a `timeMap`. */
function timeMap(el: XNode, local: number): { speed: number; reverse: boolean; hold: boolean; base: number } {
	const tm = child(el, 'timeMap');
	if (!tm) return { speed: 1, reverse: false, hold: false, base: local };
	const pts = children(tm, 'timept')
		.map((p) => [at(p, 'time'), at(p, 'value')] as const)
		.filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null);
	if (pts.length < 2) return { speed: 1, reverse: false, hold: false, base: pts[0]?.[1] ?? local };
	const [t0, v0] = pts[0]!;
	const [t1, v1] = pts[pts.length - 1]!;
	const dt = t1 - t0;
	const dv = v1 - v0;
	if (dv === 0 || dt === 0) return { speed: 1, reverse: false, hold: true, base: v0 };
	const s = Math.round((dv / dt) * 1e6) / 1e6;
	const atStart = (sp: number) => v0 + Math.round((local - t0) * sp);
	if (s < 0) {
		const speed = -s;
		const hi = atStart(s);
		const len = Math.max(0, t1 - local);
		return { speed, reverse: true, hold: false, base: hi - Math.round(len * speed) };
	}
	return { speed: s, reverse: false, hold: false, base: atStart(s) };
}

function r9(v: number): number {
	const r = Math.round(v * 1e9) / 1e9;
	return Object.is(r, -0) ? 0 : r;
}

// ---------------------------------------------------------------- export

type El = { tag: string; attrs: [string, string][]; children: El[]; text?: string };
const el = (
	tag: string,
	attrs: [string, string | number | null | undefined][] = [],
	kids: El[] = [],
): El => ({
	tag,
	attrs: attrs
		.filter((a): a is [string, string | number] => a[1] !== null && a[1] !== undefined)
		.map(([k, v]) => [k, String(v)]),
	children: kids,
});

function render(e: El, depth: number, out: string[]): void {
	const pad = '\t'.repeat(depth);
	const attrs = e.attrs.map(([k, v]) => ` ${k}="${escapeXml(v, true)}"`).join('');
	if (e.text !== undefined) {
		out.push(`${pad}<${e.tag}${attrs}>${escapeXml(e.text)}</${e.tag}>\n`);
		return;
	}
	if (!e.children.length) {
		out.push(`${pad}<${e.tag}${attrs}/>\n`);
		return;
	}
	out.push(`${pad}<${e.tag}${attrs}>\n`);
	for (const c of e.children) render(c, depth + 1, out);
	out.push(`${pad}</${e.tag}>\n`);
}

/** Shortest decimal that reads back as the same double. */
function n(v: number): string {
	if (!Number.isFinite(v)) return '0';
	const s = String(Object.is(v, -0) ? 0 : v);
	return /e/i.test(s) ? v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function exportFcpxml(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): string {
	const s = p.sequences[sequenceId];
	if (!s) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const x = new FcpxmlExporter(p, report);
	const fmt = x.format(s.rate, s.width, s.height);
	const body = x.sequenceEl(sequenceId, fmt);
	const name = opts.name ?? s.name;
	const version = opts.fcpxmlVersion ?? '1.10';
	const root = el(
		'fcpxml',
		[['version', version]],
		[
			el('resources', [], x.resources),
			el('library', [], [el('event', [['name', p.name]], [el('project', [['name', name]], [body])])]),
		],
	);
	const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n'];
	render(root, 0, out);
	return out.join('');
}

type PEl = { start: number; end: number; local: number; el: El };

class FcpxmlExporter {
	readonly resources: El[] = [];
	readonly formats: { id: string; rate: Rate; w: number; h: number }[] = [];
	readonly assets = new Map<string, string>();
	readonly medias = new Map<string, string>();
	readonly multicams = new Map<string, string>();
	readonly effects = new Map<string, string>();
	readonly building = new Set<string>();
	next = 1;

	constructor(
		readonly p: IProject,
		readonly report: Report,
	) {}

	rid(): string {
		return `r${this.next++}`;
	}

	format(rate: Rate, w: number, h: number): string {
		const f = this.formats.find(
			(x) => x.rate.num * rate.den === rate.num * x.rate.den && x.w === w && x.h === h,
		);
		if (f) return f.id;
		const id = this.rid();
		const fps = rate.num / rate.den;
		const label = Number.isInteger(fps) ? String(fps) : fps.toFixed(2).replace('.', '');
		this.resources.push(
			el('format', [
				['id', id],
				['name', `FFVideoFormat${h}p${label}`],
				['frameDuration', `${rate.den}/${rate.num}s`],
				['width', w],
				['height', h],
				['colorSpace', '1-1-1 (Rec. 709)'],
			]),
		);
		this.formats.push({ id, rate, w, h });
		return id;
	}

	asset(m: IMedia, seqRate: Rate): string {
		const known = this.assets.get(m.id);
		if (known) return known;
		const id = this.rid();
		this.assets.set(m.id, id);
		const mrate = m.video?.rate ?? seqRate;
		const fmt = m.video ? this.format(mrate, m.video.width, m.video.height) : null;
		const start = m.timecode ? framesToFlicks(m.timecode.frames, m.timecode.rate) : 0;
		const src = m.path ? (isAbsolutePath(m.path) ? pathToFileUrl(m.path) : m.path) : (m.url ?? null);
		if (!src)
			this.report.warn(`media "${m.name}" has no file path`, {
				subject: { kind: 'media', id: m.id, name: m.name },
				instead: 'an asset without a media reference (offline)',
			});
		this.resources.push(
			el(
				'asset',
				[
					['id', id],
					['name', m.name],
					['start', fmtTime(start, mrate)],
					['duration', m.duration !== null ? fmtTime(m.duration, mrate) : '0s'],
					['hasVideo', m.video ? 1 : 0],
					['hasAudio', m.audio ? 1 : 0],
					['format', fmt],
					...(m.audio
						? ([
								['audioSources', m.audio.streams ?? 1],
								['audioChannels', m.audio.channels],
								['audioRate', m.audio.sampleRate],
							] as [string, number][])
						: []),
				],
				src
					? [
							el('media-rep', [
								['kind', 'original-media'],
								['src', src],
							]),
						]
					: [],
			),
		);
		return id;
	}

	effect(name: string, uid: string): string {
		const known = this.effects.get(uid);
		if (known) return known;
		const id = this.rid();
		this.resources.push(
			el('effect', [
				['id', id],
				['name', name],
				['uid', uid],
			]),
		);
		this.effects.set(uid, id);
		return id;
	}

	media(sid: string): string | null {
		const known = this.medias.get(sid);
		if (known) return known;
		const s = this.p.sequences[sid];
		if (!s || this.building.has(sid)) return null;
		const fmt = this.format(s.rate, s.width, s.height);
		const id = this.rid();
		this.medias.set(sid, id);
		this.building.add(sid);
		const body = this.sequenceEl(sid, fmt);
		this.building.delete(sid);
		this.resources.push(
			el(
				'media',
				[
					['id', id],
					['name', s.name],
				],
				[body],
			),
		);
		return id;
	}

	/**
	 * A multi-camera source as a `<media>` resource holding a `<multicam>`: one `<mc-angle>` per camera (its video
	 * track and audio tracks laid out like a storyline), in camera order.
	 */
	multicamMedia(sid: string): string | null {
		const known = this.multicams.get(sid);
		if (known) return known;
		const s = this.p.sequences[sid];
		const mc = s?.multicam;
		if (!s || !mc || this.building.has(sid)) return null;
		const fmt = this.format(s.rate, s.width, s.height);
		const id = this.rid();
		this.multicams.set(sid, id);
		this.building.add(sid);
		const where = { kind: 'sequence' as const, id: sid, name: s.name };
		const inAngle = new Set<ITrack>();
		const angles = mc.angles.map((a) => {
			const video = a.video !== null && s.video[a.video] ? [s.video[a.video]!] : [];
			const audio = a.audio.map((i) => s.audio[i]).filter((t): t is ITrack => !!t);
			for (const t of [...video, ...audio]) inAngle.add(t);
			const tmpId = `${sid}~angle~${a.id}`;
			this.p.sequences[tmpId] = {
				...s,
				id: tmpId,
				video,
				audio,
				markers: [],
				captions: [],
				multicam: undefined,
			};
			let body: El;
			try {
				body = this.sequenceEl(tmpId, fmt);
			} finally {
				delete this.p.sequences[tmpId];
			}
			const spine = body.children.find((c) => c.tag === 'spine')?.children ?? [];
			return el(
				'mc-angle',
				[
					['name', a.name],
					['angleID', a.id],
				],
				spine,
			);
		});
		const rest = [...s.video, ...s.audio].filter((t) => t.clips.length && !inAngle.has(t)).length;
		if (rest)
			this.report.warn(
				`${rest} track(s) of multi-camera source "${s.name}" belong to no camera and are not carried by FCPXML multicam`,
				{ subject: where, instead: 'nothing' },
			);
		if (mc.angles.some((a) => !a.enabled))
			this.report.info(`the hidden cameras of "${s.name}" are written as ordinary angles`, {
				subject: where,
			});
		if (s.markers.length)
			this.report.info(`the markers of multi-camera source "${s.name}" are not carried by FCPXML multicam`, {
				subject: where,
			});
		this.building.delete(sid);
		this.resources.push(
			el(
				'media',
				[
					['id', id],
					['name', s.name],
				],
				[
					el(
						'multicam',
						[
							['format', fmt],
							['tcStart', fmtTime(framesToFlicks(s.startTimecode, s.rate), s.rate)],
							['tcFormat', s.dropFrame ? 'DF' : 'NDF'],
						],
						angles,
					),
				],
			),
		);
		return id;
	}

	sequenceEl(sid: string, fmt: string): El {
		const s = this.p.sequences[sid]!;
		const rate = s.rate;
		const tc0 = framesToFlicks(s.startTimecode, rate);
		// A/V pairs written as one clip: linked, same media, same timing, audio on the same-numbered track.
		const merged = new Map<string, IClip>();
		s.video.forEach((vt, vi) => {
			const atk = s.audio[vi];
			if (!atk) return;
			for (const v of vt.clips) {
				const a = atk.clips.find(
					(c) =>
						!!c.link &&
						c.link === v.link &&
						JSON.stringify(c.source) === JSON.stringify(v.source) &&
						c.start === v.start &&
						c.duration === v.duration &&
						c.sourceIn === v.sourceIn &&
						c.speed === v.speed &&
						c.reverse === v.reverse &&
						(c.hold ?? null) === (v.hold ?? null) &&
						c.enabled === v.enabled &&
						(c.label ?? null) === (v.label ?? null) &&
						!c.markers.length &&
						!c.effects.length &&
						!a_used(merged, c),
				);
				if (a) merged.set(v.id, a);
			}
		});
		const mergedAudio = new Set([...merged.values()].map((c) => c.id));
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips)
				if (c.link && !merged.has(c.id) && !mergedAudio.has(c.id))
					this.report.info(
						`the link of clip "${c.name}" is not carried (FCPXML links picture and sound only as one clip with identical timing)`,
						{
							subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, rate) },
							instead: 'an unlinked clip',
						},
					);
		for (let ti = 0; ti < s.video.length; ti++)
			if (ti > 0)
				for (const x of s.video[ti]!.transitions)
					this.report.warn(
						`transition "${transitionLabel(x.effectId)}" on V${ti + 1} is not carried (FCPXML transitions live on the primary storyline)`,
						{
							subject: {
								kind: 'transition',
								id: x.id,
								name: transitionLabel(x.effectId),
								frame: frameOf(x.start, rate),
							},
							instead: 'a cut',
						},
					);
		s.audio.forEach((t, ti) => {
			for (const x of t.transitions)
				this.report.warn(
					`audio transition "${transitionLabel(x.effectId)}" on A${ti + 1} is not carried by FCPXML`,
					{
						subject: {
							kind: 'transition',
							id: x.id,
							name: transitionLabel(x.effectId),
							frame: frameOf(x.start, rate),
						},
						instead: 'a cut',
					},
				);
			if (
				t.volumeDb?.keyframes.length ||
				(t.volumeDb && t.volumeDb.value !== 0) ||
				t.pan?.keyframes.length ||
				(t.pan && t.pan.value !== 0)
			)
				this.report.warn(`the volume and pan of track A${ti + 1} are not carried by FCPXML`, {
					subject: { kind: 'track', name: t.name ?? `A${ti + 1}` },
					instead: 'the clips at unity track level',
				});
		});
		const groups = new Set(
			[...s.video, ...s.audio].flatMap((t) => t.clips.map((c) => c.group).filter(Boolean)),
		);
		if (groups.size)
			this.report.info(
				`${groups.size} clip group(s) of "${s.name}" have no FCPXML equivalent and were not written`,
				{
					subject: { kind: 'sequence', id: sid, name: s.name },
				},
			);
		// Primary storyline from V1 (gaps fill holes; a trailing gap covers connected clips, captions and markers).
		const els: PEl[] = [];
		const transAt: { index: number; e: El }[] = [];
		let t = 0;
		const gap = (a: number, b: number) =>
			els.push({
				start: a,
				end: b,
				local: tc0 + a,
				el: el('gap', [
					['name', 'Gap'],
					['offset', fmtTime(tc0 + a, rate)],
					['start', fmtTime(tc0 + a, rate)],
					['duration', fmtTime(b - a, rate)],
				]),
			});
		const v1 = s.video[0];
		for (const c of v1?.clips ?? []) {
			if (c.start > t) gap(t, c.start);
			for (const x of v1!.transitions)
				if (x.to === c.id) transAt.push({ index: els.length, e: this.transition(x, tc0, rate) });
			const pe = this.clipEl(c, merged.get(c.id) ?? null, 'video', 0, tc0 + c.start, null, s);
			els.push(pe);
			for (const x of v1!.transitions)
				if (x.from === c.id && !x.to) transAt.push({ index: els.length, e: this.transition(x, tc0, rate) });
			t = c.start + c.duration;
		}
		const lastStart = Math.max(
			-1,
			...[...s.video.slice(1), ...s.audio].flatMap((tr) => tr.clips.map((c) => c.start)),
			...s.markers.map((m) => m.start),
			...(s.captions ?? []).flatMap((c) => c.cues.map((q) => q.start)),
		);
		if (lastStart >= t)
			gap(
				t,
				Math.max(
					sequenceDuration(s),
					lastStart + framesToFlicks(1, rate),
					...(s.captions ?? []).flatMap((c) => c.cues.map((q) => q.start + q.duration)),
				),
			);
		const attach = (start: number, e: El, what: string) => {
			const host = els.find((x) => x.start <= start && start < x.end);
			if (!host) {
				this.report.warn(`${what} could not be attached to the primary storyline and was dropped`);
				return;
			}
			const local = host.local + (start - host.start);
			e.attrs = e.attrs.map(([k, v]) => [k, k === 'offset' ? fmtTime(local, rate) : v]);
			host.el.children.push(e);
		};
		// Connected clips.
		for (const kind of ['video', 'audio'] as const)
			s[kind].forEach((track, ti) => {
				if (kind === 'video' && ti === 0) return;
				const lane = kind === 'video' ? ti : -(ti + 1);
				for (const c of track.clips) {
					if (mergedAudio.has(c.id)) continue;
					const pe = this.clipEl(
						c,
						kind === 'video' ? (merged.get(c.id) ?? null) : null,
						kind,
						ti,
						0,
						lane,
						s,
					);
					attach(c.start, pe.el, describeClip(c, rate));
				}
			});
		// Captions.
		(s.captions ?? []).forEach((ct, ci) => {
			const lang = ct.language ?? 'en';
			for (const q of ct.cues) {
				const e = el(
					'caption',
					[
						['lane', s.video.length + ci],
						['offset', '0s'],
						['name', q.text.split('\n')[0]!.slice(0, 64)],
						['start', fmtTime(0, rate)],
						['duration', fmtTime(q.duration, rate)],
						['role', `iTT?captionFormat=ITT.${lang}`],
						['enabled', ct.enabled ? null : 0],
					],
					[{ tag: 'text', attrs: [['placement', 'bottom']], children: [], text: q.text }],
				);
				attach(q.start, e, `caption "${q.text.slice(0, 32)}"`);
			}
		});
		// Sequence markers on the covering primary element.
		for (const m of s.markers) {
			const host = els.find((x) => x.start <= m.start && m.start < x.end);
			if (!host) {
				this.report.warn(`sequence marker "${m.name}" past the end of the timeline was dropped`, {
					subject: { kind: 'marker', name: m.name, frame: frameOf(m.start, rate) },
				});
				continue;
			}
			host.el.children.push(markerEl(m, host.local + (m.start - host.start), rate));
		}
		const spine: El[] = [];
		let k = 0;
		els.forEach((e, i) => {
			while (k < transAt.length && transAt[k]!.index === i) spine.push(transAt[k++]!.e);
			spine.push(e.el);
		});
		while (k < transAt.length) spine.push(transAt[k++]!.e);
		return el(
			'sequence',
			[
				['format', fmt],
				['duration', fmtTime(sequenceDuration(s), rate)],
				['tcStart', fmtTime(tc0, rate)],
				['tcFormat', s.dropFrame ? 'DF' : 'NDF'],
				['audioLayout', 'stereo'],
				['audioRate', audioRateStr(s.sampleRate)],
			],
			[el('spine', [], spine)],
		);
	}

	transition(x: ITransition, tc0: number, rate: Rate): El {
		const name = transitionLabel(x.effectId);
		const r = this.effect(name, `jasper:${x.effectId}`);
		return el(
			'transition',
			[
				['name', name],
				['offset', fmtTime(tc0 + x.start, rate)],
				['duration', fmtTime(x.duration, rate)],
			],
			[
				el('filter-video', [
					['ref', r],
					['name', name],
				]),
			],
		);
	}

	/** A clip element at `offset` (its parent's local time; connected clips get it when attached). */
	clipEl(
		c: IClip,
		audio: IClip | null,
		kind: 'video' | 'audio',
		ti: number,
		offset: number,
		lane: number | null,
		s: ISequence,
	): PEl {
		const rate = s.rate;
		const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: frameOf(c.start, rate) };
		const m = c.source.type === 'media' ? this.p.media[c.source.mediaId] : undefined;
		const gapEl = (instead: string, msg: string): PEl => {
			this.report.warn(msg, { subject: where, instead });
			return {
				start: c.start,
				end: c.start + c.duration,
				local: offset,
				el: el('gap', [
					['name', c.name],
					['lane', lane],
					['offset', fmtTime(offset, rate)],
					['start', fmtTime(offset, rate)],
					['duration', fmtTime(c.duration, rate)],
				]),
			};
		};
		if (c.source.type === 'none') return gapEl('a gap', `${describeClip(c, rate)} has no FCPXML equivalent`);
		if (m?.generator)
			return gapEl(
				'a gap',
				`${describeClip(c, rate)} uses the generator "${m.name}", which FCPXML cannot reference`,
			);
		let tag: string;
		let ref: string | null;
		let origin: number;
		let hasVideo = true;
		let hasAudio = false;
		const mcInfo = c.source.type === 'sequence' ? multicamOf(this.p, c) : null;
		if (c.source.type === 'sequence') {
			ref = mcInfo ? this.multicamMedia(c.source.sequenceId) : this.media(c.source.sequenceId);
			if (!ref) return gapEl('a gap', `${describeClip(c, rate)} refers to a missing or recursive sequence`);
			const inner = this.p.sequences[c.source.sequenceId]!;
			tag = mcInfo ? 'mc-clip' : 'ref-clip';
			origin = framesToFlicks(inner.startTimecode, inner.rate);
			hasAudio = inner.audio.some((t) => t.clips.length);
		} else {
			ref = this.asset(m!, rate);
			tag = 'asset-clip';
			origin = m!.timecode ? framesToFlicks(m!.timecode.frames, m!.timecode.rate) : 0;
			hasVideo = !!m!.video;
			hasAudio = !!m!.audio;
		}
		const local = origin + (c.hold ?? c.sourceIn);
		const kids: El[] = [];
		const retimed = c.speed !== 1 || c.reverse || c.hold != null;
		if (retimed) {
			const v0 = local;
			const span = Math.round(c.duration * c.speed);
			const [a, b] = c.hold != null ? [v0, v0] : c.reverse ? [v0 + span, v0] : [v0, v0 + span];
			kids.push(
				el(
					'timeMap',
					[],
					[
						el('timept', [
							['time', fmtTime(local, rate)],
							['value', fmtTime(a, rate)],
							['interp', 'linear'],
						]),
						el('timept', [
							['time', fmtTime(local + c.duration, rate)],
							['value', fmtTime(b, rate)],
							['interp', 'linear'],
						]),
					],
				),
			);
		}
		// keyframe content time → element local time
		const toLocal = (t: number) =>
			c.speed === 0 ? local : local + Math.round((t - (c.hold ?? c.sourceIn)) / c.speed);
		if (kind === 'video') this.visual(c, s, toLocal, kids, where);
		const a = audio ?? (kind === 'audio' ? c : null);
		if (a) {
			const g = a.gainDb ?? 0;
			if (g) this.report.info(`the clip gain of "${a.name}" was folded into its volume`, { subject: where });
			if ((a.volumeDb && (a.volumeDb.value !== 0 || a.volumeDb.keyframes.length)) || g)
				kids.push(
					this.kparam(
						'adjust-volume',
						'amount',
						a.volumeDb ?? anim(0),
						rate,
						toLocal,
						(v) => `${n(r9(v + g))}dB`,
					),
				);
			if (a.pan && (a.pan.value !== 0 || a.pan.keyframes.length))
				kids.push(this.kparam('adjust-panner', 'amount', a.pan, rate, toLocal, (v) => n(v), [['mode', '1']]));
		}
		for (const e of c.effects) {
			if (e.effectId === 'jasper.crop' && kind === 'video') {
				const v = (k: string) => (e.params[k] as Animatable<number> | undefined)?.value ?? 0;
				if (Object.values(e.params).some((x) => (x as Animatable<unknown>).keyframes.length))
					this.report.warn(`crop keyframes of clip "${c.name}" are written as the static crop`, {
						subject: where,
					});
				kids.push(
					el(
						'adjust-crop',
						[['mode', 'trim']],
						[
							el('trim-rect', [
								['left', n(v('left'))],
								['top', n(v('top'))],
								['right', n(v('right'))],
								['bottom', n(v('bottom'))],
							]),
						],
					),
				);
				continue;
			}
			const spec = effectSpecOf(e.effectId);
			if (!spec) {
				this.report.warn(`unknown effect "${e.effectId}" on clip "${c.name}" was not exported`, {
					subject: where,
				});
				continue;
			}
			const r = this.effect(spec.label, `jasper:${spec.id}`);
			this.report.info(
				`effect "${spec.label}" on clip "${c.name}" is written as a filter with its JasperEditor id; other applications ignore it`,
				{
					subject: { ...where, kind: 'effect', name: spec.label },
					instead: `a "${spec.label}" filter reference`,
				},
			);
			const params: El[] = [];
			for (const ps of spec.params) {
				const pa = e.params[ps.name];
				if (!pa) continue;
				const v = pa.value;
				if (typeof v === 'number')
					params.push(
						this.kparam(
							'param',
							ps.name,
							pa as Animatable<number>,
							rate,
							toLocal,
							(x) => n(x),
							[['key', ps.name]],
							true,
						),
					);
				else if (typeof v === 'boolean')
					params.push(
						el('param', [
							['name', ps.name],
							['key', ps.name],
							['value', v ? 1 : 0],
						]),
					);
				else if (typeof v === 'string')
					params.push(
						el('param', [
							['name', ps.name],
							['key', ps.name],
							['value', v],
						]),
					);
				else if (Array.isArray(v))
					params.push(
						el('param', [
							['name', ps.name],
							['key', ps.name],
							['value', (v as number[]).map(n).join(' ')],
						]),
					);
			}
			kids.push(
				el(
					kind === 'video' ? 'filter-video' : 'filter-audio',
					[
						['ref', r],
						['name', spec.label],
						['enabled', e.enabled ? null : 0],
					],
					params,
				),
			);
		}
		const primary = lane === null;
		if (primary && c.markers.length)
			this.report.info(
				`markers of clip "${c.name}" on V1 are written on the primary storyline and import as sequence markers`,
				{ subject: where },
			);
		for (const mk of c.markers) kids.push(markerEl(mk, toLocal(mk.start), rate));
		const srcEnable =
			kind === 'video' ? (audio ? null : hasAudio ? 'video' : null) : hasVideo ? 'audio' : null;
		const attrs: [string, string | number | null | undefined][] = [
			['ref', ref],
			['lane', lane],
			['name', c.name],
			['offset', fmtTime(offset, rate)],
			['start', fmtTime(local, rate)],
			['duration', fmtTime(c.duration, rate)],
			['srcEnable', srcEnable],
			['tcFormat', m?.timecode ? (m.timecode.dropFrame ? 'DF' : 'NDF') : null],
			['enabled', c.enabled ? null : 0],
			...(kind === 'video' && hasVideo
				? ([['videoRole', `video.video-${ti + 1}`]] as [string, string][])
				: []),
			...((kind === 'audio' || audio) && hasAudio
				? ([['audioRole', `dialogue.dialogue-${ti + 1}`]] as [string, string][])
				: []),
		];
		if (mcInfo) {
			// mc-clip: timing and audio adjustments, then one mc-source per angle used (picture adjustments and video
			// filters on the video angle's), then markers and audio filters (FCPXML DTD order).
			const vAngle = kind === 'video' ? mcInfo.angle : null;
			const ac = audio ?? (kind === 'audio' ? c : null);
			const aInfo = ac ? multicamOf(this.p, ac) : null;
			const audible = aInfo ? multicamAudibleTracks(aInfo.mc, aInfo.angle) : new Set<number>();
			const aAngles = aInfo ? aInfo.mc.angles.filter((x) => x.audio.some((i) => audible.has(i))) : [];
			const isVideoKid = (k: El) =>
				k.tag === 'filter-video' ||
				(k.tag.startsWith('adjust-') && k.tag !== 'adjust-volume' && k.tag !== 'adjust-panner');
			const head = kids.filter((k) => k.tag === 'timeMap' || k.tag === 'conform-rate');
			const audioAdj = kids.filter((k) => k.tag === 'adjust-volume' || k.tag === 'adjust-panner');
			const tail = kids.filter(
				(k) => k.tag === 'marker' || k.tag === 'chapter-marker' || k.tag === 'filter-audio',
			);
			const sources: El[] = [];
			if (vAngle) {
				const both = aAngles.some((x) => x.id === vAngle.id);
				sources.push(
					el(
						'mc-source',
						[
							['angleID', vAngle.id],
							['srcEnable', both ? 'all' : 'video'],
						],
						kids.filter(isVideoKid),
					),
				);
			}
			for (const x of aAngles)
				if (x.id !== vAngle?.id)
					sources.push(
						el('mc-source', [
							['angleID', x.id],
							['srcEnable', 'audio'],
						]),
					);
			if (aAngles.length > 1 && aInfo?.mc.audio === 'all')
				this.report.info(
					`multi-camera clip "${c.name}" mixes every camera: one audio angle per camera is enabled`,
					{
						subject: where,
					},
				);
			return {
				start: c.start,
				end: c.start + c.duration,
				local,
				el: el(tag, attrs, [...head, ...audioAdj, ...sources, ...tail]),
			};
		}
		return { start: c.start, end: c.start + c.duration, local, el: el(tag, attrs, kids) };
	}

	visual(
		c: IClip,
		s: ISequence,
		toLocal: (t: number) => number,
		out: El[],
		where: { kind: 'clip'; id: string; name: string; frame: number },
	): void {
		const rate = s.rate;
		const fw = s.width;
		const fh = s.height;
		let src = { width: fw, height: fh };
		if (c.source.type === 'media') {
			const m = this.p.media[c.source.mediaId];
			if (m?.video) src = { width: m.video.width, height: m.video.height };
		} else if (c.source.type === 'sequence') {
			const inner = this.p.sequences[c.source.sequenceId];
			if (inner) src = { width: inner.width, height: inner.height };
		}
		const t = c.transform;
		if (t) {
			const pos = (cx: number, cy: number) => (v: Vec2) =>
				`${n(((v[0] - cx) / fh) * 100)} ${n((-(v[1] - cy) / fh) * 100)}`;
			const attrs: [string, string][] = [];
			const params: El[] = [];
			const add = <T>(name: string, a: Animatable<T>, f: (v: T) => string, isDefault: boolean) => {
				if (isDefault && !a.keyframes.length) return;
				attrs.push([name, f(a.value)]);
				if (a.keyframes.length) params.push(this.keyParam(name, a, rate, toLocal, f));
			};
			add(
				'position',
				t.position,
				pos(fw / 2, fh / 2),
				t.position.value[0] === fw / 2 && t.position.value[1] === fh / 2,
			);
			add(
				'anchor',
				t.anchor,
				pos(src.width / 2, src.height / 2),
				t.anchor.value[0] === src.width / 2 && t.anchor.value[1] === src.height / 2,
			);
			const sw = t.uniformScale ? t.scale : t.scaleWidth;
			const fx = t.flipH ? -1 : 1;
			const fy = t.flipV ? -1 : 1;
			if (
				sw.keyframes.length &&
				t.scale.keyframes.length &&
				JSON.stringify(sw.keyframes.map((k) => k.time)) !==
					JSON.stringify(t.scale.keyframes.map((k) => k.time))
			)
				this.report.warn(
					`scale width and height keys of clip "${c.name}" at different times are written at the height's times`,
					{ subject: where },
				);
			const scaleAnim: Animatable<[number, number]> = {
				value: [sw.value, t.scale.value],
				keyframes: (t.scale.keyframes.length ? t.scale.keyframes : sw.keyframes).map((k, i) => ({
					...k,
					value: [sw.keyframes[i]?.value ?? sw.value, t.scale.keyframes[i]?.value ?? t.scale.value] as [
						number,
						number,
					],
				})),
			};
			add(
				'scale',
				scaleAnim,
				(v) => `${n((v[0] * fx) / 100)} ${n((v[1] * fy) / 100)}`,
				sw.value === 100 && t.scale.value === 100 && fx === 1 && fy === 1,
			);
			add('rotation', t.rotation, (v) => n(-v), t.rotation.value === 0);
			if (attrs.length) out.push({ tag: 'adjust-transform', attrs, children: params });
		}
		const blend = c.blendMode && c.blendMode !== 'normal' ? fcpxmlBlend(c.blendMode) : null;
		if (c.blendMode && c.blendMode !== 'normal' && !blend)
			this.report.warn(`blend mode ${c.blendMode} of clip "${c.name}" is not available in FCPXML`, {
				subject: where,
				instead: 'Normal',
			});
		if ((c.opacity && (c.opacity.value !== 100 || c.opacity.keyframes.length)) || blend) {
			const e = this.kparam('adjust-blend', 'amount', c.opacity ?? anim(100), rate, toLocal, (v) =>
				n(r9(v / 100)),
			);
			if (blend) e.attrs.push(['mode', blend]);
			out.push(e);
		}
	}

	keyParam<T>(
		name: string,
		a: Animatable<T>,
		rate: Rate,
		toLocal: (t: number) => number,
		f: (v: T) => string,
	): El {
		const keys: El[] = [];
		a.keyframes.forEach((k, i) => {
			keys.push(
				el('keyframe', [
					['time', fmtTime(toLocal(k.time), rate)],
					['value', f(k.value)],
					...interpAttrs(k.interpolation),
				]),
			);
			// A hold key: FCPXML has no hold interpolation; the value is repeated on the frame before the next key, which
			// holds it on every frame.
			const nx = a.keyframes[i + 1];
			if (k.interpolation === 'hold' && nx) {
				const tt = toLocal(nx.time) - framesToFlicks(1, rate);
				if (tt > toLocal(k.time))
					keys.push(
						el('keyframe', [
							['time', fmtTime(tt, rate)],
							['value', f(k.value)],
							['interp', 'linear'],
							['curve', 'linear'],
						]),
					);
			}
		});
		return el('param', [['name', name]], [el('keyframeAnimation', [], keys)]);
	}

	kparam<T>(
		tag: string,
		name: string,
		a: Animatable<T>,
		rate: Rate,
		toLocal: (t: number) => number,
		f: (v: T) => string,
		extra: [string, string][] = [],
		asParam = false,
	): El {
		if (asParam) {
			const e = el('param', [['name', name], ...extra, ['value', f(a.value)]]);
			if (a.keyframes.length) e.children.push(this.keyParam(name, a, rate, toLocal, f).children[0]!);
			return e;
		}
		const e = el(tag, [[name, f(a.value)], ...extra]);
		if (a.keyframes.length) e.children.push(this.keyParam(name, a, rate, toLocal, f));
		return e;
	}
}

function interpAttrs(i: Keyframe<unknown>['interpolation']): [string, string][] {
	return i === 'linear' || i === 'hold'
		? [
				['interp', 'linear'],
				['curve', 'linear'],
			]
		: [
				['interp', 'ease'],
				['curve', 'smooth'],
			];
}

function a_used(merged: Map<string, IClip>, c: IClip): boolean {
	for (const v of merged.values()) if (v.id === c.id) return true;
	return false;
}

function markerEl(m: IMarker, local: number, rate: Rate): El {
	const chapter = m.type === 'chapter';
	const dur = m.duration > 0 ? m.duration : framesToFlicks(1, rate);
	// FCP markers have no colours: green ↔ completed to-do, rose ↔ open to-do, others standard markers.
	const completed = chapter ? null : m.color === 'green' ? 1 : m.color === 'rose' ? 0 : null;
	return el(chapter ? 'chapter-marker' : 'marker', [
		['start', fmtTime(local, rate)],
		['duration', fmtTime(dur, rate)],
		['value', m.name],
		['completed', completed],
		['note', m.comment || null],
	]);
}

export type { ITrack };
