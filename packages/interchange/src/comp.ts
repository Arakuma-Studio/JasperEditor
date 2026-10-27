// A format-neutral mob-style composition model shared by AAF and OMF.
//
// Both formats describe a timeline as a composition of slots (tracks) whose segments are sequences of fillers,
// source clips and transitions, where a transition *overlaps* the end of the segment before it and the start of
// the segment after it (a sequence's length is the sum of its segment lengths minus its transition lengths).
// Source clips reference media through master mobs and file source mobs. `fromProject` turns an interchange
// sequence into that shape; `toProject` builds interchange sequences and media from it. Times are flicks here; the
// serialisers convert to and from edit units (frames for picture, samples for sound, so audio edits are exact).
//
// Port of FilmCraft `crates/interchange/src/comp.rs` (MIT OR Apache-2.0).
import { type Animatable, type Keyframe, LABEL_COLORS, segmentShape, transitionSpec } from '@jasper/project';
import { Builder, dbToGain, describeClip, frameOf, gainToDb, newClip, reportVisualLoss } from './build.ts';
import { transitionFromName, transitionLabel } from './effects.ts';
import type { IClip, IMarker, IProject, ISequence, ITrack, ITransition, Rate } from './model.ts';
import { FLICKS } from './model.ts';
import type { EssenceKey, ImportOptions, MediaOptions } from './options.ts';
import { fileName, fileStem, relativeReference, resolvePath } from './paths.ts';
import type { Report } from './report.ts';
import { bigDivRound } from './time.ts';
import { wavFile } from './wav.ts';

export type CKind = 'picture' | 'sound';

export type CDocument = { compositions: Composition[]; sources: Source[] };

export type Composition = {
	name: string;
	rate: Rate;
	sampleRate: number;
	width: number;
	height: number;
	startTc: number;
	drop: boolean;
	tracks: CTrack[];
	markers: CMarker[];
};

export type CTrack = {
	kind: CKind;
	name: string;
	/** Physical track number (1-based, per kind). */
	number: number;
	/** Sound: channels of the track (1 mono, 2 stereo, 6 5.1). */
	channels: number;
	items: CItem[];
};

export type CItem =
	| { type: 'filler'; len: number }
	| { type: 'clip'; clip: CClip }
	| { type: 'transition'; tr: CTransition };

export const itemLen = (i: CItem): number =>
	i.type === 'filler' ? i.len : i.type === 'clip' ? i.clip.len : i.tr.len;

export type CClip = {
	len: number;
	/** Index into `CDocument.sources`. */
	source: number;
	/** Source (file) time of the segment's first frame. */
	start: number;
	gain: Gain | null;
	name: string;
};

/** Clip gain (linear amplitude). Varying points are offsets from the segment start. */
export type Gain =
	| { type: 'constant'; value: number }
	| { type: 'varying'; linear: boolean; points: [number, number][] };

export type CTransition = {
	len: number;
	/** Where the cut lies, from the transition start. */
	cut: number;
	/** JasperEditor transition id. */
	effect: string;
};

export type CMarker = {
	start: number;
	duration: number;
	name: string;
	comment: string;
	color: string | null;
};

/** One essence: a file (or embedded data) carrying the picture, or some channels of the sound, of a media item. */
export type Source = {
	/** Groups the sources of one media item (one master mob). */
	key: string;
	name: string;
	kind: CKind;
	path: string | null;
	/** Sound: the (0-based) channel of the file this source exposes (broken out to mono), or null for all. */
	channel: number | null;
	/** Sound: channels this source exposes (1 when `channel` is set, else `fileChannels`). */
	channels: number;
	fileChannels: number;
	width: number;
	height: number;
	frameRate: Rate;
	sampleRate: number;
	bits: number;
	length: number;
	/** Media time of the essence's time 0 (trimmed / consolidated essence). */
	offset: number;
	/** Start timecode in frames at `tcRate`. */
	startTc: number | null;
	tcRate: Rate;
	embedded: Uint8Array | null;
	markers: CMarker[];
	/** The interchange media id (export side). */
	mediaId?: string;
};

/**
 * A linear amplitude as an exact-enough rational for AAF / OMF (int32 numerator and denominator): the largest
 * power-of-two denominator up to 2^24 that keeps the numerator in range, so levels survive to ~1e-6 dB.
 */
