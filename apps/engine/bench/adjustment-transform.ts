// Run from the repository root: pnpm exec tsx apps/engine/bench/adjustment-transform.ts
// Export time of a sequence shaped like the S5 punch-in that sent whole exports to Remotion (docs/wp-notes/
// edit-structure.md "Native Transform on adjustment layers"): 1880 frames of 1080p30 video with a scaled overlay, an
// adjustment layer at 1037–1095 whose keyframed Transform (100 → 180 → 215 %, 360° shutter) punches in, exported at
// 1280×720 H.264; then a still inside the punch-in. `BENCH_CASE=s19`: S19's adjustment layer instead (ASSEMBLY_S9_S23:
// a fast, low-amplitude S_Shake wrapping with Reflect and Tint ramping to black and white, eased, over 1037–1227, after
// the 100 → 140 % zoom added later, ASSEMBLY_S49_S89). `BENCH_CASE=kits`: no adjustment of those, but the picture cut
// every 60 frames and Decorate Cuts' LONG_PACK transition kits on every cut (seed 1). Requires ffmpeg (and Chrome when the export plans Remotion). `BENCH_PORT` (default 0) and `BENCH_APPDIR` choose the
// engine's port and appdir. Prints one JSON line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	makeEnvelope,
	passItems,
	planDecorateCuts,
} from '@jasper/project';
import { startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';

const FRAMES = 1880;
const appdir = process.env.BENCH_APPDIR || mkdtempSync(join(tmpdir(), 'jasper-adj-tf-bench-'));
const media = mkdtempSync(join(tmpdir(), 'jasper-adj-tf-bench-media-'));
const ff = (args: string[]) => {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
	assert.equal(r.status, 0, r.stderr?.toString());
};
// A moving 1080p30 picture (LGPL encoder) and a still overlay.
ff([
	...['-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${FRAMES / 30 + 1}`],
	...['-c:v', 'mpeg4', '-q:v', '3', '-g', '30', join(media, 'video.mp4')],
]);
ff([...['-f', 'lavfi', '-i', 'mandelbrot=size=960x1080', '-frames:v', '1', join(media, 'overlay.png')]]);

const engine = await startEngine({
	appdir,
	port: Number(process.env.BENCH_PORT ?? 0),
	dev: true,
	env: {
		PATH: process.env.PATH,
		...(process.env.JASPER_BROWSER_EXECUTABLE
			? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
			: {}),
	},
});
const headers = {
	host: `127.0.0.1:${engine.port}`,
	authorization: `Bearer ${engine.token}`,
	'content-type': 'application/json',
};

async function registerMedia(path: string) {
	const r = await engine.app.inject({
		method: 'POST',
		url: '/api/media/register',
		headers,
		payload: { projectId: 'prj_0000000000000001', paths: [path] },
	});
	assert.equal(r.statusCode, 200, r.body);
	const { mediaKey: _k, browserPlayable: _b, ...asset } = r.json().items[0];
	return asset;
}

function edit(video: unknown, overlay: unknown) {
	const ids = createCounterIdSource(11);
	let doc = createEmptyProject({ ids, name: 'Adjustment Transform benchmark', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	let revision = 0;
	const results: unknown[] = [];
	const transact = (commands: unknown[]) => {
		const applied = applyTransaction(
			doc,
			{ label: 'benchmark', origin: 'user', sequenceId: seqId, commands: commands as never },
			{ ids, now: () => '2026-11-14T10:00:00.000Z', revision, registries: defaultRegistries() },
		);
		assert.ok(applied.result.ok, JSON.stringify(applied.result));
		doc = applied.document;
		revision = applied.result.revision;
		results.push(...applied.result.results);
		return applied.result;
	};
	transact([{ type: 'media.register', asset: { ...(video as object), derivation: null } }]);
	transact([{ type: 'media.register', asset: { ...(overlay as object), derivation: null } }]);
	const [v, o] = results.map((r) => (r as { mediaId: string }).mediaId);
	const key = (param: string, frame: number, value: unknown, ref = '$tf') => ({
		type: 'keyframe.add',
		target: ['effect', ref, param],
		at: { sequenceFrame: frame },
		value,
		interpolation: 'linear',
	});
	// The S5 zoom (ASSEMBLY_S3_S7 §3): anchor on the face, 100 → 180 % in 7 frames then → 215 %, position eased in.
	const s5 = [
		{ type: 'clip.addAdjustment', at: 1037, duration: 58, track: 'V3', ref: '$a' },
		{
			type: 'effect.add',
			target: { clipId: '$a' },
			effectId: 'jasper.transform',
			params: {
				anchorPoint: [0.79, 0.52],
				position: [0.79, 0.52],
				useCompShutterAngle: false,
				shutterAngle: 360,
			},
			ref: '$tf',
		},
		key('scaleHeight', 1037, 100),
		key('scaleHeight', 1044, 180),
		key('scaleHeight', 1094, 215),
		key('position', 1037, [0.79, 0.52]),
		key('position', 1044, [0.66, 0.5]),
	];
	// S19 (ASSEMBLY_S9_S23 §S19): the "edgy shake + B&W" adjustment layer.
	const s19 = [
		{ type: 'clip.addAdjustment', at: 1037, duration: 190, track: 'V3', ref: '$a' },
		{
			type: 'effect.add',
			target: { clipId: '$a' },
			effectId: 'jasper.transform',
			params: { anchorPoint: [0.5, 0.4], position: [0.5, 0.4] },
			ref: '$tz',
		},
		key('scaleHeight', 1140, 100, '$tz'),
		key('scaleHeight', 1227, 140, '$tz'),
		{
			type: 'effect.add',
			target: { clipId: '$a' },
			effectId: 'jasper.s.shake',
			params: {
				amplitude: 0.4,
				frequency: 30,
				xRandAmp: 0.052,
				yRandAmp: 0.052,
				tiltRandAmp: 0.1,
				seed: 0,
				motionBlur: false,
				wrapX: 'reflect',
				wrapY: 'reflect',
			},
		},
		{
			type: 'effect.add',
			target: { clipId: '$a' },
			effectId: 'jasper.tint',
			params: { amountToTint: 0 },
			ref: '$tf',
		},
		{ ...key('amountToTint', 1037, 0), interpolation: 'bezier' },
		key('amountToTint', 1224, 100),
	];
	const kits = process.env.BENCH_CASE === 'kits';
	// kits: the picture cut every 60 frames (each piece from another part of the video: real cuts).
	const pieces = kits
		? Array.from({ length: Math.ceil(FRAMES / 60) }, (_, i) => ({
				type: 'clip.place',
				source: { mediaId: v },
				at: i * 60,
				sourceRange: {
					in: { sourceFrames: (i * 397) % (FRAMES - 60) },
					out: { sourceFrames: ((i * 397) % (FRAMES - 60)) + Math.min(60, FRAMES - i * 60) },
				},
				tracks: { video: 'V1' },
			}))
		: [
				{
					type: 'clip.place',
					source: { mediaId: v },
					at: 0,
					sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: FRAMES } },
					tracks: { video: 'V1' },
				},
			];
	transact([
		...pieces,
		{ type: 'track.add', kind: 'video', count: 2 },
		{
			type: 'clip.place',
			source: { mediaId: o },
			at: 929,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 166 } },
			tracks: { video: 'V2' },
			ref: '$o',
		},
		{ type: 'param.set', target: ['clip', '$o', 'transform', 'scale'], value: 80 },
		{ type: 'param.set', target: ['clip', '$o', 'transform', 'position'], value: [1518, 648] },
		...(kits ? [] : process.env.BENCH_CASE === 's19' ? s19 : s5),
	]);
	if (kits) {
		const plan = planDecorateCuts(doc, seqId, { pack: 'long-pack', sfx: { enabled: false }, seed: 1 });
		transact(passItems(doc, plan).items.flatMap((it) => it.commands));
		console.info(`[adjustment kits bench] ${plan.kits.length} kits: ${JSON.stringify(plan.families)}`);
	}
	return {
		envelope: makeEnvelope(doc, { revision, savedAt: new Date().toISOString(), platform: 'benchmark' }),
		seqId,
	};
}

