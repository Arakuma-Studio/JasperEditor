// S_Shake and Tint on adjustment layers on the native path (blend/adjust.ts, docs/wp-notes/edit-structure.md "Native
// Transform and S_Shake on adjustment layers"): the planner keeps such exports native and names what it refuses;
// native stills are compared with references computed here — a keyframed Tint from its formula, an S_Shake wrapping
// with Reflect from the shader's own pose (`uniforms`) through the GLSL's `sh_src` / `dw_tap` written out. The
// comparison with the Program preview's renderer is adjustment-shake-tint-parity.e2e.test.ts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildRenderSnapshot,
	clipContentTime,
	defaultEffectRegistry,
	type EffectParams,
	fxSeed,
	resolveLayerProps,
} from '@jasper/project';
import { diffImages, formatDiff } from '@jasper/testkit/golden';
import { type Rgba8, rgba8 } from '@jasper/testkit/image';
import { oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng, encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GH, GW, goldenCard } from '../../../packages/compositions/test/golden/scenes.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, register, type TestApp } from './helpers.ts';
import { tempAppdir } from './temp.ts';

const enabled = oraclesAvailable('ffmpeg', 'ffprobe');
let app: TestApp;
let card: Awaited<ReturnType<typeof register>>;
beforeAll(async () => {
	if (!enabled) return;
	app = await makeApp();
	const dir = tempAppdir('jasper-adj-shake-');
	writeFileSync(join(dir, 'card.png'), encodePng(goldenCard()));
	card = await register(app, join(dir, 'card.png'));
}, 180_000);
afterAll(closeApps);

type Cmd = Record<string, unknown>;
const fx = (effectId: string, params: Record<string, unknown>, ref: string): Cmd => ({
	type: 'effect.add',
	target: { clipId: '$a' },
	effectId,
	params,
	ref,
});
const key = (ref: string, param: string, frame: number, value: unknown): Cmd => ({
	type: 'keyframe.add',
	target: ['effect', ref, param],
	at: { sequenceFrame: frame },
	value,
	interpolation: 'linear',
});
/** S19's "edgy shake" (ASSEMBLY_S9_S23): fast, low amplitude, Reflect wrap. */
const S19_SHAKE = {
	amplitude: 0.4,
	frequency: 30,
	xRandAmp: 0.052,
	yRandAmp: 0.052,
	tiltRandAmp: 0.1,
	seed: 0,
	motionBlur: false,
	wrapX: 'reflect',
	wrapY: 'reflect',
};

/** The card on V1 (GW×GH, 30 fps) and an adjustment layer on V2 over frames 0–30 with `commands`. */
function scene(commands: Cmd[]): { d: DocBuilder; adj: string } {
	const d = new DocBuilder();
	d.tx([{ type: 'sequence.updateSettings', settings: { width: GW, height: GH } }]);
	const m = d.addMedia(card);
	const r = d.tx([
		{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1' } },
		{ type: 'track.add', kind: 'video', count: 1 },
		{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V2', ref: '$a' },
		...commands,
	]);
	return { d, adj: r.refs.$a! };
}

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: GW,
		height: GH,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
});

async function plan(d: DocBuilder) {
	return (
		await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		})
	).plan;
}

async function still(d: DocBuilder, frame: number): Promise<{ img: Rgba8; path: string }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.state, JSON.stringify(done.error ?? null)).toBe('succeeded');
	const png = await app.inject({ method: 'GET', url: `/renders/${done.id}/output`, headers: H });
	return { img: decodePng(png.rawPayload), path: (done.result as { renderPath: string }).renderPath };
}

const reasons = (p: Awaited<ReturnType<typeof plan>>) => p.blockers.map((b) => b.reason).join('\n');

