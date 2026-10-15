// Cue derivation (spec 12 §2.2 "Derivation", P2-R3): one block per source, merging, budgets, determinism.
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	type DerivedCue,
	deriveCues,
	mgPhases,
	parseSfxRequest,
	speedSegments,
	thinPattern,
	transitionClass,
	transitionTravel,
	typewriterOffsets,
} from '../src/index.ts';
import type { Harness } from './helpers.ts';
import {
	animOf,
	F,
	kf,
	kfid,
	mgRegistry,
	newHarness,
	patchClip,
	phase2Fixture,
	placeVideo,
} from './sound-cues-fixtures.ts';

const derive = (h: Harness, opts: Parameters<typeof deriveCues>[2] = {}) =>
	deriveCues(h.doc, h.seqId, { density: 'rich', mgTemplates: mgRegistry(), ...opts });
const of = (cues: DerivedCue[], from: DerivedCue['from']) => cues.filter((c) => c.from === from);

/** A still on a track, `frames` long, named; returns the clip id. */
function placeStill(
	h: Harness,
	at: number,
	frames: number,
	track: string,
	name: string,
	w = 400,
	hgt = 200,
): string {
	const m = h.registerVideo({ kind: 'image', width: w, height: hgt });
	const id = h.ok([{ type: 'clip.place', source: { mediaId: m }, at, tracks: { video: track }, ref: '$s' }])
		.refs.$s!;
	patchClip(h, id, (c) => {
		c.name = name;
		c.duration = frames;
	});
	return id;
}

function setTransform(
	h: Harness,
	id: string,
	prop: 'position' | 'scale' | 'rotation',
	a: Animatable<unknown>,
) {
	patchClip(h, id, (c) => {
		(c.transform as Record<string, unknown>)[prop] = a;
	});
}

