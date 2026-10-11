// Benchmark + validation of the vid.stab WASM step (not a test; dev machines only):
//
//   pnpm exec tsx scripts/vidstab-wasm/bench.ts [--src raw/crudo.mp4] [--out /tmp/vidstab-wasm-check]
//                                                [--threads 6] [--ref-ffmpeg /usr/bin/ffmpeg] [--only speed|quality]
//
// (a) speed, s/frame, of motion detection and of the transform at 480p and 1080p: the WASM step vs the
//     system FFmpeg's vidstabdetect / vidstabtransform with the same parameters. The system FFmpeg is a GPL
//     build and is used here ONLY as a dev-time reference; it is never part of the shipped code path.
// (b) quality: residual jitter (the trailer's metric, grade/lab/stab_test.py): camera path from the per-pair
//     median Farnebäck flow at 424x240, in 1080p pixels; jitter = RMS of the path minus its 15-frame moving
//     average. On the desk shot (95.0–98.0 s) and the corridor (38.5–41.5 s) of the source: raw, WASM medium,
//     reference medium; plus the zoom each used. A few output frames are written as PNG for inspection.
//
// The FFmpeg used for decoding/encoding in the WASM path is the LGPL vendor build when present.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrames, RawWriter, spawnFfmpeg, u16 } from '../../apps/engine/src/processing/proc/ffio.ts';
import type { DecodeSpec, StepContext } from '../../apps/engine/src/processing/proc/types.ts';
import {
	createVidstabStep,
	type VidstabStepOptions,
} from '../../apps/engine/src/processing/proc/vidstab/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
	args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const SRC = args.get('src') ?? '/var/lib/orquester/workspaces/jaspersito/MatsSmileTrailer/raw/crudo.mp4';
