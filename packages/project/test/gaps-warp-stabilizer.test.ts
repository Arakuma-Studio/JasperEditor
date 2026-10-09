// Warp Stabilizer (gaps FX-6): the stabilisation maths (ported tests of effectcraft stabilize.rs / subspace.rs), the
// stored analysis, the command and the invariant.
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	corrections,
	defaultEffectRegistry,
	DEFAULT_STAB_SETTINGS,
	hApply,
	hInv,
	hMaxDiff,
	hTranslation,
	leastSquares,
	planOutputOf,
	planSourceOf,
	repairDocument,
	smoothTrajectories,
	solveMesh,
	stabPlan,
	type StabSettings,
	type WarpAnalysis,
	type WarpAnalysisData,
	WarpMesh,
	warpFrameAt,
	warpPlanFor,
	warpSettingsOf,
	mediaTimeAtClipFrame,
} from '../src/index.ts';
import { warpSynthesisOffsets } from '../src/registry/fx/warp-stabilizer.ts';
import { Harness } from './helpers.ts';

/** A slow pan plus per-frame jitter (translation only). */
function shaky(n: number): { a: WarpAnalysis; path: [number, number][] } {
	const pos = (k: number): [number, number] => {
		const j = [((k * 7919) % 13) - 6, ((k * 104729) % 11) - 5];
		return [2 * k + j[0]!, 0.5 * k + j[1]!];
	};
	const path = Array.from({ length: n }, (_, k) => pos(k));
	const frames = path.map((_, k) => {
		if (!k) return { t: [0, 0] as const, s: [1, 0, 0, 0] as const, h: [1, 0, 0, 0, 1, 0, 0, 0] };
		const d = [path[k - 1]![0] - path[k]![0], path[k - 1]![1] - path[k]![1]] as const;
		return { t: d, s: [1, 0, d[0], d[1]] as const, h: [1, 0, d[0], 0, 1, d[1], 0, 0] };
	});
	return { a: { size: [640, 360], frames, tracks: [] }, path };
}

function jitter(p: [number, number][]): number {
	let s = 0;
	for (let k = 1; k < p.length - 1; k++)
		s += Math.hypot(p[k + 1]![0] - 2 * p[k]![0] + p[k - 1]![0], p[k + 1]![1] - 2 * p[k]![1] + p[k - 1]![1]);
	return s / (p.length - 2);
}

const fxList = (c: unknown) => (c as { effects: { id: string; effectId: string }[] }).effects;
const S = (o: Partial<StabSettings>): StabSettings => ({ ...DEFAULT_STAB_SETTINGS, ...o });

