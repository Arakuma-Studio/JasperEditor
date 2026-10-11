// fast-check generators of interchange projects (port of FilmCraft's proptest strategies) and a canonical form
// for comparing a project with its export → import round trip. Formats pick the features they carry.
import type { Animatable, Keyframe, LabelColor } from '@jasper/project';
import fc from 'fast-check';
import { sourceOut } from '../../src/build.ts';
import type {
	IClip,
	IMarker,
	IMedia,
	IProject,
	ISequence,
	ITrack,
	ITransition,
	Rate,
} from '../../src/model.ts';
import { framesToFlicks } from '../../src/time.ts';

export type Features = {
	rates: readonly { rate: Rate; dropFrame: boolean }[];
	videoTracks: number;
	audioTracks: number;
	clips: number;
	transform: boolean;
	opacity: boolean;
	audioLevels: boolean;
	pan: boolean;
	keyframes: boolean;
	speed: boolean;
	reverse: boolean;
	hold: boolean;
	markers: boolean;
	clipMarkers: boolean;
	transitions: boolean;
	links: boolean;
	labels: boolean;
	disabled: boolean;
	generators: boolean;
	nested: boolean;
	audioOnlyMedia: boolean;
	timecode: boolean;
};

export const ALL_RATES: Features['rates'] = [
	{ rate: { num: 24000, den: 1001 }, dropFrame: false },
	{ rate: { num: 24, den: 1 }, dropFrame: false },
	{ rate: { num: 25, den: 1 }, dropFrame: false },
	{ rate: { num: 30000, den: 1001 }, dropFrame: true },
	{ rate: { num: 30000, den: 1001 }, dropFrame: false },
	{ rate: { num: 30, den: 1 }, dropFrame: false },
	{ rate: { num: 50, den: 1 }, dropFrame: false },
	{ rate: { num: 60000, den: 1001 }, dropFrame: true },
	{ rate: { num: 60000, den: 1001 }, dropFrame: false },
	{ rate: { num: 60, den: 1 }, dropFrame: false },
];

export const BASIC: Features = {
	rates: ALL_RATES,
	videoTracks: 2,
	audioTracks: 2,
	clips: 4,
	transform: false,
	opacity: false,
	audioLevels: false,
	pan: false,
	keyframes: false,
	speed: false,
	reverse: false,
	hold: false,
	markers: false,
	clipMarkers: false,
	transitions: false,
	links: false,
	labels: false,
	disabled: false,
	generators: false,
	nested: false,
	audioOnlyMedia: false,
	timecode: false,
};

const LABELS: LabelColor[] = [
	'violet',
	'iris',
	'caribbean',
	'lavender',
	'cerulean',
	'forest',
	'rose',
	'mango',
];
const NAMES = ['A001_C002', 'Beach', 'Interview 01', 'Établi', 'b-roll & co', 'Tom"s <take>', '日本語'];

function key<T>(time: number, value: T, interpolation: Keyframe<T>['interpolation'] = 'linear'): Keyframe<T> {
	return {
		id: `kf${time}`,
		time,
		value,
		interpolation,
		easeIn: { influence: 1 / 3, slope: interpolation === 'bezier' ? 0 : 1 },
		easeOut: { influence: 1 / 3, slope: interpolation === 'bezier' ? 0 : 1 },
	};
}

