// Full-sequence Remotion stills provide a reference without codec noise for hybrid span and layer bakes.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { buildRenderSnapshot } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, JSON_H, register, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);

/** Measurements: console and `<tmp>/gpu-spans.txt` (Vitest hides the console of passing tests). */
function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'gpu-spans.txt'), `${new Date().toISOString()} ${line}\n`);
}

function decode(file: string, o: { frame?: number } = {}): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			...(o.frame !== undefined ? ['-vf', `select=eq(n\\,${o.frame})`] : []),
			...['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

function makeCard(): string {
	const w = 1280;
	const h = 720;
	const raw = Buffer.alloc(w * h * 3);
	const bars: [number, number, number][] = [
		[230, 30, 30],
		[30, 200, 40],
		[40, 60, 220],
		[240, 220, 20],
		[20, 210, 220],
	];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const edge = x < 48 || y < 48 || x >= w - 48 || y >= h - 48;
			raw.set(
				edge ? [255, 255, 255] : bars[Math.floor(((x - 48) / (w - 96)) * bars.length)]!,
				(y * w + x) * 3,
			);
		}
	const dir = mkdtempSync(join(tmpdir(), 'jasper-gpu-card-'));
	writeFileSync(join(dir, 'card.rgb'), raw);
	const out = join(dir, 'card.png');
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`],
		...['-i', join(dir, 'card.rgb'), '-frames:v', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

describe.runIf(enabled)('GPU transitions and GPU effects on the native path (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir('jasper-gpu-spans-'),
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
	const wait = async (id: string): Promise<EngineJob> => {
		await until(
			() => ['succeeded', 'failed', 'cancelled'].includes(queue().get(id)?.state ?? ''),
			3_600_000,
			250,
		);
		return queue().get(id)!;
	};
	const bakesOf = (id: string) =>
		queue()
			.list({})
			.filter((j) => j.parentId === id && j.kind === 'layer-bake');

	const settings = (seqId: string) => ({
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		engine: 'auto',
		video: {
			codec: 'prores',
			proresProfile: '4444',
			width: 1280,
			height: 720,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 10 },
			encoderSpeed: 'fast',
		},
	});

	async function exportDoc(d: DocBuilder, s: ReturnType<typeof settings>) {
		const plan = (
			await engine.app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
			})
		).json() as {
			path: string;
			blockers: unknown[];
		};
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const out = (await coreServices(engine.app).exports.outputFile(done.id))!;
		return { plan, done, out, bakes: bakesOf(done.id) };
	}

	async function referenceStill(d: DocBuilder, frame: number): Promise<Buffer> {
		const svc = coreServices(engine.app);
		const doc = buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: (asset) => {
				const key = asset.locators.find((locator) => locator.type === 'engine-store')?.key;
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
		const ref = join(tempAppdir('jasper-gpu-ref-'), 'ref.png');
		await svc.remotion.renderStill({
			inputProps: {
				doc,
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			},
			output: ref,
			frame,
			signal: new AbortController().signal,
		});
		return decode(ref);
	}

	it('a keyframed GPU transition + a layer with stacked GPU effects: hybrid, matches the composition, re-export reuses the masters', async () => {
		const card = await register(engine.app, makeCard(), hostH());
		const d = new DocBuilder('hd-720p-30');
		const cardId = d.addMedia(card);
		const a = d.tx([{ type: 'clip.place', source: { mediaId: cardId }, at: 0, ref: '$a' }]).refs.$a!;
		d.tx([{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: -105, mode: 'regular' }]);
		d.tx([
			{ type: 'clip.addSolid', at: 45, duration: 45, track: 'V1', color: [0.15, 0.25, 0.8, 1] },
			{ type: 'track.add', kind: 'video', count: 1 },
		]);
		const tr = d.tx([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 45,
				effectId: 'jasper.iris-round',
				duration: 20,
				ref: '$t',
			},
		]).refs.$t!;
		d.tx([
			{ type: 'param.set', target: ['transition', tr, 'borderColor'], value: [1, 1, 0, 1] },
			{
				type: 'keyframe.add',
				target: ['transition', tr, 'borderWidth'],
				at: { sequenceFrame: 35 },
				value: 0,
			},
			{
				type: 'keyframe.add',
				target: ['transition', tr, 'borderWidth'],
				at: { sequenceFrame: 54 },
				value: 24,
			},
		]);
		const fx = d.tx([
			{ type: 'clip.addSolid', at: 10, duration: 70, track: 'V2', color: [0.9, 0.5, 0.1, 1], ref: '$s' },
		]).refs.$s!;
		d.tx([
			{ type: 'param.set', target: ['clip', fx, 'transform', 'scale'], value: 30 },
			{ type: 'param.set', target: ['clip', fx, 'transform', 'position'], value: [980, 200] },
			{ type: 'effect.add', target: { clipId: fx }, effectId: 'jasper.bevel-edges' },
			{ type: 'effect.add', target: { clipId: fx }, effectId: 'jasper.s.flicker' },
		]);
		const s = settings(d.seqId);
		const first = await exportDoc(d, s);
		expect(first.plan.path).toBe('hybrid');
		expect(first.plan.blockers).toEqual([]);
		expect(first.done.result).toMatchObject({ renderPath: 'hybrid', frames: 90 });

		const shares: number[] = [];
		for (const f of [5, 20, 35, 40, 45, 50, 54, 55, 70, 89]) {
			const ref = await referenceStill(d, f);
			shares.push(within(decode(first.out, { frame: f }), ref, 3));
		}
		report(
			`[gpu spans parity] hybrid export vs Remotion stills, share within 3/255 at frames 5…89: ${shares.map((x) => x.toFixed(4)).join(' ')}`,
		);
		for (const x of shares) expect(x).toBeGreaterThanOrEqual(0.99);

		const again = await exportDoc(d, s);
		expect(again.bakes).toHaveLength(0);
		expect(within(decode(again.out, { frame: 45 }), decode(first.out, { frame: 45 }), 0)).toBe(1);
	}, 1_800_000);
});
