// spatial-points: a Transform effect whose Position travels a curved (Auto Bezier) path. The export (hybrid: the
// GPU effect span is rendered by the compositions) must match the Program composition (Remotion stills, no codec
// noise) and put the layer exactly where the shared evaluator puts it — arc length measured in layer-box pixels
// (docs/wp-notes/spatial-points.md). REMOTION_E2E=1.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import {
	type Animatable,
	buildRenderSnapshot,
	contentTimeAt,
	type EffectInstance,
	evaluate,
	type Rational,
	type Vec2,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, JSON_H, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1280;
const H = 720;

function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'spatial-points.txt'), `${new Date().toISOString()} ${line}\n`);
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

function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

/** Centroid (px) of the bright orange square on black. */
function centroid(rgb: Uint8Array): Vec2 {
	let sx = 0;
	let sy = 0;
	let n = 0;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 3;
			if (rgb[i]! > 128 && rgb[i + 2]! < 100) {
				sx += x + 0.5;
				sy += y + 0.5;
				n++;
			}
		}
	return n ? [sx / n, sy / n] : [Number.NaN, Number.NaN];
}

describe.runIf(enabled)('effect point motion paths: preview vs export (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir('jasper-spatial-points-'),
			port: PORT,
			// These tests drive the engine itself, not its authentication (server.test.ts covers it).
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
		await until(() => ['succeeded', 'failed', 'cancelled'].includes(queue().get(id)?.state ?? ''), 3_600_000, 250);
		return queue().get(id)!;
	};

	it('a Transform with a curved Position path: export = composition = the evaluator (layer-box arc length)', async () => {
		const d = new DocBuilder('hd-720p-30');
		const s = d.tx([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0.55, 0, 1], ref: '$s' }])
			.refs.$s!;
		const fxId = d.tx([{ type: 'effect.add', target: { clipId: s }, effectId: 'jasper.transform', ref: '$fx' }])
			.refs.$fx!;
		const pos = ['effect', fxId, 'position'];
		d.tx([
			{ type: 'param.set', target: ['effect', fxId, 'scaleHeight'], value: 12 },
			{ type: 'keyframe.add', target: pos, value: [0.15, 0.75], at: { sequenceFrame: 0 } },
			{ type: 'keyframe.add', target: pos, value: [0.5, 0.2], at: { sequenceFrame: 30 } },
			{ type: 'keyframe.add', target: pos, value: [0.85, 0.75], at: { sequenceFrame: 59 } },
		]);
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'entire' },
			container: 'mov',
			engine: 'auto',
			video: {
				codec: 'prores',
				proresProfile: '4444',
				width: W,
				height: H,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 10 },
				encoderSpeed: 'fast',
			},
		};
		const plan = (
			await engine.app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
			})
		).json() as { path: string; blockers: unknown[] };
		expect(plan.blockers).toEqual([]);
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const out = (await coreServices(engine.app).exports.outputFile(done.id))!;

		const svc = coreServices(engine.app);
		const snap = buildRenderSnapshot(d.doc, d.seqId, { resolveFont: () => null, resolveMedia: () => null });
		const seq = d.doc.sequences[d.seqId]!;
		const clip = seq.clips[s]!;
		const anim = (clip as unknown as { effects: EffectInstance[] }).effects[0]!.params.position as Animatable<Vec2>;
		const shares: number[] = [];
		const errs: number[] = [];
		const offs: number[] = [];
		for (const f of [0, 8, 15, 22, 30, 38, 45, 52, 59]) {
			const ref = join(tempAppdir('jasper-spatial-ref-'), 'ref.png');
			await svc.remotion.renderStill({
				inputProps: { doc: snap, options: { isPreview: false, useProxies: false, transparentBackground: false } },
				output: ref,
				frame: f,
				signal: new AbortController().signal,
			});
			const exported = decode(out, f);
			shares.push(within(exported, decode(ref), 3));
			// Where the evaluator (with the layer box metric) puts the square, and where a metric-free reading would.
			const t = contentTimeAt(clip, f, seq.settings.frameRate as Rational);
			const want = evaluate(anim, t, { metric: [W, H] });
			const naive = evaluate(anim, t);
			const got = centroid(exported);
			errs.push(Math.hypot(got[0] - want[0] * W, got[1] - want[1] * H));
			offs.push(Math.hypot(naive[0] * W - want[0] * W, naive[1] * H - want[1] * H));
		}
		report(
			`[spatial points] path ${plan.path}; export vs composition share within 3/255: ${shares.map((x) => x.toFixed(4)).join(' ')}; centroid error px: ${errs.map((x) => x.toFixed(2)).join(' ')}; metric-free offset px: ${offs.map((x) => x.toFixed(1)).join(' ')}`,
		);
		for (const x of shares) expect(x).toBeGreaterThanOrEqual(0.99);
		for (const e of errs) expect(e).toBeLessThan(1);
		// The metric matters on this path: a normalised-unit timing would be visibly elsewhere between the keys.
		expect(Math.max(...offs)).toBeGreaterThan(5);
	}, 1_800_000);
});