describe('deriveCues on the Phase 2 fixture (push, keyframed logo, typewriter, cuts, mg, marker)', () => {
	it('finds every event with an anchor and a reason', () => {
		const f = phase2Fixture();
		const r = derive(f.h);
		expect(r.warnings).toEqual([]);
		for (const c of r.cues) {
			expect(c.reason.length).toBeGreaterThan(10);
			expect(Number.isInteger(c.frame)).toBe(true);
			expect(c.confidence).toBeGreaterThanOrEqual(0);
			expect(c.confidence).toBeLessThanOrEqual(1);
		}
		// Cut A → B; the B → C edit is the push transition's event, not a cut.
		const cuts = r.cues.filter((c) => c.kind === 'cut');
		expect(cuts.map((c) => c.frame)).toEqual([90, 330]);
		expect(cuts[0]!.anchor).toEqual({
			type: 'edit',
			trackId: f.h.seq.videoTracks[0]!.id,
			outgoingClipId: f.a,
			incomingClipId: f.b,
		});
		expect(cuts[0]!.reason).toBe("Cut on V1: 'Shot A' → 'Shot B'");
		// Push: whoosh at the visual centre, window = span, pan sweep along its direction.
		const push = r.cues.find((c) => c.kind === 'transition')!;
		expect(push).toMatchObject({
			frame: 180,
			types: ['whoosh', 'transition', 'swish'],
			window: { start: 170, end: 190 },
			panSweep: { from: -60, to: 60 },
			anchor: { type: 'transition', transitionId: f.tr },
		});
		expect(push.reason).toContain('Push (left → right)');
		// Logo: peak-speed move, then a land at the overshoot's turnaround (content frame 22 = sequence 52).
		const move = r.cues.find((c) => c.kind === 'move')!;
		expect(move.anchor).toMatchObject({
			type: 'keyframe',
			clipId: f.logo,
			property: 'transform.position',
			event: 'peak-speed',
		});
		expect(move.frame).toBe(46); // the middle of the linear 200 → 1010 stretch (content frames 10–22)
		expect(move.anchor).toMatchObject({ keyframeId: kfid('kp2') });
		expect(move.types[0]).toBe('whoosh');
		const land = r.cues.find((c) => c.kind === 'land' && c.from === 'keyframes')!;
		expect(land).toMatchObject({
			frame: 52,
			anchor: {
				type: 'keyframe',
				clipId: f.logo,
				property: 'transform.position',
				keyframeId: kfid('kp2'),
				event: 'settle',
			},
		});
		expect(land.reason).toBe("Position (200, 540)→(960, 540) ends (ease-out overshoot) on V2 'Logo'");
		// Typewriter: a key pattern sharing one group, ≤ 12 per second.
		const keys = r.cues.filter((c) => c.group?.endsWith(':in:typewriter'));
		expect(keys.length).toBeGreaterThanOrEqual(6);
		expect(keys.every((k) => k.types[0] === 'key' && k.anchor.type === 'text')).toBe(true);
		expect(keys[0]!.frame).toBe(200);
		for (let i = 1; i < keys.length; i++)
			expect(keys[i]!.frame - keys[i - 1]!.frame).toBeGreaterThanOrEqual(30 / 12);
		// Motion-graphic intro end lands, outro start leaves (15 / 12 frames at 30 fps).
		expect(r.cues.filter((c) => c.from === 'mg').map((c) => [c.frame, c.kind])).toEqual([
			[345, 'land'],
			[408, 'exit'],
		]);
		// Marker: explicit hero boom + whoosh.
		const m = r.cues.find((c) => c.from === 'markers')!;
		expect(m).toMatchObject({
			frame: 250,
			kind: 'manual',
			weight: 'hero',
			types: ['boom', 'whoosh'],
			source: 'marker',
			anchor: { type: 'marker', markerId: f.marker },
			confidence: 1,
		});
		// Stats per source.
		expect(r.stats.bySource.transitions).toMatchObject({ found: 1, kept: 1 });
		expect(r.stats.bySource.edits.found).toBe(2);
		expect(r.stats.found).toBe(r.cues.length);
		// The logo's speed curve covers its keyframes.
		const curve = r.curves.find((c) => c.clipId === f.logo)!;
		expect(curve.speed.length).toBeGreaterThan(15);
		expect(Math.max(...curve.speed)).toBeCloseTo(((1010 - 200) / 12 / Math.hypot(1920, 1080)) * 30, 2);
	});

	it('is deterministic and ordered by frame, then key', () => {
		const f = phase2Fixture();
		const a = derive(f.h);
		const b = derive(f.h);
		expect(JSON.stringify(a.cues)).toBe(JSON.stringify(b.cues));
		// The same document with its clips stored in another order derives the same cues.
		const doc = structuredClone(f.h.doc);
		const seq = doc.sequences[f.h.seqId]!;
		seq.clips = Object.fromEntries(Object.entries(seq.clips).reverse());
		const c = deriveCues(doc, f.h.seqId, { density: 'rich', mgTemplates: mgRegistry() });
		expect(JSON.stringify(c.cues)).toBe(JSON.stringify(a.cues));
		for (let i = 1; i < a.cues.length; i++) {
			const p = a.cues[i - 1]!;
			const q = a.cues[i]!;
			expect(p.frame < q.frame || (p.frame === q.frame && p.key < q.key)).toBe(true);
		}
	});

	it('honours the source selection and the range', () => {
		const f = phase2Fixture();
		const only = derive(f.h, { sources: ['transitions', 'markers'] });
		expect(new Set(only.cues.map((c) => c.from))).toEqual(new Set(['transitions', 'markers']));
		expect(only.stats.bySource.edits.found).toBe(0);
		const ranged = derive(f.h, { range: { start: 100, end: 260 } });
		expect(ranged.cues.length).toBeGreaterThan(0);
		expect(ranged.cues.every((c) => c.frame >= 100 && c.frame < 260)).toBe(true);
		expect(ranged.cues.some((c) => c.from === 'mg')).toBe(false);
	});

	it('reports a missing sequence instead of throwing', () => {
		const f = phase2Fixture();
		const r = deriveCues(f.h.doc, 'seq_NOPE', {});
		expect(r.cues).toEqual([]);
		expect(r.warnings[0]!.code).toBe('W_SEQUENCE_NOT_FOUND');
	});
});

