// spec 13 AS-075: the Program preview's Canvas 2D program of a lowered layer (fx/lowered.ts) is the shared layer-space
// taps (`loweredLayerTaps`, the native export's maps) moved into the effect canvas.
import {
	applyTransaction,
	buildRenderSnapshot,
	clipContentTime,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	isLoweredLayer,
	loweredLayerTaps,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { loweredCanvasProgram } from '../src/fx/lowered.ts';

function pixelPopClip(withShake = true): RenderVisualClip {
	const ids = createCounterIdSource(3);
	const base = createEmptyProject({ ids, name: 'L', preset: 'hd-1080p-59.94' });
	const ctx = { ids, now: () => 't', revision: 0, registries: defaultRegistries() };
	const tx = (doc: typeof base, commands: unknown[]) => {
		const r = applyTransaction(doc, { label: 't', origin: 'user', commands: commands as never }, ctx);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		return r;
	};
	const a = tx(base, [
		{
			type: 'clip.addText',
			at: 0,
			duration: 30,
			track: 'V2',
			content: { text: 'HOLA' },
			box: { width: 600, height: 120, autoSize: 'none' },
			ref: '$t',
		},
	]);
	const refsOf = (r: { result: unknown }) => (r.result as { refs: Record<string, string> }).refs;
	const clip = refsOf(a).$t!;
	const b = tx(a.document, [
		{
			type: 'effect.add',
			target: { clipId: clip },
			effectId: 'jasper.transform',
			params: { useCompShutterAngle: false, shutterAngle: 360 },
			ref: '$tf',
		},
		...(withShake
			? [
					{
						type: 'effect.add',
						target: { clipId: clip },
						effectId: 'jasper.s.shake',
						params: { amplitude: 0.6, frequency: 1, wrapX: 'no', wrapY: 'no' },
					},
				]
			: []),
	]);
	const tf = refsOf(b).$tf!;
	const c = tx(b.document, [
		{ type: 'keyframe.add', target: ['effect', tf, 'scaleHeight'], at: { sequenceFrame: 0 }, value: 75 },
		{ type: 'keyframe.add', target: ['effect', tf, 'scaleHeight'], at: { sequenceFrame: 6 }, value: 108 },
		{ type: 'keyframe.add', target: ['effect', tf, 'scaleHeight'], at: { sequenceFrame: 10 }, value: 100 },
	]);
	const seqId = Object.keys(c.document.sequences)[0]!;
	const snap = buildRenderSnapshot(c.document, seqId, { resolveMedia: () => null, resolveFont: () => null });
	return snap.videoTracks.flatMap((t) => t.clips).find((x) => x.clipId === clip)!;
}

const apply = (m: readonly number[], x: number, y: number) => [
	m[0]! * x + m[1]! * y + m[2]!,
	m[3]! * x + m[4]! * y + m[5]!,
];

describe('lowered layers in the preview (spec 13 AS-075)', () => {
	it('moves the shared layer-space taps into the effect canvas (padding, pxScale)', () => {
		const clip = pixelPopClip();
		expect(isLoweredLayer(clip)).toBe(true);
		const fps = 60000 / 1001;
		for (const frame of [2, 15]) {
			const props = resolveLayerProps(clip, clipContentTime(clip, frame, { num: 60000, den: 1001 }));
			const layout = { padding: { left: 30, top: 20 }, pxScale: 0.5, width: 330, height: 80 };
			const p = loweredCanvasProgram({ clip, props, frame, fps, layout })!;
			const lt = loweredLayerTaps({ clip, props, frame, fps });
			expect(p.prog[0]).toBe(lt.taps.length);
			expect(p.prog[1]).toBeCloseTo(lt.wsum, 9);
			// First tap: canvas px (x, y) ↔ layer px (x / 0.5 − 30, y / 0.5 − 20).
			const map = p.prog.slice(3, 9);
			const [cx, cy] = [101, 33];
			const [qx, qy] = [cx / 0.5 - 30, cy / 0.5 - 20];
			const [sx, sy] = apply(lt.taps[0]!.map, qx, qy);
			const [ux, uy] = apply(map, cx, cy);
			expect(ux).toBeCloseTo((sx! + 30) * 0.5, 6);
			expect(uy).toBeCloseTo((sy! + 20) * 0.5, 6);
			// Stage maps go from canvas px to the stage's layer px, their rectangles unchanged.
			const ns = p.prog[13]!;
			expect(ns).toBe(lt.taps[0]!.stages.length);
			const st = p.prog.slice(14, 20);
			const want = apply(lt.taps[0]!.stages[0]!.map, qx, qy);
			const got = apply(st, cx, cy);
			expect(got[0]).toBeCloseTo(want[0]!, 6);
			expect(got[1]).toBeCloseTo(want[1]!, 6);
			expect(p.prog.slice(20, 24)).toEqual(lt.taps[0]!.stages[0]!.rect);
		}
	});

	it('the pop-in blurs (shutter taps), the hold is one tap; layers that are not lowered get none', () => {
		const clip = pixelPopClip(false);
		const fps = 60000 / 1001;
		const at = (frame: number) => {
			const props = resolveLayerProps(clip, clipContentTime(clip, frame, { num: 60000, den: 1001 }));
			return loweredCanvasProgram({
				clip,
				props,
				frame,
				fps,
				layout: { padding: { left: 0, top: 0 }, pxScale: 1, width: 600, height: 120 },
			})!;
		};
		expect(at(3).prog[0]).toBeGreaterThan(3);
		expect(at(20).prog[0]).toBe(1);
		const plain = { ...clip, effects: [] };
		expect(
			loweredCanvasProgram({
				clip: plain,
				props: resolveLayerProps(plain, 0),
				frame: 0,
				fps,
				layout: { padding: { left: 0, top: 0 }, pxScale: 1, width: 600, height: 120 },
			}),
		).toBeNull();
	});
});
