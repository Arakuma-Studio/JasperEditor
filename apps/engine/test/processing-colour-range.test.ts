// Colour range of processed clips (S07:PRC-003, PRC-020): every stabilise method (vid.stab WASM, smooth path,
// deshake crop/keep) and the denoise / deblock / de-judder combinations keep true black and white — measured on
// real decoded output, with EVERY ffmpeg available here: the LGPL FFmpeg 7.1 and the system FFmpeg 6.1 (which
// silently converts full → TV range in a `scale` without an explicit output range; the trailer pipeline had
// that bug: blacks lifted to 16, whites capped at 235 → "13…237"). Also a static guard: every `scale` the
// processor generates states its output range.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessStep } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createDeblockStep,
	createDenoiseStep,
	createDeshakeStep,
	fromFormatToRgb48,
	toFormat,
} from '../src/processing/proc/filters.ts';
import { runProc } from '../src/processing/proc/runner.ts';
import { createStepImpl } from '../src/processing/proc/steps.ts';
import type { StepContext } from '../src/processing/proc/types.ts';
import { ROOT } from './helpers.ts';

// ---------------------------------------------------------------- static guard

/** `scale` filters of a graph that do not set `out_range` (ffmpeg 6.1 then picks TV range for YUV output). */
function scalesWithoutRange(graph: string): string[] {
	return graph.split(/[,;]/).filter((f) => /^\s*(\[[^\]]*\]\s*)*scale=/.test(f) && !/out_range=/.test(f));
}

describe('generated filter text states the output range of every scale', () => {
	const ctx = { width: 1280, height: 720 } as StepContext;
	const graphs: Record<string, string> = {
		'deshake crop': createDeshakeStep({
			op: 'stabilize',
			method: 'deshake',
			smoothing: 15,
			borders: 'crop',
		}).filter(ctx),
		'deshake keep': createDeshakeStep({
			op: 'stabilize',
			method: 'deshake',
			smoothing: 15,
			borders: 'keep',
		}).filter(ctx),
		deblock: createDeblockStep({ op: 'deblock', filter: 'weak' }).filter(ctx),
		atadenoise: createDenoiseStep({ op: 'denoise', method: 'atadenoise', strength: 0.5 }).filter(ctx),
		nlmeans: createDenoiseStep({ op: 'denoise', method: 'nlmeans', strength: 0.5 }).filter(ctx),
		'to yuv444p': toFormat('yuv444p'),
		'to yuv444p16le from tv': toFormat('yuv444p16le', 'bt709', 'tv'),
		'to rgb48 from yuv': fromFormatToRgb48('yuv444p'),
	};
	for (const [name, g] of Object.entries(graphs))
		it(name, () => {
			expect(scalesWithoutRange(g)).toEqual([]);
		});
});

// ---------------------------------------------------------------- measured on real output

