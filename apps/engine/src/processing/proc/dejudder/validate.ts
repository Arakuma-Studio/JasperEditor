// Validation of the de-judder step on real footage (not part of the runtime):
//
//   pnpm exec tsx apps/engine/src/processing/proc/dejudder/validate.ts \
//     [--src raw/crudo.mp4] [--in 37] [--out 40] [--threads 6] [--dir /tmp/dejudder-check] [--mode auto|force]
//     [--flow-width 960] [--levels 5] [--winsize 15] [--iterations 3] [--poly-n 5] [--poly-sigma 1.1] [--gaussian] [--smooth 4]
//     [--python <venv python> --cadence-py <cadence.py>] [--frame <index within the range for the PNGs>]
//
// Decodes the range as the step would (rgb48le, accurate seek), runs the step, writes lossless FFV1 copies of the
// input and the output, and reports the cadence before/after with our analyser and, when given, with the trailer
// project's reference analyser (`cadence.py --src <file>`; run on the exported files from t = 0, so its frame
// indices are relative to the range: absolute phase = (phase + firstFrame) mod 3). Also saves 3 consecutive
// input/output frames (+ 2× crops) as PNGs for visual inspection.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyseMotion, type CadenceResult, cadenceEvenness, measureMotion } from './cadence.ts';
import { ffv1Writer, fileSpec, makeStepContext, runFrameStep } from './harness.ts';
import { CvPool } from './pool.ts';
import { createDejudderStep } from './step.ts';

const { values: a } = parseArgs({
	options: {
		src: {
			type: 'string',
			default: '/var/lib/orquester/workspaces/jaspersito/MatsSmileTrailer/raw/crudo.mp4',
		},
		in: { type: 'string', default: '37' },
		out: { type: 'string', default: '40' },
		threads: { type: 'string', default: '6' },
		dir: { type: 'string', default: '/tmp/dejudder-check' },
		mode: { type: 'string', default: 'auto' },
		ffmpeg: { type: 'string' },
		'flow-width': { type: 'string' },
		levels: { type: 'string' },
		winsize: { type: 'string' },
		iterations: { type: 'string' },
		'poly-n': { type: 'string' },
		'poly-sigma': { type: 'string' },
		gaussian: { type: 'boolean', default: false },
		smooth: { type: 'string' },
		python: { type: 'string' },
		'cadence-py': { type: 'string' },
		frame: { type: 'string' },
		crop: { type: 'string' },
	},
});

const repo = new URL('../../../../../../', import.meta.url).pathname;
const FFMPEG = a.ffmpeg ?? join(repo, 'vendor/ffmpeg-lgpl/linux-x64/ffmpeg');
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');

function probe(file: string): { width: number; height: number; fps: { num: number; den: number } } {
	const r = spawnSync(
		FFPROBE,
		[
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height,r_frame_rate',
			'-of',
			'json',
			file,
		],
		{ encoding: 'utf8' },
	);
	const s = JSON.parse(r.stdout).streams[0];
	const [num, den] = String(s.r_frame_rate).split('/').map(Number);
	return { width: s.width, height: s.height, fps: { num, den: den || 1 } };
}

