// Spec 19 §14 parity, both export paths, through the engine (REMOTION_E2E=1): a library look on animated text (a text
// animator lifts the letters, a look param is keyed) over a native solid. The planner routes it hybrid: the solid is
// composited natively and the title is a layer bake (a moving master, rendered through Remotion and overlaid by
// ffmpeg). The hybrid export, and the Remotion export, are compared frame by frame with Remotion stills of the
// document's snapshot, which is what Program draws (`packages/compositions/test/title-look.e2e.test.ts`: Program against a
// Remotion still, SSIM 1.0000, max difference 0). Thresholds are the repository's export-parity ones: SSIM ≥ 0.98
// (trim-paths-export, native-animated) and ≥ 99 % of values within 3/255 for the bake (layer-bake.e2e, text-paint-export).
// `TITLE_LOOK_EXPORT_DUMP=<dir>` writes the compared frames as PNGs for inspection.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { buildRenderSnapshot } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, TEST_FFMPEG, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1280;
const H = 720;
const N = 30;
const SAMPLE = [0, 10, 20, 29];
const LOOK = 'look.plasma-core';
const FWD_ENV: Record<string, string> = {};
for (const k of [
	'JASPER_FFMPEG',
	'JASPER_FFPROBE',
	'JASPER_FFMPEG_LGPL_ONLY',
	'JASPER_REMOTION_BIN_DIR',
	'JASPER_BROWSER_EXECUTABLE',
])
	if (process.env[k]) FWD_ENV[k] = process.env[k]!;

/** Measurements: console and `<tmp>/title-look-export.txt` (Vitest hides the console of passing tests). */
function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'title-look-export.txt'), `${new Date().toISOString()} ${line}\n`);
}