describe('edits source', () => {
	it('skips through edits and cuts between graphics on a track are still cuts', () => {
		const h = newHarness();
		const a = placeVideo(h, 0, 120, 'V1', 'Long');
		h.ok([{ type: 'clip.split', clipIds: [a], at: 60 }]);
		const r = derive(h);
		expect(of(r.cues, 'edits')).toEqual([]);
		placeStill(h, 120, 30, 'V1', 'Card 1');
		placeStill(h, 150, 30, 'V1', 'Card 2');
		expect(of(derive(h).cues, 'edits').map((c) => c.frame)).toEqual([120, 150]);
	});

	it('gives plain dialogue cuts no sound (transcript words or Essential Sound dialogue)', () => {
		const h = newHarness();
		const mediaA = h.registerVideo({ seconds: 60 });
		const mediaB = h.registerVideo({ seconds: 60 });
		const place = (m: string, at: number) =>
			h.ok([
				{
					type: 'clip.place',
					source: { mediaId: m },
					sourceRange: { in: { flicks: 30 * F }, out: { flicks: 120 * F } },
					at,
					tracks: { video: 'V1', audio: 'A1' },
				},
			]);
		place(mediaA, 0);
		place(mediaB, 90);
		place(mediaA, 180);
		expect(
			derive(h)
				.cues.filter((c) => c.kind === 'cut')
				.map((c) => c.frame),
		).toEqual([90, 180]);
		// A word spoken from sequence frame 80 to 89 (media time 110–119 frames) covers the cut at 90 (padding).
		const doc = structuredClone(h.doc);
		doc.transcripts.trs_00000000000000T1 = {
			id: 'trs_00000000000000T1',
			mediaId: mediaA,
			language: 'en',
			origin: 'manual',
			words: [
				{ text: 'hello', start: 110 * F, end: 119 * F, confidence: 1, speaker: null, breakBefore: 'none' },
			],
			speakers: {},
		};
		h.doc = doc;
		const r = derive(h);
		expect(r.cues.filter((c) => c.kind === 'cut').map((c) => c.frame)).toEqual([180]);
		expect(r.stats.bySource.edits.suppressedByDialogue).toBe(1);
		expect(derive(h, { respectDialogue: false }).cues.filter((c) => c.kind === 'cut').length).toBe(2);
		// A voice-over on A2 typed `dialogue` in Essential Sound (no transcript) silences the cut at 180 too.
		const vo = h.registerVideo({ kind: 'audio', seconds: 10 });
		const voClip = h.ok([
			{ type: 'clip.place', source: { mediaId: vo }, at: 150, tracks: { audio: 'A2' }, ref: '$v' },
		]).refs.$v!;
		patchClip(h, voClip, (c) => {
			c.essential = { type: 'dialogue' };
		});
		const r2 = derive(h);
		expect(r2.cues.filter((c) => c.kind === 'cut')).toEqual([]);
		expect(r2.stats.bySource.edits.suppressedByDialogue).toBe(2);
	});
});

describe('transitions source', () => {
	it('classifies the registry', () => {
		expect(transitionClass('jasper.push')).toBe('move');
		expect(transitionClass('jasper.whip')).toBe('move');
		expect(transitionClass('jasper.cube-spin')).toBe('move');
		expect(transitionClass('jasper.s.swish-pan')).toBe('move');
		expect(transitionClass('jasper.cross-zoom')).toBe('zoom');
		expect(transitionClass('jasper.wipe')).toBe('wipe');
		expect(transitionClass('jasper.iris-round')).toBe('wipe');
		expect(transitionClass('jasper.s.wipe-clock')).toBe('wipe');
		expect(transitionClass('jasper.glitch-transition')).toBe('glitch');
		expect(transitionClass('jasper.s.dissolve-pixel-mosh')).toBe('glitch');
		expect(transitionClass('jasper.flash-transition')).toBe('light');
		expect(transitionClass('jasper.cross-dissolve')).toBe('dissolve');
		expect(transitionClass('jasper.dip-to-black')).toBe('dissolve');
		expect(transitionClass('vendor.unknown-thing')).toBe('dissolve');
		const p = (v: unknown) => ({ direction: { value: v, keyframes: [] } }) as never;
		expect(transitionTravel(p('westToEast'))).toBe(1);
		expect(transitionTravel(p('eastToWest'))).toBe(-1);
		expect(transitionTravel(p('northToSouth'))).toBeNull();
		expect(transitionTravel({ angle: { value: 180, keyframes: [] } } as never)).toBeCloseTo(-1);
		expect(transitionTravel({ angle: { value: 90, keyframes: [] } } as never)).toBeNull();
	});

	function withTransition(effectId: string, params?: Record<string, unknown>) {
		const h = newHarness();
		placeVideo(h, 0, 90, 'V1', 'A');
		const b = placeVideo(h, 90, 90, 'V1', 'B');
		const t = h.ok([
			{
				type: 'transition.add',
				clipId: b,
				edge: 'in',
				effectId,
				duration: 16,
				...(params ? { params } : {}),
				ref: '$t',
			},
		]).refs.$t!;
		return { h, t };
	}

	it('a wipe right → left swishes with a sweep from right to left', () => {
		const { h } = withTransition('jasper.wipe', { direction: 'eastToWest' });
		const c = of(derive(h).cues, 'transitions')[0]!;
		expect(c).toMatchObject({
			frame: 90,
			types: ['swish', 'transition', 'whoosh'],
			panSweep: { from: 60, to: -60 },
		});
	});

	it('a dissolve is at most an ambient shimmer, dropped by the sparse minimum confidence', () => {
		const { h } = withTransition('jasper.cross-dissolve');
		const rich = of(derive(h).cues, 'transitions');
		expect(rich).toHaveLength(1);
		expect(rich[0]).toMatchObject({ weight: 'ambient', types: ['shimmer', 'transition'], confidence: 0.2 });
		expect(rich[0]!.panSweep).toBeUndefined();
		const sparse = derive(h, { density: 'sparse' });
		expect(of(sparse.cues, 'transitions')).toEqual([]);
		expect(sparse.stats.dropped.confidence).toBe(1);
		expect(sparse.stats.bySource.transitions.droppedByBudget).toBe(1);
	});

	it('a glitch transition suggests glitch first', () => {
		const { h } = withTransition('jasper.glitch-transition');
		expect(of(derive(h).cues, 'transitions')[0]!.types[0]).toBe('glitch');
	});
});

