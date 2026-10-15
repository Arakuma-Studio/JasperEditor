// Cue anchors (spec 12 §2.2): `resolveCueAnchor` maps every anchor variant to the frame of its picture event now.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type CueAnchor,
	CueAnchorSchema,
	createStaticMgRegistry,
	cueAnchorRefs,
	cueAnchorTargetExists,
	type DerivedCue,
	defaultRegistries,
	deriveCues,
	FLICKS_PER_SECOND,
	type MgTemplateInfo,
	resolveCueAnchor,
	textUnitCount,
	typewriterScheduleMs,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import { animOf, kf, mgRegistry, newHarness, patchClip } from './sound-cues-fixtures.ts';

const schema = z.object({});
const TPL: MgTemplateInfo = {
	id: 'reveal',
	version: 1,
	name: 'Reveal',
	category: 'Titles',
	paramsSchema: schema,
	defaults: {},
	introFrames: 15,
	outroFrames: 30,
	canvasDefault: 'sequence',
};
const mgTemplates = createStaticMgRegistry([TPL]);

/** V1: clip A [0, 60), clip B [60, 150) with a 10-frame centred dissolve; A1 audio of each. */
function edit() {
	const h = new Harness({ ctx: { registries: defaultRegistries(mgTemplates) } });
	const media = h.registerVideo({ seconds: 10 });
	const a = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: media },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
		},
	]).results[0] as { clipIds: string[] };
	const b = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: media },
			at: 60,
			sourceRange: { in: { seconds: 3 }, out: { seconds: 6 } },
		},
	]).results[0] as { clipIds: string[] };
	const [va, vb] = [a.clipIds[0]!, b.clipIds[0]!];
	const tr = h.ok([
		{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.cross-dissolve', duration: 10 },
	]).results[0] as { transitionId: string };
	return { h, media, va, vb, transitionId: tr.transitionId };
}

