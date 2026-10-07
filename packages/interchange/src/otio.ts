// OpenTimelineIO JSON (`.otio`).
//
// Schemas read and written: `Timeline.1`, `Stack.1`, `Track.1`, `Clip.1`/`Clip.2`, `Gap.1`, `Transition.1`,
// `Marker.1`/`Marker.2`, `ExternalReference.1`, `MissingReference.1`, `GeneratorReference.1`,
// `ImageSequenceReference.1` (read), `LinearTimeWarp.1`, `FreezeFrame.1`, `Effect.1`, `RationalTime.1`,
// `TimeRange.1` and `SerializableCollection.1` (several timelines).
//
// Times are written as frames at the sequence rate (`rate` is the exact rate as a float, e.g.
// 23.976023976023978) and read back exactly by snapping the rate to its rational form; sub-frame times keep
// their exact flick value in the metadata. Everything OTIO has no schema for — Motion, opacity, blend mode,
// audio levels, pan, gain, channels, effects and their keyframes, labels, links, groups, track state, sequence
// settings, media info, generators, bins, marker types, and the JasperEditor entities themselves — round-trips
// through `metadata.jasper`, so export → import is the identity on the whole interchange model. Nested sequences
// are `Stack` items inside tracks (written once per use; read back as one sequence).
//
// Port of FilmCraft `crates/interchange/src/otio.rs` (MIT OR Apache-2.0), extended.
import { Builder, colorNameOf, describeClip, frameOf, labelFromColorName } from './build.ts';
import {
	CONSTANT_GAIN,
	CONSTANT_POWER,
	CROSS_DISSOLVE,
	transitionFromName,
	transitionLabel,
} from './effects.ts';
import type {
	IBinEntry,
	IClip,
	IGenerator,
	IMarker,
	IMedia,
	IProject,
	ISequence,
	ITrack,
	ITransition,
	Rate,
} from './model.ts';
import { FLICKS } from './model.ts';
import type { ExportOptions, ImportOptions } from './options.ts';
import { fileName, isAbsolutePath, pathToFileUrl, relativePath, resolvePath } from './paths.ts';
import { InterchangeError, parseError, type Report } from './report.ts';
import { flicksToFrames, fps, framesToFlicks, rateFromFloat } from './time.ts';

type J = Record<string, unknown>;
const FORMAT = 'OpenTimelineIO';
const MAX_DEPTH = 64;

// ---------------------------------------------------------------- time

function rt(t: number, rate: Rate): J {
	const f = flicksToFrames(t, rate, 'floor');
	const value = framesToFlicks(f, rate) === t ? f : (t * rate.num) / (rate.den * FLICKS);
	return { OTIO_SCHEMA: 'RationalTime.1', rate: fps(rate), value };
}

function tr(start: number, dur: number, rate: Rate): J {
	return { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start, rate), duration: rt(dur, rate) };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function readRate(v: unknown): Rate | null {
	const r = num(obj(v)?.rate);
	return r && r > 0 ? rateFromFloat(r) : null;
}

/** RationalTime → flicks (exact for integral values at broadcast rates). */
function readRt(v: unknown): number | null {
	const o = obj(v);
	if (!o) return null;
	const rate = num(o.rate);
	const value = num(o.value);
	if (rate === null || value === null || rate <= 0) return null;
	const r = rateFromFloat(rate);
	if (Number.isInteger(value) && Math.abs(value) < 9e15) return framesToFlicks(value, r);
	return Math.round((value * FLICKS * r.den) / r.num);
}

function readTr(v: unknown): { start: number; duration: number } | null {
	const o = obj(v);
	if (!o) return null;
	const start = readRt(o.start_time);
	const duration = readRt(o.duration);
	if (start === null || duration === null) return null;
	return { start, duration };
}

/** An exact flick value from metadata when it agrees with the schema value within a millisecond. */
function exact(meta: unknown, schemaValue: number): number {
	const m = num(meta);
	return m !== null && Number.isInteger(m) && Math.abs(m - schemaValue) < FLICKS / 1000 ? m : schemaValue;
}

const schema = (v: unknown) => str(obj(v)?.OTIO_SCHEMA) ?? '';
const schemaName = (v: unknown) => schema(v).split('.')[0] ?? '';
const nameOf = (v: unknown) => str(obj(v)?.name) ?? '';
/** Our metadata namespace on an OTIO object. */
const jm = (v: unknown): J | null => obj(obj(obj(v)?.metadata)?.jasper);

// ---------------------------------------------------------------- export

export function sniffOtio(head: string): boolean {
	const h = head.replace(/^﻿/, '').trimStart();
	return h.startsWith('{') && h.includes('"OTIO_SCHEMA"');
}

const SMPTE_DISSOLVES = new Set([CROSS_DISSOLVE, CONSTANT_POWER, CONSTANT_GAIN, 'jasper.film-dissolve']);

function strip<T extends object>(v: T, ...keys: (keyof T)[]): Partial<T> {
	const o = { ...v };
	for (const k of keys) delete o[k];
	return o;
}

