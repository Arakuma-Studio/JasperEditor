// Frame-rate conform (docs/wp-notes/time.md §15): a source whose frame rate differs from the sequence's shows,
// at every sequence frame, the source frame the time model picks (S01:CLP-004, `frameIndexAt` in
// packages/project/src/time-remap/sampling.ts) — on the native path, the hybrid layer bake and Remotion, and in the
// Program preview's renderer (Remotion stills of the compositions). Each source frame carries a 12-bit code
// (scripts/fixtures/fpsmap.mjs); the patches under it check the colour of every path against the source values and
// the preview. REMOTION_E2E=1; needs FFmpeg and Chrome.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testResultsDir } from '@jasper/testkit/env';
import { diffImages, formatDiff } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	FPSMAP_BITS,
	FPSMAP_PATCHES,
	fpsmapBitCentre,
	fpsmapPatchRect,
} from '../../../scripts/fixtures/fpsmap.mjs';
import type { RunningEngine } from '../src/index.ts';
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

type R = { num: number; den: number };
type Case = {
	name: string;
	file: string;
	media: R;
	seq: R;
	/** First source frame of the clip, sequence frame it starts at, and its length in sequence frames. */
	inFrame: number;
	at: number;
	frames: number;
};
const r = (num: number, den = 1): R => ({ num, den });
const CASES: Case[] = [
	{ name: '29.97 → 30', file: 'rate-code-2997.mp4', media: r(30000, 1001), seq: r(30), inFrame: 0, at: 0, frames: 1040 },
	{ name: '29.97 → 30 (slipped)', file: 'rate-code-2997.mp4', media: r(30000, 1001), seq: r(30), inFrame: 37, at: 5, frames: 90 },
	{ name: '23.976 → 24', file: 'rate-code-23976.mp4', media: r(24000, 1001), seq: r(24), inFrame: 0, at: 0, frames: 850 },
	{ name: '25 → 30', file: 'rate-code-25.mp4', media: r(25), seq: r(30), inFrame: 0, at: 0, frames: 120 },
	{ name: '60 → 30', file: 'rate-code-60.mp4', media: r(60), seq: r(30), inFrame: 0, at: 0, frames: 120 },
	{ name: '30 → 29.97', file: 'rate-code-30.mp4', media: r(30), seq: r(30000, 1001), inFrame: 0, at: 0, frames: 1040 },
	{ name: '30 → 30', file: 'rate-code-30.mp4', media: r(30), seq: r(30), inFrame: 11, at: 3, frames: 60 },
];
const PATHS = ['native', 'hybrid', 'remotion'] as const;
/** BT.709 tagged, BT.601 untagged SD, BT.601 tagged SD, BT.709 untagged HD (placed at 50 %). */
const COLOUR_FILES = [
	'rate-code-2997.mp4',
	'rate-code-2997-sd601.mp4',
	'rate-code-2997-sd601-tagged.mp4',
	'rate-code-2997-hd-untagged.mp4',
];
type Path = (typeof PATHS)[number];

const F = 705_600_000;

/** The source frame the time model shows at sequence frame `f` (S01:CLP-004 through `frameIndexAt`). */
function modelFrame(c: Case, sourceIn: number, start: number, f: number): number {
	const content = sourceIn + (f - start) * ((F * c.seq.den) / c.seq.num);
	return project.frameIndexAt({ kind: 'cfr', rate: c.media, count: 1 << 20 }, content / F);
}

/** Codes of every frame of `file` (frame index → code), read at the bit centres. */
function readCodes(file: string): number[] {
	const x0 = fpsmapBitCentre(0).x;
	const w = fpsmapBitCentre(FPSMAP_BITS - 1).x - x0 + 1;
	const run = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file],
			...['-vf', `format=rgb24,crop=${w}:1:${x0}:${fpsmapBitCentre(0).y}`],
			...['-fps_mode', 'passthrough', '-f', 'rawvideo', '-'],
		],
		{ maxBuffer: 1 << 28 },
	);
	if (run.status !== 0) throw new Error(run.stderr.toString());
	const out: number[] = [];
	for (let i = 0; i + w * 3 <= run.stdout.length; i += w * 3) {
		let code = 0;
		for (let b = 0; b < FPSMAP_BITS; b++) if (run.stdout[i + 50 * b * 3 + 1]! > 127) code |= 1 << b;
		out.push(code);
	}
	return out;
}