export function arbProject(f: Features): fc.Arbitrary<IProject> {
	return fc
		.record({
			rateIx: fc.integer({ min: 0, max: f.rates.length - 1 }),
			media: fc.array(
				fc.record({
					name: fc.constantFrom(...NAMES),
					seconds: fc.integer({ min: 20, max: 400 }),
					audioOnly: f.audioOnlyMedia ? fc.boolean() : fc.constant(false),
					tc: f.timecode ? fc.integer({ min: 0, max: 86_399 * 24 }) : fc.constant(0),
				}),
				{ minLength: 1, maxLength: 4 },
			),
			tracks: fc.array(
				fc.array(
					fc.record({
						gap: fc.integer({ min: 0, max: 48 }),
						len: fc.integer({ min: 1, max: 240 }),
						inFrames: fc.integer({ min: 0, max: 400 }),
						media: fc.nat(),
						speedIx: f.speed ? fc.integer({ min: 0, max: 4 }) : fc.constant(0),
						reverse: f.reverse ? fc.boolean() : fc.constant(false),
						hold: f.hold ? fc.integer({ min: 0, max: 9 }) : fc.constant(9),
						enabled: f.disabled ? fc.boolean() : fc.constant(true),
						label: f.labels ? fc.constantFrom(...LABELS) : fc.constant(undefined),
						scale: fc.integer({ min: 10, max: 400 }),
						rot: fc.integer({ min: -720, max: 720 }),
						px: fc.integer({ min: -500, max: 2500 }),
						py: fc.integer({ min: -500, max: 1500 }),
						opacity: fc.integer({ min: 0, max: 100 }),
						volume: fc.integer({ min: -60, max: 12 }),
						pan: fc.integer({ min: -100, max: 100 }),
						kf: f.keyframes ? fc.boolean() : fc.constant(false),
						marker: f.clipMarkers ? fc.boolean() : fc.constant(false),
						trans: f.transitions ? fc.integer({ min: 0, max: 3 }) : fc.constant(0),
						gen: f.generators ? fc.integer({ min: 0, max: 5 }) : fc.constant(5),
					}),
					{ maxLength: f.clips },
				),
				{ minLength: f.videoTracks + f.audioTracks, maxLength: f.videoTracks + f.audioTracks },
			),
			markers: f.markers
				? fc.array(
						fc.record({
							at: fc.integer({ min: 0, max: 2000 }),
							len: fc.integer({ min: 0, max: 50 }),
							name: fc.constantFrom('', 'Chapter 1', 'Fix <this> & "that"'),
							comment: fc.constantFrom('', 'note', 'Ünïcode ✓'),
							color: fc.constantFrom(...LABELS),
						}),
						{ maxLength: 4 },
					)
				: fc.constant([] as Gen['markers']),
			nestedAt: f.nested ? fc.integer({ min: 0, max: 100 }) : fc.constant(-1),
		})
		.map((g) => build(f, g));
}

const SPEEDS = [1, 2, 0.5, 4, 0.25];
const GEN_NAMES = ['Black Video', 'Color Matte', 'Bars and Tone', 'Transparent Video', 'Counting Leader'];

type Gen = {
	rateIx: number;
	media: { name: string; seconds: number; audioOnly: boolean; tc: number }[];
	tracks: {
		gap: number;
		len: number;
		inFrames: number;
		media: number;
		speedIx: number;
		reverse: boolean;
		hold: number;
		enabled: boolean;
		label: LabelColor | undefined;
		scale: number;
		rot: number;
		px: number;
		py: number;
		opacity: number;
		volume: number;
		pan: number;
		kf: boolean;
		marker: boolean;
		trans: number;
		gen: number;
	}[][];
	markers: { at: number; len: number; name: string; comment: string; color: LabelColor }[];
	nestedAt: number;
};