describe('warp stabilizer maths', () => {
	it('least squares recovers a homography and a similarity', () => {
		const h = [1.02, 0.03, 5, -0.01, 0.98, -3, 0.0001, -0.0002, 1];
		const src: [number, number][] = [];
		for (let i = 0; i < 20; i++) src.push([(i * 37) % 300, (i * 53) % 200]);
		const dst = src.map((p) => hApply(h, p));
		expect(hMaxDiff(leastSquares('homography', src, dst)!, h)).toBeLessThan(1e-6);
		const sim = [0.9, -0.2, 4, 0.2, 0.9, 7, 0, 0, 1];
		expect(hMaxDiff(leastSquares('similarity', src, src.map((p) => hApply(sim, p)))!, sim)).toBeLessThan(1e-9);
	});

	it('Smooth Motion removes jitter for every method; No Motion locks the scene', () => {
		const { a, path } = shaky(90);
		const scene = (k: number): [number, number] => [320 - path[k]![0] + path[0]![0], 180 - path[k]![1] + path[0]![1]];
		const before = Array.from({ length: 90 }, (_, k) => scene(k));
		for (const method of ['position', 'positionScaleRotation', 'perspective'] as const) {
			const p = stabPlan(a, S({ method, framing: 'stabilizeOnly' }));
			const after = before.map((q, k) => hApply(p.warps[k]!, q));
			expect(jitter(after)).toBeLessThan(0.2 * jitter(before));
		}
		const p = stabPlan(a, S({ result: 'noMotion', framing: 'stabilizeOnly' }));
		const fixed = before.map((q, k) => hApply(p.warps[k]!, q));
		for (const q of fixed) {
			expect(Math.abs(q[0] - fixed[45]![0])).toBeLessThan(1e-6);
			expect(Math.abs(q[1] - fixed[45]![1])).toBeLessThan(1e-6);
		}
	});

	it('framing crops, auto-scales and respects Maximum Scale', () => {
		const { a } = shaky(60);
		const crop = stabPlan(a, S({ framing: 'stabilizeCrop', method: 'perspective' }));
		expect(crop.autoScale).toBe(1);
		const r = crop.crop!;
		expect(r[0]).toBeGreaterThan(0);
		expect(r[2]).toBeLessThan(640);
		for (const w of crop.warps) {
			const inv = hInv(w)!;
			for (const q of [
				[r[0], r[1]],
				[r[2], r[1]],
				[r[2], r[3]],
				[r[0], r[3]],
			] as [number, number][]) {
				const s = hApply(inv, q);
				expect(s[0]).toBeGreaterThanOrEqual(-1e-6);
				expect(s[1]).toBeGreaterThanOrEqual(-1e-6);
				expect(s[0]).toBeLessThanOrEqual(640 + 1e-6);
				expect(s[1]).toBeLessThanOrEqual(360 + 1e-6);
			}
		}
		const auto = stabPlan(a, S({ method: 'perspective' }));
		expect(auto.autoScale).toBeGreaterThan(1);
		expect(auto.crop).toBeNull();
		for (const w of auto.warps) {
			const inv = hInv(w)!;
			for (const q of [
				[0, 0],
				[640, 0],
				[640, 360],
				[0, 360],
			] as [number, number][]) {
				const s = hApply(inv, q);
				expect(s[0]).toBeGreaterThanOrEqual(-1e-3);
				expect(s[0]).toBeLessThanOrEqual(640.001);
			}
		}
		const tight = stabPlan(a, S({ method: 'perspective', maxScale: 101 }));
		expect(tight.autoScale).toBeLessThanOrEqual(1.01 + 1e-9);
		expect(tight.validFraction * tight.autoScale >= 0.999 || tight.crop !== null).toBe(true);
		expect(tight.relaxedFrames).toBeGreaterThan(0);
	});

	it('Preserve Scale removes the zoom of the correction', () => {
		const n = 40;
		const frames = Array.from({ length: n }, (_, k) => {
			const z = k ? (k % 2 ? 1.03 : 1 / 1.03) : 1;
			const c = [320, 180];
			return {
				t: [0, 0] as const,
				s: [z, 0, c[0]! * (1 - z), c[1]! * (1 - z)] as const,
				h: [z, 0, c[0]! * (1 - z), 0, z, c[1]! * (1 - z), 0, 0],
			};
		});
		const a: WarpAnalysis = { size: [640, 360], frames, tracks: [] };
		const scaleOf = (h: readonly number[]) => Math.sqrt(Math.abs(h[0]! * h[4]! - h[1]! * h[3]!));
		const zoomy = corrections(a, S({ method: 'positionScaleRotation' }));
		expect(Math.max(...zoomy.map((h) => Math.abs(scaleOf(h) - 1)))).toBeGreaterThan(0.005);
		const kept = corrections(a, S({ method: 'positionScaleRotation', preserveScale: true }));
		for (const h of kept) expect(Math.abs(scaleOf(h) - 1)).toBeLessThan(1e-6);
	});

	it('meshes: identity, homography meshes are exact for affine maps, forward inverts sample', () => {
		const m = WarpMesh.identity(4, 3, [100, 60]);
		expect(m.sample([37, 21])).toEqual([37, 21]);
		expect(m.validFraction()).toBe(1);
		const h = [1, 0.02, 5, -0.01, 1, -3, 0, 0, 1];
		const mh = WarpMesh.fromHomography(4, 3, [100, 60], h);
		const p = mh.forward([40, 30])!;
		const e = hApply(h, [40, 30]);
		expect(Math.abs(p[0] - e[0])).toBeLessThan(1e-6);
		expect(hMaxDiff(mh.homography(), h)).toBeLessThan(1e-6);
		expect(mh.validFraction()).toBeLessThan(1);
	});

	it('solveMesh bends for local motion (banded solve)', () => {
		const pairs: [[number, number], [number, number]][] = [];
		for (let y = 0; y < 12; y++)
			for (let x = 0; x < 20; x++) {
				const p: [number, number] = [5 + x * 10, 5 + y * 10];
				const bump = Math.exp(-((p[0] - 100) ** 2 + (p[1] - 60) ** 2) / (2 * 20 ** 2));
				pairs.push([p, [p[0] + 3 + 5 * bump, p[1] - 2]]);
			}
		const base = hTranslation([3, -2]);
		const m = solveMesh([200, 120], { cols: 10, rows: 6, alpha: 0.5, prior: 0.01 }, pairs, base);
		let errMesh = 0;
		let errH = 0;
		const binv = hInv(base)!;
		for (const [s, d] of pairs) {
			const q = m.sample(d);
			errMesh += Math.hypot(q[0] - s[0], q[1] - s[1]);
			const qh = hApply(binv, d);
			errH += Math.hypot(qh[0] - s[0], qh[1] - s[1]);
		}
		expect(errMesh).toBeLessThan(0.35 * errH);
	});

	it('Subspace Warp beats Perspective on parallax trajectories', () => {
		// A scene with depth: a near bump moves (1 + depth) times as much as the background.
		const n = 48;
		const hash = (i: number, j: number, k: number) => {
			let v = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) >>> 0;
			v ^= v >>> 13;
			v = Math.imul(v, 0x5bd1e995) >>> 0;
			v ^= v >>> 15;
			return (v % 10000) / 10000;
		};
		const cams = Array.from({ length: n }, (_, t) => [
			0.4 * t + 5 * (hash(t, 7, 3) - 0.5),
			0.15 * t + 5 * (hash(t, 11, 5) - 0.5),
		]);
		const depth = (s: [number, number]) =>
			1 + 1.2 * Math.exp(-((s[0] - 160) ** 2 + (s[1] - 90) ** 2) / (2 * 38 ** 2));
		const imageOf = (t: number, s: [number, number]): [number, number] => {
			const d = depth(s);
			return [s[0] + cams[t]![0]! * d, s[1] + cams[t]![1]! * d];
		};
		// Trajectories of a grid of scene points; motions = background (depth 1) translations.
		const tracks = [];
		for (let gy = 0; gy < 9; gy++)
			for (let gx = 0; gx < 14; gx++) {
				const s: [number, number] = [20 + gx * 21, 12 + gy * 19];
				tracks.push({ start: 0, pts: Array.from({ length: n }, (_, t) => imageOf(t, s)) });
			}
		const frames = cams.map((c, k) => {
			const d = k ? [c[0]! - cams[k - 1]![0]!, c[1]! - cams[k - 1]![1]!] : [0, 0];
			return { t: [d[0]!, d[1]!] as const, s: [1, 0, d[0]!, d[1]!] as const, h: [1, 0, d[0]!, 0, 1, d[1]!, 0, 0] };
		});
		const a: WarpAnalysis = { size: [320, 180], frames, tracks };
		const residual = (out: (t: number, q: [number, number]) => [number, number] | null) => {
			let tot = 0;
			let cnt = 0;
			for (let gy = 0; gy < 5; gy++)
				for (let gx = 0; gx < 7; gx++) {
					const s: [number, number] = [70 + gx * 30, 45 + gy * 22];
					const ys = Array.from({ length: n }, (_, t) => out(t, imageOf(t, s)));
					for (let t = 6; t < n - 6; t++) {
						const [p, q, r] = [ys[t - 1], ys[t], ys[t + 1]];
						if (p && q && r) {
							tot += Math.hypot(r[0] - 2 * q[0] + p[0], r[1] - 2 * q[1] + p[1]);
							cnt++;
						}
					}
				}
			return tot / Math.max(1, cnt);
		};
		const base = { framing: 'stabilizeOnly', fps: 24 } as const;
		const before = residual((_, x) => x);
		const ppl = stabPlan(a, S({ ...base, method: 'perspective' }));
		expect(ppl.meshes).toHaveLength(0);
		const persp = residual((t, x) => planOutputOf(ppl, t, x));
		const spl = stabPlan(a, S({ ...base, method: 'subspaceWarp' }));
		expect(spl.meshes).toHaveLength(n);
		const sub = residual((t, x) => planOutputOf(spl, t, x));
		const epl = stabPlan(a, S({ ...base, method: 'subspaceWarp', ripple: 'enhanced' }));
		const enh = residual((t, x) => planOutputOf(epl, t, x));
		expect(persp).toBeLessThan(0.8 * before);
		expect(sub).toBeLessThan(0.6 * persp);
		expect(enh).toBeLessThan(0.6 * persp);
		const o = planOutputOf(spl, 10, [150, 80])!;
		const back = planSourceOf(spl, 10, o)!;
		expect(Math.abs(back[0] - 150)).toBeLessThan(1e-3);
		// Trajectory smoothing returns pairs for every frame with enough tracks.
		const sm = smoothTrajectories(tracks, n, 5, 9);
		expect(sm.every((pr) => pr.length >= 100)).toBe(true);
	});
});

