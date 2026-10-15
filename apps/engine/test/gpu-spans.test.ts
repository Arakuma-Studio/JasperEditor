// Missing span renderers must fall back safely; changed span inputs must not reuse stale cached pixels.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BakeEnvironment } from '../src/layer-bake/key.ts';
import type { LayerBakeService } from '../src/layer-bake/service.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

function solidsWithPush(): { d: DocBuilder; t: string } {
	const d = new DocBuilder();
	d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
	d.tx([{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] }]);
	const t = d.tx([
		{ type: 'transition.add', trackId: 'V1', at: 30, effectId: 'jasper.push', duration: 20, ref: '$t' },
	]).refs.$t!;
	return { d, t };
}

describe('planner: missing span renderer', () => {
	it('without a span renderer (no layer-bake extension) a GPU transition still sends the export to Remotion', async () => {
		const { d, t } = solidsWithPush();
		const { planExport } = await import('../src/export/planner.ts');
		const bare = await planExport(
			{ envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) as never },
			{
				registry: coreServices(app).registry,
				fonts: coreServices(app).fonts,
				capabilities: { native: true, remotionLocal: 'ready', fframes: 'ready', mgMasters: true },
				extensions: [],
			},
		);
		expect(bare.plan.path).toBe('remotion');
		expect(bare.plan.blockers.some((b) => b.itemId === t && b.reason.includes('Push'))).toBe(true);
	});
});

describe('span bakes: the cache key covers the transition inputs (wave-4 transition polish)', () => {
	const ENV: BakeEnvironment = {
		bundleId: 'b1',
		animejs: '4.0.0',
		remotion: '4.0.499',
		browser: 'c',
		gl: 'swiftshader',
	};

	it("includes the image params' media fingerprint and the sides' tracks", async () => {
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] },
		]);
		const img = d.addMedia(await register(app, fixture('still.png')));
		d.tx([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 30,
				effectId: 'jasper.gradient-wipe',
				duration: 20,
				params: { gradientImage: { mediaId: img } },
			},
		]);
		const svc = app.jasper.services.layerBake as LayerBakeService;
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const track = planned.snapshot.videoTracks[0]!;
		const t = track.transitions![0]!;
		const span = await svc.planSpan(planned, track.trackId, t, { env: ENV });
		const again = await svc.planSpan(planned, track.trackId, t, { env: ENV });
		expect(again.key).toBe(span.key);
		const local = planned.media[img];
		if (local) local.record = { ...local.record, fingerprint: 'q1:other' } as never;
		planned.document.media[img] = { ...planned.document.media[img]!, fingerprint: 'q1:other' };
		const changed = await svc.planSpan(planned, track.trackId, t, { env: ENV });
		expect(changed.key).not.toBe(span.key);
		// The sides' tracks are part of the transition, hence of the key.
		const frame = {
			kind: 'point' as const,
			corners: null,
			point: [10, 10] as [number, number],
			confidence: 1,
			tracked: true,
		};
		const tracked = await svc.planSpan(
			planned,
			track.trackId,
			{ ...t, tracks: { in: { trackerId: 'tkr_1', name: 'T', kind: 'point', frames: [frame] } } },
			{ env: ENV },
		);
		expect(tracked.key).not.toBe(changed.key);
	});
});
