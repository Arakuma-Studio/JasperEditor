// Spec 19 §14 parity, both export paths, through the engine (REMOTION_E2E=1): a library look on animated text (a text
// animator lifts the letters, a look param is keyed) over a native solid. The planner routes it hybrid: the solid is
// composited natively and the title is a layer bake (a moving master, rendered through Remotion and overlaid by
// ffmpeg). The hybrid export, and the Remotion export, are compared frame by frame with Remotion stills of the
// document's snapshot, which is what Program draws (`packages/compositions/test/title-look.e2e.test.ts`: Program against a
// Remotion still, SSIM 1.0000, max difference 0). Thresholds are the repository's export-parity ones: SSIM ≥ 0.98
// (trim-paths-export, native-animated) and ≥ 99 % of values within 3/255 for the bake (layer-bake.e2e, text-paint-export).
// Colour is checked as well (AGENTS §4), so a colourway, gradient map or tint that keeps the lightness and changes the hue
// fails: the mean CIE76 ΔE over the pixels the title changes is at most 2, under the just-noticeable 2.3 (measured: 0.26–0.38
// hybrid, 0.86–0.90 Remotion, whose ProRes adds chroma noise; a wrong hue there is tens). The least SSIM of the R, G and B planes (ffmpeg `ssim` on `gbrp`) is reported too: on the encoded paths it
// reads the codec's chroma noise in flat areas (0.978 on the Remotion ProRes at frame 10, 1.4 % of values off by more than
// 3/255, mean signed difference ≤ 0.11/255), so it is not the gate. Also: a look with generators, and a 3D title template,
// Program against export.
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

