// spec 13 AS-070 / AS-073: lowered layers (still + native motion) — the multi-tap kernel, the per-frame maps of
// Motion, the Transform effect and S_Shake against the shaders' own formulas, eligibility and the memory preflight.
import {
	buildRenderSnapshot,
	clipContentTime,
	defaultEffectRegistry,
	type EffectParams,
	fxSeed,
	gpuPadding,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compositeMemoryBlocker, estimateComposite } from '../src/export/memory.ts';
import { drawLayer, drawTaps } from '../src/export/stream/kernel.ts';
import {
	invertAffine,
	loweredRefusal,
	planLoweredFrames,
	shiftProgram,
	singleTap,
} from '../src/export/stream/lowered.ts';
import { planTapStream, type TapMember } from '../src/export/stream/tap-plan.ts';
import { layerStill, layerStillClip } from '../src/layer-bake/layer.ts';
import { alphaBounds, cropRgba } from '../src/layer-bake/service.ts';
import { DocBuilder } from './helpers.ts';

const FPS = { num: 60000, den: 1001 };

function snapOf(d: DocBuilder): RenderSnapshot {
	return buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null });
}
const clipOf = (snap: RenderSnapshot, id: string): RenderVisualClip =>
	snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;

/** A 1080×1920 sequence at 59.94 with one subtitle-like text clip (outside stroke and soft shadow). */
function subtitle(extra: (d: DocBuilder, clip: string) => void = () => {}) {
	const d = new DocBuilder('hd-1080p-59.94');
	d.tx([
		{
			type: 'sequence.updateSettings',
			sequenceId: d.seqId,
			settings: { width: 1080, height: 1920 },
		},
	]);
	const clip = d.tx([
		{
			type: 'clip.addText',
			at: 10,
			duration: 30,
			track: 'V2',
			content: {
				text: 'HOLA MUNDO',
				style: {
					sizePx: 98,
					fill: [1, 1, 1, 1],
					strokes: [{ color: [0.68, 0, 1, 1], widthPx: 11.5, position: 'outside' }],
					shadow: { color: [0.13, 0.11, 0.35, 0.8], angleDeg: 0, distancePx: 0, blurPx: 24 },
				},
			},
			box: { width: 810, height: 140, autoSize: 'none' },
			transform: { position: [540, 960] },
			ref: '$t',
		},
	]).refs.$t!;
	extra(d, clip);
	return { d, clip };
}

const key = (d: DocBuilder, target: unknown[], f: number, value: unknown) =>
	d.tx([{ type: 'keyframe.add', target, at: { sequenceFrame: f }, value, interpolation: 'linear' }]);

/** The user's 2025 recipe (spec 13 §0, AS-021): Transform pop-in with a 360° shutter, then S_Shake. */
function pixelPop(d: DocBuilder, clip: string) {
	const t = d.tx([
		{
			type: 'effect.add',
			target: { clipId: clip },
			effectId: 'jasper.transform',
			params: { useCompShutterAngle: false, shutterAngle: 360 },
			ref: '$tf',
		},
		{
			type: 'effect.add',
			target: { clipId: clip },
			effectId: 'jasper.s.shake',
			params: {
				amplitude: 0.6,
				frequency: 1,
				wrapX: 'no',
				wrapY: 'no',
				xRandAmp: 0.889,
				yRandAmp: 0.444,
				tiltRandAmp: 1,
			},
			ref: '$sh',
		},
	]);
	const tf = t.refs.$tf!;
	key(d, ['effect', tf, 'scaleHeight'], 10, 75);
	key(d, ['effect', tf, 'scaleHeight'], 16, 108);
	key(d, ['effect', tf, 'scaleHeight'], 20, 100);
	key(d, ['effect', tf, 'opacity'], 10, 0);
	key(d, ['effect', tf, 'opacity'], 13, 100);
	return { tf, sh: t.refs.$sh! };
}

/** Applies an affine `[m0…m5]` to a point. */
const apply = (m: readonly number[], x: number, y: number): [number, number] => [
	m[0]! * x + m[1]! * y + m[2]!,
	m[3]! * x + m[4]! * y + m[5]!,
];

