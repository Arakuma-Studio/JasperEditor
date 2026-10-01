// Parallel bakes end to end (S11:LBK-022, REMOTION_E2E=1): an export with eight baked layers (three static titles,
// a static shape, a keyframed title, two text-animator titles, an anime template) bakes them side by side within the
// export's page budget, in one shared render browser, and the result is the sequential path's: every cached master
// and still decodes to identical pixels, and so does the composite. A second export needing the same bakes while
// they render joins them (each rendered once); cancelling an export cancels every bake in flight and closes the
// shared browser.
// `LAYER_BAKE_BENCH=1` adds the benchmark (cold cache, rounds alternating the modes) used for the wp-notes.
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import type { ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { type LayerBakePrepared, layerBakeExtension } from '../src/layer-bake/extension.ts';
import type { BakeParallelism, LayerBakeService } from '../src/layer-bake/service.ts';
import { layerBakeService } from '../src/routes/layer-bake.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const bench = process.env.LAYER_BAKE_BENCH === '1';
const FIXTURE_V4 = join(
	__dirname,
	'..',
	'..',
	'..',
	'packages',
	'project',
	'test',
	'fixtures',
	'v4',
	'basic.jasper',
);
const v4 = JSON.parse(readFileSync(FIXTURE_V4, 'utf8')).document as ProjectDocument;
const v4seq = Object.values(v4.sequences)[0]!;

/** Measurements: console and `<tmpdir>/layer-bake-parallel.txt`. */
function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'layer-bake-parallel.txt'), `${new Date().toISOString()} ${line}\n`);
}

const load = () =>
	loadavg()
		.map((x) => x.toFixed(1))
		.join('/');

function inject(
	d: DocBuilder,
	clip: Record<string, unknown>,
	o: { id: string; track: string; start: number },
) {
	const seq = d.doc.sequences[d.seqId]!;
	const c = { ...structuredClone(clip), id: o.id, trackId: d.track(o.track), start: o.start };
	d.doc = {
		...d.doc,
		sequences: { ...d.doc.sequences, [d.seqId]: { ...seq, clips: { ...seq.clips, [o.id]: c as never } } },
	};
	d.revision++;
}

/**
 * 90 frames, eight DOM layers: static titles (3), a static shape → four `still.png`; a keyframed title (60 frames),
 * two text-animator titles (90 and 45 frames), an anime template (60 frames) → four masters. `tag` changes every
 * text (new keys without clearing the cache).
 */