const settings = (sequenceId: string) => ({
	sequenceId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1280,
		height: 720,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 23 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

async function timed(url: string, payload: unknown) {
	const t0 = performance.now();
	const r = await engine.app.inject({ method: 'POST', url, headers, payload: payload as object });
	assert.equal(r.statusCode, 202, r.body);
	const done = await coreServices(engine.app).queue.wait(r.json().id);
	assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
	return {
		seconds: Math.round((performance.now() - t0) / 100) / 10,
		path: (done.result as { renderPath?: string }).renderPath,
	};
}

try {
	const d = edit(
		await registerMedia(join(media, 'video.mp4')),
		await registerMedia(join(media, 'overlay.png')),
	);
	const out: Record<string, unknown> = {
		machine: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30) },
		loadBefore: loadavg().map((x) => Math.round(x * 100) / 100),
		frames: FRAMES,
		at: new Date().toISOString(),
	};
	out.export = await timed('/api/exports', {
		envelope: d.envelope,
		sequenceId: d.seqId,
		settings: settings(d.seqId),
	});
	out.still1040 = await timed('/api/stills', { envelope: d.envelope, sequenceId: d.seqId, frame: 1040 });
	out.loadAfter = loadavg().map((x) => Math.round(x * 100) / 100);
	console.info(`[adjustment ${process.env.BENCH_CASE ?? 's5'} bench] ${JSON.stringify(out)}`);
	writeFileSync(join(media, 'result.json'), `${JSON.stringify(out, null, 2)}\n`);
} finally {
	await engine.stop();
	if (!process.env.BENCH_APPDIR) rmSync(appdir, { recursive: true, force: true });
	rmSync(media, { recursive: true, force: true });
}