/** Frame `n` of `file` as RGBA (BT.709 limited decode: every export is tagged so). */
function decodeFrame(file: string, n: number, width: number, height: number): Rgba8 {
	const run = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file],
			...[
				'-vf',
				`select=eq(n\\,${n}),scale=in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba`,
			],
			...['-frames:v', '1', '-f', 'rawvideo', '-'],
		],
		{ maxBuffer: 1 << 26 },
	);
	if (run.status !== 0) throw new Error(run.stderr.toString());
	return { width, height, data: new Uint8Array(run.stdout) } as Rgba8;
}

function patchMeans(img: Rgba8): number[][] {
	return FPSMAP_PATCHES.map((_, i) => {
		const p = fpsmapPatchRect(i);
		const s = [0, 0, 0];
		for (let y = p.y; y < p.y + p.h; y++)
			for (let x = p.x; x < p.x + p.w; x++)
				for (let k = 0; k < 3; k++) s[k]! += img.data[(y * img.width + x) * 4 + k]!;
		return s.map((v) => v / (p.w * p.h));
	});
}
const maxPatchError = (a: number[][], b: number[][]) =>
	Math.max(...a.flatMap((p, i) => p.map((v, k) => Math.abs(v - b[i]![k]!))));

describe.runIf(enabled)('frame-rate conform: every path shows the model frame (REMOTION_E2E=1)', { timeout: 3_600_000 }, () => {
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
		for (const f of new Set([...CASES.map((c) => c.file), ...COLOUR_FILES]))
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

	function build(c: Case, path: Path): { d: DocBuilder; clipId: string } {
		const d = new helpers.DocBuilder();
		d.tx([{ type: 'sequence.updateSettings', settings: { width: 640, height: 360, frameRate: c.seq } }]);
		const m = d.addMedia(media.get(c.file)!);
		const placed = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: c.at,
				sourceRange: {
					in: { sourceFrames: c.inFrame },
					out: { sourceFrames: c.inFrame + Math.ceil((c.frames * c.media.num * c.seq.den) / (c.media.den * c.seq.num)) + 2 },
				},
				matchSequence: 'keep',
				audio: false,
			},
		]);
		const clipId = (placed.results[0] as { clipIds: string[] }).clipIds[0]!;
		const clip = d.doc.sequences[d.seqId]!.clips[clipId]!;
		if (c.file.includes('-hd-'))
			d.tx([{ type: 'param.set', target: ['clip', clipId, 'transform', 'scale'], value: 50 }]);
		d.tx([{ type: 'clip.trim', clipId, edge: 'out', deltaFrames: c.frames - clip.duration }]);
		// hybrid: a browser-only effect that leaves the picture as it is (the mirror line is the right edge) bakes the
		// whole layer through the compositions (S11 layer bake).
		if (path === 'hybrid')
			d.tx([
				{
					type: 'effect.add',
					target: { clipId },
					effectId: 'jasper.mirror',
					params: { reflectionCenter: [1, 0.5], reflectionAngle: 0 },
				},
			]);
		return { d, clipId };
	}

	async function exportFile(d: DocBuilder, seq: R, engineChoice: 'native' | 'remotion' | 'auto') {
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
					engine: engineChoice,
				},
			},
		});
		expect(res.statusCode, res.body).toBe(202);
		const done = await svc.queue.wait(res.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return {
			file: (await svc.exports.outputFile(done.id))!,
			path: (done.result as { renderPath: string }).renderPath,
		};
	}

	async function previewStill(d: DocBuilder, frame: number): Promise<Rgba8> {
		const svc = services.coreServices(engine.app);
		const doc = project.buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: (asset) => {
				const key = asset.locators.find((l) => l.type === 'engine-store')?.key;
				if (!key) throw new Error(`Missing engine-store locator for ${asset.id}`);
				return {
					url: svc.signer.signUrl(`http://127.0.0.1:${engine.port}`, `/media/${encodeURIComponent(key)}`),
					proxyUrl: null,
					kind: asset.kind,
					width: 640,
					height: 360,
					durationFlicks: asset.durationFlicks ?? null,
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

	for (const c of CASES)
		it(`${c.name}: native, hybrid and Remotion show the model's source frame`, async () => {
			const results: Record<string, number[]> = {};
			let expected: number[] = [];
			let d0: DocBuilder | null = null;
			for (const p of PATHS) {
				const { d, clipId } = build(c, p);
				d0 ??= d;
				const clip = d.doc.sequences[d.seqId]!.clips[clipId]!;
				expected = Array.from({ length: c.at + clip.duration }, (_, f) =>
					f < c.at ? -1 : modelFrame(c, clip.sourceIn, clip.start, f),
				);
				const exp = await exportFile(d, c.seq, p === 'remotion' ? 'remotion' : 'native');
				expect(exp.path).toBe(p);
				// frames before the clip are the sequence background (not compared)
				results[p] = readCodes(exp.file)
					.slice(0, expected.length)
					.map((code, f) => (f < c.at ? -1 : code));
			}
			// Program preview renderer: Remotion stills at the frames where the paths disagree, and a few others.
			const disagree = expected
				.map((e, f) => (f >= c.at && PATHS.some((p) => results[p]![f] !== e) ? f : -1))
				.filter((f) => f >= 0);
			const probe = [...new Set([c.at, c.at + 1, c.at + 2, ...disagree.slice(0, 6), expected.length - 1])].sort(
				(a, b) => a - b,
			);
			const stills: Record<number, number> = {};
			for (const f of probe) {
				const img = await previewStill(d0!, f);
				const strip = fpsmapBitCentre(0);
				let code = 0;
				for (let b = 0; b < FPSMAP_BITS; b++)
					if (img.data[(strip.y * img.width + fpsmapBitCentre(b).x) * 4 + 1]! > 127) code |= 1 << b;
				stills[f] = code;
			}
			log(`\n[fps-conform] ${c.name}: ${expected.length - c.at} frames`);
			for (const p of PATHS) {
				const bad = expected.map((e, f) => (f >= c.at && results[p]![f] !== e ? f : -1)).filter((f) => f >= 0);
				log(`  ${p}: ${bad.length} frames differ from the model${bad.length ? ` (first: ${bad.slice(0, 8).join(', ')})` : ''}`);
			}
			log('  frame | model | native | hybrid | remotion | preview still');
			for (const f of [...new Set([...probe, ...disagree.slice(0, 12)])].sort((a, b) => a - b))
				log(
					`  ${f} | ${expected[f]} | ${results.native![f]} | ${results.hybrid![f]} | ${results.remotion![f]} | ${stills[f] ?? ''}`,
				);
			for (const f of probe) expect(stills[f], `preview still at ${f}`).toBe(expected[f]);
			for (const p of PATHS) expect(results[p], `${p} frame codes`).toEqual(expected);
		});

	for (const file of COLOUR_FILES)
		it(`colour of ${file}: every path matches the source values and the preview`, async () => {
			const c: Case = { name: file, file, media: r(30000, 1001), seq: r(30), inFrame: 0, at: 0, frames: 30 };
			const frame = 10;
			const truth = FPSMAP_PATCHES.map((p) => [...p]);
			const lines: string[] = [];
			const means: Record<string, number[][]> = {};
			const { d } = build(c, 'native');
			const still = await previewStill(d, frame);
			means.preview = patchMeans(still);
			for (const p of PATHS) {
				const { d: dp } = build(c, p);
				const exp = await exportFile(dp, c.seq, p === 'remotion' ? 'remotion' : 'native');
				const img = decodeFrame(exp.file, frame, 640, 360);
				means[p] = patchMeans(img);
				lines.push(`  ${p} vs preview: ${formatDiff(diffImages(img, still))}`);
			}
			log(`\n[fps-conform] colour of ${file} (frame ${frame}); patch means R,G,B`);
			log(`  patch | source | preview | native | hybrid | remotion`);
			FPSMAP_PATCHES.forEach((_, i) =>
				log(
					`  ${i} | ${truth[i]!.join(',')} | ${['preview', ...PATHS].map((k) => means[k]![i]!.map((v) => v.toFixed(1)).join(',')).join(' | ')}`,
				),
			);
			for (const l of lines) log(l);
			for (const k of ['preview', ...PATHS])
				log(`  ${k}: largest patch error vs source ${maxPatchError(means[k]!, truth).toFixed(2)}`);
			for (const k of ['preview', ...PATHS]) expect(maxPatchError(means[k]!, truth), k).toBeLessThanOrEqual(3);
		});
});