export function exportOtio(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): string {
	const top = p.sequences[sequenceId];
	if (!top) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const rate = top.rate;
	const name = opts.name ?? top.name;
	const stack: string[] = [sequenceId];

	const mediaMeta = (m: IMedia): J => {
		const o = strip(m, 'embedded') as J;
		return o;
	};

	const mediaRef = (m: IMedia | undefined, clipName: string): J => {
		if (!m) return { OTIO_SCHEMA: 'MissingReference.1', name: clipName, available_range: null, metadata: {} };
		const origin = m.timecode ? framesToFlicks(m.timecode.frames, m.timecode.rate) : 0;
		const avail = m.duration !== null ? tr(origin, m.duration, rate) : null;
		const metadata = { jasper: { media: mediaMeta(m) } };
		if (m.generator) {
			const g = m.generator;
			return {
				OTIO_SCHEMA: 'GeneratorReference.1',
				name: m.name,
				generator_kind:
					g.kind === 'color'
						? 'SolidColor'
						: g.kind === 'black'
							? 'black'
							: g.kind === 'bars-and-tone'
								? 'SMPTEBars'
								: g.kind,
				parameters: g.kind === 'color' ? { color: [...g.color] } : {},
				available_range: avail,
				metadata,
			};
		}
		const url = m.path
			? opts.relativeTo
				? (relativePath(m.path, opts.relativeTo) ?? absUrl(m.path))
				: absUrl(m.path)
			: (m.url ?? null);
		if (!url) return { OTIO_SCHEMA: 'MissingReference.1', name: m.name, available_range: avail, metadata };
		return {
			OTIO_SCHEMA: 'ExternalReference.1',
			name: m.name,
			target_url: url,
			available_range: avail,
			available_image_bounds: null,
			metadata,
		};
	};

	const markerJson = (m: IMarker, offset = 0): J => ({
		OTIO_SCHEMA: 'Marker.2',
		name: m.name,
		comment: m.comment,
		color: colorNameOf(m.color),
		marked_range: tr(m.start + offset, m.duration, rate),
		metadata: { jasper: { marker: strip(m, 'start'), start: m.start } },
	});

	const timeEffects = (c: IClip): J[] => {
		if (c.hold !== undefined && c.hold !== null)
			return [
				{
					OTIO_SCHEMA: 'FreezeFrame.1',
					name: '',
					effect_name: 'FreezeFrame',
					time_scalar: 0,
					metadata: { jasper: { hold: c.hold } },
				},
			];
		if (c.speed !== 1 || c.reverse)
			return [
				{
					OTIO_SCHEMA: 'LinearTimeWarp.1',
					name: '',
					effect_name: 'LinearTimeWarp',
					time_scalar: c.reverse ? -c.speed : c.speed,
					metadata: {},
				},
			];
		return [];
	};

	const clipMeta = (c: IClip): J => ({
		clip: strip(c, 'markers', 'source'),
		start: c.start,
		duration: c.duration,
		sourceIn: c.sourceIn,
	});

	const seqMeta = (s: ISequence): J => ({ sequence: strip(s, 'video', 'audio', 'markers') });

	const stackJson = (s: ISequence, clip: IClip | null): J => {
		const tracks: J[] = [];
		for (const t of s.video) tracks.push(trackJson(t, 'Video'));
		for (const t of s.audio) tracks.push(trackJson(t, 'Audio'));
		const out: J = {
			OTIO_SCHEMA: 'Stack.1',
			name: clip ? clip.name : name,
			children: tracks,
			source_range: clip ? tr(clip.sourceIn, clip.duration, rate) : null,
			effects: clip ? timeEffects(clip) : [],
			markers: s.markers.map((m) => markerJson(m)),
			enabled: clip ? clip.enabled : true,
			metadata: { jasper: { ...seqMeta(s), ...(clip ? clipMeta(clip) : {}) } },
		};
		return out;
	};

	const gap = (d: number): J => ({
		OTIO_SCHEMA: 'Gap.1',
		name: '',
		source_range: tr(0, d, rate),
		effects: [],
		markers: [],
		enabled: true,
		metadata: {},
	});

	const transitionJson = (x: ITransition, cut: number): J => ({
		OTIO_SCHEMA: 'Transition.1',
		name: transitionLabel(x.effectId),
		transition_type: SMPTE_DISSOLVES.has(x.effectId) ? 'SMPTE_Dissolve' : 'Custom_Transition',
		in_offset: rt(cut - x.start, rate),
		out_offset: rt(x.start + x.duration - cut, rate),
		metadata: { jasper: { transition: strip(x, 'from', 'to'), start: x.start, from: !!x.from, to: !!x.to } },
	});

	const trackJson = (t: ITrack, kind: 'Video' | 'Audio'): J => {
		const children: J[] = [];
		let pos = 0;
		for (const c of t.clips) {
			if (c.start > pos) children.push(gap(c.start - pos));
			for (const x of t.transitions) if (x.to === c.id) children.push(transitionJson(x, c.start));
			children.push(itemJson(c));
			for (const x of t.transitions)
				if (x.from === c.id && (!x.to || !t.clips.some((o) => o.id === x.to)))
					children.push(transitionJson(x, c.start + c.duration));
			pos = c.start + c.duration;
		}
		return {
			OTIO_SCHEMA: 'Track.1',
			name: t.name ?? '',
			kind,
			children,
			source_range: null,
			effects: [],
			markers: [],
			enabled: t.enabled,
			metadata: { jasper: { track: strip(t, 'clips', 'transitions') } },
		};
	};

	const itemJson = (c: IClip): J => {
		const s = top;
		if (c.source.type === 'sequence') {
			const inner = p.sequences[c.source.sequenceId];
			if (!inner || stack.includes(inner.id)) {
				report.warn(`${describeClip(c, s.rate)}: its nested sequence is missing or recursive`, {
					subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, s.rate) },
					instead: 'a gap',
				});
				return gap(c.duration);
			}
			stack.push(inner.id);
			const out = stackJson(inner, c);
			stack.pop();
			out.markers = [...(out.markers as J[])];
			(jm(out) as J).clipMarkers = c.markers;
			return out;
		}
		let ref: J;
		let origin = 0;
		if (c.source.type === 'none') {
			report.warn(`${describeClip(c, s.rate)} has no OTIO equivalent`, {
				subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, s.rate) },
				instead: 'a clip with a missing media reference (JasperEditor restores it from metadata.jasper)',
			});
			ref = { OTIO_SCHEMA: 'MissingReference.1', name: c.source.what, available_range: null, metadata: {} };
		} else {
			const m = p.media[c.source.mediaId];
			ref = mediaRef(m, c.name);
			origin = m?.timecode ? framesToFlicks(m.timecode.frames, m.timecode.rate) : 0;
		}
		return {
			OTIO_SCHEMA: 'Clip.2',
			name: c.name,
			source_range: tr(origin + c.sourceIn, c.duration, rate),
			effects: timeEffects(c),
			markers: c.markers.map((m) => markerJson(m, origin)),
			enabled: c.enabled,
			media_references: { DEFAULT_MEDIA: ref },
			active_media_reference_key: 'DEFAULT_MEDIA',
			metadata: { jasper: { ...clipMeta(c), ...(c.source.type === 'none' ? { what: c.source.what } : {}) } },
		};
	};

	const tracks = stackJson(top, null);
	const used = new Set<string>();
	const collect = (sid: string, seen: Set<string>) => {
		if (seen.has(sid)) return;
		seen.add(sid);
		const s = p.sequences[sid];
		if (!s) return;
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips) {
				if (c.source.type === 'media') used.add(c.source.mediaId);
				if (c.source.type === 'sequence') collect(c.source.sequenceId, seen);
			}
	};
	collect(sequenceId, new Set());
	// Bins and media no clip uses (master clips in bins) travel in the timeline metadata.
	const unused: J[] = Object.values(p.media)
		.filter((m) => !used.has(m.id))
		.map(mediaMeta);
	const timeline: J = {
		OTIO_SCHEMA: 'Timeline.1',
		name,
		global_start_time: rt(framesToFlicks(top.startTimecode, rate), rate),
		metadata: { jasper: { project: { name: p.name, root: p.root, top: p.top, media: unused } } },
		tracks,
	};
	return JSON.stringify(timeline, null, 4);
}