function benchDoc(tag = ''): DocBuilder {
	const d = new DocBuilder('hd-720p-30');
	d.tx([{ type: 'track.add', kind: 'video', count: 7 }]);
	const text = (o: Record<string, unknown>) =>
		d.tx([{ type: 'clip.addText', ...o, ref: '$t' } as never]).refs.$t!;
	text({
		at: 0,
		duration: 90,
		track: 'V1',
		content: { text: `Static title${tag}`, style: { sizePx: 64, fill: [1, 0.9, 0.2, 1] } },
		box: { width: 520, height: 90, autoSize: 'none' },
		transform: { position: [640, 100] },
	});
	text({
		at: 30,
		duration: 60,
		track: 'V2',
		content: { text: `Second static${tag}`, style: { sizePx: 48 } },
		box: { width: 460, height: 70, autoSize: 'none' },
		transform: { position: [640, 200] },
	});
	text({
		at: 0,
		duration: 90,
		track: 'V3',
		content: { text: `Lower third · Name${tag}`, style: { sizePx: 40, weight: 700 } },
		box: { width: 600, height: 64, autoSize: 'none' },
		transform: { position: [400, 640] },
	});
	const moving = text({
		at: 10,
		duration: 60,
		track: 'V4',
		content: {
			text: `Moving title${tag}`,
			style: { sizePx: 56, shadow: { color: [0, 0, 0, 0.8], angleDeg: 45, distancePx: 6, blurPx: 8 } },
		},
		box: { width: 460, height: 80, autoSize: 'none' },
	});
	d.tx([
		{
			type: 'param.setAnimated',
			target: ['clip', moving, 'transform', 'position'],
			animated: true,
			at: { sequenceFrame: 10 },
		},
	] as never);
	d.tx([
		{
			type: 'param.set',
			target: ['clip', moving, 'transform', 'position'],
			value: [400, 500],
			at: { sequenceFrame: 69 },
		},
	] as never);
	text({
		at: 0,
		duration: 90,
		track: 'V5',
		content: { text: `Slide up by word${tag}`, style: { sizePx: 60 } },
		box: { width: 700, height: 90, autoSize: 'none' },
		transform: { position: [640, 360] },
		textAnimation: { in: { preset: 'slide-up', durationFrames: 20 } },
	});
	text({
		at: 20,
		duration: 45,
		track: 'V6',
		content: { text: `POP!${tag}`, style: { sizePx: 90, weight: 900 } },
		box: { width: 360, height: 120, autoSize: 'none' },
		transform: { position: [1000, 300] },
		textAnimation: { in: { preset: 'pop', durationFrames: 15 } },
	});
	const shape = structuredClone(v4seq.clips.clp_3ZN7BJXAHGY9J4G2) as unknown as Record<string, unknown>;
	(shape.transform as { position: { value: number[] } }).position.value = [1050, 560];
	(shape.transform as { scale: { value: number } }).scale.value = 40;
	inject(d, { ...shape, duration: 90 }, { id: 'clp_SHAPE0000000PAR1', track: 'V7', start: 0 });
	const anime = structuredClone(v4seq.clips.clp_VEYXW57CH91ZEK52) as unknown as Record<string, unknown>;
	(anime.transform as { scale: { value: number } }).scale.value = 30;
	(anime.transform as { position: { value: number[] } }).position.value = [250, 560];
	inject(
		d,
		{ ...anime, duration: 60, canvas: { width: 1280, height: 720 } },
		{ id: 'clp_ANIME0000000PAR1', track: 'V8', start: 15 },
	);
	return d;
}

/** Every frame of a video (or the PNG) as raw RGBA. */
function pixels(file: string): Buffer {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], {
		maxBuffer: 1 << 30,
	});
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

