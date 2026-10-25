import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type MediaHandle,
	resolveVideoTransitions,
	sideCompToCanvas,
	type Transition,
	transitionLinearProgress,
	transitionProgress,
	transitionSpec,
	validateGpuTransition,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const HANDLE: MediaHandle = {
	url: '/m',
	proxyUrl: null,
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: null,
	hasAudio: false,
	rotation: 0,
};

function twoClips() {
	const h = new Harness();
	const a = h.registerVideo({ audio: false });
	const b = h.registerVideo({ audio: false });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
			ref: '$a',
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 100,
			sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
			ref: '$b',
		},
	]);
	return { h, a: r.refs.$a!, b: r.refs.$b! };
}
const fails = (h: Harness, commands: unknown[]) => {
	const r = h.tx(commands);
	if (r.ok) throw new Error('expected the transaction to fail');
	return r;
};
const only = (h: Harness) => Object.values(h.seq.transitions)[0] as Transition;

describe('transition catalogue', () => {
	it('flags structural mistakes', () => {
		const bad = {
			...transitionSpec('jasper.iris-round')!,
			id: 'test.bad',
			gpu: { passes: [{ output: 'from', frag: 'void main() { gl_FragColor = vec4(1.0); }' }, { frag: 'x' }] },
		};
		const problems = validateGpuTransition(bad);
		expect(problems.join('\n')).toMatch(/gl_FragColor/);
		expect(problems.join('\n')).toMatch(/output "from" is reserved/);
		expect(problems.join('\n')).toMatch(/pass 1: no void main/);
	});
});

describe('transition progress', () => {
	it('matches the cross dissolve ramp two-sided and reaches 0 / 1 at a fade edge', () => {
		expect(transitionLinearProgress(0, 3, 'both')).toBeCloseTo(0.25);
		expect(transitionLinearProgress(2, 3, 'both')).toBeCloseTo(0.75);
		expect(transitionLinearProgress(0, 4, 'in')).toBe(0);
		expect(transitionLinearProgress(3, 4, 'out')).toBe(1);
	});

	it('applies Start / End and Reverse (sides swapped, 1 − p)', () => {
		const gpu = transitionSpec('jasper.iris-round')!.gpu;
		expect(transitionProgress(gpu, { startPercent: 20, endPercent: 60 }, 0.5).progress).toBeCloseTo(0.4);
		const r = transitionProgress(gpu, { reverse: true }, 0.25);
		expect(r).toEqual({ progress: 0.75, swapped: true, reversed: true });
		expect(transitionProgress({ reverse: 'custom' }, { reverse: true }, 0.25)).toEqual({
			progress: 0.25,
			swapped: false,
			reversed: true,
		});
	});
});

describe('transition planning', () => {
	it('maps sequence px to the side picture through the layer map and the padded canvas', () => {
		// A layer scaled ×0.5 and moved to (100, 50); its fx canvas has 10 px padding at pxScale 2.
		const m = sideCompToCanvas([0.5, 0, 100, 0, 0.5, 50, 0, 0, 1], {
			padding: { left: 10, top: 10 },
			pxScale: 2,
		})!;
		const at = (x: number, y: number) => [m[0]! * x + m[1]! * y + m[2]!, m[3]! * x + m[4]! * y + m[5]!];
		expect(at(100, 50)).toEqual([20, 20]); // the layer origin = canvas px (10 + 0) × 2
		expect(at(150, 75)).toEqual([220, 120]); // layer px (100, 50)
		expect(
			sideCompToCanvas([0, 0, 0, 0, 0, 0, 0, 0, 1], { padding: { left: 0, top: 0 }, pxScale: 1 }),
		).toBeNull();
	});
});