function absUrl(path: string): string {
	return isAbsolutePath(path) ? pathToFileUrl(path, false) : path;
}

// ---------------------------------------------------------------- import

export function importOtio(text: string, opts: ImportOptions, report: Report): IProject {
	let v: unknown;
	try {
		v = JSON.parse(text.replace(/^﻿/, ''));
	} catch (e) {
		throw parseError(FORMAT, `not JSON (${(e as Error).message})`);
	}
	const timelines: unknown[] = [];
	const collect = (x: unknown, depth: number) => {
		if (depth > MAX_DEPTH) return;
		switch (schemaName(x)) {
			case 'Timeline':
			case 'Stack':
			case 'Track':
				timelines.push(x);
				break;
			case 'SerializableCollection':
				for (const c of arr(obj(x)?.children)) collect(c, depth + 1);
				break;
		}
	};
	collect(v, 0);
	if (!timelines.length) throw parseError(FORMAT, `no Timeline in a ${schema(v) || 'non-OTIO'} document`);
	const docName = nameOf(v) || opts.name || 'Imported OTIO';
	const b = new Builder(docName);
	const imp = new OtioImporter(b, opts, report);
	const projectMeta = obj(jm(timelines[0])?.project);
	for (const tl of timelines) {
		const id = imp.timeline(tl);
		if (id && !b.p.top.includes(id)) b.p.top.push(id);
	}
	// Bins and unused master clips from our metadata.
	if (projectMeta) imp.restoreProject(projectMeta);
	else {
		for (const id of Object.keys(b.p.media)) b.p.root.push({ type: 'media', id });
		for (const id of Object.keys(b.p.sequences)) b.p.root.push({ type: 'sequence', id });
	}
	return b.finish();
}