function ff(args: string[]): void {
	const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

const fmt = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
function line(label: string, r: CadenceResult, ev?: { cv: number; minOverMax: number }): string {
	return (
		`${label.padEnd(28)} phase ${r.shortPhase ?? '-'}  steps ${r.relStepByPhase.map((v) => fmt(v)).join('/')}` +
		`  short/long ${fmt(r.shortToLongRatio)}  consistency ${fmt(r.consistency * 100, 0)} % of ${r.triples}` +
		`  motion ${fmt(r.meanMotionPx1080p, 1)} px@1080p  moving ${r.movingPairs}/${r.pairs}` +
		(ev ? `  cv ${fmt(ev.cv, 3)}  min/max ${fmt(ev.minOverMax)}` : '')
	);
}

function reference(file: string, seconds: number, label: string): void {
	if (!a.python || !a['cadence-py']) return;
	const r = spawnSync(a.python, [a['cadence-py'], '0', seconds.toFixed(4), '--src', file, '--json'], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${join(FFMPEG, '..')}:${process.env.PATH}` },
	});
	if (r.status !== 0) {
		console.log(`${label}: cadence.py failed: ${r.stderr}`);
		return;
	}
	const j = JSON.parse(r.stdout.trim().split('\n').pop()!);
	const by: number[] = j.rel_step_by_phase;
	console.log(
		`${label.padEnd(28)} phase ${j.short_phase}  steps ${by.map((v) => fmt(v)).join('/')}  short/long ${fmt(
			j.short_to_long_ratio,
		)}  consistency ${fmt(j.consistency * 100, 0)} % of ${j.triples}  motion ${fmt(
			j.mean_motion_px_1080p,
			1,
		)} px@1080p  moving ${j.moving_pairs}/${j.pairs}  min/max ${fmt(Math.min(...by) / Math.max(...by))}`,
	);
}

async function main() {
	const src = a.src!;
	const dir = a.dir!;
	mkdirSync(dir, { recursive: true });
	const info = probe(src);
	const rate = info.fps.num / info.fps.den;
	const f0 = Math.round(Number(a.in) * rate);
	const n = Math.round((Number(a.out) - Number(a.in)) * rate);
	const spec = {
		ffmpeg: FFMPEG,
		inputArgs: ['-ss', ((f0 - 0.5) / rate).toFixed(6), '-i', src],
		frames: n,
		width: info.width,
		height: info.height,
		fps: info.fps,
	};
	const threads = Number(a.threads);
	const flow = {
		...(a['flow-width'] ? { maxWidth: Number(a['flow-width']) } : {}),
		...(a.levels ? { levels: Number(a.levels) } : {}),
		...(a.winsize ? { winsize: Number(a.winsize) } : {}),
		...(a.iterations ? { iterations: Number(a.iterations) } : {}),
		...(a['poly-n'] ? { polyN: Number(a['poly-n']) } : {}),
		...(a['poly-sigma'] ? { polySigma: Number(a['poly-sigma']) } : {}),
		...(a.gaussian ? { gaussian: true } : {}),
		...(a.smooth ? { smoothSigma: Number(a.smooth) } : {}),
	};
	console.log(
		`${src} ${a.in}-${a.out} s: frames ${f0}..${f0 + n - 1} (${n}), ${info.width}x${info.height}, ${threads} threads, flow ${JSON.stringify(flow)}`,
	);

	const inFile = join(dir, 'input.mkv');
	const outFile = join(dir, 'output.mkv');
	const ctx = makeStepContext(spec, { threads });
	const step = createDejudderStep(
		{ op: 'dejudder', mode: a.mode === 'force' ? 'force' : 'auto' },
		{ firstFrameIndex: f0, flow },
	);
	const inW = ffv1Writer(FFMPEG, inFile, info.width, info.height, info.fps);
	const outW = ffv1Writer(FFMPEG, outFile, info.width, info.height, info.fps);
	// Tee the decoded input frames into the lossless input copy.
	const tee = {
		...step,
		name: step.name,
		analyse: step.analyse?.bind(step),
		open: step.open.bind(step),
		end: step.end.bind(step),
		close: step.close?.bind(step),
		push: async (f: Parameters<typeof step.push>[0]) => {
			await inW.write(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength));
			return step.push(f);
		},
	};
	const t0 = performance.now();
	await runFrameStep(tee, spec, ctx, (f) =>
		outW.write(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength)),
	);
	const wall = (performance.now() - t0) / 1000;
	await inW.close();
	await outW.close();
	console.log(ctx.notes.join('\n'));
	console.log(
		`stats ${JSON.stringify(step.stats)}  ${fmt(Number(ctx.facts.secondsPerFrame), 3)} s/frame retiming pass (wall incl. decode, ${threads} workers), analysis ${fmt(Number(ctx.facts.analysisSeconds), 2)} s, ${fmt(wall / n, 3)} s/frame total incl. analysis + pool start`,
	);

	// Cadence before / after, our analyser (on the lossless copies, identical decode path).
	const pool = await CvPool.create(Math.min(threads, 6));
	try {
		for (const [label, file] of [
			['ours: input', inFile],
			['ours: output', outFile],
		] as const) {
			const m = await measureMotion(fileSpec(FFMPEG, file, n, info.width, info.height, info.fps), pool);
			const opts = { firstFrameIndex: f0, proxyWidth: m.proxyWidth };
			console.log(line(label, analyseMotion(m.motion, opts), cadenceEvenness(m.motion, opts)));
		}
	} finally {
		await pool.close();
	}
	// Reference analyser (cadence.py) on the same lossless files (indices relative to the range).
	if (a.python) console.log(`(cadence.py phases are relative to the range; absolute = (p + ${f0}) mod 3)`);
	reference(inFile, n / rate, 'cadence.py: input');
	reference(outFile, n / rate, 'cadence.py: output');

	// Three consecutive frames (one full cycle) for inspection, plus 2× crops.
	const k = a.frame ? Number(a.frame) : Math.floor(n / 2 / 3) * 3;
	const crop =
		a.crop ??
		`${Math.round(info.width / 3)}:${Math.round(info.height / 2)}:${Math.round(info.width / 3)}:${Math.round(info.height / 4)}`;
	for (const [tag, file] of [
		['in', inFile],
		['out', outFile],
	] as const) {
		ff([
			'-i',
			file,
			'-vf',
			`select='between(n,${k},${k + 2})',format=rgb24`,
			'-fps_mode',
			'passthrough',
			join(dir, `${tag}-%d.png`),
		]);
		ff([
			'-i',
			file,
			'-vf',
			`select='between(n,${k},${k + 2})',crop=${crop},scale=iw*2:ih*2:flags=neighbor,format=rgb24`,
			'-fps_mode',
			'passthrough',
			join(dir, `${tag}-crop-%d.png`),
		]);
	}
	const ph = step.cadence?.shortPhase ?? 0;
	const roles = [0, 1, 2].map(
		(i) => ['warped→next', 'anchor', 'warped→prev'][(((f0 + k + i - ph) % 3) + 3) % 3],
	);
	console.log(
		`PNGs in ${dir}: {in,out}-{1,2,3}.png = frames ${f0 + k}..${f0 + k + 2} (${roles.join(', ')}), crops ${crop} ×2`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
