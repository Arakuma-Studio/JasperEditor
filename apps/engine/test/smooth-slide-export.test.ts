// Smooth Slide on every export path (AGENTS §4): the planner bakes its span on the native path (hybrid, D-35) or
// sends the export to Remotion with a blocker naming it when no span renderer exists; with REMOTION_E2E=1 the hybrid
// and the Remotion exports are compared frame by frame with full-sequence Remotion stills (the composition the
// Player draws), over a two-sided cut with dolly + reflection + motion blur and a one-sided head on an upper track.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineJob, RenderPlanSchema } from '@jasper/api';
import { buildRenderSnapshot } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	JSON_H,
	makeApp,
	register,
	type TestApp,
	tempAppdir,
	until,
} from './helpers.ts';

const SLIDE = 'jasper.smooth-slide';
const HEAVY = {
	direction: 'left',
	animation: 'easeInOutQuad',
	dolly: 0.8,
	reflection: true,
	blurriness: 10,
	falloff: 0.2,
	aspect: 1,
	motionBlur: 'high',
	shutterAngle: 360,
	edgeSmoothing: 'low',
};

const settings = (seqId: string, engine: 'auto' | 'remotion' = 'auto', w = 1920, h = 1080) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mov',
	engine,
	video: {
		codec: 'prores',
		proresProfile: '4444',
		width: w,
		height: h,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
	},
});

describe('planner: Smooth Slide renders on every export path', () => {
	let app: TestApp;
	beforeAll(async () => {
		ensureFixtures();
		app = await makeApp();
	}, 180_000);
	afterAll(closeApps);

	function doc(oneSided: boolean) {
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1], ref: '$b' },
		]);
		if (oneSided) {
			d.tx([{ type: 'track.add', kind: 'video', count: 1 }]);
			const c = d.tx([
				{ type: 'clip.addSolid', at: 10, duration: 30, track: 'V2', color: [0, 1, 0, 1], ref: '$c' },
			]).refs.$c!;
			d.tx([{ type: 'transition.add', clipId: c, edge: 'in', effectId: SLIDE, duration: 8, params: HEAVY }]);
		} else
			d.tx([{ type: 'transition.add', trackId: 'V1', at: 30, effectId: SLIDE, duration: 12, params: HEAVY }]);
		return d;
	}

	it('native export: the span is baked (hybrid), no blocker', async () => {
		for (const oneSided of [false, true]) {
			const d = doc(oneSided);
			const r = await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
			});
			expect(r.statusCode, r.body).toBe(200);
			const plan = RenderPlanSchema.parse(r.json());
			expect(plan.path, `oneSided=${oneSided}`).toBe('hybrid');
			expect(plan.blockers).toEqual([]);
			expect(plan.segments.flatMap((s) => s.graphicsGroups ?? [])).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ engine: 'remotion', itemIds: [expect.stringMatching(/^trn_/)] }),
				]),
			);
		}
	});

	it('without a span renderer the export goes to Remotion with a blocker naming Smooth Slide', async () => {
		const d = doc(false);
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
		expect(bare.plan.blockers.some((b) => b.path === 'native' && b.reason.includes('Smooth Slide'))).toBe(
			true,
		);
	});
});

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);

function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'smooth-slide-export.txt'), `${new Date().toISOString()} ${line}\n`);
}

function decode(file: string, frame?: number): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file],
			...(frame !== undefined ? ['-vf', `select=eq(n\\,${frame})`] : []),
			...['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

/** Share of samples within tol and the mean absolute difference. */
function compare(a: Uint8Array, b: Uint8Array, tol: number): { share: number; mean: number } {
	expect(a.length).toBe(b.length);
	let n = 0;
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i]! - b[i]!);
		if (d <= tol) n++;
		sum += d;
	}
	return { share: n / a.length, mean: sum / a.length };
}