/** SSIM of the R, G and B planes (ffmpeg `ssim` on `gbrp`) of frame `frame` of a video against a still: the least of them. */
function ssimRgb(video: string, frame: number, still: string): number {
	const r = spawnSync(TEST_FFMPEG, [
		...['-v', 'info', '-i', video, '-i', still],
		...[
			'-filter_complex',
			`[0:v]select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=gbrp[a];[1:v]format=gbrp[b];[a][b]ssim`,
		],
		...['-frames:v', '1', '-f', 'null', '-'],
	]);
	const m = /SSIM R:([0-9.-]+).*G:([0-9.-]+).*B:([0-9.-]+)/.exec(r.stderr.toString());
	if (!m) throw new Error(`ssim failed: ${r.stderr.toString().slice(-2000)}`);
	return Math.min(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** sRGB 8-bit to CIELAB (D65). */
function lab(r: number, g: number, b: number): [number, number, number] {
	const lin = (v: number) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const [R, G, B] = [lin(r), lin(g), lin(b)];
	const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
	const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
	const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
	return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Mean CIE76 ΔE of `e` against `p` over the pixels where `p` differs from `bare` (what the title draws), RGB24. */
function deltaE(e: Buffer, p: Buffer, bare: Buffer): { mean: number; n: number } {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < p.length; i += 3) {
		if (
			Math.max(
				Math.abs(p[i]! - bare[i]!),
				Math.abs(p[i + 1]! - bare[i + 1]!),
				Math.abs(p[i + 2]! - bare[i + 2]!),
			) <= 3
		)
			continue;
		const a = lab(p[i]!, p[i + 1]!, p[i + 2]!);
		const b = lab(e[i]!, e[i + 1]!, e[i + 2]!);
		sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		n++;
	}
	return { mean: n ? sum / n : 0, n };
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
	type Range = { start: number; end: number };
	const settings = (seqId: string, which: 'auto' | 'remotion', range?: Range) => ({
		sequenceId: seqId,
		range: range ? { type: 'custom', startFrame: range.start, endFrame: range.end } : { type: 'entire' },
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
	const plan = (d: DocBuilder, which: 'auto' | 'remotion', range?: Range) =>
		coreServices(engine.app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, which, range) as never,
		});
	async function exportWith(d: DocBuilder, which: 'auto' | 'remotion', range?: Range) {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, which, range) },
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
			const b = rgb(bare);
			const row = {
				hybridSsim: ssim(hybrid.file, f, ref),
				hybridRgb: ssimRgb(hybrid.file, f, ref),
				hybridWithin3: within(h, p, 3),
				remotionSsim: ssim(remotion.file, f, ref),
				remotionRgb: ssimRgb(remotion.file, f, ref),
				remotionWithin3: within(r, p, 3),
				hybridDeltaE: deltaE(h, p, b).mean,
				remotionDeltaE: deltaE(r, p, b).mean,
				lookShare: 1 - within(p, b, 3),
			};
			rows.push(
				`f${f}: hybrid SSIM ${row.hybridSsim.toFixed(4)} (RGB ${row.hybridRgb.toFixed(4)}, ΔE ${row.hybridDeltaE.toFixed(2)}), within 3/255 ${row.hybridWithin3.toFixed(4)}; Remotion SSIM ${row.remotionSsim.toFixed(4)} (RGB ${row.remotionRgb.toFixed(4)}, ΔE ${row.remotionDeltaE.toFixed(2)}), within 3/255 ${row.remotionWithin3.toFixed(4)}; look changes ${(row.lookShare * 100).toFixed(2)} % of values`,
			);
			expect(row.hybridSsim, `frame ${f} hybrid SSIM`).toBeGreaterThanOrEqual(0.98);
			expect(row.hybridDeltaE, `frame ${f} hybrid ΔE over the look`).toBeLessThanOrEqual(2);
			expect(row.hybridWithin3, `frame ${f} hybrid within 3/255`).toBeGreaterThanOrEqual(0.99);
			expect(row.remotionSsim, `frame ${f} Remotion SSIM`).toBeGreaterThanOrEqual(0.98);
			expect(row.remotionDeltaE, `frame ${f} Remotion ΔE over the look`).toBeLessThanOrEqual(2);
			// The glow and rim cover a real part of the frame: a path that dropped the look would fail the SSIM above.
			expect(row.lookShare, `frame ${f} look share`).toBeGreaterThan(0.02);
		}
		// The animation reached the exports: the first and last sampled Program frames differ.
		expect(within(program[0]!, program.at(-1)!, 3)).toBeLessThan(0.99);
		report(`[title-look export] ${LOOK}, ${W}×${H}, ${N} frames: ${rows.join('; ')}`);
	}, 3_600_000);

	/**
	 * Program against the path the planner picks for `d` over `range`: each sampled frame of the export (all-plane SSIM ≥ 0.98,
	 * mean ΔE ≤ 2 over the title) against a Remotion still of the document at that frame, and the title shown to be there.
	 */
	async function parity(d: DocBuilder, name: string, range: Range, sample: number[], bare: DocBuilder) {
		const auto = await plan(d, 'auto', range);
		const out = await exportWith(d, 'auto', range);
		expect(out.result.renderPath).toBe(auto.plan.path);
		const rows: string[] = [];
		for (const f of sample) {
			const ref = await programFrame(d, f, `${name}-program-${f}`);
			dump(ref, `${name}-program-${f}`);
			dump(out.file, `${name}-${out.result.renderPath}-${f}`, f - range.start);
			const p = rgb(ref);
			const e = rgb(out.file, f - range.start);
			const all = ssim(out.file, f - range.start, ref);
			const colour = ssimRgb(out.file, f - range.start, ref);
			const b = rgb(await programFrame(bare, f, `${name}-bare-${f}`));
			const share = 1 - within(p, b, 3);
			const de = deltaE(e, p, b).mean;
			rows.push(
				`f${f}: SSIM ${all.toFixed(4)} (RGB ${colour.toFixed(4)}, ΔE over the title ${de.toFixed(2)}), within 3/255 ${within(e, p, 3).toFixed(4)}; the title changes ${(share * 100).toFixed(2)} % of values`,
			);
			expect(all, `${name} frame ${f} SSIM`).toBeGreaterThanOrEqual(0.98);
			expect(de, `${name} frame ${f} ΔE over the title`).toBeLessThanOrEqual(2);
			// A path that dropped the title would fail the SSIM above: the title covers a real part of the frame.
			expect(share, `${name} frame ${f} title share`).toBeGreaterThan(0.02);
		}
		report(`[title-look export] ${name} (${out.result.renderPath}), ${W}×${H}: ${rows.join('; ')}`);
	}

	it('a look with a generator (fire behind a bevelled face) matches Program on its export path', async () => {
		const d = new DocBuilder('hd-720p-30');
		const r = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: N, track: 'V1', color: [0.12, 0.14, 0.2, 1] },
			{
				type: 'clip.addText',
				at: 0,
				duration: N,
				track: 'V2',
				content: { text: 'BURN', style: { sizePx: 160, fill: [1, 1, 1, 1], align: 'center', weight: 700 } },
				box: { width: 900, height: 260, autoSize: 'none' },
				ref: '$t',
			},
			{ type: 'look.apply', clipIds: ['$t'], lookId: 'look.cursed-flame', seed: 4242 },
		]);
		const bare = new DocBuilder('hd-720p-30');
		bare.doc = structuredClone(d.doc);
		bare.revision = d.revision;
		bare.tx([{ type: 'look.remove', clipIds: [r.refs.$t!] }]);
		await parity(d, 'generator-look', { start: 0, end: 12 }, [0, 6, 11], bare);
	}, 3_600_000);

	it('a 3D title template matches Program on the Remotion path', async () => {
		const d = new DocBuilder('hd-720p-30');
		const r = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0.12, 0.14, 0.2, 1] },
			{ type: 'title.insertTemplate', templateId: 'template.gold-3d-title', at: 0 },
		]);
		expect(r.results.length).toBe(2);
		const bare = new DocBuilder('hd-720p-30');
		bare.tx([{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0.12, 0.14, 0.2, 1] }]);
		// After the reveal: the whole solid is there.
		const p = await plan(d, 'auto', { start: 45, end: 47 });
		expect(p.plan.path).toBe('remotion');
		await parity(d, '3d-template', { start: 45, end: 47 }, [45, 46], bare);
	}, 3_600_000);
});