describe('GPU transitions in the document and the render snapshot', () => {
	it('two-sided: both clips get the handles of the span, no ramps; a stage on the track', () => {
		const { h, a, b } = twoClips();
		h.ok([{ type: 'transition.add', trackId: 'V1', at: 100, effectId: 'jasper.push', duration: 20 }]);
		const r = resolveVideoTransitions(h.doc, h.seq);
		expect(r.clips.get(a)).toEqual({ headHandle: 0, tailHandle: 10, fades: [] });
		expect(r.clips.get(b)).toEqual({ headHandle: 10, tailHandle: 0, fades: [] });
		const trackId = h.seq.videoTracks[0]!.id;
		expect(r.stages.get(trackId)).toMatchObject([
			{
				effectId: 'jasper.push',
				start: 90,
				duration: 20,
				sides: 'both',
				outgoingClipId: a,
				incomingClipId: b,
			},
		]);
		expect(r.stages.get(trackId)![0]!.params.direction).toEqual({ value: 'westToEast', keyframes: [] });
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => HANDLE, resolveFont: () => null });
		expect(snap.videoTracks[0]!.transitions).toHaveLength(1);
		expect(snap.videoTracks[0]!.mattes).toBeUndefined();
	});

	it('one-sided: a stage inside the clip, no handles', () => {
		const { h, b } = twoClips();
		h.ok([{ type: 'transition.add', clipId: b, edge: 'out', effectId: 'jasper.iris-round', duration: 15 }]);
		const r = resolveVideoTransitions(h.doc, h.seq);
		expect(r.clips.get(b)).toBeUndefined();
		expect([...r.stages.values()][0]).toMatchObject([
			{ start: 185, duration: 15, sides: 'out', outgoingClipId: b, incomingClipId: null },
		]);
	});

	it('transition.add / update take validated params; unknown names fail with the list', () => {
		const { h } = twoClips();
		const w = h.ok([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 100,
				effectId: 'jasper.iris-round',
				duration: 20,
				params: { borderWidth: 6, center: [0.25, 0.5] },
			},
		]);
		expect(w.warnings).toEqual([]);
		const t = only(h);
		expect(t.params.borderWidth).toEqual({ value: 6, keyframes: [] });
		h.ok([
			{ type: 'transition.update', transitionId: t.id, params: { antiAliasing: 'high', startPercent: 150 } },
		]);
		expect(only(h).params.antiAliasing!.value).toBe('high');
		expect(only(h).params.startPercent!.value).toBe(100);
		const bad = fails(h, [{ type: 'transition.update', transitionId: t.id, params: { radius: 3 } }]);
		expect(bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(bad.errors[0]!.message).toContain('radius');
		expect(bad.errors[0]!.message).toContain('borderWidth');
		const builtin = fails(h, [
			{ type: 'transition.update', transitionId: t.id, effectId: 'jasper.cross-dissolve', params: { x: 1 } },
		]);
		expect(builtin.errors[0]!.code).toBe('E_INVALID_PARAM');
	});

	it('param.set / keyframe.add on ["transition", id, name]: keys in flicks from the span start', () => {
		const { h } = twoClips();
		h.ok([{ type: 'transition.add', trackId: 'V1', at: 100, effectId: 'jasper.iris-round', duration: 20 }]);
		const t = only(h);
		h.ok([{ type: 'param.set', target: ['transition', t.id, 'borderWidth'], value: 4 }]);
		expect(only(h).params.borderWidth!.value).toBe(4);
		h.ok([
			{
				type: 'keyframe.add',
				target: ['transition', t.id, 'borderWidth'],
				at: { sequenceFrame: 90 },
				value: 0,
			},
			{
				type: 'keyframe.add',
				target: ['transition', t.id, 'borderWidth'],
				at: { sequenceFrame: 99 },
				value: 20,
			},
		]);
		const k = only(h).params.borderWidth!.keyframes;
		const F = 705600000 / 30;
		expect(k.map((x) => x.time)).toEqual([0, 9 * F]);
		h.ok([{ type: 'keyframe.remove', keyframeIds: [k[1]!.id] }]);
		expect(only(h).params.borderWidth!.keyframes).toHaveLength(1);
	});
});