export function amplitudeRational(a: number): [number, number] {
	const g = Math.max(0, Number.isFinite(a) ? a : 0);
	let den = 2 ** 24;
	while (den > 1 && g * den > 2147483647) den /= 2;
	return [Math.min(2147483647, Math.round(g * den)), den];
}

/** dB read back from a rational amplitude, rounded to 1/10000 dB (what the rationals carry). */
export const ampDb = (g: number): number => Math.round(gainToDb(g) * 10000) / 10000 || 0;

export const isStill = (s: Source) => s.kind === 'picture' && s.length === 0;

/** The largest time read from a document (about 3.3 days of flicks). */
export const MAX_TIME = 2 ** 47;

/** Flicks of `n` edit units at rate `num/den` (nearest flick, clamped to ±MAX_TIME). */
export function unitsToFlicks(n: number, num: number, den: number): number {
	if (num <= 0 || den <= 0 || !Number.isFinite(n)) return 0;
	const t = bigDivRound(BigInt(Math.round(n)) * BigInt(den) * BigInt(FLICKS), BigInt(num));
	return Math.max(-MAX_TIME, Math.min(MAX_TIME, t));
}

/** Edit units at rate `num/den` nearest to `t`; `exact` false when `t` is not on a unit. */
export function flicksToUnits(t: number, num: number, den: number): { n: number; exact: boolean } {
	if (num <= 0 || den <= 0) return { n: 0, exact: false };
	const x = BigInt(Math.round(t)) * BigInt(num);
	const d = BigInt(den) * BigInt(FLICKS);
	return { n: bigDivRound(x, d), exact: x % d === 0n };
}

type Side = { type: 'two'; start: number; end: number } | { type: 'one'; len: number };

const essenceKeyEq = (a: EssenceKey, b: EssenceKey) => JSON.stringify(a) === JSON.stringify(b);