describe('keyframes source', () => {
	it('a scale-up from 0 with overshoot pops in once (appear), not a move', () => {
		const h = newHarness();
		const id = placeStill(h, 0, 90, 'V2', 'Badge');
		setTransform(h, id, 'scale', animOf(100, [kf('s1', 10, 0), kf('s2', 15, 115), kf('s3', 19, 100)]));
		const cues = of(derive(h).cues, 'keyframes');
		const appear = cues.filter((c) => c.kind === 'appear');
		expect(appear).toHaveLength(1);
		expect(appear[0]!.types[0]).toBe('pop');
		expect(appear[0]!.anchor).toMatchObject({ property: 'transform.scale', event: 'end' });
		expect(appear[0]!.frame).toBe(15); // on the key the growth reaches
		expect(appear[0]!.anchor).toMatchObject({ keyframeId: kfid('s2') });
		expect(cues.some((c) => c.kind === 'move')).toBe(false);
	});

	it('a scale pulse out and back is an emphasis at its extreme', () => {
		const h = newHarness();
		const id = placeStill(h, 0, 90, 'V2', 'Logo');
		setTransform(h, id, 'scale', animOf(100, [kf('s1', 20, 100), kf('s2', 26, 120), kf('s3', 32, 100)]));
		const cues = of(derive(h).cues, 'keyframes');
		expect(cues.map((c) => [c.kind, c.frame])).toEqual([['emphasis', 26]]);
		expect(cues[0]!.reason).toBe("Scale pulses 100 %→120 %→100 % on V2 'Logo'");
		expect(cues[0]!.anchor).toMatchObject({
			property: 'transform.scale',
			keyframeId: kfid('s2'),
			event: 'end',
		});
	});

	it('an abrupt stop lands; a gentle ease-out only moves', () => {
		const h = newHarness();
		const hard = placeStill(h, 0, 90, 'V2', 'Hard', 1200, 800);
		setTransform(
			h,
			hard,
			'position',
			animOf<[number, number]>([960, 540], [kf('p1', 10, [0, 540]), kf('p2', 20, [960, 540])]),
		);
		const soft = placeStill(h, 0, 90, 'V3', 'Soft');
		const easeOut = { influence: 0.9, slope: 0 };
		setTransform(
			h,
			soft,
			'position',
			animOf<[number, number]>(
				[960, 540],
				[
					{
						id: kfid('q1'),
						time: 40 * F,
						value: [0, 540],
						interpolation: 'bezier',
						easeIn: easeOut,
						easeOut: { influence: 0.1, slope: 0 },
					},
					{
						id: kfid('q2'),
						time: 70 * F,
						value: [960, 540],
						interpolation: 'bezier',
						easeIn: easeOut,
						easeOut,
					},
				],
			),
		);
		const r = derive(h);
		const hardCues = r.cues.filter((c) => (c.anchor as { clipId?: string }).clipId === hard);
		expect(hardCues.map((c) => c.kind)).toEqual(['move', 'land']);
		const land = hardCues[1]!;
		expect(land.frame).toBe(20);
		expect(land.reason).toContain('stops');
		// 1200×800 is ≥ 20 % of the frame and fast: a hero hit.
		expect(land).toMatchObject({ weight: 'hero', types: ['hit', 'thump', 'tap'] });
		const softCues = r.cues.filter((c) => (c.anchor as { clipId?: string }).clipId === soft);
		expect(softCues.map((c) => c.kind)).toEqual(['move']);
		// Pan follows the layer: the peak is left of centre, the sweep goes left → centre.
		expect(softCues[0]!.panSweep!.from).toBeLessThan(softCues[0]!.panSweep!.to);
	});

	it('opacity ramps appear and disappear', () => {
		const h = newHarness();
		const id = placeStill(h, 0, 120, 'V2', 'Fade');
		patchClip(h, id, (c) => {
			c.opacity = animOf(100, [kf('o1', 0, 0), kf('o2', 6, 100), kf('o3', 100, 100), kf('o4', 115, 0)]);
		});
		const cues = of(derive(h).cues, 'keyframes');
		expect(cues.map((c) => [c.kind, c.frame])).toEqual([
			['appear', 6],
			['exit', 101],
		]);
		expect(cues[0]!.types[0]).toBe('pop');
		expect(cues[0]!.anchor).toMatchObject({ property: 'opacity', keyframeId: kfid('o2'), event: 'end' });
	});

	it('a rotation spin moves; hidden tracks and disabled clips are ignored', () => {
		const h = newHarness();
		const id = placeStill(h, 0, 90, 'V2', 'Spinner');
		setTransform(h, id, 'rotation', animOf(0, [kf('r1', 0, 0), kf('r2', 15, 360)]));
		expect(of(derive(h).cues, 'keyframes').map((c) => c.anchor)).toEqual([
			expect.objectContaining({ property: 'transform.rotation', event: 'peak-speed' }),
			expect.objectContaining({ property: 'transform.rotation', event: 'settle' }),
		]);
		const doc = structuredClone(h.doc);
		doc.sequences[h.seqId]!.videoTracks[1]!.output = false;
		expect(deriveCues(doc, h.seqId, { density: 'rich' }).cues).toEqual([]);
		patchClip(h, id, (c) => {
			c.enabled = false;
		});
		expect(derive(h).cues).toEqual([]);
	});

	it('maps on-screen x to pan ±60', () => {
		const h = newHarness();
		const id = placeStill(h, 0, 90, 'V2', 'Right', 100, 100);
		setTransform(
			h,
			id,
			'position',
			animOf<[number, number]>([1728, 540], [kf('p1', 10, [1728, 100]), kf('p2', 20, [1728, 900])]),
		);
		const move = of(derive(h).cues, 'keyframes').find((c) => c.kind === 'move')!;
		expect(move.pan).toBe(48); // x 1728 of 1920 = 0.9 → (0.9·2 − 1)·60
	});

	it('speedSegments joins an overshoot turnaround and drops slow drifts', () => {
		expect(speedSegments([0, 0.5, 0.5, 0.02, 0.2, 0.2, 0], 2)).toEqual([{ a: 1, b: 5, peak: 1 }]);
		expect(speedSegments([0, 0.05, 0.08, 0.05, 0], 2)).toEqual([]);
		expect(speedSegments([0, 0.5, 0], 2)).toEqual([]); // one frame: a jump, not a move
	});
});