describe.runIf(enabled)('S_Shake and Tint on adjustment layers (native)', () => {
	it('keeps S19 (zoom, Reflect shake, keyframed Tint) native and names what it refuses', async () => {
		// The S19 layer as it is now (ASSEMBLY_S49_S89): a Transform zoom first, then the shake and the Tint ramp.
		const s19 = scene([
			fx('jasper.transform', { anchorPoint: [0.5, 0.4], position: [0.5, 0.4] }, '$tf'),
			key('$tf', 'scaleHeight', 10, 100),
			key('$tf', 'scaleHeight', 29, 140),
			fx('jasper.s.shake', S19_SHAKE, '$sh'),
			fx('jasper.tint', { amountToTint: 0 }, '$ti'),
			key('$ti', 'amountToTint', 0, 0),
			key('$ti', 'amountToTint', 29, 100),
		]);
		const ok = await plan(s19.d);
		expect(ok.blockers).toEqual([]);
		expect(ok.path).toBe('native');
		const blurred = await plan(scene([fx('jasper.s.shake', { ...S19_SHAKE, motionBlur: true }, '$sh')]).d);
		expect(blurred.path).not.toBe('native');
		expect(reasons(blurred)).toMatch(/S_Shake motion blur/);
	}, 120_000);

	it('draws a keyframed Tint of the composite below', async () => {
		const black = [0.1, 0.05, 0.3];
		const white = [1, 0.9, 0.6];
		const { d } = scene([
			fx('jasper.tint', { mapBlackTo: [...black, 1], mapWhiteTo: [...white, 1], amountToTint: 0 }, '$ti'),
			key('$ti', 'amountToTint', 0, 0),
			key('$ti', 'amountToTint', 20, 100),
		]);
		const got = await still(d, 10);
		expect(got.path).toBe('native');
		// Premiere's Tint at 50 %: mix(c, mix(black, white, Y709(c)), 0.5) on every pixel of the card.
		const src = goldenCard();
		const want = rgba8(GW, GH);
		for (let i = 0; i < GW * GH; i++) {
			const c = [0, 1, 2].map((k) => src.data[i * 4 + k]! / 255);
			const y = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
			want.data.set(
				[0, 1, 2].map((k) =>
					Math.round((c[k]! + (black[k]! + (white[k]! - black[k]!) * y - c[k]!) * 0.5) * 255),
				),
				i * 4,
			);
			want.data[i * 4 + 3] = 255;
		}
		const diff = diffImages(got.img, want);
		console.info(`[adjustment tint] keyframed 50 %: native vs formula ${formatDiff(diff)}`);
		expect(diff.maxAbs, formatDiff(diff)).toBeLessThanOrEqual(3);
	}, 120_000);

	it('draws an S_Shake that wraps with Reflect like its shader', async () => {
		// A strong shake (tens of px) so that the reflection at the frame edges is wide.
		const params = { ...S19_SHAKE, amplitude: 3, frequency: 4, xRandAmp: 0.3, yRandAmp: 0.3, tiltRandAmp: 1 };
		const { d, adj } = scene([fx('jasper.s.shake', params, '$sh')]);
		const frame = 7;
		const got = await still(d, frame);
		expect(got.path).toBe('native');
		// The shader's pose at the frame (its own `uniforms`, the frame context the compositions build).
		const snap = buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const c = snap.videoTracks.flatMap((t) => t.clips).find((x) => x.clipId === adj)!;
		const props = resolveLayerProps(c, clipContentTime(c, frame, snap.settings.fps));
		const e = props.effects.find((x) => x.effectId === 'jasper.s.shake')!;
		const sp = e.params as EffectParams;
		const ctx = {
			width: GW,
			height: GH,
			pxScale: 1,
			fps: 30,
			frame: frame - c.start,
			duration: c.duration,
			progress: 0,
			seed: fxSeed(c.clipId, e.id, sp),
		};
		const u = defaultEffectRegistry.get('jasper.s.shake')!.gpu!.uniforms!(sp, ctx) as unknown as {
			u_shakeNow: { vec4s: number[] };
		};
		const [dx, dy, cs, sn] = u.u_shakeNow.vec4s.slice(4, 8) as [number, number, number, number];
		expect(Math.hypot(dx, dy) * GW, 'the shake moves the frame by several px').toBeGreaterThan(4);
		// GLSL, literally: frame units (centre origin, 1 = the width), sh_src, dw_tap with Reflect on both axes.
		const pic = goldenCard();
		const reflect = (x: number) => {
			const t = ((x % 2) + 2) % 2;
			return t > 1 ? 2 - t : t;
		};
		const texel = (x: number, y: number, k: number) => pic.data[(y * GW + x) * 4 + k]!;
		const want = rgba8(GW, GH);
		for (let y = 0; y < GH; y++)
			for (let x = 0; x < GW; x++) {
				const fx0 = (x + 0.5 - GW / 2) / GW - dx;
				const fy0 = (y + 0.5 - GH / 2) / GW - dy;
				const sx = cs * fx0 + sn * fy0;
				const sy = -sn * fx0 + cs * fy0;
				const nx = Math.min(Math.max(reflect(sx + 0.5), 0.5 / GW), 1 - 0.5 / GW);
				const ny = Math.min(Math.max(reflect((sy * GW) / GH + 0.5), 0.5 / GH), 1 - 0.5 / GH);
				const u0 = nx * GW - 0.5;
				const v0 = ny * GH - 0.5;
				const iu = Math.floor(u0);
				const iv = Math.floor(v0);
				const fu = u0 - iu;
				const fv = v0 - iv;
				const iu1 = Math.min(GW - 1, iu + 1);
				const iv1 = Math.min(GH - 1, iv + 1);
				for (let k = 0; k < 3; k++)
					want.data[(y * GW + x) * 4 + k] = Math.round(
						texel(iu, iv, k) * (1 - fu) * (1 - fv) +
							texel(iu1, iv, k) * fu * (1 - fv) +
							texel(iu, iv1, k) * (1 - fu) * fv +
							texel(iu1, iv1, k) * fu * fv,
					);
				want.data[(y * GW + x) * 4 + 3] = 255;
			}
		const diff = diffImages(got.img, want);
		console.info(`[adjustment shake] Reflect: native vs the shader's pose ${formatDiff(diff)}`);
		expect(diff.psnr, formatDiff(diff)).toBeGreaterThan(45);
		expect(diff.p99, formatDiff(diff)).toBeLessThanOrEqual(3);
	}, 120_000);
});
