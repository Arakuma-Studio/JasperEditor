// Cue derivation on generated and fuzzed documents (spec 12 P2-R3): deriveCues never throws, every frame is inside
// the sequence and the range, the order is deterministic, and the density budgets hold. Plus the performance budget
// (10-minute sequence, 200 clips, < 1 s).
import { fuzzScale, fuzzSeed, mutateJson, Rng } from '@jasper/testkit/fuzz';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	type Clip,
	CUE_DENSITIES,
	CUE_DERIVE_SOURCES,
	type CueDensity,
	type DeriveCuesOptions,
	type DeriveCuesResult,
	type DerivedCue,
	deriveCues,
	type Keyframe,
	type ProjectDocument,
	TRANSITION_SPECS,
} from '../src/index.ts';
import { F, kfid, mgRegistry, newHarness, phase2Fixture, placeVideo } from './sound-cues-fixtures.ts';

const RATES = [
	{ num: 24000, den: 1001 },
	{ num: 24, den: 1 },
	{ num: 25, den: 1 },
	{ num: 30000, den: 1001 },
	{ num: 30, den: 1 },
	{ num: 50, den: 1 },
	{ num: 60000, den: 1001 },
	{ num: 60, den: 1 },
];
const VIDEO_TRANSITIONS = TRANSITION_SPECS.filter((s) => s.appliesTo === 'video').map((s) => s.id);
const TEXT_PRESETS = ['fade', 'slide-up', 'pop', 'typewriter', 'mask-reveal', 'drop', 'unknown-preset'];
const MARKER_NAMES = ['sfx: hit', 'sfx: whoosh+boom', 'SFX: swoosh', 'sfx: banana', 'note', 'sfx:', ''];

/** Clip templates (a video, a still, a text, a camera) from a real document. */
function templates() {
	const h = newHarness();
	const video = placeVideo(h, 0, 30, 'V1', 'Video');
	const m = h.registerVideo({ kind: 'image', width: 300, height: 300 });
	const still = h.ok([
		{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V2' }, ref: '$s' },
	]).refs.$s!;
	const text = h.ok([
		{ type: 'clip.addText', at: 0, duration: 30, track: 'V3', content: { text: 'Hello there' }, ref: '$t' },
	]).refs.$t!;
	const cam = h.ok([{ type: 'clip.addCamera', at: 40, duration: 30, track: 'V3', ref: '$c' }]).refs.$c!;
	const mg = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 40,
			duration: 30,
			track: 'V1',
			template: { id: 'lower-third', version: 1 },
			ref: '$m',
		},
	]).refs.$m!;
	const base = structuredClone(h.doc) as ProjectDocument;
	const seq = base.sequences[h.seqId]!;
	const pick = (id: string) => structuredClone(seq.clips[id]!) as Clip & Record<string, unknown>;
	const t = { video: pick(video), still: pick(still), text: pick(text), camera: pick(cam), mg: pick(mg) };
	seq.clips = {};
	seq.transitions = {};
	return { base, seqId: h.seqId, t };
}
const TPL = templates();

const LIN = { influence: 1 / 3, slope: 0 };
const key = <T>(
	n: number,
	frame: number,
	value: T,
	interpolation: Keyframe<T>['interpolation'],
): Keyframe<T> => ({
	id: kfid(`g${n}`),
	time: Math.round(frame * F),
	value,
	interpolation,
	easeIn: LIN,
	easeOut: LIN,
});

type ClipSpec = {
	kind: 'video' | 'still' | 'text' | 'camera' | 'mg';
	len: number;
	gap: number;
	keys: {
		prop: 'position' | 'scale' | 'rotation' | 'opacity';
		frames: number[];
		values: number[];
		interp: 'linear' | 'bezier' | 'hold';
	}[];
	preset: { in: number | null; out: number | null; len: number };
	transition: number | null;
};

