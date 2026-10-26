// Frame-rate conform (docs/wp-notes/time.md §15): a source whose frame rate differs from the sequence's shows, at
// every sequence frame, the source frame the time model picks (S01:CLP-004, `frameIndexAt` in
// packages/project/src/time-remap/sampling.ts) — on the native path, the hybrid layer bake and Remotion, and in the
// Program preview's renderer (Remotion stills of the compositions). Each source frame carries a 12-bit code
// (scripts/fixtures/fpsmap.mjs); the patches under it check the colour of every path against the preview and the
// source. REMOTION_E2E=1; needs FFmpeg and Chrome. Before the fix: native 537 / hybrid 60 / Remotion 60 of 1040
// frames wrong for 29.97 → 30, and untagged SD footage exported with the BT.601 matrix where the preview used BT.709.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testResultsDir } from '@jasper/testkit/env';
import { diffImages, formatDiff } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningEngine } from '../src/index.ts';
import {
	buildConform,
	COLOUR_FILES,
	CONFORM_CASES,
	type ConformCase,
	codeOf,
	decodeFrame,
	maxPatchError,
	mismatches,
	modelFrames,
	patchMeans,
	R2997,
	readCodes,
	SOURCE_PATCHES,
} from './fps-conform-support.ts';
import type { DocBuilder, register } from './helpers.ts';
import { tempAppdir } from './temp.ts';

const enabled = process.env.REMOTION_E2E === '1' && oraclesAvailable('ffmpeg', 'ffprobe');
let engineApi: typeof import('../src/index.ts');
let services: typeof import('../src/tools/services.ts');
let helpers: typeof import('./helpers.ts');
let project: typeof import('@jasper/project');
if (enabled)
	[engineApi, services, helpers, project] = await Promise.all([
		import('../src/index.ts'),
		import('../src/tools/services.ts'),
		import('./helpers.ts'),
		import('@jasper/project'),
	]);

const PATHS = ['native', 'hybrid', 'remotion'] as const;
type Path = (typeof PATHS)[number];

/**
 * Chrome's software YUV → RGB (libyuv) uses 2.0 instead of 2.112 per 8-bit Cb step for BT.709's B: the preview's blue
 * is off by −0.112·(Cb − 128) levels (measured up to 9 on the saturated patches). Bound for that channel: the
 * predicted offset of a patch (from its exact colour) plus 3 levels.
 */
function libyuvBlueBound(rgb: number[]): number {
	const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
	const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const cb = (224 * (b - y)) / 1.8556;
	return Math.abs(0.112 * cb) + 3;
}