const OUT = args.get('out') ?? '/tmp/vidstab-wasm-check';
const THREADS = Number(args.get('threads') ?? 6);
const REF = args.get('ref-ffmpeg') ?? '/usr/bin/ffmpeg';
const ONLY = args.get('only') ?? 'all'; // all | speed | quality
const vendor = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`, 'ffmpeg');
const FF = existsSync(vendor) ? vendor : 'ffmpeg';
mkdirSync(OUT, { recursive: true });

const FPS = 30;
const MEDIUM = { smoothing: 15, shakiness: 5, maxshift: 20, maxangle: 0.03 };

function run(cmd: string, argv: string[], env?: NodeJS.ProcessEnv): { seconds: number; stderr: string } {
	const t0 = performance.now();
	const r = spawnSync(cmd, argv, { env: { ...process.env, ...env }, maxBuffer: 1 << 30 });
	if (r.status !== 0)
		throw new Error(`${cmd} ${argv.join(' ')} failed: ${r.stderr?.toString().slice(-2000)}`);
	return { seconds: (performance.now() - t0) / 1000, stderr: r.stderr.toString() };
}

/** Frame-exact excerpt, as stab_test.py cuts it: ss = (round(t·30) − 0.5)/30, n frames, FFV1. */
function excerpt(name: string, tIn: number, tOut: number, size?: string): string {
	const out = join(OUT, `${name}.mkv`);
	if (existsSync(out)) return out;
	const n = Math.round((tOut - tIn) * FPS);
	const ss = ((Math.round(tIn * FPS) - 0.5) / FPS).toFixed(4);
	const vf = size ? ['-vf', `scale=${size}:flags=lanczos`] : [];
	run(FF, [
		'-v',
		'error',
		'-y',
		'-ss',
		ss,
		'-i',
		SRC,
		'-frames:v',
		String(n),
		'-an',
		...vf,
		'-c:v',
		'ffv1',
		out,
	]);
	return out;
}

function probe(file: string): { width: number; height: number; frames: number } {
	const r = spawnSync('ffprobe', [
		'-v',
		'error',
		'-count_frames',
		'-select_streams',
		'v:0',
		'-show_entries',
		'stream=width,height,nb_read_frames',
		'-of',
		'json',
		file,
	]);
	const s = JSON.parse(r.stdout.toString()).streams[0];
	return { width: s.width, height: s.height, frames: Number(s.nb_read_frames) };
}

function ctxFor(
	p: { width: number; height: number; frames: number },
	info: Record<string, unknown>,
): StepContext {
	return {
		ffmpeg: FF,
		ffprobe: 'ffprobe',
		threads: THREADS,
		device: 'cpu',
		scratch: OUT,
		width: p.width,
		height: p.height,
		frames: p.frames,
		fps: { num: FPS, den: 1 },
		models: {},
		note: (m) => console.log(`  note: ${m}`),
		info: (k, v) => {
			info[k] = v;
		},
		analysisProgress: () => {},
		signal: new AbortController().signal,
	};
}

type WasmRun = {
	detect: number;
	warp: number;
	total: number;
	zoom: number;
	info: Record<string, unknown>;
};

/** Runs the WASM step on `input`; writes FFV1 (rgb48 → gbrp16le, lossless) to `output` unless null. */
async function runWasm(
	input: string,
	output: string | null,
	step: { smoothing: number; shakiness: number; borders: 'crop' | 'keep' },
	opts: VidstabStepOptions,
): Promise<WasmRun> {
	const p = probe(input);
	const spec: DecodeSpec = {
		ffmpeg: FF,
		inputArgs: ['-i', input],
		frames: p.frames,
		width: p.width,
		height: p.height,
		fps: { num: FPS, den: 1 },
	};
	const info: Record<string, unknown> = {};
	const ctx = ctxFor(p, info);
	const s = createVidstabStep({ method: 'vidstab', rotation: true, ...step }, opts);
	const t0 = performance.now();
	await s.analyse?.(spec, ctx);
	const tA = performance.now();
	await s.open(ctx);
	const writer = output
		? new RawWriter(
				spawnFfmpeg(
					FF,
					[
						'-y',
						'-f',
						'rawvideo',
						'-pix_fmt',
						'rgb48le',
						'-s',
						`${p.width}x${p.height}`,
						'-r',
						String(FPS),
						'-i',
						'-',
						'-c:v',
						'ffv1',
						'-pix_fmt',
						'gbrp16le',
						output,
					],
					'pipe',
				),
			)
		: null;
	let index = 0;
	for await (const buf of decodeFrames(spec, { pixFmt: 'rgb48le' })) {
		const frames = await s.push({ index: index++, width: p.width, height: p.height, data: u16(buf) });
		for (const f of frames)
			await writer?.write(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength));
	}
	await s.end();
	await s.close?.();
	await writer?.close();
	const total = (performance.now() - t0) / 1000;
	const timing = info.timing as { detectSeconds: number };
	const warp = info.warp as { msPerFrame: number } | undefined;
	return {
		detect: timing.detectSeconds / p.frames,
		warp: (warp?.msPerFrame ?? 0) / 1000,
		total: total / p.frames,
		zoom: info.zoomPercent as number,
		info: { ...info, analyseSeconds: (tA - t0) / 1000 },
	};
}

/** The reference: system FFmpeg vid.stab (GPL, dev only), full-range 4:4:4 like the trailer pipeline. */
function runRef(input: string, output: string | null, threads: number) {
	const p = probe(input);
	const yuv = 'scale=out_color_matrix=bt709:out_range=pc:flags=accurate_rnd+full_chroma_int,format=yuv444p';
	const trf = join(OUT, `ref-${Date.now()}.trf`);
	const env = { OMP_NUM_THREADS: String(threads) };
	const base = run(REF, ['-v', 'error', '-i', input, '-vf', yuv, '-f', 'null', '-'], env).seconds;
	const det = run(
		REF,
		[
			'-v',
			'error',
			'-i',
			input,
			'-vf',
			`${yuv},vidstabdetect=shakiness=${MEDIUM.shakiness}:accuracy=15:stepsize=4:mincontrast=0.2:result=${trf}`,
			'-f',
			'null',
			'-',
		],
		env,
	).seconds;
	const tr = run(
		REF,
		[
			'-v',
			'info',
			'-y',
			'-i',
			input,
			'-vf',
			`${yuv},vidstabtransform=input=${trf}:smoothing=${MEDIUM.smoothing}:optalgo=gauss:maxshift=${MEDIUM.maxshift}:maxangle=${MEDIUM.maxangle}:crop=keep:optzoom=1:interpol=bicubic`,
			...(output ? ['-c:v', 'ffv1', output] : ['-f', 'null', '-']),
		],
		env,
	);
	const zl = tr.stderr.split('\n').filter((l) => /zoom/i.test(l));
	const zoomLine = zl.length ? zl[zl.length - 1].split(']').pop()?.trim() : '?';
	return {
		detect: Math.max(0, det - base) / p.frames,
		transform: Math.max(0, tr.seconds - base) / p.frames,
		detectRaw: det / p.frames,
		transformRaw: tr.seconds / p.frames,
		zoom: zoomLine,
	};
}

type Cv = {
	Mat: new (rows: number, cols: number, type: number) => CvMat;
	CV_8UC1: number;
	calcOpticalFlowFarneback(...a: unknown[]): void;
};
type CvMat = { data: Uint8Array; data32F: Float32Array; delete(): void };
let cvPromise: Promise<{ cv: Cv }> | null = null;
/**
 * Waits for the Emscripten runtime. The Module is a thenable whose then() never settles once initialised, so
 * it must never be returned from an async function or passed to resolve(): it travels boxed.
 */
function loadCv(): Promise<{ cv: Cv }> {
	cvPromise ??= new Promise((resolve) => {
		const req = createRequire(join(ROOT, 'apps', 'engine', 'package.json'));
		const m = req('@techstark/opencv-js');
		const poll = setInterval(() => {
			if (typeof m.Mat === 'function' && typeof m.calcOpticalFlowFarneback === 'function') {
				clearInterval(poll);
				resolve({ cv: m });
			}
		}, 20);
	});
	return cvPromise;
}

function median(a: Float32Array): number {
	const s = Float32Array.from(a).sort();
	const n = s.length;
	return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

async function jitter(file: string): Promise<number> {
	const t0 = performance.now();
	const { cv } = await loadCv();
	console.log(`  jitter ${file}: OpenCV ready after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
	const W = 424;
	const H = 240;
	const raw = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', file, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'],
		{
			maxBuffer: 1 << 30,
		},
	).stdout;
	const n = raw.length / (W * H);
	const d: Array<[number, number]> = [];
	for (let i = 0; i + 1 < n; i++) {
		const a = new cv.Mat(H, W, cv.CV_8UC1);
		const b = new cv.Mat(H, W, cv.CV_8UC1);
		a.data.set(raw.subarray(i * W * H, (i + 1) * W * H));
		b.data.set(raw.subarray((i + 1) * W * H, (i + 2) * W * H));
		const flow = new (cv.Mat as unknown as new () => CvMat)();
		cv.calcOpticalFlowFarneback(a, b, flow, 0.5, 4, 21, 3, 5, 1.1, 0);
		const f = flow.data32F;
		const fx = new Float32Array(W * H);
		const fy = new Float32Array(W * H);
		for (let k = 0; k < W * H; k++) {
			fx[k] = f[2 * k];
			fy[k] = f[2 * k + 1];
		}
		d.push([(median(fx) * 1920) / W, (median(fy) * 1920) / W]);
		a.delete();
		b.delete();
		flow.delete();
	}
	const p: Array<[number, number]> = [];
	let cx = 0;
	let cy = 0;
	for (const [x, y] of d) {
		cx += x;
		cy += y;
		p.push([cx, cy]);
	}
	const k = 15;
	const half = Math.floor(k / 2);
	let sum = 0;
	for (let i = 0; i < p.length; i++) {
		let sx = 0;
		let sy = 0;
		for (let j = i - half; j <= i + half; j++) {
			const q = p[Math.min(p.length - 1, Math.max(0, j))];
			sx += q[0];
			sy += q[1];
		}
		sum += (p[i][0] - sx / k) ** 2 + (p[i][1] - sy / k) ** 2;
	}
	return Math.sqrt(sum / p.length);
}