const clipSpec = fc.record({
	kind: fc.constantFrom<ClipSpec['kind']>('video', 'still', 'text', 'camera', 'mg'),
	len: fc.integer({ min: 1, max: 240 }),
	gap: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60 })),
	keys: fc.array(
		fc.record({
			prop: fc.constantFrom<'position' | 'scale' | 'rotation' | 'opacity'>(
				'position',
				'scale',
				'rotation',
				'opacity',
			),
			frames: fc.array(fc.integer({ min: -20, max: 260 }), { minLength: 1, maxLength: 5 }),
			values: fc.array(fc.integer({ min: -2000, max: 3000 }), { minLength: 5, maxLength: 5 }),
			interp: fc.constantFrom<'linear' | 'bezier' | 'hold'>('linear', 'bezier', 'hold'),
		}),
		{ maxLength: 3 },
	),
	preset: fc.record({
		in: fc.option(fc.integer({ min: 0, max: TEXT_PRESETS.length - 1 }), { nil: null }),
		out: fc.option(fc.integer({ min: 0, max: TEXT_PRESETS.length - 1 }), { nil: null }),
		len: fc.integer({ min: 1, max: 120 }),
	}),
	transition: fc.option(fc.integer({ min: 0, max: VIDEO_TRANSITIONS.length - 1 }), { nil: null }),
});

const docSpec = fc.record({
	rate: fc.constantFrom(...RATES),
	tracks: fc.array(fc.array(clipSpec, { maxLength: 12 }), { minLength: 1, maxLength: 3 }),
	markers: fc.array(
		fc.record({ frame: fc.integer({ min: 0, max: 2000 }), name: fc.constantFrom(...MARKER_NAMES) }),
		{
			maxLength: 10,
		},
	),
});

/** Builds a document from a spec (clips laid out per track without overlaps; no command validation on purpose). */
type DocSpec = typeof docSpec extends fc.Arbitrary<infer T> ? T : never;

function buildDoc(spec: DocSpec): ProjectDocument {
	const doc = structuredClone(TPL.base);
	const seq = doc.sequences[TPL.seqId]!;
	seq.settings.frameRate = spec.rate;
	let n = 0;
	let k = 0;
	spec.tracks.forEach((list, ti) => {
		const track = seq.videoTracks[ti]!;
		let at = 0;
		let prev: string | null = null;
		for (const s of list) {
			at += s.gap;
			const c = structuredClone(TPL.t[s.kind]) as Clip & Record<string, unknown>;
			const id = `clp_${String(++n).padStart(16, '0')}`;
			Object.assign(c, {
				id,
				trackId: track.id,
				start: at,
				duration: s.len,
				linkId: null,
				name: `${s.kind} ${n}`,
			});
			if (s.kind !== 'camera')
				for (const kk of s.keys) {
					const frames = [...new Set(kk.frames)].sort((a, b) => a - b);
					const val = (v: number) =>
						kk.prop === 'position'
							? ([v, (v * 7) % 1080] as [number, number])
							: kk.prop === 'opacity'
								? Math.abs(v) % 101
								: v / 10;
					const anim: Animatable<unknown> = {
						value: val(kk.values[0]!),
						keyframes: frames.map((f, i) => key(++k, f, val(kk.values[i % 5]!), kk.interp)),
					};
					if (kk.prop === 'opacity') c.opacity = anim;
					else (c.transform as Record<string, unknown>)[kk.prop] = anim;
				}
			else if (s.keys[0]) {
				const tr = (c.camera as { transform: Record<string, unknown> }).transform;
				tr.position = {
					value: [0, 0, -1500],
					keyframes: s.keys[0].frames.map((f, i) =>
						key(++k, f, [s.keys[0]!.values[i % 5]!, 0, -1500], 'linear'),
					),
				};
			}
			if (s.kind === 'text') {
				const side = (p: number | null) =>
					p === null
						? null
						: {
								preset: TEXT_PRESETS[p]!,
								version: TEXT_PRESETS[p] === 'typewriter' ? 2 : 1,
								durationFrames: s.preset.len,
								params: {},
							};
				c.textAnimation = { in: side(s.preset.in), out: side(s.preset.out) };
			}
			seq.clips[id] = c;
			if (prev && s.gap === 0 && s.transition !== null) {
				const tid = `trn_${String(n).padStart(16, '0')}`;
				seq.transitions[tid] = {
					id: tid,
					trackId: track.id,
					effectId: VIDEO_TRANSITIONS[s.transition]!,
					effectVersion: 1,
					outgoingClipId: prev,
					incomingClipId: id,
					duration: Math.max(1, Math.min(20, s.len)),
					alignment: 'center',
					params: {},
				};
			}
			prev = id;
			at += s.len;
		}
	});
	seq.markers = spec.markers.map((m, i) => ({
		id: `mrk_${String(i + 1).padStart(16, '0')}`,
		frame: m.frame,
		duration: 0,
		name: m.name,
		comment: '',
		color: 'green',
		type: 'comment',
		author: 'user',
	})) as never;
	return doc;
}

