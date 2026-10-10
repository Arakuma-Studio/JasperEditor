// GPU transitions and GPU-effect layers on the native path (wave1c, ARCHITECTURE D-35), end to end with a listening
// engine and headless Chrome (REMOTION_E2E=1): an export with a GPU transition (keyframed params) and a layer with
// stacked GPU effects plans `hybrid`, bakes only the span and the layer, and matches the composition frame by frame
// (Remotion `renderStill` of the whole sequence: the renderer without codec noise); a re-export reuses the masters.
// GPU_SPANS_BENCH=1 times a 60 s 1080p timeline: full Remotion export vs hybrid.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, fixture, JSON_H, register, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const bench = process.env.GPU_SPANS_BENCH === '1';
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

/** Share of samples within `tol` code values. */
function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

/** A 1280×720 PNG card: a white frame around coloured bars (known colours, sharp edges). */
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

describe.runIf(enabled || bench)(
	'GPU transitions and GPU effects on the native path (REMOTION_E2E=1)',
	() => {
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

		const settings = (
			seqId: string,
			engineName: 'auto' | 'remotion',
			o: { width: number; height: number; codec: 'prores' | 'h264' },
		) => ({
			sequenceId: seqId,
			range: { type: 'entire' },
			container: o.codec === 'prores' ? 'mov' : 'mp4',
			engine: engineName,
			video: {
				codec: o.codec,
				...(o.codec === 'prores' ? { proresProfile: '4444' } : {}),
				width: o.width,
				height: o.height,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: o.codec === 'prores' ? 10 : 18 },
				encoderSpeed: 'fast',
				colorTags: 'rec709',
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
				segments: { graphicsGroups: { itemIds: string[] }[] }[];
			};
			const started = Date.now();
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
			return { plan, done, out, ms: Date.now() - started, bakes: bakesOf(done.id) };
		}

		/** Remotion `renderStill` of the whole sequence at `frame` (signed media, as the Remotion path renders). */
		async function referenceStill(
			d: DocBuilder,
			frame: number,
			s: ReturnType<typeof settings>,
		): Promise<Buffer> {
			const svc = coreServices(engine.app);
			const planned = await svc.exports.plan({
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: { ...s, range: { type: 'custom', startFrame: frame, endFrame: frame + 1 } } as never,
			});
			const ref = join(tempAppdir('jasper-gpu-ref-'), 'ref.png');
			await svc.remotion.renderStill({
				inputProps: (
					svc.exports as unknown as { remotionProps(p: unknown): Record<string, unknown> }
				).remotionProps(planned),
				output: ref,
				frame: 0,
				signal: new AbortController().signal,
			});
			return decode(ref);
		}

		it.runIf(enabled)(
			'a keyframed GPU transition + a layer with stacked GPU effects: hybrid, matches the composition, re-export reuses the masters',
			async () => {
				const card = await register(engine.app, makeCard(), hostH());
				const d = new DocBuilder('hd-720p-30');
				const cardId = d.addMedia(card);
				const a = d.tx([{ type: 'clip.place', source: { mediaId: cardId }, at: 0, ref: '$a' }]).refs.$a!;
				d.tx([{ type: 'clip.trim', clipId: a, edge: 'out', deltaFrames: -105, mode: 'regular' }]); // 150 → 45
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
				// V2: a small solid with two stacked GPU effects (one time-dependent: a new flicker every frame).
				const fx = d.tx([
					{ type: 'clip.addSolid', at: 10, duration: 70, track: 'V2', color: [0.9, 0.5, 0.1, 1], ref: '$s' },
				]).refs.$s!;
				d.tx([
					{ type: 'param.set', target: ['clip', fx, 'transform', 'scale'], value: 30 },
					{ type: 'param.set', target: ['clip', fx, 'transform', 'position'], value: [980, 200] },
					{ type: 'effect.add', target: { clipId: fx }, effectId: 'jasper.bevel-edges' },
					{ type: 'effect.add', target: { clipId: fx }, effectId: 'jasper.s.flicker' },
				]);
				const s = settings(d.seqId, 'auto', { width: 1280, height: 720, codec: 'prores' });
				const first = await exportDoc(d, s);
				expect(first.plan.path).toBe('hybrid');
				expect(first.plan.blockers).toEqual([]);
				expect(first.done.result).toMatchObject({ renderPath: 'hybrid', frames: 90 });
				// One span bake (20 frames) and one layer bake (the GPU solid); nothing else through Remotion.
				expect(first.bakes).toHaveLength(2);
				const groups = first.plan.segments[0]!.graphicsGroups.flatMap((g) => g.itemIds);
				expect(groups.sort()).toEqual([fx, tr].sort());

				const shares: number[] = [];
				for (const f of [5, 20, 35, 40, 45, 50, 54, 55, 70, 89]) {
					const ref = await referenceStill(d, f, s);
					shares.push(within(decode(first.out, { frame: f }), ref, 3));
				}
				report(
					`[gpu spans parity] hybrid export vs Remotion stills, share within 3/255 at frames 5…89: ${shares.map((x) => x.toFixed(4)).join(' ')}`,
				);
				for (const x of shares) expect(x).toBeGreaterThanOrEqual(0.99);

				const again = await exportDoc(d, s);
				expect(again.bakes).toHaveLength(0);
				expect(within(decode(again.out, { frame: 45 }), decode(first.out, { frame: 45 }), 0)).toBe(1);
			},
			1_800_000,
		);

		it.runIf(bench)(
			'speed: a 60 s 1080p timeline with GPU transitions and GPU effects, full Remotion vs hybrid',
			async () => {
				const d = new DocBuilder('hd-1080p-30');
				const m = d.addMedia(await register(engine.app, fixture('clip-a.mp4'), hostH()));
				// 7 clips of 8.5 s (source 0.5…9 s: handles for the transitions) = 59.5 s.
				const ids: string[] = [];
				for (let i = 0; i < 7; i++) {
					const r = d.tx([
						{
							type: 'clip.place',
							source: { mediaId: m },
							at: i * 255,
							sourceRange: { in: { seconds: 0.5 }, out: { seconds: 9 } },
							ref: '$c',
						},
					]);
					ids.push(r.refs.$c!);
				}
				d.tx([{ type: 'track.add', kind: 'video', count: 1 }]);
				for (const [i, effectId] of [
					[1, 'jasper.iris-round'],
					[3, 'jasper.push'],
					[5, 'jasper.cross-zoom'],
				] as const)
					d.tx([{ type: 'transition.add', trackId: 'V1', at: i * 255, effectId, duration: 20 }]);
				// A GPU effect on one clip, and a 5 s lower third with two stacked GPU effects.
				d.tx([{ type: 'effect.add', target: { clipId: ids[2]! }, effectId: 'jasper.color-emboss' }]);
				const lt = d.tx([
					{
						type: 'clip.addSolid',
						at: 900,
						duration: 150,
						track: 'V2',
						color: [0.1, 0.1, 0.12, 0.85],
						ref: '$l',
					},
				]).refs.$l!;
				d.tx([
					{ type: 'param.set', target: ['clip', lt, 'transform', 'scaleWidth'], value: 60 },
					{ type: 'param.set', target: ['clip', lt, 'transform', 'uniformScale'], value: false },
					{ type: 'param.set', target: ['clip', lt, 'transform', 'scale'], value: 14 },
					{ type: 'param.set', target: ['clip', lt, 'transform', 'position'], value: [760, 920] },
					{ type: 'effect.add', target: { clipId: lt }, effectId: 'jasper.bevel-edges' },
					{ type: 'effect.add', target: { clipId: lt }, effectId: 'jasper.s.flicker' },
				]);
				const s = (e: 'auto' | 'remotion') =>
					settings(d.seqId, e, { width: 1920, height: 1080, codec: 'h264' });
				const load = () =>
					(spawnSync('cat', ['/proc/loadavg']).stdout?.toString() ?? '').split(' ').slice(0, 3).join(' ');
				const l0 = load();
				const hybrid = await exportDoc(d, s('auto'));
				const again = await exportDoc(d, s('auto'));
				const l1 = load();
				const remotion = await exportDoc(d, s('remotion'));
				const l2 = load();
				expect(hybrid.plan.path).toBe('hybrid');
				expect(remotion.done.result).toMatchObject({ renderPath: 'remotion' });
				report(
					`[gpu spans bench] 59.5 s 1080p30, 3 GPU transitions + 2 GPU-effect layers: hybrid ${hybrid.ms} ms (${hybrid.bakes.length} bakes; load ${l0}), re-export ${again.ms} ms (${again.bakes.length} bakes), full Remotion ${remotion.ms} ms (load ${l1} → ${l2})`,
				);
			},
			7_200_000,
		);
	},
);
