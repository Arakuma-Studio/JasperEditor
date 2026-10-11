import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyMat3,
	buildRenderSnapshot,
	type Clip,
	flicksPerFrame,
	type Quad,
	resolveSceneAt,
	type SimplifyReport,
	type TrackerSamples,
	type Vec2,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const F = flicksPerFrame({ num: 30, den: 1 });

type Kf = { id: string; time: number; value: unknown; interpolation: string };
type Anim = { value: unknown; keyframes: Kf[] };

/** Plate (1920×1080 video, V1) and a 1280×720 replacement (V2) with its own Motion (scale 150 %, rotation 4°). */
function setup(frames: number) {
	const h = new Harness();
	const plateMedia = h.registerVideo({ seconds: Math.ceil(frames / 30) + 1, audio: false });
	const overMedia = (
		h.ok([
			{
				type: 'media.register',
				asset: videoAsset({ seconds: Math.ceil(frames / 30) + 1, width: 1280, height: 720, audio: false }),
			},
		]).results[0] as { mediaId: string }
	).mediaId;
	const range = { in: { flicks: 0 }, out: { flicks: frames * F } };
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: plateMedia },
			at: 0,
			sourceRange: range,
			tracks: { video: 'V1' },
		},
	]);
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: overMedia },
			at: 0,
			sourceRange: range,
			tracks: { video: 'V2' },
		},
	]);
	const plate = h.clips('V1')[0]!.id;
	const target = h.clips('V2')[0]!.id;
	h.ok([
		{ type: 'param.set', target: ['clip', target, 'transform', 'scale'], value: 150 },
		{ type: 'param.set', target: ['clip', target, 'transform', 'rotation'], value: 4 },
	]);
	return { h, plate, target };
}

/** Drawn quads of a clip at every frame (sequence px) and, when pinned, a 9×9 grid through the projective map. */
function drawn(h: Harness, clipId: string, frames: number, n = 8) {
	const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
	const out: { quad: Quad; grid: Vec2[] }[] = [];
	for (let f = 0; f < frames; f++) {
		const layer = resolveSceneAt(snap, f).find((l) => l.clip.clipId === clipId)!;
		const p = layer.props;
		const grid: Vec2[] = [];
		for (let i = 0; i <= n; i++)
			for (let j = 0; j <= n; j++) {
				const q: Vec2 = [(p.box.width * i) / n, (p.box.height * j) / n];
				grid.push(
					p.projective
						? applyMat3(p.projective, q)
						: [
								p.matrix.a * q[0] + p.matrix.c * q[1] + p.matrix.e,
								p.matrix.b * q[0] + p.matrix.d * q[1] + p.matrix.f,
							],
				);
			}
		out.push({ quad: p.quad, grid });
	}
	return out;
}

function maxShift(a: Vec2[] | Quad, b: Vec2[] | Quad): number {
	let m = 0;
	for (let i = 0; i < a.length; i++) m = Math.max(m, Math.hypot(a[i]![0] - b[i]![0], a[i]![1] - b[i]![1]));
	return m;
}

function bakeCornerPin(h: Harness, plate: string, target: string, quads: Quad[]) {
	const data: number[] = [];
	for (const q of quads) for (const p of q) data.push(p[0], p[1]);
	const samples: TrackerSamples = { start: 0, step: F, stride: 8, data, confidence: quads.map(() => 1) };
	const r = h.ok([
		{ type: 'tracker.add', clipId: plate, kind: 'planar', at: { frames: 0 }, corners: quads[0], ref: '$t' },
		{ type: 'tracker.setSamples', trackerId: '$t', samples, method: 'klt-homography@1' },
		{ type: 'tracker.apply', trackerId: '$t', targetClipId: target, mode: 'corner-pin' },
	]);
	return (r.results[0] as { trackerId: string }).trackerId;
}

function bakeMotion(
	h: Harness,
	target: string,
	keys: { x: number; y: number; scale?: number; rotation?: number }[],
) {
	const cmds: unknown[] = [];
	const path = (k: string) => ['clip', target, 'transform', k];
	const props = [
		'position',
		...(keys.some((k) => k.scale !== undefined) ? ['scale'] : []),
		...(keys.some((k) => k.rotation !== undefined) ? ['rotation'] : []),
	];
	for (const p of props)
		cmds.push({ type: 'param.setAnimated', target: path(p), animated: true, at: { frames: 0 } });
	keys.forEach((k, f) => {
		cmds.push({ type: 'keyframe.add', target: path('position'), at: { frames: f }, value: [k.x, k.y] });
		if (props.includes('scale'))
			cmds.push({
				type: 'keyframe.add',
				target: path('scale'),
				at: { frames: f },
				value: (k.scale ?? 1) * 150,
			});
		if (props.includes('rotation'))
			cmds.push({
				type: 'keyframe.add',
				target: path('rotation'),
				at: { frames: f },
				value: k.rotation ?? 0,
			});
	});
	h.ok(cmds);
}