/** The density budget holds on a result (spec 12 §2.2). */
function assertBudgets(
	r: DeriveCuesResult,
	fps: number,
	density: CueDensity,
	opts: { maxCues?: number; minGap?: number },
) {
	// Spec 12 §2.2 and WP2.2's decision table, independent of the implementation's constants.
	const b = {
		sparse: { heroEverySec: 3, perSec: 1, minConfidence: 0.4 },
		balanced: { heroEverySec: 2, perSec: 2, minConfidence: 0.3 },
		rich: { heroEverySec: 1.5, perSec: 3, minConfidence: 0.15 },
	}[density];
	const W = Math.max(1, Math.round(fps));
	const units = new Map<string, { a: number; b: number; explicit: boolean }>();
	for (const c of r.cues) {
		const k = c.group ?? c.key;
		const u = units.get(k);
		if (u) {
			u.a = Math.min(u.a, c.frame);
			u.b = Math.max(u.b, c.frame);
		} else units.set(k, { a: c.frame, b: c.frame, explicit: c.source === 'marker' });
	}
	const derived = [...units.values()].filter((u) => !u.explicit);
	// A unit intersects windows starting in [a - W + 1, b]. The overlap count can increase only at a unit's
	// entry, so these starts prove the bound for every integer frame without scanning long empty stretches.
	for (const u of derived) {
		const start = u.a - W + 1;
		const count = derived.filter((x) => x.a <= start + W - 1 && x.b >= start).length;
		if (count > b.perSec)
			throw new Error(`${count} cues in the 1 s window at ${start} (${density}, ≤ ${b.perSec})`);
	}
	const heroGap = Math.max(Math.round(b.heroEverySec * fps), Math.round(0.5 * fps));
	const heroes = r.cues.filter((c) => c.weight === 'hero').map((c) => c.frame);
	for (let i = 1; i < heroes.length; i++) expect(heroes[i]! - heroes[i - 1]!).toBeGreaterThanOrEqual(heroGap);
	if (opts.maxCues !== undefined) expect(r.cues.length).toBeLessThanOrEqual(opts.maxCues);
	if (opts.minGap)
		for (const u of derived)
			for (const x of derived)
				if (x !== u) expect(x.a - u.b >= opts.minGap || u.a - x.b >= opts.minGap).toBe(true);
	for (const c of r.cues)
		if (c.source !== 'marker') expect(c.confidence).toBeGreaterThanOrEqual(b.minConfidence);
}

function assertWellFormed(r: DeriveCuesResult, duration: number, range?: { start: number; end: number }) {
	const lo = Math.max(0, range?.start ?? 0);
	const hi = Math.min(duration, range?.end ?? duration);
	for (let i = 0; i < r.cues.length; i++) {
		const c: DerivedCue = r.cues[i]!;
		expect(Number.isInteger(c.frame)).toBe(true);
		expect(c.frame).toBeGreaterThanOrEqual(lo);
		expect(c.frame).toBeLessThan(hi);
		expect(c.reason.length).toBeGreaterThan(0);
		expect(c.score).toBeGreaterThanOrEqual(0);
		expect(c.score).toBeLessThanOrEqual(1);
		if (i) {
			const p = r.cues[i - 1]!;
			expect(p.frame < c.frame || (p.frame === c.frame && p.key < c.key)).toBe(true);
		}
	}
	for (const s of CUE_DERIVE_SOURCES)
		expect(r.stats.bySource[s].kept).toBeLessThanOrEqual(r.stats.bySource[s].found);
}

const durationOf = (doc: ProjectDocument, seqId: string) =>
	Math.max(0, ...Object.values(doc.sequences[seqId]!.clips).map((c) => c.start + c.duration));