class OtioImporter {
	/** Exported sequence id (metadata) → imported sequence id. */
	private readonly seqIds = new Map<string, string>();
	/** Exported media id (metadata) → imported media id. */
	private readonly mediaIds = new Map<string, string>();
	private readonly linkIds = new Map<string, string>();
	private readonly groupIds = new Map<string, string>();
	private depth = 0;

	constructor(
		private readonly b: Builder,
		private readonly opts: ImportOptions,
		private readonly report: Report,
	) {}

	timeline(tl: unknown): string | null {
		let name = nameOf(tl) || this.opts.name || 'Timeline';
		let stack: unknown;
		switch (schemaName(tl)) {
			case 'Timeline':
				stack = obj(tl)?.tracks;
				break;
			case 'Track':
				stack = { OTIO_SCHEMA: 'Stack.1', children: [tl] };
				break;
			default:
				stack = tl;
		}
		if (!obj(stack)) stack = { OTIO_SCHEMA: 'Stack.1', children: [] };
		const gst = obj(tl)?.global_start_time;
		const rate = readRate(gst) ?? firstRate(stack, 0) ?? { num: 24, den: 1 };
		const meta = obj(jm(stack)?.sequence);
		if (!nameOf(tl) && meta && str(meta.name)) name = str(meta.name)!;
		const seq = this.sequence(stack, name, rate, meta, true);
		if (!seq) return null;
		const st = readRt(gst);
		if (st !== null && !meta) seq.startTimecode = Math.max(0, flicksToFrames(st, seq.rate));
		return seq.id;
	}

	private sequence(stack: unknown, name: string, rate: Rate, meta: J | null, top: boolean): ISequence | null {
		if (this.depth > MAX_DEPTH) {
			this.report.warn('nested stacks deeper than 64 levels were skipped');
			return null;
		}
		const r = (meta && rateOf(meta.rate)) || rate;
		const seq = this.b.sequence(
			{
				name: str(meta?.name) || name,
				rate: r,
				dropFrame: meta?.dropFrame === true,
				width: num(meta?.width) ?? 1920,
				height: num(meta?.height) ?? 1080,
				...(rateOf(meta?.pixelAspect) ? { pixelAspect: rateOf(meta?.pixelAspect)! } : {}),
				sampleRate: num(meta?.sampleRate) ?? 48000,
				startTimecode: num(meta?.startTimecode) ?? 0,
				...(labelOf(meta?.label) ? { label: labelOf(meta?.label)! } : {}),
				...(num(meta?.inPoint) !== null ? { inPoint: num(meta?.inPoint) } : {}),
				...(num(meta?.outPoint) !== null ? { outPoint: num(meta?.outPoint) } : {}),
				...(obj(meta?.jasper) ? { jasper: obj(meta?.jasper)! } : {}),
			},
			{ top, bin: null },
		);
		const oldId = str(meta?.id);
		if (oldId) this.seqIds.set(oldId, seq.id);
		if (Array.isArray(meta?.captions)) seq.captions = meta.captions as ISequence['captions'];
		seq.markers = this.markers(stack, 0);
		this.depth++;
		for (const t of arr(obj(stack)?.children)) {
			if (schemaName(t) === 'Track') {
				const kind = str(obj(t)?.kind)?.toLowerCase() === 'audio' ? 'audio' : 'video';
				this.track(seq, t, kind);
			} else if (schemaName(t) === 'Stack' || schemaName(t) === 'Clip') {
				// A clip or stack directly in a stack: one track of its own.
				this.track(seq, { OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [t] }, 'video');
			} else this.report.warn(`OTIO ${schema(t) || 'item'} directly in a stack is not supported`);
		}
		this.depth--;
		return seq;
	}