function simplify(h: Harness, cmd: Record<string, unknown>): SimplifyReport {
	const r = h.ok([{ type: 'keyframes.simplify', ...cmd }]);
	return r.results[0] as SimplifyReport;
}

describe('keyframes.simplify (document)', () => {
	it('property: random dense corner-pin and Motion tracks stay within the tolerance at every frame', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 5, max: 70 }),
				fc.double({ min: 0.05, max: 3, noNaN: true }),
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.boolean(),
				(n, tol, seed, pin) => {
					let r = seed;
					const rnd = () => {
						r = (r * 1103515245 + 12345) % 2147483648;
						return r / 2147483648 - 0.5;
					};
					const { h, plate, target } = setup(n);
					if (pin) {
						const base: Quad = [
							[600, 300],
							[1300, 330],
							[1280, 760],
							[620, 720],
						];
						const v = [rnd() * 6, rnd() * 6];
						const quads: Quad[] = [];
						for (let i = 0; i < n; i++) {
							v[0]! += rnd();
							v[1]! += rnd();
							quads.push(
								base.map(([x, y], k) => [
									x + v[0]! * i + rnd() * 0.6 + k * rnd() * 0.2,
									y + v[1]! * i + rnd() * 0.6,
								]) as Quad,
							);
						}
						bakeCornerPin(h, plate, target, quads);
					} else {
						const keys = [];
						let x = 900;
						let y = 500;
						let s = 1;
						let a = 0;
						for (let i = 0; i < n; i++) {
							x += 3 + rnd() * 2;
							y += rnd() * 4;
							s *= 1 + rnd() * 0.01;
							a += rnd() * 0.5;
							keys.push({ x, y, scale: s, rotation: a });
						}
						bakeMotion(h, target, keys);
					}
					const before = drawn(h, target, n);
					const report = simplify(h, { clipIds: [target], tolerance: tol });
					const after = drawn(h, target, n);
					for (let f = 0; f < n; f++) {
						expect(maxShift(after[f]!.quad, before[f]!.quad)).toBeLessThanOrEqual(tol + 1e-9);
						expect(maxShift(after[f]!.grid, before[f]!.grid)).toBeLessThanOrEqual(tol + 1e-9);
					}
					expect(report.maxError).toBeLessThanOrEqual(tol);
				},
			),
			{ numRuns: 40 },
		);
	});

	it('simplifies only the selected keys, as one undoable transaction, and previews with a dry run', () => {
		const n = 60;
		const { h, target } = setup(n);
		bakeMotion(
			h,
			target,
			Array.from({ length: n }, (_, i) => ({ x: 900 + 4 * i, y: 500 + 30 * Math.sin(i / 10) })),
		);
		const pos = () =>
			(h.seq.clips[target] as unknown as { transform: { position: Anim } }).transform.position;
		const ids = pos().keyframes.map((k) => k.id);
		const dry = h.tx(
			[{ type: 'keyframes.simplify', keyframeIds: ids.slice(10, 40), tolerance: 0.2, details: true }],
			{
				dryRun: true,
			},
		);
		expect(dry.ok).toBe(true);
		const rep = (dry as { results: SimplifyReport[] }).results[0]!;
		expect(rep.after).toBeLessThan(rep.before);
		expect(rep.groups[0]!.errors!.length).toBe(rep.groups[0]!.samples);
		expect(rep.groups[0]!.unit).toBe('px');
		expect(pos().keyframes.length).toBe(n);
		// Real run over keys 10…39: keys outside stay, the span ends stay.
		const before = drawn(h, target, n);
		const docBefore = h.doc;
		const report = simplify(h, { keyframeIds: ids.slice(10, 40), tolerance: 0.2 });
		const kept = pos().keyframes.map((k) => k.id);
		expect(kept.slice(0, 11)).toEqual(ids.slice(0, 11));
		expect(kept.slice(-20)).toEqual(ids.slice(40 - 20 + 20));
		expect(kept.length).toBe(n - report.removed);
		const after = drawn(h, target, n);
		for (let f = 0; f < n; f++) expect(maxShift(after[f]!.quad, before[f]!.quad)).toBeLessThanOrEqual(0.2);
		expect(
			(docBefore.sequences[h.seqId]!.clips[target] as unknown as { transform: { position: Anim } }).transform
				.position.keyframes.length,
		).toBe(n);
	});

	it('simplifies opacity within the requested tolerance in percentage units', () => {
		const { h, target } = setup(40);
		const cmds: unknown[] = [
			{ type: 'param.setAnimated', target: ['clip', target, 'opacity'], animated: true, at: { frames: 0 } },
		];
		for (let f = 0; f < 40; f++)
			cmds.push({
				type: 'keyframe.add',
				target: ['clip', target, 'opacity'],
				at: { frames: f },
				value: 50 + 40 * Math.sin(f / 8),
			});
		h.ok(cmds);
		const report = simplify(h, { targets: [['clip', target, 'opacity']], tolerance: 0.5 });
		expect(report.groups[0]!.kind).toBe('value');
		expect(report.groups[0]!.unit).toBe('%');
		expect(report.after).toBeLessThan(report.before);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		for (let frame = 0; frame < 40; frame++) {
			const opacity = resolveSceneAt(snap, frame).find((layer) => layer.clip.clipId === target)!.props
				.opacity;
			expect(Math.abs(opacity - (50 + 40 * Math.sin(frame / 8)))).toBeLessThanOrEqual(0.5);
		}
		expect(report.maxError).toBeLessThanOrEqual(0.5);
	});

	it('tracker.apply {simplify} bakes and simplifies in one transaction; trackedOnly targets the tracked params', () => {
		const n = 45;
		const { h, plate, target } = setup(n);
		const quads: Quad[] = Array.from({ length: n }, (_, i) => [
			[600 + 5 * i, 300 + Math.sin(i / 6) * 20],
			[1300 + 5 * i, 330 + Math.sin(i / 6) * 20],
			[1280 + 5 * i, 760 + Math.sin(i / 6) * 20],
			[620 + 5 * i, 720 + Math.sin(i / 6) * 20],
		]);
		const id = bakeCornerPin(h, plate, target, quads);
		const ref = drawn(h, target, n);
		const r = h.ok([
			{
				type: 'tracker.apply',
				trackerId: id,
				targetClipId: target,
				mode: 'corner-pin',
				simplify: { tolerance: 0.25 },
			},
		]);
		const res = r.results[0] as { simplified: { before: number; after: number; maxError: number } };
		expect(res.simplified.after).toBeLessThan(res.simplified.before);
		expect(res.simplified.maxError).toBeLessThanOrEqual(0.25);
		const now = drawn(h, target, n);
		for (let f = 0; f < n; f++) expect(maxShift(now[f]!.quad, ref[f]!.quad)).toBeLessThanOrEqual(0.25);
		h.ok([
			{ type: 'param.setAnimated', target: ['clip', target, 'opacity'], animated: true, at: { frames: 0 } },
			...Array.from({ length: 10 }, (_, f) => ({
				type: 'keyframe.add',
				target: ['clip', target, 'opacity'],
				at: { frames: f },
				value: 100 - f,
			})),
		]);
		const rep = simplify(h, { clipIds: [target], trackedOnly: true, tolerance: 1 });
		expect(rep.properties.every((p) => p.path[0] === 'effect')).toBe(true);
		expect((h.seq.clips[target] as unknown as { opacity: Anim }).opacity.keyframes.length).toBe(10);
	});

	it('refuses ambiguous selections and locked tracks', () => {
		const { h, target } = setup(10);
		bakeMotion(
			h,
			target,
			Array.from({ length: 10 }, (_, i) => ({ x: i, y: i })),
		);
		const before = h.doc;
		const bad = h.tx([
			{ type: 'keyframes.simplify', clipIds: [target], targets: [['clip', target, 'opacity']], tolerance: 1 },
		]);
		expect(bad.ok ? null : bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(h.doc).toBe(before);
		const v2 = (h.seq.clips[target] as Clip).trackId;
		h.ok([{ type: 'track.update', trackId: v2, patch: { locked: true } }]);
		const lockedBefore = h.doc;
		const locked = h.tx([{ type: 'keyframes.simplify', clipIds: [target], tolerance: 1 }]);
		expect(locked.ok ? null : locked.errors[0]!.code).toBe('E_TRACK_LOCKED');
		expect(h.doc).toBe(lockedBefore);
	});
});