describe('deriveCues properties (P2-R3)', () => {
	it('generated documents: never throws, frames in range, deterministic, budgets hold', () => {
		fc.assert(
			fc.property(
				docSpec,
				fc.constantFrom(...CUE_DENSITIES),
				fc.option(
					fc.record({ start: fc.integer({ min: 0, max: 600 }), len: fc.integer({ min: 0, max: 900 }) }),
					{ nil: undefined },
				),
				fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
				fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
				(spec, density, rg, maxCues, minGap) => {
					const doc = buildDoc(spec);
					const range = rg ? { start: rg.start, end: rg.start + rg.len } : undefined;
					const opts: DeriveCuesOptions = {
						density,
						mgTemplates: mgRegistry(),
						...(range ? { range } : {}),
						...(maxCues !== undefined ? { maxCues } : {}),
						...(minGap !== undefined ? { minGapFrames: minGap } : {}),
					};
					const r = deriveCues(doc, TPL.seqId, opts);
					expect(r.warnings.filter((w) => w.code === 'W_SOURCE_FAILED')).toEqual([]);
					assertWellFormed(r, durationOf(doc, TPL.seqId), range);
					assertBudgets(r, spec.rate.num / spec.rate.den, density, { maxCues, minGap });
					expect(JSON.stringify(deriveCues(doc, TPL.seqId, opts).cues)).toBe(JSON.stringify(r.cues));
				},
			),
			{ numRuns: 60 * fuzzScale(), seed: fuzzSeed() },
		);
	}, 240_000);

	it('fuzzed documents and options (testkit mutateJson): never throws, frames stay in range', () => {
		const rng = new Rng(fuzzSeed());
		const f = phase2Fixture();
		const seeds = [f.h.doc.sequences[f.h.seqId]!, TPL.base.sequences[TPL.seqId]!];
		const junk = [null, 1.5, -3, Number.NaN, 'x', {}, [], { start: 'a' }, { start: 5, end: 2 }];
		const runs = 300 * fuzzScale();
		for (let i = 0; i < runs; i++) {
			const doc = structuredClone(f.h.doc) as ProjectDocument;
			doc.sequences[f.h.seqId] = mutateJson(rng, rng.pick(seeds), seeds) as never;
			const opts = {
				density: rng.pick(['sparse', 'balanced', 'rich', 'bogus', undefined]),
				range: rng.chance(0.3)
					? rng.pick(junk)
					: rng.chance(0.5)
						? { start: rng.below(400), end: rng.below(800) }
						: undefined,
				sources: rng.chance(0.2)
					? rng.pick(junk)
					: rng.chance(0.5)
						? [rng.pick([...CUE_DERIVE_SOURCES])]
						: undefined,
				maxCues: rng.chance(0.2) ? rng.pick(junk) : undefined,
				minGapFrames: rng.chance(0.2) ? rng.pick(junk) : undefined,
				extraCues: rng.chance(0.2)
					? [rng.pick(junk), { frame: 3, kind: 'cut', from: 'beat', anchor: { type: 'beat' } }]
					: undefined,
				mgTemplates: mgRegistry(),
			} as unknown as DeriveCuesOptions;
			let r: DeriveCuesResult;
			try {
				r = deriveCues(doc, f.h.seqId, opts);
			} catch (e) {
				throw new Error(`deriveCues threw on fuzz case ${i} (seed ${fuzzSeed()}): ${e}`);
			}
			let dur = 0;
			try {
				dur = durationOf(doc, f.h.seqId);
			} catch {
				dur = 0;
			}
			for (const c of r.cues) {
				expect(Number.isInteger(c.frame)).toBe(true);
				expect(c.frame).toBeGreaterThanOrEqual(0);
				if (Number.isFinite(dur)) expect(c.frame).toBeLessThan(dur);
			}
			expect(JSON.stringify(deriveCues(doc, f.h.seqId, opts).cues)).toBe(JSON.stringify(r.cues));
		}
		// Whole-document garbage.
		for (const bad of [null, undefined, 1, 'doc', {}, { sequences: null }, { sequences: { s: 5 } }])
			expect(deriveCues(bad as never, 's').cues).toEqual([]);
	}, 240_000);
});