	private track(seq: ISequence, t: unknown, kind: 'video' | 'audio'): void {
		const tm = obj(jm(t)?.track);
		const track: ITrack = {
			name: nameOf(t) || null,
			enabled: obj(t)?.enabled !== false,
			locked: tm?.locked === true,
			clips: [],
			transitions: [],
		};
		if (tm) {
			if (tm.solo === true) track.solo = true;
			if (obj(tm.volumeDb)) track.volumeDb = tm.volumeDb as never;
			if (obj(tm.pan)) track.pan = tm.pan as never;
			if (obj(tm.jasper)) track.jasper = obj(tm.jasper)!;
			if (tm.name === null) track.name = null;
		}
		// Track markers become sequence markers.
		if (arr(obj(t)?.markers).length) {
			seq.markers.push(...this.markers(t, 0));
			seq.markers.sort((a, b) => a.start - b.start);
		}
		const slots: { clip: string | null; start: number; end: number }[] = [];
		const pending: { slot: number; x: unknown }[] = [];
		let pos = 0;
		for (const c of arr(obj(t)?.children)) {
			switch (schemaName(c)) {
				case 'Transition':
					pending.push({ slot: slots.length, x: c });
					continue;
				case 'Gap': {
					const d = readTr(obj(c)?.source_range)?.duration ?? 0;
					slots.push({ clip: null, start: pos, end: pos + d });
					pos += Math.max(0, d);
					break;
				}
				case 'Clip':
				case 'Stack': {
					const clip = schemaName(c) === 'Clip' ? this.clip(c, kind, pos) : this.nested(c, kind, pos);
					if (clip) {
						track.clips.push(clip);
						slots.push({ clip: clip.id, start: clip.start, end: clip.start + clip.duration });
						pos = clip.start + clip.duration;
					} else {
						const d = readTr(obj(c)?.source_range)?.duration ?? 0;
						slots.push({ clip: null, start: pos, end: pos + d });
						pos += Math.max(0, d);
					}
					break;
				}
				default:
					this.report.warn(`OTIO ${schema(c) || 'item'} items are not supported and were skipped`);
			}
		}
		for (const { slot, x } of pending) {
			const cut = slot < slots.length ? slots[slot]!.start : pos;
			const sides = jm(x);
			const from = slot > 0 && sides?.from !== false ? slots[slot - 1]!.clip : null;
			const to = sides?.to !== false ? (slots[slot]?.clip ?? null) : null;
			if (!from && !to) continue;
			const xo = obj(x)!;
			const inn = Math.max(0, readRt(xo.in_offset) ?? 0);
			const out = Math.max(0, readRt(xo.out_offset) ?? 0);
			if (inn + out <= 0) continue;
			const meta = obj(jm(x)?.transition);
			const n = nameOf(x);
			const type = str(xo.transition_type) ?? 'SMPTE_Dissolve';
			const effectId =
				str(meta?.effectId) ??
				transitionFromName(
					n || (type === 'SMPTE_Dissolve' ? 'Cross Dissolve' : type),
					kind === 'audio',
					this.report,
				);
			const alignment =
				meta?.alignment === 'center' || meta?.alignment === 'start-at-cut' || meta?.alignment === 'end-at-cut'
					? meta.alignment
					: inn === 0
						? 'start-at-cut'
						: out === 0
							? 'end-at-cut'
							: 'center';
			track.transitions.push({
				id: this.b.id('t'),
				effectId,
				from,
				to,
				start: exact(jm(x)?.start, cut - inn),
				duration: inn + out,
				alignment,
				params: (obj(meta?.params) as ITransition['params']) ?? {},
				...(obj(meta?.jasper) ? { jasper: obj(meta?.jasper)! } : {}),
			});
		}
		track.clips.sort((a, b) => a.start - b.start);
		track.transitions.sort((a, b) => a.start - b.start);
		seq[kind].push(track);
	}

	private applyClipMeta(clip: IClip, c: unknown): void {
		const co = obj(c)!;
		clip.enabled = co.enabled !== false;
		const meta = jm(c);
		const cm = obj(meta?.clip);
		for (const e of arr(co.effects)) {
			switch (schemaName(e)) {
				case 'LinearTimeWarp': {
					const s = num(obj(e)?.time_scalar) ?? 1;
					if (s === 0) clip.hold = clip.sourceIn;
					else {
						clip.speed = Math.abs(s);
						clip.reverse = s < 0;
					}
					break;
				}
				case 'FreezeFrame':
					clip.hold = exact(jm(e)?.hold, clip.sourceIn);
					break;
				default:
					if (!cm)
						this.report.warn(
							`OTIO effect "${str(obj(e)?.effect_name) ?? nameOf(e) ?? 'effect'}" on clip "${clip.name}" is not supported`,
							{
								subject: { kind: 'effect', name: str(obj(e)?.effect_name) ?? 'effect' },
							},
						);
			}
		}
		// Resolve's OTIO export links A/V with "Link Group ID".
		const resolve = obj(obj(co.metadata)?.Resolve_OTIO);
		const rl = resolve?.['Link Group ID'];
		if ((typeof rl === 'number' || typeof rl === 'string') && !cm)
			clip.link = this.mapId(this.linkIds, `resolve:${rl}`, 'l');
		if (!cm) return;
		clip.start = exact(meta?.start, clip.start);
		clip.duration = exact(meta?.duration, clip.duration);
		clip.sourceIn = exact(meta?.sourceIn, clip.sourceIn);
		if (clip.hold !== undefined && clip.hold !== null && num(cm.hold) !== null)
			clip.hold = exact(cm.hold, clip.hold);
		const label = labelOf(cm.label);
		if (label) clip.label = label;
		if (typeof cm.link === 'string') clip.link = this.mapId(this.linkIds, cm.link, 'l');
		if (typeof cm.group === 'string') clip.group = this.mapId(this.groupIds, cm.group, 'g');
		for (const k of ['transform', 'opacity', 'volumeDb', 'pan', 'channels'] as const)
			if (obj(cm[k])) (clip as Record<string, unknown>)[k] = cm[k];
		if (typeof cm.blendMode === 'string') clip.blendMode = cm.blendMode as IClip['blendMode'];
		if (num(cm.gainDb) !== null) clip.gainDb = num(cm.gainDb)!;
		if (Array.isArray(cm.effects)) clip.effects = cm.effects as IClip['effects'];
		if (obj(cm.jasper)) clip.jasper = obj(cm.jasper)!;
	}

	private mapId(table: Map<string, string>, key: string, prefix: string): string {
		let v = table.get(key);
		if (!v) {
			v = this.b.id(prefix);
			table.set(key, v);
		}
		return v;
	}

