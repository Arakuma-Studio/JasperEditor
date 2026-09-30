// Runs the engine's tracking job on a file without a server (S09 validation aid, wp-m2-track).
//
//   pnpm --filter @jasper/engine exec tsx scripts/track-file.ts --file clip.mov --kind planar \
//     --ref 46 --corners "886,596 1787,616 1790,1100 880,1100" [--range 0,92] [--direction both] \
//     [--quality balanced] [--refine-edges] [--features inside|surroundings|both] \
//     [--truth plate-planar.json] [--json out.json] [--every 10]
//   … --kind point --point 805,209 [--patch 33] [--search 40]
//
// Prints the tracked geometry every `--every` frames, the corner motion relative to the reference frame, speed,
// lost frames, and (with --truth, the fixture JSON format) RMS/max errors against the ground truth.
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { TrackRequest, TrackResult } from '@jasper/api';
import { Broadcaster } from '../src/events/broadcaster.ts';
import type { JobContext } from '../src/jobs/types.ts';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';
import type { CoreServices } from '../src/tools/services.ts';
import { TrackingService, type TrackJobInput } from '../src/tracking/service.ts';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const pairs = (s: string) =>
	s
		.trim()
		.split(/\s+/)
		.map((p) => p.split(',').map(Number) as [number, number]);

const file = arg('file');
if (!file) {
	console.error(
		'usage: track-file.ts --file <video> --kind planar|point --ref <frame> --corners "x,y x,y x,y x,y"',
	);
	process.exit(2);
}
const ff = new Ffmpeg(resolveBinaries());
const probe = await ff.probeJson([
	'-select_streams',
	'v:0',
	'-count_packets',
	'-show_entries',
	'stream=width,height,r_frame_rate,nb_read_packets:stream_side_data=rotation',
	file,
]);
const st = (probe.streams as Record<string, unknown>[])[0]!;
const [num, den] = String(st.r_frame_rate).split('/').map(Number) as [number, number];
const rot = Math.abs(
	Number(
		((st.side_data_list as { rotation?: number }[] | undefined) ?? []).find((d) => d.rotation)?.rotation ?? 0,
	),
);
const w0 = Number(st.width);
const h0 = Number(st.height);
const display = rot === 90 || rot === 270 ? { width: h0, height: w0 } : { width: w0, height: h0 };
const frameCount = Number(st.nb_read_packets);

const truth = arg('truth') ? JSON.parse(await readFile(arg('truth')!, 'utf8')) : null;
const kind = (arg('kind') ?? (truth?.points ? 'point' : 'planar')) as 'planar' | 'point';
const ref = Number(arg('ref') ?? truth?.reference.frame ?? Math.floor(frameCount / 2));
const range = (arg('range') ?? `0,${frameCount}`).split(',').map(Number) as [number, number];
const reference: TrackRequest['reference'] =
	kind === 'planar'
		? { frame: ref, corners: arg('corners') ? pairs(arg('corners')!) : truth.corners[ref] }
		: {
				frame: ref,
				point: arg('point') ? pairs(arg('point')!)[0]! : truth.points[ref],
				...(arg('patch') || truth?.reference.patch
					? { patch: Number(arg('patch') ?? truth.reference.patch) }
					: {}),
				...(arg('search') || truth?.reference.search
					? { search: Number(arg('search') ?? truth.reference.search) }
					: {}),
			};
const request: TrackRequest = {
	mediaKey: 'mk_cli',
	kind,
	reference,
	range: { startFrame: range[0], endFrame: range[1] },
	direction: (arg('direction') ?? 'both') as TrackRequest['direction'],
	quality: (arg('quality') ?? 'balanced') as TrackRequest['quality'],
	options: {
		...(arg('features') ? { features: arg('features') as 'inside' } : {}),
		...(flag('refine-edges') ? { refineEdges: true } : {}),
	},
};
const input: TrackJobInput = { request, file, display, fps: { num, den }, frameCount };
const core = { ffmpeg: ff, broadcaster: new Broadcaster() } as unknown as CoreServices;
const svc = new TrackingService(core);
const ctx: JobContext = {
	job: { id: 'job_cli' } as JobContext['job'],
	input,
	signal: new AbortController().signal,
	slots: Number(arg('slots') ?? 2),
	progress: () => undefined,
	trackChild: () => undefined,
	addPartial: () => undefined,
	scratchDir: async () => '/tmp',
	log: (t) => console.error(t),
};
const t0 = performance.now();
const result = (await svc.runner(ctx)) as TrackResult;
const wall = (performance.now() - t0) / 1000;
svc.shutdown();

const n = result.data.length / result.stride;
const every = Number(arg('every') ?? 10);
const at = (i: number) => result.data.slice(i * result.stride, (i + 1) * result.stride);
const refIdx = ref - result.startFrame;
const r0 = at(refIdx);
let maxMotion = 0;
for (let i = 0; i < n; i++) {
	const v = at(i);
	let m = 0;
	for (let k = 0; k < v.length; k += 2) m = Math.max(m, Math.hypot(v[k]! - r0[k]!, v[k + 1]! - r0[k + 1]!));
	maxMotion = Math.max(maxMotion, m);
	if (i % every === 0 || i === n - 1)
		console.log(
			`f${String(result.startFrame + i).padStart(5)}  conf ${result.confidence[i]!.toFixed(2)}  ` +
				v.map((x) => x.toFixed(2).padStart(8)).join(' ') +
				`   |Δref| ${m.toFixed(1)} px`,
		);
}
console.log(
	`${n} frames, ${display.width}x${display.height} ${num}/${den} fps, quality ${request.quality}: ` +
		`${result.framesPerSec ?? '?'} frames/s tracking, ${(n / wall).toFixed(1)} frames/s wall (incl. start-up ${wall.toFixed(2)} s); ` +
		`max motion vs reference ${maxMotion.toFixed(1)} px; lost ${result.lost.length ? result.lost.join(',') : 'none'}`,
);

if (truth) {
	const occluded = new Set<number>(truth.occluded ?? []);
	let sum = 0;
	let cnt = 0;
	let max = 0;
	let maxAt = -1;
	const occ: string[] = [];
	for (let i = 0; i < n; i++) {
		const f = result.startFrame + i;
		const gt: number[] = kind === 'planar' ? truth.corners[f].flat() : truth.points[f];
		const v = at(i);
		let fmax = 0;
		for (let k = 0; k < v.length; k += 2) {
			const e = Math.hypot(v[k]! - gt[k]!, v[k + 1]! - gt[k + 1]!);
			fmax = Math.max(fmax, e);
			if (!occluded.has(f)) {
				sum += e * e;
				cnt++;
			}
		}
		if (occluded.has(f) || (f > Math.max(...occluded) && f <= Math.max(...occluded) + 5))
			occ.push(`${f}:${result.lost.includes(f) ? 'lost' : fmax.toFixed(2)}`);
		if (!occluded.has(f) && fmax > max) {
			max = fmax;
			maxAt = f;
		}
	}
	console.log(
		`error vs truth (excl. occluded): RMS ${Math.sqrt(sum / cnt).toFixed(3)} px, max ${max.toFixed(3)} px @f${maxAt}`,
	);
	if (occ.length) console.log(`occlusion + 5 after: ${occ.join(' ')}`);
}
if (arg('json')) writeFileSync(arg('json')!, JSON.stringify(result));