export function fromProject(
	p: IProject,
	seqId: string,
	name: string,
	media: MediaOptions,
	report: Report,
	formatName = 'AAF',
): CDocument {
	const s = p.sequences[seqId]!;
	const doc: CDocument = { compositions: [], sources: [] };
	const memo = new Map<string, number>();
	const rate = s.rate;
	const comp: Composition = {
		name,
		rate,
		sampleRate: Math.max(1, s.sampleRate),
		width: s.width,
		height: s.height,
		startTc: s.startTimecode,
		drop: s.dropFrame,
		tracks: [],
		markers: s.markers.map(markerOut),
	};
	const essenceFor = (key: EssenceKey, channel: number | null) =>
		media.essence.find((e) => essenceKeyEq(e.key, key) && (e.channel === channel || e.channel === null)) ??
		null;

	const sourceOf = (c: IClip, kind: 'video' | 'audio', sub: number | null): number | null => {
		const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: frameOf(c.start, rate) };
		if (c.source.type === 'sequence') {
			report.warn(
				`${describeClip(c, rate)} is not carried (nested sequences are not exported); render and replace it first`,
				{
					subject: where,
					instead: 'a filler',
				},
			);
			return null;
		}
		if (c.source.type === 'none') {
			report.warn(`${describeClip(c, rate)} is not carried`, { subject: where, instead: 'a filler' });
			return null;
		}
		const m = p.media[c.source.mediaId];
		if (!m) return null;
		if (m.generator) {
			report.warn(`${describeClip(c, rate)} uses the synthetic source "${m.name}", which is not carried`, {
				subject: where,
				instead: 'a filler',
			});
			return null;
		}
		const ckind: CKind = kind === 'video' ? 'picture' : 'sound';
		const channel = sub === null ? null : (c.channels?.map[sub] ?? sub);
		const clipKey: EssenceKey = { clip: c.id };
		const mediaKey: EssenceKey = { media: m.id };
		const ess = ckind === 'sound' ? (essenceFor(clipKey, channel) ?? essenceFor(mediaKey, channel)) : null;
		const key = ess && essenceKeyEq(ess.key, clipKey) ? `clip:${c.id}` : `item:${m.id}`;
		const memoKey = `${key}|${ckind}|${channel}`;
		const known = memo.get(memoKey);
		if (known !== undefined) return known;
		const still = m.kind === 'image';
		if (ckind === 'picture' && !m.video && !still) return null;
		if (ckind === 'sound' && !m.audio) return null;
		const frameRate = m.video?.rate ?? rate;
		const markers = [...m.markers, ...c.markers].map(markerOut);
		const src: Source = {
			key,
			name: m.name,
			kind: ckind,
			path: m.path,
			channel: null,
			channels: 0,
			fileChannels: 0,
			width: m.video?.width ?? 0,
			height: m.video?.height ?? 0,
			frameRate,
			sampleRate: Math.max(1, m.audio?.sampleRate ?? 48000),
			bits: Math.min(32, Math.max(8, m.audio?.bitDepth ?? 16)),
			length: still ? 0 : (m.duration ?? 0),
			offset: 0,
			startTc: m.timecode
				? Math.round(
						(m.timecode.frames * frameRate.num * m.timecode.rate.den) / (frameRate.den * m.timecode.rate.num),
					)
				: null,
			tcRate: frameRate,
			embedded: null,
			markers: dedupeMarkers(markers),
			mediaId: m.id,
		};
		if (ckind === 'sound') {
			src.fileChannels = Math.max(1, m.audio?.channels ?? 2);
			src.channel = channel;
			if (ess) {
				src.sampleRate = Math.max(1, ess.sampleRate);
				src.bits = ess.bits;
				src.fileChannels = Math.max(1, ess.channels);
				if (ess.channel !== null) src.channel = null;
				src.offset = ess.start;
				src.length = unitsToFlicks(ess.frames, src.sampleRate, 1);
				if ('embedded' in ess.data) {
					src.path = null;
					src.embedded = ess.data.embedded;
				} else src.path = ess.data.file;
				if (essenceKeyEq(ess.key, clipKey)) src.name = `${c.name} (rendered)`;
			}
		}
		src.channels = src.channel !== null ? 1 : src.fileChannels;
		doc.sources.push(src);
		memo.set(memoKey, doc.sources.length - 1);
		return doc.sources.length - 1;
	};

	const gainOf = (c: IClip, src: Source): Gain | null => {
		if (src.key.startsWith('clip:')) return null; // rendered: effects baked in
		const g = c.gainDb ?? 0;
		const v = c.volumeDb;
		if (v?.keyframes.length) {
			const linear = !v.keyframes.every((k) => k.interpolation === 'hold');
			// keyframe-sides: any curved segment (also a Linear key into an eased incoming side).
			if (
				v.keyframes.some(
					(_, i) => i < v.keyframes.length - 1 && typeof segmentShape(v.keyframes, i) === 'object',
				)
			)
				report.info('Bezier volume keyframes were exported as linear');
			const sp = Math.abs(c.speed) > 1e-9 ? Math.abs(c.speed) : 1;
			return {
				type: 'varying',
				linear,
				points: v.keyframes.map((k) => [Math.round((k.time - c.sourceIn) / sp), dbToGain(k.value + g)]),
			};
		}
		const db = (v?.value ?? 0) + g;
		return Math.abs(db) > 1e-9 ? { type: 'constant', value: dbToGain(db) } : null;
	};

	const track = (t: ITrack, kind: 'video' | 'audio', sub: number | null): CItem[] => {
		const clips: [IClip, number][] = [];
		for (const c of t.clips) {
			const s2 = sourceOf(c, kind, sub);
			if (s2 !== null) clips.push([c, s2]);
		}
		const idx = new Map(clips.map(([c], i) => [c.id, i]));
		const tin: (readonly [Side, ITransition] | null)[] = clips.map(() => null);
		const tout: (readonly [Side, ITransition] | null)[] = clips.map(() => null);
		for (const tr of t.transitions) {
			const a = tr.from ? idx.get(tr.from) : undefined;
			const b = tr.to ? idx.get(tr.to) : undefined;
			const end = tr.start + tr.duration;
			// Only the transition's type (a JasperEditor comment) and its span travel: its params (a Custom Fade's
			// fade shape, a GPU transition's options) do not.
			if ((sub === null || sub === 0) && Object.keys(tr.params ?? {}).length > 0)
				report.warn(
					`the parameters of transition "${transitionLabel(tr.effectId)}" (${Object.keys(tr.params).join(', ')}) are not carried by ${formatName}`,
					{
						subject: {
							kind: 'transition',
							id: tr.id,
							name: transitionLabel(tr.effectId),
							frame: frameOf(tr.start, rate),
						},
						instead: 'the transition with its default parameters',
					},
				);
			if (
				a !== undefined &&
				b !== undefined &&
				b === a + 1 &&
				clips[a]![0].start + clips[a]![0].duration === clips[b]![0].start &&
				tr.start <= clips[b]![0].start &&
				end >= clips[a]![0].start + clips[a]![0].duration
			) {
				tout[a] = [{ type: 'two', start: tr.start, end }, tr];
				tin[b] = [{ type: 'two', start: tr.start, end }, tr];
			} else if (b !== undefined && (tr.from === null || a === undefined)) {
				const c = clips[b]![0];
				const len = Math.max(0, Math.min(end, c.start + c.duration) - Math.max(tr.start, c.start));
				if (tr.start !== c.start)
					report.info('a fade-in transition not starting at its clip was moved to the clip start');
				if (len > 0) tin[b] = [{ type: 'one', len }, tr];
			} else if (a !== undefined) {
				const c = clips[a]![0];
				const len = Math.max(0, Math.min(end, c.start + c.duration) - Math.max(tr.start, c.start));
				if (end !== c.start + c.duration)
					report.info('a fade-out transition not ending at its clip was moved to the clip end');
				if (len > 0) tout[a] = [{ type: 'one', len }, tr];
			} else
				report.warn('a transition without an exported clip was dropped', {
					subject: { kind: 'transition', id: tr.id, name: tr.effectId, frame: frameOf(tr.start, rate) },
				});
		}
		const out: CItem[] = [];
		let cursor = 0;
		let tail = 0;
		clips.forEach(([c, src], i) => {
			const s0 = c.start;
			const e = c.start + c.duration;
			let segStart = s0;
			const ti = tin[i];
			if (ti?.[0].type === 'two') segStart = ti[0].start;
			else if (ti?.[0].type === 'one') {
				const len = ti[0].len;
				const fillTo = s0 + len;
				if (fillTo > cursor) {
					out.push({ type: 'filler', len: fillTo - cursor });
					cursor = fillTo;
				}
				out.push({ type: 'transition', tr: { len, cut: 0, effect: ti[1].effectId } });
				cursor -= len;
			} else if (s0 > cursor) out.push({ type: 'filler', len: s0 - cursor });
			const to = tout[i];
			const segEnd = to?.[0].type === 'two' ? to[0].end : e;
			if (c.speed !== 1 || c.reverse || c.hold != null)
				report.warn(`the speed / reverse / frame hold of ${describeClip(c, rate)} is not carried`, {
					subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, rate) },
					instead: 'the clip at 100 % speed',
				});
			if (kind === 'audio' && c.pan && (c.pan.value !== 0 || c.pan.keyframes.length))
				report.warn(`the pan of ${describeClip(c, rate)} is not carried`, {
					subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, rate) },
					instead: 'centred',
				});
			if (kind === 'video') reportVisualLoss(c, s, p, formatName, report);
			const source = doc.sources[src]!;
			// Audio clip effects (EQ, pitch shift, a sound design build filter…): only rendered essence carries them.
			if (
				kind === 'audio' &&
				!source.key.startsWith('clip:') &&
				c.effects.length &&
				(sub === null || sub === 0)
			)
				report.warn(
					`the audio effects (${[...new Set(c.effects.map((e) => e.effectId))].join(', ')}) of ${describeClip(c, rate)} are not carried by ${formatName}`,
					{
						subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, rate) },
						instead: 'the clip without its effects',
					},
				);
			const start = (c.hold ?? c.sourceIn) + (segStart - s0) - source.offset;
			if (start < 0) report.warn(`clip "${c.name}" uses media before the start of its (trimmed) essence`);
			let gain = kind === 'audio' ? gainOf(c, source) : null;
			if (gain?.type === 'varying')
				gain = { ...gain, points: gain.points.map(([o, v]) => [o + (s0 - segStart), v]) };
			out.push({ type: 'clip', clip: { len: segEnd - segStart, source: src, start, gain, name: c.name } });
			cursor = segEnd;
			if (to?.[0].type === 'two') {
				out.push({
					type: 'transition',
					tr: { len: segEnd - to[0].start, cut: e - to[0].start, effect: to[1].effectId },
				});
				cursor = to[0].start;
				tail = Math.max(tail, segEnd);
			} else if (to?.[0].type === 'one') {
				out.push({ type: 'transition', tr: { len: to[0].len, cut: to[0].len, effect: to[1].effectId } });
				cursor = e - to[0].len;
				tail = Math.max(tail, e);
			} else tail = Math.max(tail, e);
		});
		if (tail > cursor) out.push({ type: 'filler', len: tail - cursor });
		return out;
	};

	if (!media.audioOnly) {
		const mix = media.mixdownVideo;
		if (mix) {
			doc.sources.push({
				key: 'mixdown',
				name: `${name} (video mixdown)`,
				kind: 'picture',
				path: mix.path,
				channel: null,
				channels: 0,
				fileChannels: 0,
				width: mix.width,
				height: mix.height,
				frameRate: rate,
				sampleRate: 0,
				bits: 0,
				length: mix.duration,
				offset: 0,
				startTc: s.startTimecode + Math.round((mix.start * rate.num) / (rate.den * FLICKS)),
				tcRate: rate,
				embedded: null,
				markers: [],
			});
			const items: CItem[] = [];
			if (mix.start > 0) items.push({ type: 'filler', len: mix.start });
			items.push({
				type: 'clip',
				clip: {
					len: mix.duration,
					source: doc.sources.length - 1,
					start: 0,
					gain: null,
					name: `${name} (video mixdown)`,
				},
			});
			comp.tracks.push({ kind: 'picture', name: 'V1', number: 1, channels: 0, items });
		} else
			s.video.forEach((t, i) => {
				comp.tracks.push({
					kind: 'picture',
					name: `V${i + 1}`,
					number: i + 1,
					channels: 0,
					items: track(t, 'video', null),
				});
			});
	} else
		for (const t of s.video)
			for (const c of t.clips)
				report.warn(`${describeClip(c, rate)} is not carried (audio-only export)`, {
					subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, rate) },
					instead: 'nothing',
				});
	let n = 0;
	for (const [ti, t] of s.audio.entries()) {
		// Track Volume / Pan (and their automation: stop-before dips, ducking) live on the track: not carried here.
		if (
			t.volumeDb?.keyframes.length ||
			(t.volumeDb && t.volumeDb.value !== 0) ||
			t.pan?.keyframes.length ||
			(t.pan && t.pan.value !== 0)
		)
			report.warn(
				`the volume and pan of track A${ti + 1} (and their automation) are not carried by ${formatName}`,
				{
					subject: { kind: 'track', name: t.name ?? `A${ti + 1}` },
					instead: 'the clips at unity track level',
				},
			);
		const fmt = (t.jasper as { channelFormat?: string } | undefined)?.channelFormat;
		const ch = fmt === 'mono' ? 1 : fmt === '5.1' ? 6 : 2;
		if (media.breakoutToMono)
			for (let c = 0; c < ch; c++) {
				n++;
				comp.tracks.push({
					kind: 'sound',
					name: `A${n}`,
					number: n,
					channels: 1,
					items: track(t, 'audio', c),
				});
			}
		else {
			n++;
			comp.tracks.push({
				kind: 'sound',
				name: `A${n}`,
				number: n,
				channels: ch,
				items: track(t, 'audio', null),
			});
		}
	}
	doc.compositions.push(comp);
	return doc;
}