/** The taps of a program: weight, sample map, stage maps and rectangles. */
function tapsOf(prog: readonly number[]) {
	const out: { w: number; map: number[]; clip: number[]; stages: { map: number[]; rect: number[] }[] }[] = [];
	const n = prog[0]! | 0;
	let p = 2;
	for (let t = 0; t < n; t++) {
		const w = prog[p]!;
		const map = prog.slice(p + 1, p + 7);
		const clip = prog.slice(p + 7, p + 11);
		const ns = prog[p + 11]! | 0;
		p += 12;
		const stages = Array.from({ length: ns }, (_, s) => ({
			map: prog.slice(p + s * 10, p + s * 10 + 6),
			rect: prog.slice(p + s * 10 + 6, p + s * 10 + 10),
		}));
		p += ns * 10;
		out.push({ w, map, clip, stages });
	}
	return out;
}

describe('multi-tap kernel (AS-070)', () => {
	it('one tap without stages draws exactly what the sub-pixel kernel draws', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 9 }),
				fc.integer({ min: 2, max: 9 }),
				fc.double({ min: -3, max: 3, noNaN: true }),
				fc.double({ min: 0.4, max: 2.5, noNaN: true }),
				fc.double({ min: -0.6, max: 0.6, noNaN: true }),
				fc.double({ min: 0.05, max: 1, noNaN: true }),
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				(cw, ch, off, scale, rot, opacity, seed) => {
					let s = seed | 1;
					const rnd = () => {
						s ^= s << 13;
						s ^= s >>> 17;
						s ^= s << 5;
						return (s >>> 0) & 255;
					};
					const src = new Uint8Array(cw * ch * 4).map(() => rnd());
					const c = Math.cos(rot) / scale;
					const sn = Math.sin(rot) / scale;
					const inv: [number, number, number, number, number, number] = [c, sn, off, -sn, c, off + 0.3];
					const dw = 16;
					const dh = 14;
					const rect = [0, 0, dw, dh];
					const clip = [0.3, 0, cw, ch - 0.5];
					const a = new Uint8Array(dw * dh * 4);
					const b = new Uint8Array(dw * dh * 4);
					drawLayer(src, cw, cw, ch, clip, a, dw, dh, inv, opacity, rect);
					drawTaps(
						src,
						cw,
						cw,
						ch,
						b,
						dw,
						dh,
						singleTap(inv, clip),
						opacity,
						rect,
						new Float32Array(dw * dh * 4),
					);
					for (let i = 0; i < a.length; i++)
						expect(Math.abs(a[i]! - b[i]!), `byte ${i}`).toBeLessThanOrEqual(1);
				},
			),
			{ numRuns: 200 },
		);
	});

	it('matches a per-pixel reference for random taps and stages (row spans skip only full coverage)', () => {
		/** The kernel's formula pixel by pixel, without spans (test oracle). */
		const reference = (
			src: Uint8Array,
			cw: number,
			ch: number,
			dw: number,
			dh: number,
			prog: number[],
			opacity: number,
		): Uint8Array => {
			const out = new Uint8Array(dw * dh * 4);
			const n = prog[0]!;
			const acc = new Float64Array(dw * dh * 4);
			let p = 2;
			for (let t = 0; t < n; t++) {
				const [w, m0, m1, m2, m3, m4, m5, c0, c1, c2, c3, ns] = prog.slice(p, p + 12) as number[];
				const stages = Array.from({ length: ns! }, (_, k) => prog.slice(p + 12 + k * 10, p + 22 + k * 10));
				p += 12 + ns! * 10;
				for (let y = 0; y < dh; y++)
					for (let x = 0; x < dw; x++) {
						const X = x + 0.5;
						const Y = y + 0.5;
						const u = m0! * X + m1! * Y + m2!;
						const v = m3! * X + m4! * Y + m5!;
						const term = (d1: number, d2: number, g: number) => Math.min(1, 0.5 + Math.min(d1, d2) * g);
						let cover =
							Math.max(0, term(u - c0!, c2! - u, 1 / Math.hypot(m0!, m1!))) *
							Math.max(0, term(v - c1!, c3! - v, 1 / Math.hypot(m3!, m4!)));
						for (const st of stages) {
							const su = st[0]! * X + st[1]! * Y + st[2]!;
							const sv = st[3]! * X + st[4]! * Y + st[5]!;
							cover *=
								Math.max(0, term(su - st[6]!, st[8]! - su, 1 / Math.hypot(st[0]!, st[1]!))) *
								Math.max(0, term(sv - st[7]!, st[9]! - sv, 1 / Math.hypot(st[3]!, st[4]!)));
						}
						if (!(cover > 0)) continue;
						const lu = Math.min(c0! + 0.5, (c0! + c2!) / 2);
						const hu = Math.max(c2! - 0.5, (c0! + c2!) / 2);
						const lv = Math.min(c1! + 0.5, (c1! + c3!) / 2);
						const hv = Math.max(c3! - 0.5, (c1! + c3!) / 2);
						const su = Math.min(cw - 1, Math.max(0, Math.min(hu, Math.max(lu, u)) - 0.5));
						const sv = Math.min(ch - 1, Math.max(0, Math.min(hv, Math.max(lv, v)) - 0.5));
						const iu = Math.floor(su);
						const iv = Math.floor(sv);
						const fx = su - iu;
						const fy = sv - iv;
						const iu1 = Math.min(cw - 1, iu + 1);
						const iv1 = Math.min(ch - 1, iv + 1);
						const px = (i: number, j: number, c: number) => src[(j * cw + i) * 4 + c]!;
						const ws: [number, number, number][] = [
							[iu, iv, (1 - fx) * (1 - fy)],
							[iu1, iv, fx * (1 - fy)],
							[iu, iv1, (1 - fx) * fy],
							[iu1, iv1, fx * fy],
						];
						const a = ws.reduce((s, [i, j, k]) => s + px(i, j, 3) * k, 0);
						if (a <= 0) continue;
						const o = (y * dw + x) * 4;
						for (let c = 0; c < 3; c++)
							acc[o + c]! += (w! * cover * ws.reduce((s, [i, j, k]) => s + px(i, j, c) * px(i, j, 3) * k, 0)) / 255;
						acc[o + 3]! += w! * cover * a;
					}
			}
			for (let i = 0; i < dw * dh; i++) {
				const a = acc[i * 4 + 3]!;
				if (!(a > 0)) continue;
				for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.min(255, (acc[i * 4 + c]! * 255) / a) + 0.5;
				out[i * 4 + 3] = Math.min(255, (a * opacity) / prog[1]!) + 0.5;
			}
			return out;
		};
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
				let s = seed | 1;
				const r = () => {
					s ^= s << 13;
					s ^= s >>> 17;
					s ^= s << 5;
					return ((s >>> 0) % 100000) / 100000;
				};
				const cw = 5 + Math.floor(r() * 6);
				const ch = 5 + Math.floor(r() * 6);
				const src = new Uint8Array(cw * ch * 4).map(() => Math.floor(r() * 256));
				const dw = 18;
				const dh = 15;
				const taps = 1 + Math.floor(r() * 3);
				const prog: number[] = [taps, 0];
				for (let t = 0; t < taps; t++) {
					const w = 0.2 + r();
					prog[1] += w;
					const a = (r() - 0.5) * 1.5;
					const k = 0.5 + r();
					const map = [Math.cos(a) * k, Math.sin(a) * k, -r() * 6, -Math.sin(a) * k, Math.cos(a) * k, -r() * 6];
					const ns = Math.floor(r() * 3);
					prog.push(w, ...map, r(), r(), cw - r(), ch - r(), ns);
					for (let q = 0; q < ns; q++) {
						const b = (r() - 0.5) * 2;
						prog.push(Math.cos(b), Math.sin(b), -r() * 4, -Math.sin(b), Math.cos(b), -r() * 4);
						prog.push(r() * 3, r() * 3, 6 + r() * 10, 6 + r() * 10);
					}
				}
				const got = new Uint8Array(dw * dh * 4);
				drawTaps(src, cw, cw, ch, got, dw, dh, prog, 0.9, [0, 0, dw, dh], new Float32Array(dw * dh * 4));
				const want = reference(src, cw, ch, dw, dh, prog, 0.9);
				for (let i = 0; i < got.length; i++) expect(Math.abs(got[i]! - want[i]!), `byte ${i}`).toBeLessThanOrEqual(1);
			}),
			{ numRuns: 300 },
		);
	});

	it('equal taps average to the single tap; a stage rectangle cuts with an anti-aliased edge', () => {
		const cw = 8;
		const src = new Uint8Array(cw * cw * 4).fill(255);
		const inv: [number, number, number, number, number, number] = [1, 0, -2, 0, 1, -2];
		const dw = 12;
		const one = new Uint8Array(dw * dw * 4);
		const two = new Uint8Array(dw * dw * 4);
		const acc = new Float32Array(dw * dw * 4);
		drawTaps(src, cw, cw, cw, one, dw, dw, singleTap(inv, [0, 0, cw, cw]), 1, [0, 0, dw, dw], acc);
		const tap = singleTap(inv, [0, 0, cw, cw]).slice(2);
		drawTaps(src, cw, cw, cw, two, dw, dw, [2, 2, ...tap, ...tap], 1, [0, 0, dw, dw], acc);
		expect([...two]).toEqual([...one]);
		// A stage that keeps x < 5.5 (output px): full alpha left of it, half at the edge pixel, none right of it.
		const staged = new Uint8Array(dw * dw * 4);
		drawTaps(
			src,
			cw,
			cw,
			cw,
			staged,
			dw,
			dw,
			[1, 1, 1, ...inv, 0, 0, cw, cw, 1, 1, 0, 0, 0, 1, 0, -100, -100, 5.5, 100],
			1,
			[0, 0, dw, dw],
			acc,
		);
		const alpha = (x: number, y: number) => staged[(y * dw + x) * 4 + 3]!;
		expect(alpha(4, 5)).toBe(255);
		expect(alpha(5, 5)).toBe(128);
		expect(alpha(6, 5)).toBe(0);
	});

	it('moving a program into a larger frame moves its picture by whole pixels', () => {
		const prog = singleTap([0.9, 0.1, -3.2, -0.1, 0.9, 4.4], [0, 0, 5, 5]);
		const shifted = shiftProgram(prog, 7, -3);
		const [u, v] = apply(prog.slice(3, 9), 12.5, 9.5);
		const [u2, v2] = apply(shifted.slice(3, 9), 12.5 - 7, 9.5 + 3);
		expect(u2).toBeCloseTo(u, 9);
		expect(v2).toBeCloseTo(v, 9);
		// Every tap and stage map moves; nothing else changes.
		const tap = (m: number[]) => [1, ...m, 0, 0, 9, 9, 1, ...m, -1, -1, 4, 4];
		const two = [2, 2, ...tap([1, 0, 0, 0, 1, 0]), ...tap([0.5, 0, 1, 0, 0.5, 2])];
		const moved = shiftProgram(two, 3, 4);
		expect(moved).toHaveLength(two.length);
		const t1 = tapsOf(moved)[1]!;
		expect(apply(t1.map, 1, 1)).toEqual(apply([0.5, 0, 1, 0, 0.5, 2], 4, 5));
		expect(apply(t1.stages[0]!.map, 1, 1)).toEqual(apply([0.5, 0, 1, 0, 0.5, 2], 4, 5));
		expect(t1.clip).toEqual([0, 0, 9, 9]);
		expect(t1.stages[0]!.rect).toEqual([-1, -1, 4, 4]);
	});
});