describe('text source', () => {
	function addText(h: Harness, text: string, textAnimation: unknown, at = 0, duration = 90, track = 'V2') {
		return h.ok([{ type: 'clip.addText', at, duration, track, content: { text }, textAnimation, ref: '$x' }])
			.refs.$x!;
	}

	it('In / Out presets appear at the start and exit where the out motion starts', () => {
		const h = newHarness();
		const id = addText(h, 'Hi there', {
			in: { preset: 'slide-up', durationFrames: 20 },
			out: { preset: 'pop', durationFrames: 15 },
		});
		const cues = of(derive(h).cues, 'text');
		expect(cues.map((c) => [c.kind, c.frame, c.types[0]])).toEqual([
			['appear', 0, 'swish'],
			['exit', 75, 'pop'],
		]);
		expect(cues[0]!.anchor).toEqual({ type: 'text', clipId: id, side: 'in' });
		expect(cues[0]!.window).toEqual({ start: 0, end: 20 });
		expect(cues[0]!.reason).toContain('Slide Up');
		// No clip-edge cue duplicates an animated side.
		expect(of(derive(h).cues, 'clipEdges')).toEqual([]);
	});

	it('typewriter patterns are capped at 12 per second and 40 per clip', () => {
		const h = newHarness();
		addText(h, 'x'.repeat(200), { in: { preset: 'typewriter', durationFrames: 300 } }, 0, 400);
		const keys = of(derive(h).cues, 'text').filter((c) => c.group);
		expect(keys.length).toBe(40);
		expect(new Set(keys.map((k) => k.group)).size).toBe(1);
		for (let i = 0; i + 12 < keys.length; i++)
			expect(keys[i + 12]!.frame - keys[i]!.frame).toBeGreaterThanOrEqual(30);
		const fast = newHarness();
		addText(fast, 'abcdefghijklmnopqrst', { in: { preset: 'typewriter', durationFrames: 15 } });
		const k2 = of(derive(fast).cues, 'text').filter((c) => c.group);
		for (let i = 1; i < k2.length; i++) expect(k2[i]!.frame - k2[i - 1]!.frame).toBeGreaterThanOrEqual(2.5);
		expect(k2.length).toBeLessThanOrEqual(6);
	});

	it('typewriterOffsets follows typewriterSchedule (delay, typing span, out deletes backwards)', () => {
		expect(typewriterOffsets(4, 30, 30, { delay: 0, typing: 1 }, 'in')).toEqual([0, 8, 15, 23]);
		expect(typewriterOffsets(4, 30, 30, { delay: 0.5, typing: 0.5 }, 'in')).toEqual([15, 19, 23, 27]);
		const out = typewriterOffsets(4, 30, 30, { delay: 0, typing: 1 }, 'out');
		expect(out).toEqual([...out].sort((a, b) => a - b));
		expect(out[out.length - 1]).toBeLessThanOrEqual(29);
		expect(thinPattern([0, 1, 2, 3, 4, 5, 6], 30)).toEqual([0, 3, 6]);
	});

	it('an animated Range Selector reveals unit by unit', () => {
		const h = newHarness();
		const id = addText(h, 'ABCDEFGH', undefined);
		patchClip(h, id, (c) => {
			c.animators = [
				{
					id: 'tag_00000000000000A1',
					name: 'Reveal',
					enabled: true,
					properties: { opacity: { value: 0, keyframes: [] } },
					selectors: [
						{
							id: 'tsl_00000000000000S1',
							kind: 'range',
							name: 'Range Selector 1',
							enabled: true,
							start: animOf(0, [kf('a1', 10, 0), kf('a2', 40, 100)]),
							end: { value: 100, keyframes: [] },
							offset: { value: 0, keyframes: [] },
							units: 'percentage',
							basedOn: 'characters',
							mode: 'add',
							amount: { value: 100, keyframes: [] },
							shape: 'square',
							smoothness: { value: 0, keyframes: [] },
							easeHigh: { value: 0, keyframes: [] },
							easeLow: { value: 0, keyframes: [] },
							randomize: false,
							randomSeed: { value: 0, keyframes: [] },
						},
					],
				},
			];
		});
		const r = deriveCues(h.doc, h.seqId, { density: 'rich' });
		const reveal = of(r.cues, 'text').filter((c) => c.group?.includes(':animator:'));
		expect(reveal.length).toBe(8);
		expect(reveal.every((c) => c.kind === 'appear' && c.types[0] === 'key')).toBe(true);
		expect(reveal.map((c) => (c.anchor as { unit?: number }).unit)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(reveal[0]!.frame).toBeGreaterThanOrEqual(10);
		expect(reveal[7]!.frame).toBeLessThanOrEqual(41);
	});
});

describe('mg, clip edges, 3D camera and markers', () => {
	it('mgPhases converts from 30 fps and compresses like animeTemplateTiming', () => {
		expect(mgPhases({ introFrames: 15, outroFrames: 12 }, 60, 300)).toEqual({ intro: 30, outro: 24 });
		expect(mgPhases({ introFrames: 30, outroFrames: 30 }, 30, 40)).toEqual({ intro: 20, outro: 20 });
	});

	it('without a template registry the mg source warns and finds nothing', () => {
		const f = phase2Fixture();
		const r = deriveCues(f.h.doc, f.h.seqId, { density: 'rich' });
		expect(of(r.cues, 'mg')).toEqual([]);
		expect(r.warnings.map((w) => w.code)).toContain('W_MG_REGISTRY_MISSING');
	});

	it('graphics on V2+ appear and disappear; V1 graphics and adjacent edits do not', () => {
		const h = newHarness();
		placeVideo(h, 0, 300, 'V1', 'Base');
		const s = placeStill(h, 30, 60, 'V2', 'Sticker');
		placeStill(h, 120, 30, 'V1', 'Card');
		const cues = of(derive(h).cues, 'clipEdges');
		expect(cues.map((c) => [c.kind, c.frame, c.weight])).toEqual([
			['appear', 30, 'support'],
			['exit', 90, 'ambient'],
		]);
		expect(cues[0]!.anchor).toEqual({ type: 'clip', clipId: s, edge: 'start' });
		expect(cues[0]!.types[0]).toBe('pop');
	});

	it('the active 3D camera moving gives a move; a camera under a higher one does not', () => {
		const h = newHarness();
		placeVideo(h, 0, 150, 'V1', 'Plate');
		const cam = h.ok([{ type: 'clip.addCamera', at: 0, duration: 150, track: 'V2', name: 'Cam', ref: '$c' }])
			.refs.$c!;
		patchClip(h, cam, (c) => {
			const tr = (c.camera as { transform: { position: Animatable<number[]> } }).transform;
			tr.position = animOf([0, 0, -2000], [kf('c1', 30, [0, 0, -2000]), kf('c2', 60, [1500, 0, -2000])]);
		});
		const r = derive(h);
		const moves = of(r.cues, 'camera3d');
		expect(moves).toHaveLength(1);
		expect(moves[0]!.anchor).toMatchObject({
			type: 'keyframe',
			clipId: cam,
			property: 'camera.transform.position',
			keyframeId: kfid('c2'),
			event: 'peak-speed',
		});
		// A two-node camera also turns towards its point of interest while it travels: the peak is inside the move.
		expect(moves[0]!.frame).toBeGreaterThan(30);
		expect(moves[0]!.frame).toBeLessThan(60);
		expect(r.curves.some((c) => c.clipId === cam)).toBe(true);
		// A static camera on V3 covers the moving one: nothing moves on screen.
		h.ok([{ type: 'clip.addCamera', at: 0, duration: 150, track: 'V3', name: 'Top' }]);
		expect(of(derive(h).cues, 'camera3d')).toEqual([]);
	});

	it('parses sfx: requests (ids, synonyms, separators) and agent notes', () => {
		expect(parseSfxRequest('sfx: hit')).toEqual({ names: ['hit'], types: ['hit'] });
		expect(parseSfxRequest('SFX: swoosh, sub drop')!.types).toEqual(['whoosh', 'boom']);
		expect(parseSfxRequest('sfx: banana')).toEqual({ names: ['banana'], types: [] });
		expect(parseSfxRequest('music cue')).toBeNull();
		expect(parseSfxRequest(42)).toBeNull();
		const h = newHarness();
		placeVideo(h, 0, 300, 'V1', 'Base');
		h.ok([
			{ type: 'marker.add', frame: 30, name: 'sfx: banana' },
			{ type: 'marker.add', frame: 60, name: 'Note' },
			{ type: 'marker.add', frame: 90, name: 'agent', comment: 'sfx: pop', markerType: 'agent-note' },
			{ type: 'marker.add', frame: 120, name: 'plain', comment: 'sfx: hit' },
		]);
		const doc = h.doc;
		const cues = deriveCues(doc, h.seqId, { density: 'rich', sources: ['markers'] }).cues;
		expect(cues.map((c) => [c.frame, c.types])).toEqual([
			[30, []],
			[90, ['pop']],
		]);
		expect(cues[0]!.reason).toContain('unknown: banana');
	});
});

describe('merging and budgets', () => {
	it('cues within 2 frames merge into the heavier one, keeping the other anchor', () => {
		const h = newHarness();
		placeVideo(h, 0, 90, 'V1', 'A');
		placeVideo(h, 90, 90, 'V1', 'B');
		h.ok([{ type: 'marker.add', frame: 91, name: 'sfx: boom' }]);
		const r = derive(h);
		expect(r.cues).toHaveLength(1);
		const c = r.cues[0]!;
		expect(c).toMatchObject({ frame: 91, from: 'markers', weight: 'hero' });
		expect(c.also).toEqual([expect.objectContaining({ type: 'edit' })]);
		expect(c.reason).toContain('also Cut on V1');
		expect(r.stats.bySource.edits).toMatchObject({ found: 1, merged: 1, kept: 0 });
	});

	/** 60 one-second shots: 59 cuts, one per second. */
	function montage(n = 60, len = 30) {
		const h = newHarness();
		for (let i = 0; i < n; i++) placeVideo(h, i * len, len, 'V1', `S${i}`);
		return h;
	}

	it('caps cues per second by density and counts drops', () => {
		const h = montage(60, 10); // a cut every 10 frames = 3 per second
		for (const [density, perSec] of [
			['sparse', 1],
			['balanced', 2],
			['rich', 3],
		] as const) {
			const r = derive(h, { density });
			const frames = r.cues.map((c) => c.frame);
			for (const f of frames)
				expect(frames.filter((g) => g >= f && g < f + 30).length).toBeLessThanOrEqual(perSec);
			expect(r.stats.dropped.rate + r.cues.length + r.stats.dropped.confidence).toBe(59);
		}
	});

	it('demotes heroes closer than the density spacing; never two within 0.5 s', () => {
		const h = montage(10, 30);
		h.ok([10, 25, 40, 70, 160].map((frame) => ({ type: 'marker.add', frame, name: 'sfx: hit' })));
		const heroes = (d: 'sparse' | 'balanced' | 'rich') =>
			derive(h, { density: d, sources: ['markers'] })
				.cues.filter((c) => c.weight === 'hero')
				.map((c) => c.frame);
		expect(heroes('rich')).toEqual([10, 70, 160]);
		expect(heroes('balanced')).toEqual([10, 70, 160]);
		expect(heroes('sparse')).toEqual([10, 160]);
		const r = derive(h, { density: 'rich', sources: ['markers'] });
		expect(r.cues).toHaveLength(5); // explicit cues are kept, as support
		expect(r.stats.heroesDemoted).toBe(2);
	});

	it('respects maxCues and minGapFrames; a pattern group counts once in a window', () => {
		const h = montage(30, 30);
		expect(derive(h, { maxCues: 5 }).cues).toHaveLength(5);
		const gapped = derive(h, { minGapFrames: 70 }).cues.map((c) => c.frame);
		for (let i = 1; i < gapped.length; i++) expect(gapped[i]! - gapped[i - 1]!).toBeGreaterThanOrEqual(70);
		const t = newHarness();
		t.ok([
			{
				type: 'clip.addText',
				at: 0,
				duration: 120,
				track: 'V2',
				content: { text: 'ABCDEFGHIJKL' },
				textAnimation: { in: { preset: 'typewriter', durationFrames: 30 } },
			},
		]);
		const keys = deriveCues(t.doc, t.seqId, { density: 'sparse' }).cues.filter((c) => c.group);
		expect(keys.length).toBeGreaterThan(1); // 1 cue per second, yet the whole pattern is kept
	});

	it('merges engine cues (scene, beat, pixel) and ignores malformed ones', () => {
		const h = montage(4, 30);
		const scene = {
			frame: 45,
			kind: 'cut' as const,
			weight: 'support' as const,
			types: ['hit' as const],
			align: 'peak' as const,
			anchor: { type: 'scene' as const, mediaId: 'med_X', mediaSec: 1.5 },
			confidence: 0.6,
			reason: 'Scene change in the footage',
			from: 'scene' as const,
		};
		const r = derive(h, { extraCues: [scene, { ...scene, frame: 1.5 }, null as never] });
		expect(of(r.cues, 'scene').map((c) => c.frame)).toEqual([45]);
		expect(r.stats.bySource.scene.found).toBe(1);
		expect(r.warnings.map((w) => w.code)).toEqual(['W_EXTRA_CUE_INVALID']);
		expect(of(derive(h, { sources: ['edits'], extraCues: [scene] }).cues, 'scene')).toEqual([]);
	});
});