describe('stored analysis, command and invariant', () => {
	const analysis = (n: number): WarpAnalysisData => {
		const { a } = shaky(n);
		return {
			version: 1,
			key: `test-${n}`,
			start: 0,
			frameDuration: 1 / 30,
			size: [640, 360],
			detailed: false,
			frames: a.frames.flatMap((f) => [...f.t, ...f.s, ...f.h]),
			tracks: [{ start: 0, pts: [1, 2, 3, 4] }],
		};
	};

	it('maps clip frames to analysed frames through the clip in-point and speed', () => {
		const a = analysis(30);
		expect(mediaTimeAtClipFrame(a, 3, 30, { sourceInSeconds: 0.5, speed: 1, reverse: false })).toBeCloseTo(0.6);
		expect(warpFrameAt(a, 0.6)).toEqual({ index: 18, inside: true });
		expect(warpFrameAt(a, 5)).toEqual({ index: 29, inside: false });
		expect(warpSettingsOf({ cropLessSmoothMore: 100 }, 30).cropLessSmoothMore).toBe(100);
		expect(warpSettingsOf({ cropLessSmoothMore: 50 }, 30).cropLessSmoothMore).toBe(0);
		expect(warpSynthesisOffsets({ framing: 'synthesizeEdges', synthesisInputRange: 1 }, 30)).toEqual([
			8, -8, 15, -15, 23, -23, 30, -30,
		]);
		expect(warpSynthesisOffsets({ framing: 'stabilizeOnly' }, 30)).toEqual([]);
		// Plans are cached per analysis and settings.
		const s = warpSettingsOf({}, 30);
		expect(warpPlanFor(a, s)).toBe(warpPlanFor(a, s));
	});

	it('effect.setWarpAnalysis stores, clears, undoes and refuses', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 2 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const clip = h.clips('V1')[0]!;
		expect(defaultEffectRegistry.get('jasper.warp-stabilizer')?.gpu).toBeTruthy();
		h.ok([{ type: 'effect.add', target: { clipId: clip.id }, effectId: 'jasper.warp-stabilizer' }]);
		const fxOf = () =>
			fxList(h.seq.clips[clip.id]).find((e) => e.effectId === 'jasper.warp-stabilizer')! as {
				id: string;
				warpAnalysis?: WarpAnalysisData;
			};
		const fxId = fxOf().id;
		const before = h.doc;
		h.ok([{ type: 'effect.setWarpAnalysis', effectInstanceId: fxId, analysis: analysis(10) }]);
		expect(fxOf().warpAnalysis?.key).toBe('test-10');
		expect(checkInvariants(h.doc)).toEqual([]);
		const analysed = h.doc;
		// Malformed data and other effects are refused.
		expect(
			h.tx([
				{ type: 'effect.setWarpAnalysis', effectInstanceId: fxId, analysis: { ...analysis(10), frames: [1, 2, 3] } },
			]).ok,
		).toBe(false);
		h.ok([{ type: 'effect.add', target: { clipId: clip.id }, effectId: 'jasper.crop' }]);
		const crop = fxList(h.seq.clips[clip.id]).find((e) => e.effectId === 'jasper.crop')!;
		expect(h.tx([{ type: 'effect.setWarpAnalysis', effectInstanceId: crop.id, analysis: analysis(4) }]).ok).toBe(
			false,
		);
		h.ok([{ type: 'effect.setWarpAnalysis', effectInstanceId: fxId, analysis: null }]);
		expect(fxOf().warpAnalysis).toBeUndefined();
		// Undo = the previous document.
		h.doc = before;
		expect(fxOf().warpAnalysis).toBeUndefined();
		// A broken stored analysis is reported and repaired.
		const broken = structuredClone(analysed);
		const bfx = fxList(Object.values(broken.sequences)[0]!.clips[clip.id]).find((e) => e.id === fxId)! as {
			warpAnalysis?: { frames: number[] };
		};
		bfx.warpAnalysis!.frames = [1, 2];
		expect(checkInvariants(broken).some((i) => i.invariant === 'INV-WARP')).toBe(true);
		const repaired = repairDocument(broken, h.ids);
		expect(repaired.report.some((r) => r.action === 'drop-warp-analysis')).toBe(true);
		expect(checkInvariants(repaired.document)).toEqual([]);
	});
});