describe('resolveCueAnchor', () => {
	it('edit: the incoming clip’s first frame (else the outgoing clip’s end); transition: its visual centre', () => {
		const { h, va, vb, transitionId } = edit();
		const seq = h.seq;
		const trackId = seq.videoTracks[0]!.id;
		expect(
			resolveCueAnchor(h.doc, seq, { type: 'edit', trackId, outgoingClipId: va, incomingClipId: vb }),
		).toBe(60);
		expect(
			resolveCueAnchor(h.doc, seq, { type: 'edit', trackId, outgoingClipId: va, incomingClipId: 'clp_X' }),
		).toBe(60);
		expect(
			resolveCueAnchor(h.doc, seq, {
				type: 'edit',
				trackId,
				outgoingClipId: 'clp_X',
				incomingClipId: 'clp_Y',
			}),
		).toBeNull();
		// centred dissolve of 10 frames over the cut at 60 → [55, 65) → centre 60
		expect(resolveCueAnchor(h.doc, seq, { type: 'transition', transitionId })).toBe(60);
		expect(resolveCueAnchor(h.doc, seq, { type: 'transition', transitionId: 'trn_missing' })).toBeNull();
		// the cut follows the incoming clip when it moves
		h.ok([{ type: 'clip.move', clipIds: [vb], deltaFrames: 12 }]);
		expect(
			resolveCueAnchor(h.doc, h.seq, { type: 'edit', trackId, outgoingClipId: va, incomingClipId: vb }),
		).toBe(72);
	});

	it('clip edges, sequence and clip markers', () => {
		const { h, va, vb } = edit();
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'clip', clipId: vb, edge: 'start' })).toBe(60);
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'clip', clipId: vb, edge: 'end' })).toBe(150);
		const m = h.ok([{ type: 'marker.add', frame: 42, name: 'hit' }]).results[0] as { markerId: string };
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'marker', markerId: m.markerId })).toBe(42);
		// a clip marker 1 s into clip A's content (A shows 0…2 s at frames 0…59)
		const cm = h.ok([{ type: 'marker.add', clipId: va, flicks: { seconds: 1 }, name: 'x' }]).results[0] as {
			markerId: string;
		};
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'marker', markerId: cm.markerId })).toBe(30);
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'marker', markerId: 'mrk_none' })).toBeNull();
	});

	it('scene and beat: the frame that shows a media time (earliest clip), null when not shown', () => {
		const { h, media, vb } = edit();
		// B shows media 3…6 s from frame 60 at 30 fps: 4 s → frame 90
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'scene', mediaId: media, mediaSec: 4 })).toBe(90);
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'scene', mediaId: media, mediaSec: 0.5 })).toBe(15);
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'scene', mediaId: media, mediaSec: 2.5 })).toBeNull();
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'scene', mediaId: 'med_none', mediaSec: 1 })).toBeNull();
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'beat', clipId: vb, beatIndex: 2, mediaSec: 5 })).toBe(120);
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'beat', clipId: vb, beatIndex: 2 })).toBeNull();
		// a clip at 200 % speed shows media 2 s per second
		h.ok([{ type: 'clip.setSpeed', clipIds: [vb], rate: 2, ripple: false }]);
		const c = h.seq.clips[vb]!;
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'beat', clipId: vb, beatIndex: 0, mediaSec: 4 })).toBe(
			c.start + 15,
		);
	});

	it('keyframes: start, end, peak speed and settle of a run, or of the segment ending at a keyframe', () => {
		const { h, vb } = edit();
		const path = ['clip', vb, 'transform', 'position'];
		h.ok([
			{ type: 'param.setAnimated', target: path, animated: true, at: { frames: 0 } },
			{ type: 'keyframe.add', target: path, at: { frames: 0 }, value: [0, 0], interpolation: 'linear' },
			{ type: 'keyframe.add', target: path, at: { frames: 20 }, value: [200, 0], interpolation: 'linear' },
			{ type: 'keyframe.add', target: path, at: { frames: 40 }, value: [200, 0], interpolation: 'linear' },
		]);
		const kfs = (h.seq.clips[vb] as { transform: { position: { keyframes: { id: string }[] } } }).transform
			.position.keyframes;
		const k = (event: 'start' | 'end' | 'peak-speed' | 'settle', keyframeId?: string): CueAnchor => ({
			type: 'keyframe',
			clipId: vb,
			property: 'transform.position',
			event,
			...(keyframeId ? { keyframeId } : {}),
		});
		const r = (a: CueAnchor) => resolveCueAnchor(h.doc, h.seq, a);
		expect(r(k('start'))).toBe(60);
		expect(r(k('end'))).toBe(100);
		// a linear move 0…20 then a hold: the middle of the move; it settles when it arrives (frame 80)
		expect(r(k('peak-speed'))).toBe(70);
		expect(r(k('settle'))).toBe(80);
		// the segment ending at the 2nd key
		expect(r(k('end', kfs[1]!.id))).toBe(80);
		expect(r(k('start', kfs[1]!.id))).toBe(80);
		expect(r(k('peak-speed', kfs[1]!.id))).toBe(70);
		expect(r(k('end', 'kf_missing'))).toBeNull();
		expect(r({ ...k('end'), property: 'transform.nothing' } as CueAnchor)).toBeNull();
		expect(r({ ...k('end'), property: '__proto__.x' } as CueAnchor)).toBeNull();
		expect(cueAnchorTargetExists(h.doc, h.seq, k('end', kfs[1]!.id))).toBe(true);
		expect(cueAnchorTargetExists(h.doc, h.seq, k('end', 'kf_missing'))).toBe(false);
	});

	it('keyframes: an eased move peaks in its middle; an overshoot settles at its first arrival', () => {
		const { h, vb } = edit();
		const path = ['clip', vb, 'transform', 'scale'];
		h.ok([
			{ type: 'param.setAnimated', target: path, animated: true, at: { frames: 0 } },
			{ type: 'keyframe.add', target: path, at: { frames: 0 }, value: 0, interpolation: 'bezier' },
			{ type: 'keyframe.add', target: path, at: { frames: 30 }, value: 100, interpolation: 'bezier' },
		]);
		const r = (event: 'peak-speed' | 'settle') =>
			resolveCueAnchor(h.doc, h.seq, { type: 'keyframe', clipId: vb, property: 'transform.scale', event });
		// ease in/out symmetric: the fastest frame is the middle (frame 60 + 15)
		expect(r('peak-speed')).toBe(75);
		const s = r('settle')!;
		expect(s).toBeGreaterThan(75);
		expect(s).toBeLessThanOrEqual(90);
	});

	it('text: In at the clip start, Out at the Out window, typewriter units at their keystroke', () => {
		const h = new Harness();
		const r = h.ok([
			{
				type: 'clip.addText',
				at: 30,
				duration: 120,
				track: 'V2',
				content: { text: 'Hi you' },
				textAnimation: {
					in: { preset: 'typewriter', durationFrames: 30, params: { typing: 1, delay: 0 } },
					out: { preset: 'fade', durationFrames: 15 },
				},
				ref: '$t',
			},
		]);
		const clipId = r.refs.$t!;
		const t = (side: 'in' | 'out', unit?: number) =>
			resolveCueAnchor(h.doc, h.seq, { type: 'text', clipId, side, ...(unit !== undefined ? { unit } : {}) });
		expect(t('in')).toBe(30);
		expect(t('out')).toBe(30 + 120 - 15);
		expect(textUnitCount('Hi you', 'char')).toBe(5);
		expect(textUnitCount(' Hi  you ', 'word')).toBe(2);
		// 5 units over 30 frames (1000 ms at 30 fps): one every 200 ms = 6 frames
		expect(typewriterScheduleMs(5, 1000, { typing: 1 })).toEqual({ start: 0, slot: 200 });
		expect([0, 1, 2, 3, 4].map((u) => t('in', u))).toEqual([30, 36, 42, 48, 54]);
		expect(t('in', 5)).toBeNull();
		// the Out side is a fade, not a typewriter: no units
		expect(t('out', 0)).toBeNull();
	});

	it('mg: intro end and outro start (30 fps reference, compressed like the renderer); needs the registry', () => {
		const h = new Harness({ ctx: { registries: defaultRegistries(mgTemplates) } });
		const r = h.ok([
			{
				type: 'clip.addMotionGraphic',
				at: 10,
				duration: 90,
				track: 'V2',
				template: { id: 'reveal', version: 1 },
				ref: '$m',
			},
		]);
		const clipId = r.refs.$m!;
		const mg = (event: 'intro-end' | 'outro-start', opts = { mgTemplates }) =>
			resolveCueAnchor(h.doc, h.seq, { type: 'mg', clipId, event }, opts);
		expect(mg('intro-end')).toBe(25);
		expect(mg('outro-start')).toBe(70);
		expect(resolveCueAnchor(h.doc, h.seq, { type: 'mg', clipId, event: 'intro-end' })).toBeNull();
	});

	it('refs and target existence (repair) for every anchor type', () => {
		const { h, va, vb, transitionId, media } = edit();
		const trackId = h.seq.videoTracks[0]!.id;
		const anchors: CueAnchor[] = [
			{ type: 'edit', trackId, outgoingClipId: va, incomingClipId: vb },
			{ type: 'transition', transitionId },
			{ type: 'clip', clipId: va, edge: 'end' },
			{ type: 'scene', mediaId: media, mediaSec: 1 },
		];
		for (const a of anchors) {
			expect(CueAnchorSchema.safeParse(a).success).toBe(true);
			expect(cueAnchorTargetExists(h.doc, h.seq, a)).toBe(true);
			expect(cueAnchorRefs(a).length).toBeGreaterThan(0);
		}
		h.ok([{ type: 'clip.lift', clipIds: [vb] }]);
		expect(cueAnchorTargetExists(h.doc, h.seq, anchors[0])).toBe(false);
		expect(cueAnchorTargetExists(h.doc, h.seq, anchors[1])).toBe(false);
		expect(cueAnchorTargetExists(h.doc, h.seq, anchors[2])).toBe(true);
	});

	it('never throws on hostile anchors and documents (property)', () => {
		const { h } = edit();
		const anyAnchor = fc.oneof(
			fc.anything(),
			fc.record({
				type: fc.constantFrom(
					'edit',
					'transition',
					'keyframe',
					'text',
					'mg',
					'clip',
					'scene',
					'beat',
					'marker',
					'x',
				),
				clipId: fc.oneof(
					fc.string(),
					fc.constantFrom(...Object.keys(h.seq.clips), '__proto__', 'constructor'),
				),
				property: fc.oneof(fc.string(), fc.constantFrom('transform.position', 'opacity', 'effects.0.params')),
				event: fc.string(),
				side: fc.constantFrom('in', 'out'),
				unit: fc.oneof(fc.integer(), fc.double()),
				mediaSec: fc.oneof(fc.double(), fc.constant(Number.NaN)),
				mediaId: fc.string(),
				markerId: fc.string(),
				transitionId: fc.string(),
				outgoingClipId: fc.string(),
				incomingClipId: fc.string(),
			}),
		);
		fc.assert(
			fc.property(anyAnchor, (a) => {
				const f = resolveCueAnchor(h.doc, h.seq, a as CueAnchor, { mgTemplates });
				expect(f === null || (Number.isInteger(f) && f >= 0)).toBe(true);
				cueAnchorTargetExists(h.doc, h.seq, a as CueAnchor);
				cueAnchorRefs(a as CueAnchor);
			}),
			{ numRuns: 400 },
		);
		expect(resolveCueAnchor(null as never, null as never, null)).toBeNull();
		expect(
			resolveCueAnchor({ media: {} } as never, { clips: 5 } as never, { type: 'clip' } as never),
		).toBeNull();
		expect(FLICKS_PER_SECOND).toBeGreaterThan(0);
	});
});

