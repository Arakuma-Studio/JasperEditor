// Transform on adjustment layers on the native path (blend/adjust.ts, docs/wp-notes/edit-structure.md "Native
// Transform on adjustment layers"): the planner keeps such exports native and names what it refuses; native stills
// of the composite below drawn through a static Transform and a keyframed one with a 360° shutter are compared with
// references computed here from Premiere's Transform definition (out = position + R·S·(src − anchor), a box shutter
// centred on the frame). The comparison with the Program preview's renderer is adjustment-transform-parity.e2e.test.ts.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDiff, diffImages as imageDiff } from '@jasper/testkit/golden';
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
	const dir = tempAppdir('jasper-adj-tf-');
	writeFileSync(join(dir, 'card.png'), encodePng(goldenCard()));
	card = await register(app, join(dir, 'card.png'));
}, 180_000);
afterAll(closeApps);

type Cmd = Record<string, unknown>;
const TF = (params: Record<string, unknown>): Cmd => ({
	type: 'effect.add',
	target: { clipId: '$a' },
	effectId: 'jasper.transform',
	params,
	ref: '$tf',
});
const key = (param: string, frame: number, value: unknown): Cmd => ({
	type: 'keyframe.add',
	target: ['effect', '$tf', param],
	at: { sequenceFrame: frame },
	value,
	interpolation: 'linear',
});