function build(f: Features, g: Gen): IProject {
	const { rate, dropFrame } = f.rates[g.rateIx]!;
	const F = framesToFlicks(1, rate);
	const media: Record<string, IMedia> = {};
	g.media.forEach((m, i) => {
		const id = `m${i + 1}`;
		media[id] = {
			id,
			name: `${m.name} ${i + 1}`,
			kind: m.audioOnly ? 'audio' : 'video',
			path: `/media/${m.name.replace(/[^A-Za-z0-9 _-]/g, '_')} ${i + 1}.${m.audioOnly ? 'wav' : 'mov'}`,
			duration: framesToFlicks(m.seconds * 30, rate),
			...(m.audioOnly ? {} : { video: { width: 1920, height: 1080, rate } }),
			audio: { sampleRate: 48000, channels: 2 },
			...(f.timecode ? { timecode: { frames: m.tc, rate, dropFrame } } : {}),
			markers: [],
		};
	});
	const gens: Record<string, IMedia> = {};
	const genMedia = (k: number): string => {
		const id = `g${k}`;
		if (!gens[id])
			gens[id] = {
				id,
				name: GEN_NAMES[k]!,
				kind: 'generator',
				path: null,
				duration: null,
				video: { width: 1920, height: 1080, rate },
				generator: [
					{ kind: 'black' as const },
					{ kind: 'color' as const, color: [1, 0, 0, 1] as [number, number, number, number] },
					{ kind: 'bars-and-tone' as const, toneHz: 1000, toneDb: -20 },
					{ kind: 'transparent' as const },
					{ kind: 'counting-leader' as const },
				][k]!,
				markers: [],
			};
		return id;
	};
	const ids = Object.keys(media);
	let n = 0;
	const seq: ISequence = {
		id: 'seq1',
		name: 'Main Sequence',
		rate,
		dropFrame,
		width: 1920,
		height: 1080,
		sampleRate: 48000,
		startTimecode: 0,
		video: [],
		audio: [],
		markers: [...g.markers]
			.sort((a, b) => a.at - b.at)
			.map(
				(m): IMarker => ({
					start: m.at * F,
					duration: m.len * F,
					name: m.name,
					comment: m.comment,
					color: m.color,
				}),
			),
	};
	g.tracks.forEach((list, ti) => {
		const video = ti < f.videoTracks;
		const track: ITrack = { name: null, enabled: true, locked: false, clips: [], transitions: [] };
		let at = 0;
		let prev: IClip | null = null;
		for (const c of list) {
			at += c.gap;
			const mid = ids[c.media % ids.length]!;
			const m = media[mid]!;
			if (!video && !m.audio) continue;
			if (video && !m.video && !(f.generators && c.gen < 5)) continue;
			const speed = SPEEDS[c.speedIx]!;
			const useGen = video && f.generators && c.gen < 5;
			const hold = video && !useGen && f.hold && c.hold === 0;
			const clip: IClip = {
				id: `c${++n}`,
				name: useGen ? GEN_NAMES[c.gen]! : m.name,
				start: at * F,
				duration: c.len * F,
				sourceIn: useGen ? 0 : c.inFrames * F,
				speed: hold ? 1 : speed,
				reverse: hold ? false : c.reverse,
				...(hold ? { hold: c.inFrames * F } : {}),
				enabled: c.enabled,
				...(c.label ? { label: c.label } : {}),
				source: useGen ? { type: 'media', mediaId: genMedia(c.gen) } : { type: 'media', mediaId: mid },
				markers: c.marker
					? [{ start: (c.inFrames + 1) * F, duration: 0, name: 'clip marker', comment: '', color: 'green' }]
					: [],
				effects: [],
			};
			if (video && f.transform) {
				const kf = f.keyframes && c.kf;
				clip.transform = {
					position: kf
						? {
								value: [c.px, c.py],
								keyframes: [key(clip.sourceIn, [c.px, c.py]), key(clip.sourceIn + 10 * F, [960, 540])],
							}
						: { value: [c.px, c.py], keyframes: [] },
					anchor: { value: [960, 540], keyframes: [] },
					scale: anim(c.scale, kf ? [key(clip.sourceIn, c.scale), key(clip.sourceIn + 5 * F, 100)] : []),
					scaleWidth: anim(c.scale, kf ? [key(clip.sourceIn, c.scale), key(clip.sourceIn + 5 * F, 100)] : []),
					uniformScale: true,
					rotation: anim(c.rot),
					flipH: false,
					flipV: false,
				};
			}
			if (video && f.opacity)
				clip.opacity = anim(
					c.opacity,
					f.keyframes && c.kf ? [key(clip.sourceIn, 0), key(clip.sourceIn + 12 * F, c.opacity)] : [],
				);
			if (!video && f.audioLevels)
				clip.volumeDb = anim(
					c.volume,
					f.keyframes && c.kf ? [key(clip.sourceIn, -20), key(clip.sourceIn + 8 * F, c.volume)] : [],
				);
			if (!video && f.pan) clip.pan = anim(c.pan);
			// Transitions: 1 = cut dissolve with the previous adjacent clip, 2 = fade in, 3 = fade out.
			if (f.transitions && c.trans) {
				const d = Math.min(8, c.len, prev ? prev.duration / F : 8) * F;
				if (c.trans === 1 && prev && prev.start + prev.duration === clip.start && d >= F * 2) {
					const half = Math.floor(d / F / 2) * F;
					track.transitions.push(transition(`t${n}`, video, prev.id, clip.id, clip.start - half, half * 2));
				} else if (c.trans === 2 && !track.transitions.some((t) => t.to === prev?.id))
					track.transitions.push(
						transition(`t${n}`, video, null, clip.id, clip.start, Math.min(d, clip.duration)),
					);
			}
			track.clips.push(clip);
			at += c.len;
			prev = clip;
		}
		(video ? seq.video : seq.audio).push(track);
	});
	if (f.links) {
		for (const v of seq.video[0]?.clips ?? [])
			for (const a of seq.audio[0]?.clips ?? [])
				if (!v.link && !a.link && v.start === a.start && v.duration === a.duration) {
					v.link = a.link = `l${v.id}`;
				}
	}
	const p: IProject = {
		name: 'Generated',
		root: [
			...Object.keys(media).map((id) => ({ type: 'media' as const, id })),
			{ type: 'sequence', id: seq.id },
		],
		media: { ...media, ...gens },
		sequences: { [seq.id]: seq },
		top: [seq.id],
	};
	if (f.nested && g.nestedAt >= 0 && seq.video.length && media[ids[0]!]!.video) {
		const inner: ISequence = {
			...seq,
			id: 'seq2',
			name: 'Nested Sequence',
			markers: [],
			video: [
				{
					name: null,
					enabled: true,
					locked: false,
					transitions: [],
					clips: [
						{
							id: `c${++n}`,
							name: media[ids[0]!]!.name,
							start: 0,
							duration: 48 * F,
							sourceIn: 0,
							speed: 1,
							reverse: false,
							enabled: true,
							source: { type: 'media', mediaId: ids[0]! },
							markers: [],
							effects: [],
						},
					],
				},
			],
			audio: [{ name: null, enabled: true, locked: false, transitions: [], clips: [] }],
		};
		p.sequences[inner.id] = inner;
		p.root.push({ type: 'sequence', id: inner.id });
		const top = seq.video[seq.video.length - 1]!;
		const startF = top.clips.length
			? top.clips[top.clips.length - 1]!.start + top.clips[top.clips.length - 1]!.duration
			: g.nestedAt * F;
		top.clips.push({
			id: `c${++n}`,
			name: 'Nested Sequence',
			start: startF,
			duration: 24 * F,
			sourceIn: 0,
			speed: 1,
			reverse: false,
			enabled: true,
			source: { type: 'sequence', sequenceId: inner.id },
			markers: [],
			effects: [],
		});
	}
	for (const id of Object.keys(gens)) p.root.push({ type: 'media', id });
	// Media cover every use (readers grow durations the same way).
	for (const s of Object.values(p.sequences))
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips) {
				if (c.source.type !== 'media') continue;
				const m = p.media[c.source.mediaId]!;
				if (m.kind === 'generator' || m.duration === null) continue;
				m.duration = Math.max(m.duration, sourceOut(c), (c.hold ?? c.sourceIn) + 1);
			}
	return p;
}

function anim<T>(value: T, keyframes: Keyframe<T>[] = []): Animatable<T> {
	return { value, keyframes };
}

function transition(
	id: string,
	video: boolean,
	from: string | null,
	to: string | null,
	start: number,
	duration: number,
): ITransition {
	return {
		id,
		effectId: video ? 'jasper.cross-dissolve' : 'jasper.constant-power',
		from,
		to,
		start,
		duration,
		alignment: from && to ? 'center' : from ? 'end-at-cut' : 'start-at-cut',
		params: {},
	};
}
