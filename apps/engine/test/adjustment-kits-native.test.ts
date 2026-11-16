// The editor's transition kits (LONG_PACK, automation/kits.ts) on the native path: every family's adjustment clips
// plan natively, and a chain of geometric effects (one GL pass each, blend/passes.ts) draws the composite like its
// shaders — Offset by a quarter frame then Mirror about the centre land on texel centres, so the expected picture is
// the card's pixels moved and reflected. The comparison with the Program preview's renderer per kit family is
// automation-kits-export.e2e and adjustment-transform-parity.e2e (REMOTION_E2E=1).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinKitPack, passItems, planDecorateCuts } from '@jasper/project';
import { diffImages, formatDiff } from '@jasper/testkit/golden';
import { rgba8 } from '@jasper/testkit/image';
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
	const dir = tempAppdir('jasper-adj-kits-');
	writeFileSync(join(dir, 'card.png'), encodePng(goldenCard()));
	card = await register(app, join(dir, 'card.png'));
}, 180_000);
afterAll(closeApps);

const CUT = 40;
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

/** The card on V1 over 0–80 (a cut in the middle for the kits). */
function cardDoc(): DocBuilder {
	const d = new DocBuilder();
	d.tx([{ type: 'sequence.updateSettings', settings: { width: GW, height: GH } }]);
	const m = d.addMedia(card);
	d.tx([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: CUT } },
			tracks: { video: 'V1' },
		},
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: CUT,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: CUT } },
			tracks: { video: 'V1' },
		},
	]);
	return d;
}

describe.runIf(enabled)('transition kits on adjustment layers (native)', () => {
	it('plans every LONG_PACK family natively', async () => {
		const pack = builtinKitPack('long-pack')!;
		for (const family of pack.families) {
			const d = cardDoc();
			const weights = Object.fromEntries(pack.families.map((f) => [f.id, f.id === family.id ? 1 : 0]));
			const plan = planDecorateCuts(d.doc, d.seqId, {
				pack: 'long-pack',
				families: weights,
				sfx: { enabled: false },
				seed: 3,
			});
			expect(plan.kits.map((k) => k.family)).toEqual([family.id]);
			d.tx(passItems(d.doc, plan).items.flatMap((it) => it.commands));
			const planned = (
				await coreServices(app).exports.plan({
					envelope: d.envelope(),
					sequenceId: d.seqId,
					settings: settings(d.seqId) as never,
				})
			).plan;
			expect(planned.blockers, family.id).toEqual([]);
			expect(planned.path, family.id).toBe('native');
		}
	}, 240_000);

	it('runs Offset then Mirror as two passes like their shaders', async () => {
		const d = cardDoc();
		d.tx([
			{ type: 'track.add', kind: 'video', count: 1 },
			{ type: 'clip.addAdjustment', at: 0, duration: 2 * CUT, track: 'V2', ref: '$a' },
			{
				type: 'effect.add',
				target: { clipId: '$a' },
				effectId: 'jasper.offset',
				params: { shiftCenterTo: [0.75, 0.5], blendWithOriginal: 0 },
			},
			{
				type: 'effect.add',
				target: { clipId: '$a' },
				effectId: 'jasper.mirror',
				params: { reflectionCenter: [0.5, 0.5], reflectionAngle: 0 },
			},
		]);
		const r = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 10 },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await coreServices(app).queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error ?? null)).toBe('succeeded');
		expect((done.result as { renderPath: string }).renderPath).toBe('native');
		const png = await app.inject({ method: 'GET', url: `/renders/${done.id}/output`, headers: H });
		const got = decodePng(png.rawPayload);
		// Offset (Shift Center To 0.75 = a quarter frame right, wrapping) then Mirror about x = ½, angle 0 (the right half
		// shows the left half reflected): column x shows the card's column (x′ − W/4) mod W with x′ = x < W/2 ? x : W−1−x.
		const src = goldenCard();
		const want = rgba8(GW, GH);
		for (let y = 0; y < GH; y++)
			for (let x = 0; x < GW; x++) {
				const xm = x < GW / 2 ? x : GW - 1 - x;
				const xs = (xm - GW / 4 + GW) % GW;
				want.data.set(src.data.subarray((y * GW + xs) * 4, (y * GW + xs) * 4 + 4), (y * GW + x) * 4);
			}
		const diff = diffImages(got, want);
		console.info(`[adjustment kits] Offset + Mirror: native vs moved card ${formatDiff(diff)}`);
		expect(diff.maxAbs, formatDiff(diff)).toBeLessThanOrEqual(2);
	}, 120_000);
});