export function dedupeMarkers(list: CMarker[]): CMarker[] {
	const sorted = [...list].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
	return sorted.filter((m, i) => i === 0 || JSON.stringify(m) !== JSON.stringify(sorted[i - 1]));
}

function markerOut(m: IMarker): CMarker {
	return { start: m.start, duration: m.duration, name: m.name, comment: m.comment, color: m.color };
}

const LABEL_SET = new Set<string>(LABEL_COLORS);

function markerIn(m: CMarker): IMarker {
	const c = (m.color ?? '').toLowerCase();
	return {
		start: m.start,
		duration: m.duration,
		name: m.name,
		comment: m.comment,
		color: (LABEL_SET.has(c) ? c : 'forest') as IMarker['color'],
	};
}

export function toProject(doc: CDocument, opts: ImportOptions, report: Report): IProject {
	const name = opts.name ?? doc.compositions[0]?.name ?? 'Imported';
	const b = new Builder(name);
	const mediaBin = b.bin('Media');
	const itemOf = new Map<number, string>();
	const groups: { key: string; members: number[] }[] = [];
	doc.sources.forEach((s, i) => {
		const k = `${s.key}|${s.path ?? (s.embedded ? `embedded:${i}` : '')}`;
		const g = groups.find((x) => x.key === k);
		if (g) g.members.push(i);
		else groups.push({ key: k, members: [i] });
	});
	const usedNames = new Set<string>();
	for (const g of groups) {
		const srcs = g.members.map((i) => doc.sources[i]!);
		const first = srcs[0]!;
		const pic = srcs.find((s) => s.kind === 'picture');
		const snd = srcs.find((s) => s.kind === 'sound');
		const embedded = snd?.embedded ? snd : null;
		let path: string | null = first.path ? resolvePath(first.path, opts.baseDir) : null;
		let display = first.name || (first.path ? fileName(first.path) : '');
		let emb: { fileName: string; bytes: Uint8Array } | undefined;
		if (embedded) {
			const safe = (first.name || 'Audio').replace(/[^\p{L}\p{N} ._-]/gu, '_').trim() || 'Audio';
			let fname = `${safe}${embedded.channel !== null ? ` ch${embedded.channel + 1}` : ''}.wav`;
			let k = 1;
			while (usedNames.has(fname.toLowerCase())) fname = `${safe} (${++k}).wav`;
			usedNames.add(fname.toLowerCase());
			emb = {
				fileName: fname,
				bytes: wavFile(
					embedded.embedded!,
					Math.max(1, embedded.fileChannels),
					embedded.sampleRate,
					embedded.bits,
				),
			};
			path = null;
			display ||= fileStem(fname);
		}
		const channels = Math.max(
			1,
			...srcs.filter((x) => x.kind === 'sound').map((x) => Math.max(x.fileChannels, (x.channel ?? -1) + 1)),
		);
		const tc = first.startTc ?? srcs.find((s) => s.startTc !== null)?.startTc ?? null;
		const id = b.media(
			`${first.key}|${path ?? emb?.fileName ?? g.key}`,
			{
				name: display || 'Media',
				kind: pic ? (isStill(pic) ? 'image' : 'video') : 'audio',
				path,
				relativePath: path && first.path ? relativeReference(first.path) : null,
				duration: Math.max(0, ...srcs.map((s) => s.length)) || null,
				...(pic
					? { video: { width: Math.max(1, pic.width), height: Math.max(1, pic.height), rate: pic.frameRate } }
					: {}),
				...(snd ? { audio: { sampleRate: snd.sampleRate, channels, bitDepth: snd.bits } } : {}),
				...(tc !== null ? { timecode: { frames: tc, rate: (pic ?? first).tcRate, dropFrame: false } } : {}),
				...(emb ? { embedded: emb } : {}),
				offline: !path && !emb,
			},
			mediaBin,
		);
		if (!path && !emb)
			report.warn(`"${display}" has no media location; imported offline`, {
				subject: { kind: 'media', name: display },
				instead: 'an offline media item',
			});
		b.p.media[id]!.markers = dedupeMarkers(srcs.flatMap((s) => s.markers)).map(markerIn);
		for (const i of g.members) itemOf.set(i, id);
	}
	for (const comp of doc.compositions) {
		const seq = b.sequence(
			{
				name: comp.name,
				rate: comp.rate,
				dropFrame: comp.drop,
				width: Math.max(16, comp.width),
				height: Math.max(16, comp.height),
				sampleRate: Math.max(1, comp.sampleRate),
				startTimecode: Math.max(0, comp.startTc),
				markers: comp.markers.map(markerIn),
			},
			{ top: true },
		);
		for (const t of comp.tracks) {
			const kind = t.kind === 'picture' ? 'video' : 'audio';
			const track: ITrack = {
				name: t.name || null,
				enabled: true,
				locked: false,
				clips: [],
				transitions: [],
			};
			if (kind === 'audio')
				track.jasper = { channelFormat: t.channels === 1 ? 'mono' : t.channels === 6 ? '5.1' : 'stereo' };
			buildTrack(b, track, kind, t, doc.sources, itemOf, report);
			seq[kind].push(track);
		}
		b.ensureTracks(seq, 'video', 1);
		b.ensureTracks(seq, 'audio', 1);
		linkClips(b, seq);
	}
	return b.finish();
}