function png(video: string, frame: number, out: string): void {
	run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', out]);
}

const lines: string[] = [];
const log = (s: string) => {
	console.log(s);
	lines.push(s);
};
log(
	`vid.stab WASM bench  ${new Date().toISOString()}  threads=${THREADS}  ffmpeg(LGPL path)=${FF}  reference=${REF}`,
);
log(
	`host: ${process.platform}-${process.arch}, node ${process.version}, load ${spawnSync('uptime').stdout.toString().trim()}`,
);

const desk = excerpt('desk', 95.0, 98.0);
const corridor = excerpt('corridor', 38.5, 41.5);
const desk1080 = excerpt('desk1080', 95.0, 98.0, '1920:1080');

if (ONLY !== 'quality') {
	log('\n(a) speed, s/frame (WASM: detect incl. its gray decode; warp = pure 16-bit transform in the pool)');
	log(
		'| clip | WASM detect | WASM warp (pool) | WASM step total (incl. rgb48 decode) | ref detect (net / raw) | ref transform (net / raw) |',
	);
	log('|---|---|---|---|---|---|');
	for (const [label, file] of [
		['480p (848x480)', desk],
		['1080p (1920x1080, detect at 960x540)', desk1080],
	] as const) {
		const w = await runWasm(file, null, { smoothing: 15, shakiness: 5, borders: 'crop' }, {});
		const w1 = await runWasm(file, null, { smoothing: 15, shakiness: 5, borders: 'crop' }, { threads: 1 });
		const r1 = runRef(file, null, 1);
		const rN = runRef(file, null, THREADS);
		log(
			`| ${label} | ${w.detect.toFixed(4)} | ${w.warp.toFixed(4)} (${THREADS} thr) / ${w1.warp.toFixed(4)} (1 thr) | ${w.total.toFixed(4)} | ` +
				`${r1.detect.toFixed(4)} / ${r1.detectRaw.toFixed(4)} (OMP 1); ${rN.detect.toFixed(4)} / ${rN.detectRaw.toFixed(4)} (OMP ${THREADS}) | ` +
				`${r1.transform.toFixed(4)} / ${r1.transformRaw.toFixed(4)} (OMP 1); ${rN.transform.toFixed(4)} / ${rN.transformRaw.toFixed(4)} (OMP ${THREADS}) |`,
		);
	}
}
if (ONLY !== 'speed') {
	log('\n(b) residual jitter, px @1080p (RMS of camera path minus 15-frame moving average), medium preset');
	log('| clip | raw | WASM medium (zoom %) | reference medium (zoom) | WASM opt-L1 (zoom %) |');
	log('|---|---|---|---|---|');
	for (const [name, file] of [
		['desk 95.0–98.0 s', desk],
		['corridor 38.5–41.5 s', corridor],
	] as const) {
		const tag = name.split(' ')[0];
		const wOut = join(OUT, `${tag}-wasm-medium.mkv`);
		const lOut = join(OUT, `${tag}-wasm-opt.mkv`);
		const rOut = join(OUT, `${tag}-ref-medium.mkv`);
		const w = await runWasm(file, wOut, { smoothing: 15, shakiness: 5, borders: 'crop' }, { maxShift: 20 });
		const l = await runWasm(
			file,
			lOut,
			{ smoothing: 15, shakiness: 5, borders: 'crop' },
			{ maxShift: 20, algo: 'opt' },
		);
		const r = runRef(file, rOut, THREADS);
		const [jr, jw, jref, jl] = [
			await jitter(file),
			await jitter(wOut),
			await jitter(rOut),
			await jitter(lOut),
		];
		log(
			`| ${name} | ${jr.toFixed(2)} | ${jw.toFixed(2)} (${w.zoom.toFixed(2)}) | ${jref.toFixed(2)} (${r.zoom}) | ${jl.toFixed(2)} (${l.zoom.toFixed(2)}) |`,
		);
		for (const f of [0, 45, 89]) {
			png(wOut, f, join(OUT, `${tag}-wasm-${f}.png`));
			png(rOut, f, join(OUT, `${tag}-ref-${f}.png`));
		}
		png(file, 45, join(OUT, `${tag}-raw-45.png`));
		log(
			`  ${tag}: WASM info ${JSON.stringify(w.info.correction)} detect ${JSON.stringify((w.info.vidstab as { detect: unknown }).detect)}`,
		);
	}
}
writeFileSync(join(OUT, `bench-${ONLY}.md`), `${lines.join('\n')}\n`);
log(`\nwritten ${join(OUT, `bench-${ONLY}.md`)} and PNGs in ${OUT}`);