	private clip(c: unknown, kind: 'video' | 'audio', pos: number): IClip | null {
		const co = obj(c)!;
		const refs = obj(co.media_references);
		let ref: unknown = null;
		if (refs) {
			const key = str(co.active_media_reference_key) ?? 'DEFAULT_MEDIA';
			ref = refs[key] ?? Object.values(refs)[0] ?? null;
		} else ref = co.media_reference ?? null;
		const name = nameOf(c);
		const avail = readTr(obj(ref)?.available_range);
		const range = readTr(co.source_range) ?? avail;
		if (!range || range.duration <= 0) {
			if (range) return null;
			this.report.warn(`OTIO clip "${name}" has no source range and was skipped`);
			return null;
		}
		const meta = jm(c);
		const what = str(meta?.what);
		const origin = avail?.start ?? 0;
		const clip: IClip = {
			id: this.b.id('c'),
			name: name || 'Clip',
			start: pos,
			duration: range.duration,
			sourceIn: range.start - origin,
			speed: 1,
			reverse: false,
			enabled: true,
			source: { type: 'none', what: what ?? 'clip' },
			markers: this.markers(c, origin),
			effects: [],
		};
		if (what && schemaName(ref) === 'MissingReference' && obj(meta?.clip)) {
			clip.source = { type: 'none', what };
		} else {
			const mid = this.media(ref, name, kind, avail);
			if (!mid) return null;
			clip.source = { type: 'media', mediaId: mid };
		}
		this.applyClipMeta(clip, c);
		return clip;
	}

	private nested(c: unknown, kind: 'video' | 'audio', pos: number): IClip | null {
		const co = obj(c)!;
		const range = readTr(co.source_range);
		const meta = jm(c);
		const seqMeta = obj(meta?.sequence);
		const oldId = str(seqMeta?.id);
		let sid = oldId ? this.seqIds.get(oldId) : undefined;
		if (!sid) {
			const rate = firstRate(c, 0) ?? { num: 24, den: 1 };
			const inner = { ...co, source_range: null, markers: co.markers };
			const s = this.sequence(inner, nameOf(c) || 'Nested Sequence', rate, seqMeta, false);
			if (!s) return null;
			sid = s.id;
		}
		const inner = this.b.p.sequences[sid]!;
		let duration = range?.duration ?? 0;
		if (!range) {
			for (const t of [...inner.video, ...inner.audio])
				for (const x of t.clips) duration = Math.max(duration, x.start + x.duration);
		}
		if (duration <= 0) return null;
		const clip: IClip = {
			id: this.b.id('c'),
			name: nameOf(c) || inner.name,
			start: pos,
			duration,
			sourceIn: range?.start ?? 0,
			speed: 1,
			reverse: false,
			enabled: true,
			source: { type: 'sequence', sequenceId: sid },
			markers: Array.isArray(meta?.clipMarkers) ? (meta.clipMarkers as IMarker[]) : [],
			effects: [],
		};
		void kind;
		this.applyClipMeta(clip, c);
		return clip;
	}