describe.runIf(enabled)('parallel bakes end to end (REMOTION_E2E=1, S11:LBK-022)', () => {
	let engine: RunningEngine;
	let svc: LayerBakeService;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });
	const queue = () => coreServices(engine.app).queue;
	const t = (s?: string) => Date.parse(s ?? '');

	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-lbp-e2e-'),
			port: 0,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		svc = layerBakeService(engine.app)!;
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const settings = (seqId: string) => ({
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		engine: 'native',
		video: {
			codec: 'prores',
			proresProfile: '4444',
			width: 1280,
			height: 720,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 10 },
			encoderSpeed: 'fast',
			colorTags: 'rec709',
		},
	});

	async function submit(d: DocBuilder): Promise<string> {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		return r.json().id as string;
	}

	async function finished(id: string): Promise<EngineJob> {
		await until(
			() => ['succeeded', 'failed', 'cancelled'].includes(queue().get(id)?.state ?? ''),
			1_800_000,
			200,
		);
		return queue().get(id)!;
	}

	const bakesOf = (id: string) =>
		queue()
			.list({})
			.filter((j) => j.parentId === id && j.kind === 'layer-bake');

	/** One export with `mode`; times: export, bake phase (export start → last bake finished). */
	async function exportWith(d: DocBuilder, mode: BakeParallelism) {
		svc.parallelism = mode;
		const before = { ...svc.stats };
		const la = load();
		const id = await submit(d);
		const done = await finished(id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const bakes = bakesOf(id);
		const start = t(done.startedAt);
		const bakeEnd = Math.max(start, ...bakes.map((k) => t(k.finishedAt)));
		return {
			id,
			done,
			bakes,
			out: join(coreServices(engine.app).config.paths.rendersDir, id, 'output.mov'),
			exportSec: (t(done.finishedAt) - start) / 1000,
			bakeSec: (bakeEnd - start) / 1000,
			rendered: svc.stats.rendered - before.rendered,
			fallbacks: svc.stats.clippedFallbacks - before.clippedFallbacks,
			browsers: svc.stats.browsers - before.browsers,
			load: `${la} → ${load()}`,
		};
	}

	const clearCache = () => {
		rmSync(svc.dir, { recursive: true, force: true });
		mkdirSync(svc.dir, { recursive: true });
	};
	const SEQUENTIAL: BakeParallelism = { maxInFlight: 1, sharedBrowser: false };
	const PARALLEL: BakeParallelism = { maxInFlight: null, sharedBrowser: true };

	it('bakes side by side in one browser; masters, stills and the composite equal the sequential path', async () => {
		const d = benchDoc();
		// Warm-up (bundle, GL probe, fonts), then the sequential path on a cold cache: the reference.
		await exportWith(benchDoc(' warm-up'), PARALLEL);
		clearCache();
		const seq = await exportWith(d, SEQUENTIAL);
		expect(seq.bakes).toHaveLength(8);
		expect(seq.rendered).toBe(8);
		expect(seq.browsers).toBe(0);
		const reference = join(tempAppdir('jasper-lbp-ref-'), 'layers');
		cpSync(svc.dir, reference, { recursive: true });
		clearCache();
		const par = await exportWith(d, PARALLEL);
		expect(par.bakes).toHaveLength(8);
		expect(par.rendered).toBe(8);
		expect(par.browsers).toBe(1);
		// Bakes overlapped (at least two in flight at some point).
		const spans = par.bakes.map((k) => [t(k.startedAt), t(k.finishedAt)] as const);
		const overlap = Math.max(...spans.map(([s]) => spans.filter(([a, b]) => a <= s && s < b).length));
		expect(overlap).toBeGreaterThanOrEqual(2);
		report(
			`[LBK parallel] sequential: bake phase ${seq.bakeSec.toFixed(1)} s, export ${seq.exportSec.toFixed(1)} s (load ${seq.load}); parallel: ${par.bakeSec.toFixed(1)} s, ${par.exportSec.toFixed(1)} s (load ${par.load}); max bakes in flight ${overlap}`,
		);
		// Same keys, same files: identical bytes, else identical decoded pixels.
		const keys = readdirSync(reference).filter((k) => /^[0-9a-f]{40}$/.test(k));
		expect(keys).toHaveLength(8);
		let identicalBytes = 0;
		for (const key of keys) {
			const file = existsSync(join(reference, key, 'master.mov')) ? 'master.mov' : 'still.png';
			const a = join(reference, key, file);
			const b = join(svc.dir, key, file);
			expect(existsSync(b), `${key}/${file}`).toBe(true);
			const ra = JSON.parse(readFileSync(join(reference, key, 'meta.json'), 'utf8')) as { rect: unknown };
			const rb = JSON.parse(readFileSync(join(svc.dir, key, 'meta.json'), 'utf8')) as { rect: unknown };
			expect(rb.rect).toEqual(ra.rect);
			if (readFileSync(a).equals(readFileSync(b))) {
				identicalBytes++;
				continue;
			}
			expect(pixels(b).equals(pixels(a)), `${key}/${file} decodes to other pixels`).toBe(true);
		}
		const composite = pixels(par.out).equals(pixels(seq.out));
		report(
			`[LBK parallel] ${identicalBytes}/${keys.length} cache files byte-identical, all ${keys.length} pixel-identical; composite pixel-identical: ${composite}`,
		);
		expect(composite).toBe(true);
	}, 1_800_000);

	it('a second export needing the same bakes while they render joins them: each is rendered once', async () => {
		clearCache();
		svc.parallelism = PARALLEL;
		const before = { ...svc.stats };
		const d = benchDoc();
		const a = await submit(d);
		await until(() => bakesOf(a).some((k) => k.state === 'running'), 600_000, 50);
		// A second export preparing the same layers at the same time (exports may run side by side with half the
		// CPU slots each): its `prepare` under its own job id.
		const planned = await coreServices(engine.app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const second = (await layerBakeExtension(svc).prepare!(planned, {
			signal: new AbortController().signal,
			stage: () => undefined,
			scratchDir: async () => tempAppdir('jasper-lbp-second-'),
			log: () => undefined,
			jobId: 'job_SECONDEXPORT0000',
			purpose: 'native',
			concurrency: 3,
		})) as LayerBakePrepared;
		const da = await finished(a);
		expect(da.state, JSON.stringify(da.error)).toBe('succeeded');
		expect(second.size).toBe(8);
		expect(svc.stats.rendered - before.rendered).toBe(8);
		expect(svc.stats.joined - before.joined).toBeGreaterThanOrEqual(1);
		const paths = new Set(bakesOf(a).map((k) => (k.result as { path: string }).path));
		for (const p of second.values()) expect(paths.has(p.override!.path)).toBe(true);
		report(
			`[LBK parallel] second export at the same time: ${svc.stats.joined - before.joined} bake(s) joined, ${svc.stats.reused - before.reused} reused, 8 rendered in all`,
		);
	}, 1_800_000);

	it('cancelling the export cancels every bake in flight and closes the shared browser', async () => {
		clearCache();
		svc.parallelism = PARALLEL;
		const id = await submit(benchDoc());
		await until(() => bakesOf(id).filter((k) => k.state === 'running').length >= 2, 600_000, 100);
		const browsersBefore = svc.stats.browsers;
		queue().cancel(id);
		const done = await finished(id);
		expect(done.state).toBe('cancelled');
		await until(
			() => bakesOf(id).every((k) => ['cancelled', 'succeeded', 'failed'].includes(k.state)),
			10_000,
			100,
		);
		const states = bakesOf(id).map((k) => k.state);
		expect(states.filter((s) => s === 'cancelled').length).toBeGreaterThanOrEqual(2);
		expect(states).not.toContain('failed');
		expect(browsersBefore).toBeGreaterThan(0);
		// No session left open (the release closed the browser).
		expect((svc as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
	}, 1_200_000);

	it.runIf(bench)(
		'benchmark: cold-cache exports, modes alternating (LAYER_BAKE_BENCH=1)',
		async () => {
			const allModes: [string, BakeParallelism][] = [
				['sequential', SEQUENTIAL],
				['parallel, own browsers', { maxInFlight: null, sharedBrowser: false }],
				['parallel, shared browser', PARALLEL],
				['parallel ×3, shared browser', { maxInFlight: 3, sharedBrowser: true }],
			];
			// `LAYER_BAKE_BENCH_MODES=sequential,shared` runs the modes whose name contains one of the words.
			const only = process.env.LAYER_BAKE_BENCH_MODES?.split(',');
			const modes = allModes.filter(([name]) => !only || only.some((m) => name.includes(m)));
			const rounds = Number(process.env.LAYER_BAKE_BENCH_ROUNDS ?? 3);
			report(`[LBK bench] ${availableParallelism()} cores, ${rounds} rounds, load ${load()}`);
			await exportWith(benchDoc(' bench warm-up'), PARALLEL);
			const all: Record<string, number[]> = {};
			for (let r = 0; r < rounds; r++)
				for (const [name, mode] of modes) {
					// Cold cache, same document (longer texts would overflow their boxes and re-render full frame).
					clearCache();
					const res = await exportWith(benchDoc(), mode);
					expect(res.rendered).toBe(8);
					(all[name] ??= []).push(res.bakeSec);
					report(
						`[LBK bench] round ${r} ${name}: bake phase ${res.bakeSec.toFixed(1)} s, export ${res.exportSec.toFixed(1)} s, rendered ${res.rendered}, browsers ${res.browsers}, full-frame fallbacks ${res.fallbacks}, load ${res.load}`,
					);
					// Timeline: start offset from the export's start and duration of every bake.
					const t0 = t(res.done.startedAt);
					report(
						`[LBK bench]   ${res.bakes
							.map(
								(k) =>
									[
										t(k.startedAt) - t0,
										t(k.finishedAt) - t(k.startedAt),
										k.title.replace(/^Bake graphics – /, ''),
									] as const,
							)
							.sort((a, b) => a[0] - b[0])
							.map(([s0, d, n]) => `${n.slice(0, 12)} @${(s0 / 1000).toFixed(1)}+${(d / 1000).toFixed(1)}`)
							.join(', ')}`,
					);
				}
			for (const [name, xs] of Object.entries(all)) {
				const sorted = [...xs].sort((a, b) => a - b);
				report(
					`[LBK bench] ${name}: bake phase median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} s (${xs.map((x) => x.toFixed(1)).join(', ')})`,
				);
			}
		},
		7_200_000,
	);
});