/** A 10-minute 30 fps sequence with 200 clips: 120 shots (transitions every 4th edit), 40 keyframed graphics, 40 titles. */
function tenMinutes(): { doc: ProjectDocument; seqId: string } {
	const doc = structuredClone(TPL.base);
	const seq = doc.sequences[TPL.seqId]!;
	let n = 0;
	let k = 0;
	const add = (kind: 'video' | 'still' | 'text', track: number, start: number, duration: number) => {
		const c = structuredClone(TPL.t[kind]) as Clip & Record<string, unknown>;
		const id = `clp_${String(++n).padStart(16, '0')}`;
		Object.assign(c, {
			id,
			trackId: seq.videoTracks[track]!.id,
			start,
			duration,
			linkId: null,
			name: `${kind} ${n}`,
		});
		seq.clips[id] = c;
		return c;
	};
	let prev: string | null = null;
	for (let i = 0; i < 120; i++) {
		const c = add('video', 0, i * 150, 150);
		if (prev && i % 4 === 0) {
			const tid = `trn_${String(i).padStart(16, '0')}`;
			seq.transitions[tid] = {
				id: tid,
				trackId: c.trackId,
				effectId: i % 8 === 0 ? 'jasper.push' : 'jasper.cross-dissolve',
				effectVersion: 1,
				outgoingClipId: prev,
				incomingClipId: c.id,
				duration: 20,
				alignment: 'center',
				params: {},
			};
		}
		prev = c.id;
	}
	for (let i = 0; i < 40; i++) {
		const c = add('still', 1, i * 450 + 30, 300);
		(c.transform as Record<string, unknown>).position = {
			value: [960, 540],
			keyframes: [
				key(++k, 0, [100, 540], 'linear'),
				key(++k, 15, [1010, 540], 'bezier'),
				key(++k, 22, [960, 540], 'bezier'),
			],
		};
		(c.transform as Record<string, unknown>).scale = {
			value: 100,
			keyframes: [
				key(++k, 200, 100, 'bezier'),
				key(++k, 210, 125, 'bezier'),
				key(++k, 220, 100, 'bezier'),
				key(++k, 300, 0, 'linear'),
			],
		};
		c.opacity = { value: 100, keyframes: [key(++k, 0, 0, 'linear'), key(++k, 8, 100, 'linear')] };
	}
	for (let i = 0; i < 40; i++) {
		const c = add('text', 2, i * 450 + 200, 200);
		c.content = { ...(c.content as object), text: `Chapter title number ${i}` };
		c.textAnimation = {
			in: { preset: 'typewriter', version: 2, durationFrames: 45, params: {} },
			out: { preset: 'slide-up', version: 1, durationFrames: 15, params: {} },
		};
	}
	seq.markers = Array.from({ length: 20 }, (_, i) => ({
		id: `mrk_${String(i + 1).padStart(16, '0')}`,
		frame: i * 900 + 77,
		duration: 0,
		name: 'sfx: hit',
		comment: '',
		color: 'green',
		type: 'comment',
		author: 'user',
	})) as never;
	return { doc, seqId: TPL.seqId };
}

describe('deriveCues performance', () => {
	it('derives a 10-minute, 200-clip sequence in < 1 s', () => {
		const { doc, seqId } = tenMinutes();
		expect(Object.keys(doc.sequences[seqId]!.clips)).toHaveLength(200);
		const times: number[] = [];
		let r: DeriveCuesResult | null = null;
		for (let i = 0; i < 3; i++) {
			const t0 = performance.now();
			r = deriveCues(doc, seqId, { density: 'balanced' });
			times.push(performance.now() - t0);
		}
		const best = Math.min(...times);
		console.log(
			`deriveCues 10 min / 200 clips: ${times.map((t) => t.toFixed(0)).join(', ')} ms (best ${best.toFixed(0)} ms); found ${r!.stats.found}, kept ${r!.stats.kept}, curves ${r!.curves.length}`,
		);
		expect(r!.stats.found).toBeGreaterThan(300);
		expect(r!.warnings).toEqual([]);
		expect(best).toBeLessThan(1000);
	}, 120_000);
});