// Review of WP2.2 (deriveCues): anchors the deriver makes must resolve back to the derived frame, and follow the clip.
describe('derived anchors resolve back to their frame (WP2.2 review regressions)', () => {
	const offenders = (h: Harness, cues: DerivedCue[]) =>
		cues
			.map((c) => ({ c, at: resolveCueAnchor(h.doc, h.seq, c.anchor, { mgTemplates: mgRegistry() }) }))
			.filter(({ c, at }) => at !== c.frame)
			.map(({ c, at }) => `${c.key} @${c.frame} → ${at}`);
	const addText = (h: Harness, text: string, textAnimation: unknown, at = 0, duration = 90) =>
		h.ok([{ type: 'clip.addText', at, duration, track: 'V2', content: { text }, textAnimation, ref: '$x' }])
			.refs.$x!;

	it('typewriter Out units: N − ⌈t/frame⌉ like the renderer (was one frame late when t/frame is not whole)', () => {
		const h = newHarness();
		addText(
			h,
			'abcdefg',
			{ out: { preset: 'typewriter', durationFrames: 37, params: { typing: 1, delay: 0 } } },
			0,
			120,
		);
		const keys = deriveCues(h.doc, h.seqId, { density: 'rich' }).cues.filter((c) =>
			c.group?.includes('typewriter'),
		);
		expect(keys.length).toBeGreaterThan(3);
		expect(offenders(h, keys)).toEqual([]);
	});

	it('Range Selector reveals resolve per unit (were null) and follow the clip', () => {
		const h = newHarness();
		const id = addText(h, 'ABCDEFGH', undefined);
		patchClip(h, id, (c) => {
			c.animators = [
				{
					id: 'tan_00000000000000A1',
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
		const reveal = deriveCues(h.doc, h.seqId, { density: 'rich' }).cues.filter((c) =>
			c.group?.includes(':animator:'),
		);
		expect(reveal.length).toBe(8);
		expect(offenders(h, reveal)).toEqual([]);
		h.ok([{ type: 'clip.move', clipIds: [id], deltaFrames: 20 }]);
		expect(reveal.map((c) => resolveCueAnchor(h.doc, h.seq, c.anchor))).toEqual(
			reveal.map((c) => c.frame + 20),
		);
	});

	it('peak speed of a combined position + scale + rotation move is the deriver’s (combined speed)', () => {
		const h = newHarness();
		const m = h.registerVideo({ kind: 'image', width: 400, height: 200 });
		const id = h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V2' }, ref: '$s' },
		]).refs.$s!;
		patchClip(h, id, (c) => {
			c.duration = 120;
			const tr = c.transform as Record<string, unknown>;
			tr.position = animOf<[number, number]>(
				[960, 540],
				[kf('p1', 10, [200, 540]), kf('p2', 20, [700, 540])],
			);
			tr.scale = animOf(100, [kf('s1', 10, 100, 'bezier'), kf('s2', 50, 300, 'bezier')]);
			tr.rotation = animOf(0, [kf('r1', 30, 0), kf('r2', 50, 180)]);
		});
		const moves = deriveCues(h.doc, h.seqId, { density: 'rich' }).cues.filter((c) => c.from === 'keyframes');
		expect(moves.some((c) => c.kind === 'move')).toBe(true);
		expect(offenders(h, moves)).toEqual([]);
	});

	it('an overshoot with no key at its extreme lands at the turnaround (deriver and resolver agree)', () => {
		const h = newHarness();
		const m = h.registerVideo({ kind: 'image', width: 400, height: 200 });
		const id = h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V2' }, ref: '$s' },
		]).refs.$s!;
		patchClip(h, id, (c) => {
			c.duration = 120;
			const a = kf<[number, number]>('p1', 10, [200, 540], 'bezier');
			const b = kf<[number, number]>('p2', 40, [960, 540], 'bezier');
			// a fast start that passes the target and comes back (an ease-out overshoot without a key at the extreme)
			a.easeOut = { influence: 0.7, slope: 3.2 };
			b.easeIn = { influence: 0.5, slope: 0 };
			(c.transform as Record<string, unknown>).position = animOf<[number, number]>([960, 540], [a, b]);
		});
		const cues = deriveCues(h.doc, h.seqId, { density: 'rich' }).cues.filter((c) => c.from === 'keyframes');
		const land = cues.find((c) => c.kind === 'land');
		expect(land, JSON.stringify(cues.map((c) => [c.kind, c.frame, c.reason]))).toBeDefined();
		expect(land!.frame).toBeLessThan(40);
		expect(offenders(h, cues)).toEqual([]);
		// the generic rule (no derived event to match) also lands at the turnaround
		const generic = resolveCueAnchor(h.doc, h.seq, {
			...(land!.anchor as CueAnchor & { type: 'keyframe' }),
			keyframeId: undefined,
		} as CueAnchor);
		expect(generic).toBe(land!.frame);
	});
});