/** A detailed picture (bars, a ramp, a grid) so geometry, reflection and blur differences show. */
function makeCard(name: string, hue: number): string {
	const w = 1280;
	const h = 720;
	const raw = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const grid = x % 80 < 4 || y % 80 < 4;
			const bar = Math.floor((x / w) * 6);
			const v = Math.round((255 * y) / (h - 1));
			raw.set(grid ? [255, 255, 255] : [(bar * 40 + hue) % 256, v, (255 - v + hue) % 256], (y * w + x) * 3);
		}
	const dir = mkdtempSync(join(tmpdir(), 'jasper-slide-card-'));
	writeFileSync(join(dir, `${name}.rgb`), raw);
	const out = join(dir, `${name}.png`);
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`],
		...['-i', join(dir, `${name}.rgb`), '-frames:v', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

describe.runIf(enabled)('Smooth Slide exports match the composition (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir('jasper-smooth-slide-'),
			port: PORT,
			// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const queue = () => coreServices(engine.app).queue;
	async function exportDoc(d: DocBuilder, s: ReturnType<typeof settings>) {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const id = r.json().id as string;
		await until(
			() => ['succeeded', 'failed', 'cancelled'].includes(queue().get(id)?.state ?? ''),
			3_600_000,
			250,
		);
		const done = queue().get(id)! as EngineJob;
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return { done, out: (await coreServices(engine.app).exports.outputFile(done.id))! };
	}

	async function still(d: DocBuilder, frame: number): Promise<Buffer> {
		const svc = coreServices(engine.app);
		const doc = buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: (asset) => {
				const key = asset.locators.find((l) => l.type === 'engine-store')?.key;
				if (!key) throw new Error(`Missing engine-store locator for ${asset.id}`);
				return {
					url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(key)}`),
					proxyUrl: null,
					kind: asset.kind,
					width: 1280,
					height: 720,
					durationFlicks: null,
					hasAudio: false,
					rotation: 0,
				};
			},
		});
		const ref = join(tempAppdir('jasper-slide-ref-'), 'ref.png');
		await svc.remotion.renderStill({
			inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
			output: ref,
			frame,
			signal: new AbortController().signal,
		});
		return decode(ref);
	}

	it('hybrid and Remotion exports of a heavy Smooth Slide match the composition frame by frame', async () => {
		const a = await register(engine.app, makeCard('a', 0), hostH());
		const b = await register(engine.app, makeCard('b', 128), hostH());
		const d = new DocBuilder('hd-720p-30');
		const am = d.addMedia(a);
		const bm = d.addMedia(b);
		const ca = d.tx([{ type: 'clip.place', source: { mediaId: am }, at: 0, ref: '$a' }]).refs.$a!;
		d.tx([{ type: 'clip.trim', clipId: ca, edge: 'out', deltaFrames: -110, mode: 'regular' }]);
		const cb = d.tx([{ type: 'clip.place', source: { mediaId: bm }, at: 40, ref: '$b' }]).refs.$b!;
		d.tx([{ type: 'clip.trim', clipId: cb, edge: 'out', deltaFrames: -110, mode: 'regular' }]);
		d.tx([{ type: 'transition.add', trackId: 'V1', at: 40, effectId: SLIDE, duration: 16, params: HEAVY }]);
		// One-sided head on V2 (a smaller solid sliding in from the top over the cut picture).
		d.tx([{ type: 'track.add', kind: 'video', count: 1 }]);
		const s = d.tx([
			{ type: 'clip.addSolid', at: 50, duration: 25, track: 'V2', color: [0.9, 0.6, 0.1, 1], ref: '$s' },
		]).refs.$s!;
		d.tx([
			{ type: 'param.set', target: ['clip', s, 'transform', 'scale'], value: 40 },
			{
				type: 'transition.add',
				clipId: s,
				edge: 'in',
				effectId: SLIDE,
				duration: 10,
				params: { direction: 'down', animation: 'easeOutCubic', motionBlur: 'medium', edgeSmoothing: 'high' },
			},
		]);
		const hybrid = await exportDoc(d, settings(d.seqId, 'auto', 1280, 720));
		expect(hybrid.done.result).toMatchObject({ renderPath: 'hybrid' });
		const remotion = await exportDoc(d, settings(d.seqId, 'remotion', 1280, 720));
		expect(remotion.done.result).toMatchObject({ renderPath: 'remotion' });
		// The hybrid path encodes the span master losslessly enough for a strict per-sample check. The Remotion export
		// goes through its ProRes 422 HQ intermediate (Remotion's JPEG frames + 4:2:2 chroma), which costs every frame the
		// same codec error around sharp edges: measure that on frames without a transition and require the transition
		// frames to be no worse (the transition itself adds no path-specific difference).
		const lines: string[] = [];
		const base: { share: number; mean: number }[] = [];
		for (const f of [5, 20, 78]) {
			const ref = await still(d, f);
			const h = compare(decode(hybrid.out, f), ref, 3);
			const r = compare(decode(remotion.out, f), ref, 3);
			lines.push(
				`f${f} (no transition) hybrid ${h.share.toFixed(4)}/${h.mean.toFixed(3)} remotion ${r.share.toFixed(4)}/${r.mean.toFixed(3)}`,
			);
			expect(h.share, `hybrid frame ${f}`).toBeGreaterThanOrEqual(0.99);
			base.push(r);
		}
		const minShare = Math.min(...base.map((b) => b.share));
		const maxMean = Math.max(...base.map((b) => b.mean));
		for (const f of [32, 35, 39, 40, 44, 47, 50, 54, 57, 70]) {
			const ref = await still(d, f);
			const h = compare(decode(hybrid.out, f), ref, 3);
			const r = compare(decode(remotion.out, f), ref, 3);
			lines.push(
				`f${f} hybrid ${h.share.toFixed(4)}/${h.mean.toFixed(3)} remotion ${r.share.toFixed(4)}/${r.mean.toFixed(3)}`,
			);
			expect(h.share, `hybrid frame ${f}`).toBeGreaterThanOrEqual(0.99);
			expect(r.share, `remotion frame ${f} (baseline ${minShare.toFixed(4)})`).toBeGreaterThanOrEqual(
				minShare - 0.03,
			);
			expect(r.mean, `remotion frame ${f} (baseline ${maxMean.toFixed(3)})`).toBeLessThanOrEqual(maxMean + 1);
		}
		report(`[smooth slide parity] share within 3/255 / mean |Δ| vs Remotion stills: ${lines.join('; ')}`);
	}, 3_600_000);
});