	private media(
		r: unknown,
		clipName: string,
		kind: 'video' | 'audio',
		avail: { start: number; duration: number } | null,
	): string | null {
		const meta = obj(jm(r)?.media);
		const oldId = str(meta?.id);
		if (oldId && this.mediaIds.has(oldId)) return this.mediaIds.get(oldId)!;
		const name = nameOf(r) || clipName || 'Media';
		const ro = obj(r);
		const fromMeta = (m: J | null): Partial<IMedia> => {
			if (!m) return {};
			const out: Partial<IMedia> = {};
			for (const k of ['video', 'audio', 'timecode', 'generator', 'jasper'] as const)
				if (obj(m[k])) (out as J)[k] = m[k];
			if (typeof m.kind === 'string') out.kind = m.kind as IMedia['kind'];
			if (labelOf(m.label)) out.label = labelOf(m.label)!;
			if (typeof m.reel === 'string') out.reel = m.reel;
			if (num(m.sizeBytes) !== null) out.sizeBytes = num(m.sizeBytes);
			if (m.duration === null || num(m.duration) !== null) out.duration = num(m.duration);
			if (m.offline === true) out.offline = true;
			if (typeof m.url === 'string') out.url = m.url;
			if (Array.isArray(m.markers)) out.markers = m.markers as IMarker[];
			if (typeof m.name === 'string') out.name = m.name;
			return out;
		};
		const spec = {
			duration: avail?.duration ?? null,
			...(kind === 'video' ? { video: { width: 1920, height: 1080, rate: { num: 24, den: 1 } } } : {}),
			...(kind === 'audio' ? { audio: { sampleRate: 48000, channels: 2 } } : {}),
		};
		let id: string;
		switch (schemaName(r)) {
			case 'ExternalReference':
			case 'ImageSequenceReference': {
				let url = str(ro?.target_url);
				if (schemaName(r) === 'ImageSequenceReference') {
					const base = str(ro?.target_url_base) ?? '';
					const prefix = str(ro?.name_prefix) ?? '';
					const suffix = str(ro?.name_suffix) ?? '';
					const start = num(ro?.start_frame) ?? 0;
					const pad = num(ro?.frame_zero_padding) ?? 0;
					url = `${base}${base.endsWith('/') ? '' : '/'}${prefix}${String(start).padStart(pad, '0')}${suffix}`;
					this.report.warn(
						`image sequence "${name}" is imported as a reference to its first frame (offline)`,
						{
							subject: { kind: 'media', name },
							instead: 'an offline media item',
						},
					);
				}
				const isFile =
					!!url &&
					!/^[a-z][a-z0-9+.-]*:\/\//i.test(url.replace(/^file:/i, '')) &&
					!/^(https?|s3|gs):/i.test(url);
				const path = url && (isFile || /^file:/i.test(url)) ? resolvePath(url, this.opts.baseDir) : null;
				const key = path ? `file:${path}` : `url:${url ?? name}`;
				const m = fromMeta(meta);
				const timecode =
					m.timecode ??
					(avail && avail.start > 0
						? (() => {
								const rr = readRate(obj(obj(ro?.available_range)?.start_time)) ?? { num: 24, den: 1 };
								return { frames: flicksToFrames(avail.start, rr), rate: rr, dropFrame: false };
							})()
						: null);
				id = this.b.media(
					key,
					{
						name: m.name ?? (name || (path ? fileName(path) : 'Media')),
						kind: m.kind,
						path,
						url: path ? null : url,
						duration: m.duration !== undefined ? m.duration : spec.duration,
						video: m.video ?? (m.kind === 'audio' ? undefined : spec.video),
						audio: m.audio ?? spec.audio,
						timecode,
						reel: m.reel ?? null,
						label: m.label,
						offline: m.offline || schemaName(r) === 'ImageSequenceReference',
						sizeBytes: m.sizeBytes ?? null,
						jasper: m.jasper,
					},
					null,
				);
				break;
			}
			case 'GeneratorReference': {
				const m = fromMeta(meta);
				let g = m.generator as IGenerator | undefined;
				if (!g) {
					const gk = (str(ro?.generator_kind) ?? '').toLowerCase().replace(/[\s_]/g, '');
					const params = obj(ro?.parameters);
					if (gk === 'solidcolor' || gk === 'color') {
						const c = arr(params?.color).map((x) => num(x) ?? 0);
						g = { kind: 'color', color: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1] };
					} else if (gk === 'smptebars' || gk === 'bars' || gk === 'barsandtone')
						g = { kind: 'bars-and-tone', toneHz: 1000, toneDb: -20 };
					else if (gk === 'black' || gk === 'blackvideo' || gk === 'slug') g = { kind: 'black' };
					else if (gk === 'transparent') g = { kind: 'transparent' };
					else if (gk === 'countingleader') g = { kind: 'counting-leader' };
					else {
						this.report.warn(
							`OTIO generator "${str(ro?.generator_kind) ?? ''}" is not supported; imported as Black Video`,
							{
								subject: { kind: 'media', name },
								instead: 'Black Video',
							},
						);
						g = { kind: 'black' };
					}
				}
				id = this.b.media(
					`gen:${JSON.stringify(g)}`,
					{
						name: m.name ?? (name || 'Generator'),
						kind: 'generator',
						generator: g,
						video: m.video ?? { width: 1920, height: 1080, rate: { num: 24, den: 1 } },
						label: m.label,
						jasper: m.jasper,
					},
					null,
				);
				break;
			}
			default: {
				if (schemaName(r) !== 'MissingReference' && r !== null && r !== undefined)
					this.report.warn(`OTIO media reference ${schema(r)} is not supported; imported offline`, {
						subject: { kind: 'media', name },
						instead: 'an offline media item',
					});
				const m = fromMeta(meta);
				const key = oldId ? `meta:${oldId}` : `missing:${name}`;
				id = this.b.media(
					key,
					{
						name: m.name ?? name,
						kind: m.kind,
						path: null,
						duration: m.duration !== undefined ? m.duration : spec.duration,
						video: m.video ?? (m.kind === 'audio' ? undefined : spec.video),
						audio: m.audio ?? spec.audio,
						timecode: m.timecode ?? null,
						label: m.label,
						offline: true,
						sizeBytes: m.sizeBytes ?? null,
						jasper: m.jasper,
					},
					null,
				);
				if (!meta?.offline)
					this.report.info(`"${name}" has no media reference; imported as offline media`, {
						subject: { kind: 'media', name },
					});
			}
		}
		const media = this.b.p.media[id]!;
		if (meta) {
			if (Array.isArray(meta.markers)) media.markers = meta.markers as IMarker[];
			if (typeof oldId === 'string') this.mediaIds.set(oldId, id);
		}
		return id;
	}

	private markers(v: unknown, origin: number): IMarker[] {
		const out: IMarker[] = [];
		for (const m of arr(obj(v)?.markers)) {
			const mo = obj(m);
			if (!mo) continue;
			const range = readTr(mo.marked_range) ?? { start: 0, duration: 0 };
			const meta = jm(m);
			const mm = obj(meta?.marker);
			const start = exact(meta?.start, range.start - origin);
			const marker: IMarker = {
				start,
				duration: exact(mm?.duration, Math.max(0, range.duration)),
				name: nameOf(m),
				comment: str(mo.comment) ?? '',
				color: labelOf(mm?.color) ?? labelFromColorName(str(mo.color)) ?? 'green',
				...(typeof mm?.type === 'string' ? { type: mm.type as IMarker['type'] } : {}),
				...(typeof mm?.url === 'string' ? { url: mm.url } : {}),
				...(obj(mm?.jasper) ? { jasper: obj(mm?.jasper)! } : {}),
			};
			out.push(marker);
		}
		out.sort((a, b) => a.start - b.start);
		return out;
	}

	restoreProject(meta: J): void {
		const p = this.b.p;
		// Media no clip used (master clips in bins).
		for (const m of arr(meta.media)) {
			const mo = obj(m);
			const oldId = str(mo?.id);
			if (!mo || !oldId || this.mediaIds.has(oldId)) continue;
			const id = this.b.media(
				`meta:${oldId}`,
				{
					name: str(mo.name) ?? 'Media',
					kind: (str(mo.kind) as IMedia['kind']) ?? 'video',
					path: str(mo.path),
					url: str(mo.url),
					duration: num(mo.duration),
					...(obj(mo.video) ? { video: mo.video as IMedia['video'] } : {}),
					...(obj(mo.audio) ? { audio: mo.audio as IMedia['audio'] } : {}),
					...(obj(mo.timecode) ? { timecode: mo.timecode as IMedia['timecode'] } : {}),
					...(obj(mo.generator) ? { generator: mo.generator as IGenerator } : {}),
					reel: str(mo.reel),
					...(labelOf(mo.label) ? { label: labelOf(mo.label)! } : {}),
					offline: mo.offline === true,
					sizeBytes: num(mo.sizeBytes),
					...(obj(mo.jasper) ? { jasper: obj(mo.jasper)! } : {}),
				},
				null,
			);
			if (Array.isArray(mo.markers)) p.media[id]!.markers = mo.markers as IMarker[];
			this.mediaIds.set(oldId, id);
		}
		// Rebuild the bin tree with the new ids; anything not in it is appended.
		const placed = new Set<string>();
		const walk = (entries: unknown[], depth: number): IBinEntry[] => {
			const out: IBinEntry[] = [];
			if (depth > MAX_DEPTH) return out;
			for (const e of entries) {
				const eo = obj(e);
				if (!eo) continue;
				if (eo.type === 'bin') {
					out.push({
						type: 'bin',
						name: str(eo.name) ?? 'Bin',
						...(labelOf(eo.label) ? { label: labelOf(eo.label)! } : {}),
						children: walk(arr(eo.children), depth + 1),
					});
				} else if (eo.type === 'media' && typeof eo.id === 'string' && this.mediaIds.has(eo.id)) {
					const id = this.mediaIds.get(eo.id)!;
					if (!placed.has(id)) {
						placed.add(id);
						out.push({ type: 'media', id });
					}
				} else if (eo.type === 'sequence' && typeof eo.id === 'string' && this.seqIds.has(eo.id)) {
					const id = this.seqIds.get(eo.id)!;
					if (!placed.has(id)) {
						placed.add(id);
						out.push({ type: 'sequence', id });
					}
				}
			}
			return out;
		};
		const root = walk(arr(meta.root), 0);
		for (const id of Object.keys(p.media)) if (!placed.has(id)) root.push({ type: 'media', id });
		for (const id of Object.keys(p.sequences)) if (!placed.has(id)) root.push({ type: 'sequence', id });
		p.root = root;
		if (typeof meta.name === 'string') p.name = meta.name;
		const top = arr(meta.top)
			.map((t) => (typeof t === 'string' ? this.seqIds.get(t) : undefined))
			.filter((x): x is string => !!x);
		if (top.length) p.top = top;
	}
}

function firstRate(v: unknown, depth: number): Rate | null {
	if (depth > MAX_DEPTH) return null;
	const sr = obj(obj(v)?.source_range);
	if (sr) {
		const r = readRate(sr.duration);
		if (r) return r;
	}
	for (const c of arr(obj(v)?.children)) {
		const r = firstRate(c, depth + 1);
		if (r) return r;
	}
	return null;
}

function rateOf(v: unknown): Rate | null {
	const o = obj(v);
	const n = num(o?.num);
	const d = num(o?.den);
	return n !== null && d !== null && n > 0 && d > 0 && Number.isInteger(n) && Number.isInteger(d)
		? { num: n, den: d }
		: null;
}

const LABEL_SET = new Set([
	'violet',
	'iris',
	'caribbean',
	'lavender',
	'cerulean',
	'forest',
	'rose',
	'mango',
	'purple',
	'blue',
	'teal',
	'magenta',
	'tan',
	'green',
	'brown',
	'yellow',
]);
function labelOf(v: unknown): IMarker['color'] | null {
	return typeof v === 'string' && LABEL_SET.has(v) ? (v as IMarker['color']) : null;
}