type Placed =
	| { type: 'gap' }
	| { type: 'clip'; index: number }
	| { type: 'tr'; start: number; len: number; cut: number; effect: string };

function buildTrack(
	b: Builder,
	track: ITrack,
	kind: 'video' | 'audio',
	t: CTrack,
	sources: Source[],
	itemOf: Map<number, string>,
	report: Report,
): void {
	let pos = 0;
	const placed: Placed[] = [];
	const clips: IClip[] = [];
	for (const it of t.items) {
		if (Math.abs(pos) > 4 * MAX_TIME) {
			report.warn('a track longer than supported was cut short');
			break;
		}
		if (it.type === 'filler') {
			pos += it.len;
			placed.push({ type: 'gap' });
		} else if (it.type === 'transition') {
			pos -= it.tr.len;
			placed.push({ type: 'tr', start: pos, len: it.tr.len, cut: it.tr.cut, effect: it.tr.effect });
		} else {
			const c = it.clip;
			const mid = itemOf.get(c.source);
			if (!mid) {
				pos += c.len;
				placed.push({ type: 'gap' });
				continue;
			}
			const clip = newClip({
				id: b.id('c'),
				name: c.name || sources[c.source]!.name || 'Clip',
				start: pos,
				duration: c.len,
				sourceIn: c.start + sources[c.source]!.offset,
				source: { type: 'media', mediaId: mid },
			});
			if (kind === 'audio') {
				const src = sources[c.source]!;
				if (t.channels === 1 && src.channel !== null) clip.channels = { streamIndex: 0, map: [src.channel] };
				if (c.gain) applyGain(clip, c.gain);
			}
			placed.push({ type: 'clip', index: clips.length });
			clips.push(clip);
			pos += c.len;
		}
	}
	const transitions: ITransition[] = [];
	placed.forEach((p, k) => {
		if (p.type !== 'tr') return;
		const prevP = placed[k - 1];
		const nextP = placed[k + 1];
		const prev = prevP?.type === 'clip' ? prevP.index : null;
		const next = nextP?.type === 'clip' ? nextP.index : null;
		const cut = Math.min(p.len, Math.max(0, p.cut));
		const cutAt = p.start + cut;
		if (prev !== null && next !== null) {
			const a = clips[prev]!;
			if (a.start + a.duration > cutAt) a.duration = cutAt - a.start;
			const nb = clips[next]!;
			const shift = cutAt - nb.start;
			if (shift > 0) {
				nb.start += shift;
				nb.sourceIn += shift;
				nb.duration -= shift;
			}
		} else if (prev === null && next === null) {
			report.warn('a transition between two fillers was dropped');
			return;
		}
		const spec = transitionSpec(p.effect);
		const audio = kind === 'audio';
		const effectId =
			spec && (spec.appliesTo === 'audio') === audio ? spec.id : transitionFromName(p.effect, audio, report);
		transitions.push({
			id: b.id('t'),
			effectId,
			from: prev !== null ? clips[prev]!.id : null,
			to: next !== null ? clips[next]!.id : null,
			start: p.start,
			duration: p.len,
			alignment: cut === 0 ? 'start-at-cut' : cut === p.len ? 'end-at-cut' : 'center',
			params: {},
		});
	});
	track.clips = clips.filter((c) => c.duration > 0).sort((a, c) => a.start - c.start);
	track.transitions = transitions;
}