/** RGB of frame `frame` of a video, or of a still when `frame` is omitted. */
function rgb(file: string, frame?: number): Buffer {
	const r = spawnSync(
		TEST_FFMPEG,
		[
			...['-v', 'error', '-i', file],
			...(frame !== undefined ? ['-vf', `select=eq(n\\,${frame})`] : []),
			...['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	expect(r.stdout.length).toBe(W * H * 3);
	return r.stdout;
}

/** SSIM (all planes, ffmpeg `ssim` on yuv444p) of frame `frame` of a video against a still. */
function ssim(video: string, frame: number, still: string): number {
	const r = spawnSync(TEST_FFMPEG, [
		...['-v', 'info', '-i', video, '-i', still],
		...[
			'-filter_complex',
			`[0:v]select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim`,
		],
		...['-frames:v', '1', '-f', 'null', '-'],
	]);
	const m = /SSIM .*All:([0-9.]+)/.exec(r.stderr.toString());
	if (!m) throw new Error(`ssim failed: ${r.stderr.toString().slice(-2000)}`);
	return Number(m[1]);
}

/** Share of values within `tol` of each other. */
function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

function dump(file: string, name: string, frame?: number): void {
	const dir = process.env.TITLE_LOOK_EXPORT_DUMP;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	spawnSync(TEST_FFMPEG, [
		...['-v', 'error', '-y', '-i', file],
		...(frame !== undefined ? ['-vf', `select=eq(n\\,${frame})`] : []),
		...['-frames:v', '1', join(dir, `${name}.png`)],
	]);
}

describe.runIf(enabled)('a title look on both export paths (REMOTION_E2E=1, spec 19 §14)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-tl-export-e2e-'),
			port: PORT,
			// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
			insecure: true,
			dev: true,
			env: { PATH: process.env.PATH, ...FWD_ENV },
		});
		// Which FFmpeg the engine and the Remotion path use, so a run with `JASPER_FFMPEG_LGPL_ONLY=1` is shown to be one.
		const caps = (
			await engine.app.inject({ method: 'GET', url: '/api/capabilities', headers: hostH() })
		).json();
		console.info(
			`[toolchain] ffmpeg ${caps.media.ffmpegSource} (${caps.media.encoding?.license}, lgplOnly ${caps.media.encoding?.lgplOnly}); Remotion ${JSON.stringify(caps.render.remotionBinaries)}`,
		);
		if (FWD_ENV.JASPER_FFMPEG_LGPL_ONLY === '1') expect(caps.media.encoding?.lgplOnly).toBe(true);
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const queue = () => coreServices(engine.app).queue;
	const children = (id: string) =>
		queue()
			.list({})
			.filter((j) => j.parentId === id);
	const wait = async (id: string): Promise<EngineJob> => {
		await until(
			() => ['succeeded', 'failed', 'cancelled'].includes(queue().get(id)?.state ?? ''),
			2_400_000,
			250,
		);
		return queue().get(id)!;
	};
	const settings = (seqId: string, which: 'auto' | 'remotion') => ({
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		engine: which,
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
	});
	const plan = (d: DocBuilder, which: 'auto' | 'remotion') =>
		coreServices(engine.app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, which) as never,
		});
	async function exportWith(d: DocBuilder, which: 'auto' | 'remotion') {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, which) },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const file = (await coreServices(engine.app).exports.outputFile(done.id))!;
		return {
			file,
			result: done.result as { renderPath?: string },
			bakes: children(done.id).filter((j) => j.kind === 'layer-bake'),
		};
	}
	/**
	 * What Program draws at `frame`: a Remotion still of the document's snapshot with the fonts the editor loads from the
	 * engine (signed absolute URLs, as the export's own snapshot; the plan's snapshot carries relative font paths that a
	 * headless page cannot load, and draws the fallback face).
	 */
	async function programFrame(d: DocBuilder, frame: number, name: string): Promise<string> {
		const core = coreServices(engine.app);
		const snapshot = buildRenderSnapshot(d.doc, d.seqId, {
			resolveMedia: () => null,
			resolveFont: (font, weight, italic) => {
				const face = core.fonts.resolve(font.family, weight, italic);
				return face ? core.signer.signUrl(`http://127.0.0.1:${engine.port}`, face.url) : null;
			},
		});
		const out = join(tempAppdir('jasper-tl-export-ref-'), `${name}.png`);
		await core.remotion.renderStill({
			inputProps: {
				doc: snapshot,
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			},
			output: out,
			frame,
			signal: new AbortController().signal,
		});
		return out;
	}

	function scene(): { d: DocBuilder; title: string } {
		const d = new DocBuilder('hd-720p-30');
		const r = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: N, track: 'V1', color: [0.12, 0.14, 0.2, 1] },
			{
				type: 'clip.addText',
				at: 0,
				duration: N,
				track: 'V2',
				content: {
					text: 'LEVEL UP',
					style: { sizePx: 140, fill: [1, 1, 1, 1], align: 'center', weight: 700 },
				},
				box: { width: 900, height: 220, autoSize: 'none' },
				ref: '$t',
			},
			{ type: 'look.apply', clipIds: ['$t'], lookId: LOOK, seed: 4242 },
			{ type: 'textAnimator.add', clipId: '$t', properties: ['position'], ref: '$a' },
		]);
		const title = r.refs.$t!;
		const fx = (r.results[2] as { effectInstanceIds: string[] }).effectInstanceIds[0]!;
		const clip = d.doc.sequences[d.seqId]!.clips[title] as unknown as {
			effects: { id: string; appearance: { layers: { id: string; type: string }[] } }[];
		};
		const look = clip.effects.find((e) => e.id === fx)!;
		const rim = look.appearance.layers.find((l) => l.type === 'rim')!.id;
		const glow = look.appearance.layers.find((l) => l.type === 'glow')!.id;
		const pos = ['clip', title, 'textAnimators', r.refs.$a!, 'properties', 'position'];
		d.tx([
			// The letters rise while the rim thickens and the glow spreads: the bake is a moving master.
			{ type: 'keyframe.add', target: pos, at: { frames: 0 }, value: [0, -40] },
			{ type: 'keyframe.add', target: pos, at: { frames: N - 1 }, value: [0, 30] },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 2 },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: N - 1 }, value: 10 },
			{ type: 'keyframe.add', target: ['appearance', fx, glow, 'radius'], at: { frames: 0 }, value: 20 },
			{ type: 'keyframe.add', target: ['appearance', fx, glow, 'radius'], at: { frames: N - 1 }, value: 80 },
		]);
		return { d, title };
	}

	it('hybrid (the title baked, composited natively) and Remotion exports match Program on every sampled frame', async () => {
		const { d, title } = scene();
		const auto = await plan(d, 'auto');
		expect(auto.plan).toMatchObject({ path: 'hybrid', blockers: [] });
		expect((await plan(d, 'remotion')).plan.path).toBe('remotion');

		const hybrid = await exportWith(d, 'auto');
		expect(hybrid.result.renderPath).toBe('hybrid');
		// The title is the one layer the native composite cannot draw: one bake, a master (it moves), not stills.
		expect(hybrid.bakes).toHaveLength(1);
		expect(hybrid.bakes[0]!.result).toMatchObject({ frames: N });
		const remotion = await exportWith(d, 'remotion');
		expect(remotion.result.renderPath).toBe('remotion');

		// The same document without the look, to show the look is what the frames compare.
		const plain = new DocBuilder('hd-720p-30');
		plain.doc = structuredClone(d.doc);
		plain.revision = d.revision;
		plain.tx([{ type: 'look.remove', clipIds: [title] }]);

		const rows: string[] = [];
		const program: Buffer[] = [];
		for (const f of SAMPLE) {
			const ref = await programFrame(d, f, `program-${f}`);
			const bare = await programFrame(plain, f, `plain-${f}`);
			dump(ref, `program-${f}`);
			dump(hybrid.file, `hybrid-${f}`, f);
			dump(remotion.file, `remotion-${f}`, f);
			const p = rgb(ref);
			program.push(p);
			const h = rgb(hybrid.file, f);
			const r = rgb(remotion.file, f);
			const row = {
				hybridSsim: ssim(hybrid.file, f, ref),
				hybridWithin3: within(h, p, 3),
				remotionSsim: ssim(remotion.file, f, ref),
				remotionWithin3: within(r, p, 3),
				lookShare: 1 - within(p, rgb(bare), 3),
			};
			rows.push(
				`f${f}: hybrid SSIM ${row.hybridSsim.toFixed(4)}, within 3/255 ${row.hybridWithin3.toFixed(4)}; Remotion SSIM ${row.remotionSsim.toFixed(4)}, within 3/255 ${row.remotionWithin3.toFixed(4)}; look changes ${(row.lookShare * 100).toFixed(2)} % of values`,
			);
			expect(row.hybridSsim, `frame ${f} hybrid SSIM`).toBeGreaterThanOrEqual(0.98);
			expect(row.hybridWithin3, `frame ${f} hybrid within 3/255`).toBeGreaterThanOrEqual(0.99);
			expect(row.remotionSsim, `frame ${f} Remotion SSIM`).toBeGreaterThanOrEqual(0.98);
			// The glow and rim cover a real part of the frame: a path that dropped the look would fail the SSIM above.
			expect(row.lookShare, `frame ${f} look share`).toBeGreaterThan(0.02);
		}
		// The animation reached the exports: the first and last sampled Program frames differ.
		expect(within(program[0]!, program.at(-1)!, 3)).toBeLessThan(0.99);
		report(`[title-look export] ${LOOK}, ${W}×${H}, ${N} frames: ${rows.join('; ')}`);
	}, 3_600_000);
});