describe('lowered maps against the shaders (AS-070, AS-073)', () => {
	it('Motion keys only: one tap, the inverse layer map into the still', () => {
		const { d, clip } = subtitle((dd, c) => {
			key(dd, ['clip', c, 'transform', 'scale'], 10, 75);
			key(dd, ['clip', c, 'transform', 'scale'], 13, 108);
			key(dd, ['clip', c, 'transform', 'scale'], 16, 100);
		});
		const c = clipOf(snapOf(d), clip);
		const pic = layerStill(c)!;
		expect(pic).not.toBeNull();
		const { frames } = planLoweredFrames({
			clip: c,
			f0: 10,
			f1: 40,
			fps: FPS,
			picture: pic,
			W: 1080,
			H: 1920,
		});
		expect(frames).toHaveLength(30);
		for (const [k, f] of frames.entries()) {
			const taps = tapsOf(f.prog);
			expect(taps).toHaveLength(1);
			expect(taps[0]!.stages).toHaveLength(0);
			const props = resolveLayerProps(c, clipContentTime(c, 10 + k, FPS));
			const m = props.matrix;
			// A layer point q maps to M·q; the tap must send M·q back to q − picture origin.
			for (const [qx, qy] of [
				[0, 0],
				[400, 70],
				[810, 140],
			] as const) {
				const sx = m.a * qx + m.c * qy + m.e;
				const sy = m.b * qx + m.d * qy + m.f;
				const [u, v] = apply(taps[0]!.map, sx, sy);
				expect(u).toBeCloseTo(qx - pic.x, 6);
				expect(v).toBeCloseTo(qy - pic.y, 6);
			}
		}
	});

	it('Pixel Pop: S_Shake and the Transform follow the GLSL of their shaders, stage by stage', () => {
		let ids: { tf: string; sh: string } = { tf: '', sh: '' };
		const { d, clip } = subtitle((dd, c) => {
			ids = pixelPop(dd, c);
		});
		const c = clipOf(snapOf(d), clip);
		expect(loweredRefusal(c)).toBeNull();
		const pic = layerStill(c)!;
		const { frames } = planLoweredFrames({
			clip: c,
			f0: 10,
			f1: 40,
			fps: FPS,
			picture: pic,
			W: 1080,
			H: 1920,
		});
		const shake = defaultEffectRegistry.get('jasper.s.shake')!;
		const transform = defaultEffectRegistry.get('jasper.transform')!;
		let blurred = 0;
		for (const [k, f] of frames.entries()) {
			const frame = 10 + k;
			const lf = frame - c.start;
			const props = resolveLayerProps(c, clipContentTime(c, frame, FPS));
			const sp = props.effects.find((e) => e.id === ids.sh)!.params as EffectParams;
			const tp = props.effects.find((e) => e.id === ids.tf)!.params as EffectParams;
			const box = props.box;
			const fps = FPS.num / FPS.den;
			const ctx = {
				width: box.width,
				height: box.height,
				pxScale: 1,
				fps,
				frame: lf,
				duration: c.duration,
				progress: 0,
				seed: fxSeed(c.clipId, ids.sh, sp),
			};
			const pose = (shake.gpu!.uniforms!(sp, ctx) as unknown as { u_shakeNow: { vec4s: number[] } })
				.u_shakeNow.vec4s;
			const taps = tapsOf(f.prog);
			if (taps.length > 1) {
				blurred++;
				expect(f.prog[1], 'wsum').toBeGreaterThan(0);
				continue;
			}
			if (taps.length === 0) continue;
			const tu = transform.gpu!.uniforms!(tp, { ...ctx, seed: 0 }) as unknown as {
				u_tfA: number[];
				u_tfT: number[];
			};
			const tap = taps[0]!;
			// Stages: the canvas the browser draws, S_Shake's canvas, the Transform's box.
			const pad = gpuPadding(shake, sp, ctx);
			expect(tap.stages).toHaveLength(3);
			expect(tap.stages[0]!.rect).toEqual([
				-pad.left,
				-pad.top,
				Math.ceil(box.width + pad.left + pad.right) - pad.left,
				Math.ceil(box.height + pad.top + pad.bottom) - pad.top,
			]);
			expect(tap.stages[2]!.rect).toEqual([0, 0, box.width, box.height]);
			const m = props.matrix;
			const minv = invertAffine([m.a, m.c, m.e, m.b, m.d, m.f])!;
			for (const [sx, sy] of [
				[540, 960],
				[300, 930],
				[790, 1000],
			] as const) {
				// GLSL, literally: Motion⁻¹, then sh_src (frame units of the box width), then the Transform's tf_at.
				const [qx, qy] = apply(minv, sx, sy);
				const fx = (qx - box.width / 2) / box.width;
				const fy = (qy - box.height / 2) / box.width;
				const [dx, dy, cz, sz] = [pose[4]!, pose[5]!, pose[6]!, pose[7]!];
				const ddx = fx - dx;
				const ddy = fy - dy;
				const zd = Number(sp.zDist ?? 1);
				const srcx = (cz * ddx + sz * ddy) * zd;
				const srcy = (-sz * ddx + cz * ddy) * zd;
				const q1x = srcx * box.width + box.width / 2;
				const q1y = srcy * box.width + box.height / 2;
				const A = tu.u_tfA;
				const T = tu.u_tfT;
				const q0x = A[0]! * q1x + A[2]! * q1y + T[0]!;
				const q0y = A[1]! * q1x + A[3]! * q1y + T[1]!;
				const [u, v] = apply(tap.map, sx, sy);
				expect(u, `frame ${frame} u`).toBeCloseTo(q0x - pic.x, 5);
				expect(v, `frame ${frame} v`).toBeCloseTo(q0y - pic.y, 5);
				const [s1x, s1y] = apply(tap.stages[1]!.map, sx, sy);
				expect(s1x).toBeCloseTo(q1x, 5);
				expect(s1y).toBeCloseTo(q1y, 5);
			}
		}
		// The 360° shutter blurs the pop-in (scale moves), not the hold.
		expect(blurred).toBeGreaterThanOrEqual(5);
		expect(blurred).toBeLessThan(15);
	});

	it('refuses what the kernel cannot draw: RGB split, shake motion blur, wrap, other effects, masks', () => {
		const shaken = (params: Record<string, unknown>) => {
			const { d, clip } = subtitle((dd, c) =>
				dd.tx([{ type: 'effect.add', target: { clipId: c }, effectId: 'jasper.s.shake', params }]),
			);
			return clipOf(snapOf(d), clip);
		};
		expect(loweredRefusal(shaken({ wrapX: 'no', wrapY: 'no' }))).toBeNull();
		expect(loweredRefusal(shaken({}))).toBe('S_Shake wrap');
		expect(loweredRefusal(shaken({ wrapX: 'no', wrapY: 'no', motionBlur: true }))).toBe(
			'S_Shake motion blur',
		);
		expect(loweredRefusal(shaken({ wrapX: 'no', wrapY: 'no', redAmplitude: 1.4 }))).toBe('S_Shake RGB split');
		expect(loweredRefusal(shaken({ wrapX: 'no', wrapY: 'no', rgbRandomness: 0.5 }))).toBe(
			'S_Shake RGB split',
		);
		const { d, clip } = subtitle((dd, c) =>
			dd.tx([
				{
					type: 'effect.add',
					target: { clipId: c },
					effectId: 'jasper.gaussian-blur',
					params: { radius: 3 },
				},
			]),
		);
		expect(loweredRefusal(clipOf(snapOf(d), clip))).toBe('effect jasper.gaussian-blur');
	});

	it('the layer still: the box grown by the bleed, Motion and effects removed, one frame', () => {
		const { d, clip } = subtitle(pixelPop);
		const c = clipOf(snapOf(d), clip);
		const pic = layerStill(c)!;
		expect(pic.x).toBe(pic.y);
		expect(pic.x).toBeLessThan(-11);
		expect(pic.w).toBe(810 - 2 * pic.x);
		expect(pic.h).toBe(140 - 2 * pic.y);
		const baked = layerStillClip(c);
		expect(baked.effects).toEqual([]);
		expect(baked).toMatchObject({ start: 0, duration: 1, opacity: { value: 100, keyframes: [] } });
		const m = resolveLayerProps(baked, 0).matrix;
		expect([m.a, m.b, m.c, m.d, m.e, m.f].map((v) => v + 0)).toEqual([1, 0, 0, 1, -pic.x, -pic.y]);
		// Grown (the layer drew past its bleed): a quarter of the box and two font sizes more on every side.
		const grown = layerStill(c, undefined, true)!;
		const more = Math.ceil(0.25 * 810 + 2 * 98);
		expect(grown.x).toBe(pic.x - more);
		expect(grown.w).toBe(pic.w + 2 * more);
		// A static subtitle keeps the ordinary still recipe.
		const s = subtitle();
		expect(layerStill(clipOf(snapOf(s.d), s.clip))).toBeNull();
	});
});