describe.runIf(enabled)(
	'frame-rate conform: every path shows the model frame (REMOTION_E2E=1)',
	{ timeout: 3_600_000 },
	() => {
		let engine: RunningEngine;
		let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
		const media = new Map<string, Awaited<ReturnType<typeof register>>>();
		const host = () => ({ host: `127.0.0.1:${engine.port}` });
		const out = () => testResultsDir('fps-conform');

		beforeAll(async () => {
			helpers.ensureFixtures();
			engine = await engineApi.startEngine({
				appdir: tempAppdir('jasper-fps-conform-'),
				port: 0,
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
			for (const f of new Set([...CONFORM_CASES.map((c) => c.file), ...COLOUR_FILES]))
				media.set(f, await helpers.register(engine.app, helpers.fixture(f), host()));
			browser = await services.coreServices(engine.app).remotion.openSharedBrowser();
			mkdirSync(out(), { recursive: true });
		}, 900_000);
		afterAll(async () => {
			try {
				await browser?.close();
			} finally {
				await engine?.stop();
			}
		});

		function build(c: ConformCase, path: Path): { d: DocBuilder; clipId: string } {
			const d = new helpers.DocBuilder();
			return { d, ...buildConform(d, media.get(c.file)!, c, path === 'hybrid') };
		}

		async function exportFile(d: DocBuilder, seq: ConformCase['seq'], path: Path) {
			const svc = services.coreServices(engine.app);
			const res = await engine.app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: { ...helpers.JSON_H, ...host() },
				payload: {
					envelope: d.envelope(),
					sequenceId: d.seqId,
					settings: {
						sequenceId: d.seqId,
						range: { type: 'entire' },
						container: 'mp4',
						video: {
							codec: 'h264',
							width: 640,
							height: 360,
							frameRate: seq,
							scaling: 'fit',
							quality: { mode: 'crf', value: 12 },
							encoderSpeed: 'fast',
						},
						audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
						engine: path === 'remotion' ? 'remotion' : 'native',
					},
				},
			});
			expect(res.statusCode, res.body).toBe(202);
			const done = await svc.queue.wait(res.json().id);
			expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
			expect((done.result as { renderPath: string }).renderPath).toBe(path);
			return (await svc.exports.outputFile(done.id))!;
		}

		/** The Program preview's renderer: a Remotion still of the compositions at `frame`. */
		async function previewStill(d: DocBuilder, frame: number): Promise<Rgba8> {
			const svc = services.coreServices(engine.app);
			const doc = project.buildRenderSnapshot(d.doc, d.seqId, {
				resolveFont: () => null,
				resolveMedia: (asset) => {
					const key = asset.locators.find((l) => l.type === 'engine-store')?.key;
					if (!key) throw new Error(`Missing engine-store locator for ${asset.id}`);
					const vs = asset.probe.streams.find((x) => x.type === 'video');
					return {
						url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(key)}`),
						proxyUrl: null,
						kind: asset.kind,
						width: vs?.type === 'video' ? vs.width : 640,
						height: vs?.type === 'video' ? vs.height : 360,
						durationFlicks: asset.probe.durationFlicks ?? null,
						hasAudio: false,
						rotation: 0,
					};
				},
			});
			const file = join(tempAppdir('jasper-fps-conform-'), 'still.png');
			await svc.remotion.renderStill({
				inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
				output: file,
				frame,
				signal: new AbortController().signal,
				browser,
			});
			return decodePng(readFileSync(file));
		}

		const log = (line: string) => {
			console.info(line);
			appendFileSync(join(out(), 'report.txt'), `${line}\n`);
		};

		for (const c of CONFORM_CASES)
			it(`${c.name}: native, hybrid, Remotion and the preview show the model's source frame`, async () => {
				const codes: Record<string, number[]> = {};
				let want: number[] = [];
				let d0: DocBuilder | null = null;
				for (const p of PATHS) {
					const { d, clipId } = build(c, p);
					d0 ??= d;
					want = modelFrames(d, clipId, c);
					codes[p] = readCodes(await exportFile(d, c.seq, p), c.at, want.length);
				}
				// The preview at the first frames (where Remotion's linear player used to differ), every repeated or
				// skipped source frame, and the last frame.
				const step = Math.round((c.media.num * c.seq.den) / (c.media.den * c.seq.num));
				const near = want.map((w, f) => (f > c.at && w - want[f - 1]! !== step ? f : -1)).filter((f) => f >= 0);
				const probe = [
					...new Set([c.at, c.at + 1, c.at + 2, c.at + 30, ...near.slice(0, 4), want.length - 1]),
				]
					.filter((f) => f < want.length)
					.sort((a, b) => a - b);
				const stills: Record<number, number> = {};
				for (const f of probe) stills[f] = codeOf(await previewStill(d0!, f));
				log(`\n[fps-conform] ${c.name}: ${want.length - c.at} frames`);
				for (const p of PATHS) {
					const bad = mismatches(want, codes[p]!);
					log(`  ${p}: ${bad.length} frames differ from the model${bad.length ? ` (first: ${bad.slice(0, 8).join(', ')})` : ''}`);
				}
				log('  frame | model | native | hybrid | remotion | preview still');
				for (const f of probe)
					log(`  ${f} | ${want[f]} | ${codes.native![f]} | ${codes.hybrid![f]} | ${codes.remotion![f]} | ${stills[f]}`);
				for (const f of probe) expect(stills[f], `preview still at ${f}`).toBe(want[f]);
				for (const p of PATHS) expect(mismatches(want, codes[p]!), `${p}: frames that differ`).toEqual([]);
			});

		for (const file of COLOUR_FILES)
			it(`colour of ${file}: every path matches the preview`, async () => {
				const c: ConformCase = { name: file, file, media: R2997, seq: { num: 30, den: 1 }, inFrame: 0, at: 0, frames: 30 };
				const frame = 10;
				const means: Record<string, number[][]> = {};
				const frames: Record<string, Rgba8> = {};
				const still = await previewStill(build(c, 'native').d, frame);
				means.preview = patchMeans(still);
				for (const p of PATHS) {
					frames[p] = decodeFrame(await exportFile(build(c, p).d, c.seq, p), frame);
					means[p] = patchMeans(frames[p]!);
				}
				log(`\n[fps-conform] colour of ${file} (frame ${frame}); patch means R,G,B`);
				log('  patch | source | preview | native | hybrid | remotion');
				SOURCE_PATCHES.forEach((s, i) =>
					log(
						`  ${i} | ${s.join(',')} | ${['preview', ...PATHS].map((k) => means[k]![i]!.map((v) => v.toFixed(1)).join(',')).join(' | ')}`,
					),
				);
				const nr = diffImages(frames.native!, frames.remotion!);
				const nh = diffImages(frames.native!, frames.hybrid!);
				log(`  native vs Remotion export: ${formatDiff(nr)}`);
				log(`  native vs hybrid export: ${formatDiff(nh)}`);
				for (const k of ['preview', ...PATHS])
					log(`  ${k}: largest patch error vs source R,G ${maxPatchError(means[k]!, SOURCE_PATCHES, [0, 1]).toFixed(2)}, B ${maxPatchError(means[k]!, SOURCE_PATCHES, [2]).toFixed(2)}`);
				// Hybrid and Remotion are the preview's renderer: the same colour.
				for (const p of ['hybrid', 'remotion'] as const)
					expect(maxPatchError(means[p]!, means.preview!), p).toBeLessThanOrEqual(3);
				// Native: the same matrix and range as the preview (R and G within 3 levels); B within Chrome's own decoder
				// deviation (libyuvBlueBound) of the exact decode.
				expect(maxPatchError(means.native!, means.preview!, [0, 1]), 'native R,G').toBeLessThanOrEqual(3);
				means.native!.forEach((n, i) =>
					expect(Math.abs(n[2]! - means.preview![i]![2]!), `native B of patch ${i}`).toBeLessThanOrEqual(
						libyuvBlueBound(n),
					),
				);
				// Tagged files and untagged HD decode to the source values natively (an untagged BT.601 SD file is shown with
				// BT.709 on every path, as the preview shows it).
				if (!file.endsWith('sd601.mp4'))
					expect(maxPatchError(means.native!, SOURCE_PATCHES), 'native vs source').toBeLessThanOrEqual(3);
			});
	},
);