function kfOf(time: number, value: number, hold: boolean): Keyframe<number> {
	return {
		id: `kf${time}`,
		time,
		value,
		interpolation: hold ? 'hold' : 'linear',
		easeIn: { influence: 1 / 3, slope: 1 },
		easeOut: { influence: 1 / 3, slope: 1 },
	};
}

function applyGain(c: IClip, g: Gain): void {
	if (g.type === 'constant') {
		c.volumeDb = { value: ampDb(g.value), keyframes: [] };
		return;
	}
	const a: Animatable<number> = { value: ampDb(g.points[0]?.[1] ?? 1), keyframes: [] };
	for (const [off, v] of g.points) {
		const o = Math.max(-MAX_TIME, Math.min(MAX_TIME, off));
		a.keyframes.push(kfOf(c.sourceIn + o, ampDb(v), !g.linear));
	}
	a.keyframes.sort((x, y) => x.time - y.time);
	a.keyframes = a.keyframes.filter((k, i, l) => i === 0 || l[i - 1]!.time !== k.time);
	c.volumeDb = a;
}

/** Links video and audio clips of the same media that start and end together. */
function linkClips(b: Builder, seq: ISequence): void {
	const groups = new Map<string, IClip[]>();
	for (const t of [...seq.video, ...seq.audio])
		for (const c of t.clips) {
			if (c.source.type !== 'media') continue;
			const k = `${c.source.mediaId}|${c.start}|${c.duration}|${c.sourceIn}`;
			groups.set(k, [...(groups.get(k) ?? []), c]);
		}
	for (const g of groups.values()) {
		if (g.length < 2) continue;
		const l = b.id('l');
		for (const c of g) c.link = l;
	}
}
