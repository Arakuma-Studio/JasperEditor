// Run from the repository root: pnpm exec tsx apps/engine/bench/automation-kits.ts
// Spec 15 EA-033: compare a 202 s 1080p export with the same edit carrying 100 long-form or shake kits.
// Requires ffmpeg and headless Chrome. This reports measured cost; rendering regression oracles live in
// test/automation-kits-export.test.ts. Hold the benchmark lock while measuring (wp-note edit-automation).
import assert from 'node:assert/strict';
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

const CLIP = 60;
const CLIPS = 101;
const settings = (sequenceId: string) => ({
	sequenceId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 20 },
		encoderSpeed: 'fast',
	},
});

function edit(pack?: 'long-pack' | 'shorts-shake') {
	const ids = createCounterIdSource(11);
	let doc = createEmptyProject({ ids, name: 'Kit benchmark', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	let revision = 0;
	const transact = (commands: unknown[]) => {
		const applied = applyTransaction(
			doc,
			{ label: 'benchmark', origin: 'user', sequenceId: seqId, commands },
			{ ids, now: () => '2026-09-30T10:00:00.000Z', revision, registries: defaultRegistries() },
		);
		assert.ok(applied.result.ok, JSON.stringify(applied.result));
		doc = applied.document;
		revision = applied.result.revision;
	};
	const colours = [
		[0.1, 0.2, 0.8, 1],
		[0.15, 0.6, 0.2, 1],
		[0.7, 0.2, 0.3, 1],
	];
	transact([
		...Array.from({ length: CLIPS }, (_, i) => ({
			type: 'clip.addSolid',
			at: i * CLIP,
			duration: CLIP,
			track: 'V1',
			color: colours[i % 3],
		})),
		{ type: 'track.add', kind: 'video' },
		{
			type: 'clip.addSolid',
			at: 0,
			duration: CLIPS * CLIP,
			track: 'V2',
			color: [0.95, 0.8, 0.1, 1],
			ref: '$sq',
		},
		{ type: 'param.set', target: ['clip', '$sq', 'transform', 'scale'], value: 20 },
	]);
	let families: Record<string, number> | undefined;
	if (pack) {
		const plan = planDecorateCuts(doc, seqId, { pack, sfx: { enabled: false }, seed: 1 });
		assert.equal(plan.kits.length, 100);
		families = plan.families;
		transact(passItems(doc, plan).items.flatMap((item) => item.commands));
	}
	return {
		envelope: makeEnvelope(doc, { revision, savedAt: new Date().toISOString(), platform: 'benchmark' }),
		seqId,
		families,
	};
}

const appdir = mkdtempSync(join(tmpdir(), 'jasper-kits-bench-'));
const engine = await startEngine({
	appdir,
	port: 0,
	dev: true,
	env: {
		PATH: process.env.PATH,
		...(process.env.JASPER_BROWSER_EXECUTABLE
			? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
			: {}),
	},
});

async function timedExport(pack?: 'long-pack' | 'shorts-shake') {
	const d = edit(pack);
	const t0 = performance.now();
	const response = await engine.app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: {
			host: `127.0.0.1:${engine.port}`,
			authorization: `Bearer ${engine.token}`,
			'content-type': 'application/json',
		},
		payload: { envelope: d.envelope, sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	assert.equal(response.statusCode, 202, response.body);
	const done = await coreServices(engine.app).queue.wait(response.json().id);
	assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
	return {
		seconds: (performance.now() - t0) / 1000,
		path: (done.result as { renderPath?: string }).renderPath,
		families: d.families,
	};
}

try {
	const out: Record<string, unknown> = {
		machine: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30) },
		loadBefore: loadavg(),
		frames: CLIPS * CLIP,
		at: new Date().toISOString(),
	};
	const plain = await timedExport();
	out.plain = plain;
	for (const pack of ['long-pack', 'shorts-shake'] as const) {
		const measured = await timedExport(pack);
		out[pack] = { ...measured, perKitSeconds: (measured.seconds - plain.seconds) / 100 };
	}
	out.loadAfter = loadavg();
	console.info(`[kits bench] ${JSON.stringify(out)}`);
	writeFileSync(
		new URL('./automation-kits.results.json', import.meta.url),
		`${JSON.stringify(out, null, 2)}\n`,
	);
} finally {
	await engine.stop();
	rmSync(appdir, { recursive: true, force: true });
}