describe('kernel streams and the memory preflight (AS-072, AS-074)', () => {
	const member = (clipId: string, f0: number, f1: number, x: number): TapMember => ({
		clipId,
		f0,
		f1,
		pictures: [{ w: 10, h: 10, inputs: [], filter: '' }],
		frames: Array.from({ length: f1 - f0 }, () => ({
			rect: [x, 100, x + 10, 110] as [number, number, number, number],
			opacity: 1,
			level: 0,
			prog: singleTap([1, 0, -x, 0, 1, -100], [0, 0, 10, 10]),
		})),
	});

	it('a stream covers its members’ union, frame programs moved into it', () => {
		const plan = planTapStream([member('b', 30, 40, 500), member('a', 0, 30, 200)], 1080, 1920, FPS);
		expect(plan).toMatchObject({ x: 200, y: 100, outW: 310, outH: 10, g0: 0, g1: 40 });
		expect(plan.members.map((m) => m.clipId)).toEqual(['a', 'b']);
		const f = plan.members[1]!.frames[0]!;
		expect(f.rect).toEqual([300, 0, 310, 10]);
		expect(apply(f.prog.slice(3, 9), 300.5, 0.5)).toEqual([0.5, 0.5]);
		expect(() => planTapStream([member('a', 0, 30, 0), member('b', 20, 40, 0)], 1080, 1920, FPS)).toThrow(
			/overlap/,
		);
	});

	it('memory: 1 080 animated subtitles on one track are one stream; masters are refused by budget', () => {
		const d = new DocBuilder('hd-1080p-59.94');
		const cmds: unknown[] = [];
		for (let i = 0; i < 1080; i++)
			cmds.push({
				type: 'clip.addText',
				at: i * 30,
				duration: 30,
				track: 'V2',
				content: { text: `W${i}` },
				box: { width: 600, height: 120, autoSize: 'none' },
				ref: `$t${i}`,
			});
		const refs = d.tx(cmds).refs;
		const keys: unknown[] = [];
		for (let i = 0; i < 1080; i++)
			for (const [f, v] of [
				[0, 75],
				[3, 108],
				[6, 100],
			] as const)
				keys.push({
					type: 'keyframe.add',
					target: ['clip', refs[`$t${i}`], 'transform', 'scale'],
					at: { sequenceFrame: i * 30 + f },
					value: v,
				});
		d.tx(keys);
		const snap = snapOf(d);
		const est = estimateComposite(snap, { start: 0, end: 1080 * 30 });
		expect(est.inputs).toMatchObject({ masters: 0, kernelStreams: 1, stills: 0, streams: 0 });
		expect(est.bytes).toBeLessThan(2 * 1024 ** 3);
		expect(compositeMemoryBlocker(est, 6 * 1024 ** 3)).toBeNull();
		// The same captions with an In animation (glyphs move: not lowered) are 1 080 masters.
		const masters = {
			...snap,
			videoTracks: snap.videoTracks.map((t) => ({
				...t,
				clips: t.clips.map((c) =>
					'text' in c.source
						? ({
								...c,
								source: {
									...c.source,
									animation: { in: { preset: 'fade', durationFrames: 6, params: {} } },
								},
							} as unknown as RenderVisualClip)
						: c,
				),
			})),
		} as RenderSnapshot;
		const big = estimateComposite(masters, { start: 0, end: 1080 * 30 });
		expect(big.inputs.masters).toBe(1080);
		const reason = compositeMemoryBlocker(big, 6 * 1024 ** 3);
		expect(reason).toMatch(/needs ≈ \d+\.\d GB of memory \(1080 animated graphics masters/);
		expect(reason).toMatch(/Remotion path/);
	});
});

describe('layer still trimming (AS-070)', () => {
	it('finds the pixels’ bounds and crops them', () => {
		const w = 6;
		const h = 5;
		const px = new Uint8Array(w * h * 4);
		expect(alphaBounds(px, w, h)).toBeNull();
		px[(1 * w + 2) * 4 + 3] = 9;
		px[(3 * w + 4) * 4 + 3] = 200;
		px[(3 * w + 4) * 4] = 77;
		expect(alphaBounds(px, w, h)).toEqual({ x0: 2, y0: 1, x1: 5, y1: 4 });
		const c = cropRgba(px, w, 2, 1, 3, 3);
		expect(c[(0 * 3 + 0) * 4 + 3]).toBe(9);
		expect(c[(2 * 3 + 2) * 4]).toBe(77);
		expect(c[(2 * 3 + 2) * 4 + 3]).toBe(200);
	});
});
