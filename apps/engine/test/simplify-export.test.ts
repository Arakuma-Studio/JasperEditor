// Export after "Simplify keyframes" (S09:TRK-023, TRK-032): the per-frame layer maps of the render snapshot (what
// the native export's warp stage renders) of a tracked corner pin and of tracked Motion move by at most the
// tolerance in sequence pixels after keyframes.simplify, and the warped pixels follow (a gradient texture differs
// by at most gradient × shift).
import {
	applyMat3,
	applyTransaction,
	buildRenderSnapshot,
	clipContentTime,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	invertMat3,
	layerMapOf,
	type Mat3,
	multiplyMat3,
	type ProjectDocument,
	type Quad,
	resolveLayerProps,
	type SimplifyReport,
	type Vec2,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { destRect, warpFrame } from '../src/export/warp/kernel.ts';

const N = 90;
const F = FLICKS_PER_SECOND / 30;

function run(doc: ProjectDocument, seqId: string, commands: unknown[], ids = createCounterIdSource(9)) {
	const { document, result } = applyTransaction(
		doc,
		{ label: 't', origin: 'user', sequenceId: seqId, commands: commands as never },
		{ ids, now: () => '2026-10-01T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return { document, result };
}

/** A solid (sequence-sized box) driven by a dense noisy track: corner pin or Motion (position/scale/rotation). */
function trackedDoc(mode: 'pin' | 'motion') {
	const ids = createCounterIdSource(5);
	const d = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const seqId = Object.keys(d.sequences)[0]!;
	let seed = 42;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648 - 0.5;
	};
	const cmds: unknown[] = [
		{ type: 'clip.addSolid', at: 0, duration: N, track: 'V1', color: [0.2, 0.6, 1, 1], ref: '$s' },
	];
	if (mode === 'pin') {
		cmds.push({ type: 'effect.add', target: { clipId: '$s' }, effectId: 'jasper.corner-pin', ref: '$pin' });
		const base: Quad = [
			[0.3, 0.25],
			[0.72, 0.28],
			[0.7, 0.74],
			[0.32, 0.7],
		];
		const names = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
		for (let f = 0; f < N; f++) {
			const dx = 0.0015 * f + 0.02 * Math.sin(f / 15);
			const dy = 0.01 * Math.sin(f / 11);
			base.forEach(([x, y], k) => {
				cmds.push({
					type: 'keyframe.add',
					target: ['effect', '$pin', names[k]],
					at: { sequenceFrame: f },
					value: [x + dx + (k === 1 ? 0.0004 * f : 0) + rnd() * 0.00005, y + dy + rnd() * 0.00005],
				});
			});
		}
	} else {
		for (let f = 0; f < N; f++) {
			const tgt = (k: string) => ['clip', '$s', 'transform', k];
			cmds.push(
				{
					type: 'keyframe.add',
					target: tgt('position'),
					at: { sequenceFrame: f },
					value: [960 + 4 * f + rnd() * 0.05, 540 + 40 * Math.sin(f / 12)],
				},
				{ type: 'keyframe.add', target: tgt('scale'), at: { sequenceFrame: f }, value: 50 * (1 + 0.002 * f) },
				{
					type: 'keyframe.add',
					target: tgt('rotation'),
					at: { sequenceFrame: f },
					value: 3 * Math.sin(f / 20),
				},
			);
		}
	}
	const { document, result } = run(d, seqId, cmds, ids);
	return { doc: document, seqId, clipId: result.refs.$s! };
}

/**
 * Per-frame layer maps (source px → sequence px) of the sequence-sized solid on V1, and the warp inputs of each
 * frame (inverse map, opacity, destination rect), from the render snapshot the native export renders.
 */
function mapsOf(doc: ProjectDocument, seqId: string) {
	const snap = buildRenderSnapshot(doc, seqId, { resolveMedia: () => null, resolveFont: () => null });
	const c = snap.videoTracks[0]!.clips[0]!;
	const toLayer: Mat3 = [c.intrinsicBox.width / 1920, 0, 0, 0, c.intrinsicBox.height / 1080, 0, 0, 0, 1];
	const maps: Mat3[] = [];
	const specs: { inv: Mat3 | null; opacity: number; rect: ArrayLike<number> | null }[] = [];
	for (let f = 0; f < N; f++) {
		const props = resolveLayerProps(c, clipContentTime(c, f, snap.settings.fps));
		const fwd = multiplyMat3(layerMapOf(props), toLayer);
		const inv = invertMat3(fwd);
		maps.push(fwd);
		specs.push({
			inv,
			opacity: props.opacity / 100,
			rect: inv ? destRect(fwd, 1920, 1080, 1920, 1080) : null,
		});
	}
	return { maps, specs };
}

/** Largest distance between two forward maps over a 17×17 grid of the source frame. */
function mapShift(a: Mat3, b: Mat3): number {
	let m = 0;
	for (let i = 0; i <= 16; i++)
		for (let j = 0; j <= 16; j++) {
			const p: Vec2 = [(1920 * i) / 16, (1080 * j) / 16];
			const qa = applyMat3(a, p);
			const qb = applyMat3(b, p);
			m = Math.max(m, Math.hypot(qa[0] - qb[0], qa[1] - qb[1]));
		}
	return m;
}

describe('native export after keyframes.simplify (S09:TRK-023)', () => {
	for (const mode of ['pin', 'motion'] as const) {
		for (const tol of [0.1, 0.5]) {
			it(`${mode}: warp maps move ≤ ${tol} px and the warped pixels follow`, () => {
				const { doc, seqId, clipId } = trackedDoc(mode);
				const before = mapsOf(doc, seqId);
				const { document, result } = run(doc, seqId, [
					{ type: 'keyframes.simplify', clipIds: [clipId], tolerance: tol },
				]);
				const report = result.results[0] as SimplifyReport;
				expect(report.after).toBeLessThan(report.before);
				const after = mapsOf(document, seqId);
				let worst = 0;
				for (let f = 0; f < N; f++) worst = Math.max(worst, mapShift(before.maps[f]!, after.maps[f]!));
				expect(worst).toBeLessThanOrEqual(tol * 1.02); // 17×17 grid: within the 9×9-verified bound (pins)
				if (mode === 'motion') expect(worst).toBeLessThanOrEqual(tol + 1e-6);
				// Pixels: warp a gradient texture (0.1 levels/px horizontally) on the frame with the largest shift.
				let fw = 0;
				let ws = -1;
				for (let f = 0; f < N; f++) {
					const s = mapShift(before.maps[f]!, after.maps[f]!);
					if (s > ws) [ws, fw] = [s, f];
				}
				const sw = 1920;
				const sh = 1080;
				const src = new Uint8Array(sw * sh * 4);
				for (let y = 0; y < sh; y++)
					for (let x = 0; x < sw; x++) {
						const o = (y * sw + x) * 4;
						src[o] = Math.round(x * 0.1);
						src[o + 1] = Math.round(y * 0.1);
						src[o + 2] = 128;
						src[o + 3] = 255;
					}
				const out = (spec: (typeof before.specs)[number]) => {
					const dst = new Uint8Array(1920 * 1080 * 4);
					warpFrame(src, sw, sh, dst, 1920, 1080, 'rgba', spec.inv, spec.opacity, spec.rect);
					return dst;
				};
				const a = out(before.specs[fw]!);
				const b = out(after.specs[fw]!);
				// Inside the layer (alpha 255 in both), colour differs by ≤ gradient × source shift (+ rounding).
				let maxDiff = 0;
				for (let i = 0; i < a.length; i += 4) {
					if (a[i + 3] !== 255 || b[i + 3] !== 255) continue;
					maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!));
				}
				// Source px per sequence px ≤ 1/0.4 here (the pin / scale make the layer ≥ 40 % of the box).
				expect(maxDiff).toBeLessThanOrEqual(Math.ceil(0.1 * tol * 2.5 + 1));
			});
		}
	}

	it('keeps the per-frame key time grid of tracking (content time = sequence frame here)', () => {
		const { doc, seqId, clipId } = trackedDoc('motion');
		const { document } = run(doc, seqId, [{ type: 'keyframes.simplify', clipIds: [clipId], tolerance: 0.1 }]);
		const clip = document.sequences[seqId]!.clips[clipId] as unknown as {
			transform: { position: { keyframes: { time: number }[] } };
		};
		for (const k of clip.transform.position.keyframes) expect(k.time % F).toBe(0);
	});
});