/** The card on V1 (GW×GH, 30 fps) and an adjustment layer on V2 over frames 0–30 with `commands`. */
function scene(commands: Cmd[]): DocBuilder {
	const d = new DocBuilder();
	d.tx([{ type: 'sequence.updateSettings', settings: { width: GW, height: GH } }]);
	const m = d.addMedia(card);
	d.tx([
		{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1' } },
		{ type: 'track.add', kind: 'video', count: 1 },
		{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V2', ref: '$a' },
		...commands,
	]);
	return d;
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

type Pose = { anchor: [number, number]; position: [number, number]; scale: number; rotation: number };

/**
 * Reference: the picture `src` drawn through Transform `pose` (fractions of the frame, scale in %, degrees): every
 * output pixel centre maps back to src = anchor + (R·S)⁻¹ · (out − position), sampled bilinearly (premultiplied,
 * texel centres), transparent outside the picture. Returns premultiplied colour + alpha in floats.
 */
function drawn(src: Rgba8, pose: Pose): Float64Array {
	const { width: W, height: H } = src;
	const out = new Float64Array(W * H * 4);
	const s = pose.scale / 100;
	const t = (pose.rotation * Math.PI) / 180;
	const [ax, ay] = [pose.anchor[0] * W, pose.anchor[1] * H];
	const [px, py] = [pose.position[0] * W, pose.position[1] * H];
	const texel = (x: number, y: number, k: number) => {
		const i = (y * W + x) * 4;
		return k === 3 ? src.data[i + 3]! / 255 : ((src.data[i + k]! / 255) * src.data[i + 3]!) / 255;
	};
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const dx = x + 0.5 - px;
			const dy = y + 0.5 - py;
			const u = ax + (Math.cos(t) * dx + Math.sin(t) * dy) / s;
			const v = ay + (-Math.sin(t) * dx + Math.cos(t) * dy) / s;
			if (u < 0 || v < 0 || u > W || v > H) continue;
			const su = Math.min(W - 1, Math.max(0, u - 0.5));
			const sv = Math.min(H - 1, Math.max(0, v - 0.5));
			const iu = Math.floor(su);
			const iv = Math.floor(sv);
			const fx = su - iu;
			const fy = sv - iv;
			const iu1 = Math.min(W - 1, iu + 1);
			const iv1 = Math.min(H - 1, iv + 1);
			for (let k = 0; k < 4; k++)
				out[(y * W + x) * 4 + k] =
					texel(iu, iv, k) * (1 - fx) * (1 - fy) +
					texel(iu1, iv, k) * fx * (1 - fy) +
					texel(iu, iv1, k) * (1 - fx) * fy +
					texel(iu1, iv1, k) * fx * fy;
		}
	return out;
}

/** Premultiplied floats → the adjustment's output over black (premultiplied colour, alpha 1). */
function onBlack(p: Float64Array, W: number, H: number): Rgba8 {
	const img = rgba8(W, H);
	for (let i = 0; i < W * H; i++)
		img.data.set([0, 1, 2].map((k) => Math.round(Math.min(1, p[i * 4 + k]!) * 255)).concat(255), i * 4);
	return img;
}

describe.runIf(enabled)('Transform on adjustment layers (native)', () => {
	it('keeps the export native and names the adjustment cases it refuses', async () => {
		const tf = scene([TF({ scaleHeight: 150, useCompShutterAngle: false, shutterAngle: 360 })]);
		const ok = await plan(tf);
		expect(ok.blockers).toEqual([]);
		expect(ok.path).toBe('native');
		// An effect before the Transform would have to run on the composite first: refused by name.
		const before = scene([
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' },
			TF({ scaleHeight: 150 }),
		]);
		const refused = await plan(before);
		expect(refused.path).not.toBe('native');
		expect(refused.blockers.map((b) => b.reason).join('\n')).toMatch(
			/jasper\.black-white before a geometric effect/,
		);
	}, 120_000);

	it('draws the composite below through a static Transform', async () => {
		const pose: Pose = { anchor: [0.6, 0.4], position: [0.5, 0.55], scale: 150, rotation: 8 };
		const d = scene([
			TF({
				anchorPoint: pose.anchor,
				position: pose.position,
				scaleHeight: pose.scale,
				rotation: pose.rotation,
			}),
		]);
		const got = await still(d, 10);
		expect(got.path).toBe('native');
		const want = onBlack(drawn(goldenCard(), pose), GW, GH);
		const diff = imageDiff(got.img, want);
		console.info(`[adjustment transform] static: native vs reference ${formatDiff(diff)}`);
		expect(diff.psnr, formatDiff(diff)).toBeGreaterThan(40);
		expect(diff.p99, formatDiff(diff)).toBeLessThanOrEqual(4);
	}, 120_000);

	it('blurs a keyframed Transform over its 360° shutter', async () => {
		// Scale 100 % → 190 % over frames 0–12 (linear) about the anchor (0.62, 0.32), the white disc of the card.
		const d = scene([
			TF({
				anchorPoint: [0.62, 0.32],
				position: [0.62, 0.32],
				useCompShutterAngle: false,
				shutterAngle: 360,
			}),
			key('scaleHeight', 0, 100),
			key('scaleHeight', 12, 190),
		]);
		const got = await still(d, 6);
		expect(got.path).toBe('native');
		// Box shutter of one frame centred on frame 6: 256 poses over frames 5.5 … 6.5 (scale 7.5 % per frame).
		const N = 256;
		const sum = new Float64Array(GW * GH * 4);
		for (let i = 0; i < N; i++) {
			const t = 5.5 + (i + 0.5) / N;
			const p = drawn(goldenCard(), {
				anchor: [0.62, 0.32],
				position: [0.62, 0.32],
				scale: 100 + 7.5 * t,
				rotation: 0,
			});
			for (let k = 0; k < sum.length; k++) sum[k]! += p[k]! / N;
		}
		const want = onBlack(sum, GW, GH);
		const diff = imageDiff(got.img, want);
		console.info(
			`[adjustment transform] keyframed 360°: native vs box-shutter reference ${formatDiff(diff)}`,
		);
		expect(diff.psnr, formatDiff(diff)).toBeGreaterThan(38);
		expect(diff.p99, formatDiff(diff)).toBeLessThanOrEqual(6);
		// The single pose at frame 6 is visibly sharper than the shutter: the blur is there.
		const sharp = imageDiff(
			got.img,
			onBlack(
				drawn(goldenCard(), { anchor: [0.62, 0.32], position: [0.62, 0.32], scale: 145, rotation: 0 }),
				GW,
				GH,
			),
		);
		console.info(`[adjustment transform] keyframed 360°: native vs the unblurred pose ${formatDiff(sharp)}`);
		expect(sharp.psnr).toBeLessThan(diff.psnr - 3);
	}, 120_000);
});