const LGPL_DIR = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`);

function version(ffmpeg: string): string | null {
	const r = spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' });
	if (r.status !== 0) return null;
	return /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? null;
}

/** Every distinct ffmpeg on this host: the LGPL build and the system one (6.1 on Ubuntu 24.04). */
const FFMPEGS = (() => {
	const out: Array<{ name: string; ffmpeg: string; ffprobe: string }> = [];
	if (existsSync(join(LGPL_DIR, 'ffmpeg')))
		out.push({ name: 'lgpl', ffmpeg: join(LGPL_DIR, 'ffmpeg'), ffprobe: join(LGPL_DIR, 'ffprobe') });
	const sys = version('ffmpeg');
	if (sys && spawnSync('ffprobe', ['-version']).status === 0)
		out.push({ name: `system ${sys}`, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
	return out;
})();

const W = 480;
const H = 272;
const N = 30;
const PAD = 12;
/** The black and white patches (output coordinates before jitter). */
const BLACK = { x0: 40, y0: 30, x1: 200, y1: 110 };
const WHITE = { x0: 280, y0: 30, x1: 440, y1: 110 };

/** Seeded textured canvas with a black and a white patch and a 0…255 ramp, shaken by a seeded walk. */
function fixtureFrames(): Buffer {
	let s = 987654321;
	const rnd = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const CW = W + 2 * PAD;
	const CH = H + 2 * PAD;
	const canvas = new Uint8Array(CW * CH * 3).fill(128);
	const rect = (x0: number, y0: number, x1: number, y1: number, v: (x: number, y: number) => number) => {
		for (let y = y0; y < y1; y++)
			for (let x = x0; x < x1; x++) {
				const c = v(x, y);
				const i = ((y + PAD) * CW + x + PAD) * 3;
				canvas[i] = canvas[i + 1] = canvas[i + 2] = c;
			}
	};
	// texture (features for the trackers) everywhere, incl. the pad
	for (let k = 0; k < 700; k++) {
		const x = Math.floor(rnd() * (CW - 10));
		const y = Math.floor(rnd() * (CH - 10));
		const sz = 3 + Math.floor(rnd() * 7);
		const c = 40 + Math.floor(rnd() * 176);
		for (let yy = y; yy < y + sz; yy++)
			for (let xx = x; xx < x + sz; xx++) {
				const i = (yy * CW + xx) * 3;
				canvas[i] = canvas[i + 1] = canvas[i + 2] = c;
			}
	}
	rect(BLACK.x0, BLACK.y0, BLACK.x1, BLACK.y1, () => 0);
	rect(WHITE.x0, WHITE.y0, WHITE.x1, WHITE.y1, () => 255);
	rect(40, 140, 440, 190, (x) => Math.round(((x - 40) / 399) * 255));
	const frames = Buffer.alloc(W * H * 3 * N);
	let ox = 0;
	let oy = 0;
	for (let f = 0; f < N; f++) {
		if (f > 0) {
			ox = Math.max(-PAD + 2, Math.min(PAD - 2, ox + Math.round((rnd() * 2 - 1) * 4)));
			oy = Math.max(-PAD + 2, Math.min(PAD - 2, oy + Math.round((rnd() * 2 - 1) * 4)));
		}
		for (let y = 0; y < H; y++) {
			const src = ((y + PAD + oy) * CW + PAD + ox) * 3;
			Buffer.from(canvas.buffer, src, W * 3).copy(frames, (f * H + y) * W * 3);
		}
	}
	return frames;
}

/**
 * Levels of a whole file decoded with its tagged range (R'G'B' 0…255): the 0.5th / 99.5th percentiles over all
 * pixels and channels (the fixture is ~10 % pure black and ~10 % pure white, so the stabilisers' motion and
 * zoom do not matter), and the 99.99th percentile of the chroma deviation max(|R−G|, |B−G|) (the fixture is
 * achromatic: anything coloured — e.g. green borders — is a bug).
 */
function levels(
	ffmpeg: string,
	file: string,
	range: 'tv' | 'pc',
): { low: number; high: number; chroma: number } {
	const res = spawnSync(
		ffmpeg,
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`scale=in_color_matrix=bt709:in_range=${range}:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24`,
			'-f',
			'rawvideo',
			'-',
		],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	const d = res.stdout;
	const hist = new Float64Array(256);
	const dev = new Float64Array(256);
	for (let i = 0; i + 2 < d.length; i += 3) {
		hist[d[i]]++;
		hist[d[i + 1]]++;
		hist[d[i + 2]]++;
		dev[Math.max(Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 2] - d[i + 1]))]++;
	}
	const pct = (h: Float64Array, p: number) => {
		const total = h.reduce((x, y) => x + y, 0);
		let acc = 0;
		for (let v = 0; v < 256; v++) {
			acc += h[v];
			if (acc >= total * p) return v;
		}
		return 255;
	};
	return { low: pct(hist, 0.005), high: pct(hist, 0.995), chroma: pct(dev, 0.9999) };
}

const RECIPES: Record<string, ProcessStep[]> = {
	'vid.stab': [{ op: 'stabilize', method: 'vidstab', smoothing: 10, borders: 'crop' }],
	'smooth path': [
		{
			op: 'stabilize',
			method: 'smoothpath',
			smoothing: 10,
			borders: 'crop',
			lockVertical: true,
			maxZoom: 115,
		},
	],
	'deshake crop': [{ op: 'stabilize', method: 'deshake', smoothing: 10, borders: 'crop' }],
	'deshake keep': [{ op: 'stabilize', method: 'deshake', smoothing: 10, borders: 'keep' }],
	'deblock + atadenoise + vid.stab': [
		{ op: 'deblock', filter: 'weak' },
		{ op: 'denoise', method: 'atadenoise', strength: 0.5 },
		{ op: 'stabilize', method: 'vidstab', smoothing: 10, borders: 'crop' },
	],
	'nlmeans + deshake crop': [
		{ op: 'denoise', method: 'nlmeans', strength: 0.3 },
		{ op: 'stabilize', method: 'deshake', smoothing: 10, borders: 'crop' },
	],
	'dejudder + deshake crop': [
		{ op: 'dejudder', mode: 'force' },
		{ op: 'stabilize', method: 'deshake', smoothing: 10, borders: 'crop' },
	],
	'deblock + fftdnoiz + dejudder + smooth path': [
		{ op: 'deblock', filter: 'strong' },
		{ op: 'denoise', method: 'fftdnoiz', strength: 0.5 },
		{ op: 'dejudder', mode: 'force' },
		{ op: 'stabilize', method: 'smoothpath', smoothing: 10, borders: 'crop', maxZoom: 115 },
	],
};

describe.skipIf(!FFMPEGS.length)('stabilised output keeps true black and white (all ffmpegs)', () => {
	let dir: string;
	const inputs: Record<'tv' | 'pc', string> = { tv: '', pc: '' };
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'jasper-range-'));
		const raw = fixtureFrames();
		const ff = FFMPEGS[0]!.ffmpeg;
		for (const range of ['tv', 'pc'] as const) {
			const out = join(dir, `ramp-${range}.mkv`);
			const r = spawnSync(
				ff,
				[
					...[
						'-v',
						'error',
						'-y',
						'-f',
						'rawvideo',
						'-pix_fmt',
						'rgb24',
						'-s',
						`${W}x${H}`,
						'-r',
						'30',
						'-i',
						'-',
					],
					...[
						'-vf',
						`scale=out_color_matrix=bt709:out_range=${range}:flags=accurate_rnd+full_chroma_int,format=yuv420p`,
					],
					...[
						'-color_primaries',
						'bt709',
						'-color_trc',
						'bt709',
						'-colorspace',
						'bt709',
						'-color_range',
						range,
					],
					...['-c:v', 'ffv1', out],
				],
				{ input: raw },
			);
			if (r.status !== 0) throw new Error(r.stderr.toString());
			inputs[range] = out;
		}
	}, 120_000);
	afterAll(() => {
		if (!process.env.JASPER_KEEP_RANGE_TEST) rmSync(dir, { recursive: true, force: true });
		else console.log(`[range] kept ${dir}`);
	});

	it('the fixture itself decodes to 0 / 255, achromatic', () => {
		for (const range of ['tv', 'pc'] as const)
			expect(levels(FFMPEGS[0]!.ffmpeg, inputs[range], range)).toEqual({ low: 0, high: 255, chroma: 0 });
	});

	for (const fx of FFMPEGS)
		for (const [name, steps] of Object.entries(RECIPES))
			for (const range of ['tv', 'pc'] as const)
				it(`${name} · ${fx.name} · ${range}-range source`, async () => {
					const id = `${name}-${fx.name}-${range}`.replace(/[^a-z0-9]+/gi, '_');
					const output = join(dir, `${id}.mov`);
					const scratch = join(dir, `scratch-${id}`);
					mkdirSync(scratch, { recursive: true });
					await runProc(
						{
							input: inputs[range],
							output,
							steps,
							ffmpeg: fx.ffmpeg,
							ffprobe: fx.ffprobe,
							models: {},
							threads: 2,
							device: 'cpu',
							scratch,
							vidstabEngine: 'wasm',
						},
						{ emit: () => {}, signal: new AbortController().signal, createStep: createStepImpl },
					);
					// The output is ProRes tagged TV range: decode it as such (with the same ffmpeg and the LGPL one).
					for (const dec of [fx.ffmpeg, FFMPEGS[0]!.ffmpeg]) {
						const l = levels(dec, output, 'tv');
						const what = `(${name}, ${fx.name}, ${range}-range source, decoded by ${dec})`;
						expect(l.low, `black level ${what}`).toBeLessThanOrEqual(2);
						expect(l.high, `white level ${what}`).toBeGreaterThanOrEqual(253);
						expect(l.chroma, `colour cast on achromatic content ${what}`).toBeLessThanOrEqual(6);
					}
					if (!process.env.JASPER_KEEP_RANGE_TEST) rmSync(output, { force: true });
				}, 300_000);
});
