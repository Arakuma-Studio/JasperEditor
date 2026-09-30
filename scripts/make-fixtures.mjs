#!/usr/bin/env node
// Generates deterministic test media under fixtures/media/ with the system ffmpeg (ARCHITECTURE §14;
// `JASPER_FFMPEG` selects another one, e.g. the LGPL build in vendor/ffmpeg-lgpl/<platform>/).
// Existing files are kept while their recipe is unchanged: a `.<name>.recipe` stamp holds a hash of the
// ffmpeg arguments, and a missing or different stamp regenerates the file. Outputs are gitignored.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fixtures', 'media');
const ffmpeg = process.env.JASPER_FFMPEG || 'ffmpeg';
mkdirSync(outDir, { recursive: true });

const base = ['-hide_banner', '-loglevel', 'error', '-y'];
// H.264 sources that mimic camera files. x264 is used when the ffmpeg has it (the recipe the fixtures were
// tuned with); an LGPL build (ARCHITECTURE D-13) encodes them with OpenH264 instead, so x264 is never needed.
const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
const h264 =
	/\blibx264\b/.test(encoders) || !/\blibopenh264\b/.test(encoders)
		? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30']
		: ['-c:v', 'libopenh264', '-b:v', '4M', '-allow_skip_frames', '0', '-pix_fmt', 'yuv420p', '-g', '30'];
const aac = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
/**
 * A tone whose level changes over time, so timeline waveforms show a shape (a steady sine draws as a flat
 * band). `envelope` is an ffmpeg expression in `t` with values in 0…1.
 */
const shapedTone = (hz, seconds, envelope) => [
	'-f',
	'lavfi',
	'-i',
	`aevalsrc='0.5*sin(2*PI*${hz}*t)*(${envelope})':s=48000:d=${seconds}`,
];

/**
 * A 1 s overlay with an alpha channel (straight alpha): a transparent 1080p frame with a half-transparent
 * green box in the middle and an opaque white box top left.
 */
const alphaOverlay = [
	'-f',
	'lavfi',
	'-i',
	'color=c=black@0.0:size=1920x1080:rate=30:duration=1,format=rgba,' +
		'drawbox=x=480:y=270:w=960:h=540:color=0x00FF00@0.5:t=fill:replace=1,' +
		'drawbox=x=100:y=100:w=200:h=200:color=white@1.0:t=fill:replace=1',
];
const bt709 = [
	'-colorspace',
	'bt709',
	'-color_primaries',
	'bt709',
	'-color_trc',
	'bt709',
	'-color_range',
	'tv',
];

/** @type {{name: string, steps: (out: string) => string[][]}[]} */
const fixtures = [
	{
		name: 'clip-a.mp4',
		steps: (out) => [
			[
				...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10'],
				// Speech-like: syllables (1.3 Hz) under a slow phrase swell.
				...shapedTone(440, 10, 'abs(sin(2*PI*1.3*t))*(0.4+0.6*abs(sin(2*PI*0.21*t)))'),
				...h264,
				...aac,
				...['-t', '10', '-movflags', '+faststart', out],
			],
		],
	},
	{
		name: 'clip-b.mp4',
		steps: (out) => [
			[
				...['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6'],
				...shapedTone(660, 6, '0.55+0.45*sin(2*PI*1.7*t)'),
				...h264,
				...aac,
				...['-t', '6', '-movflags', '+faststart', out],
			],
		],
	},
	{
		name: 'tone.wav',
		steps: (out) => [
			[
				// Decaying 1 kHz beeps, two per second.
				...shapedTone(1000, 5, 'exp(-5*mod(t,0.5))'),
				...['-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out],
			],
		],
	},
	{
		name: 'still.png',
		steps: (out) => [['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1', '-frames:v', '1', out]],
	},
	{
		// ProRes 4444 with alpha: what Remotion/After Effects write for overlays; browsers cannot decode it.
		name: 'overlay-alpha.mov',
		steps: (out) => [
			[
				...alphaOverlay,
				...['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le'],
				...['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', ...bt709],
				...['-f', 'mov', out],
			],
		],
	},
	{
		// VP9 with alpha in WebM (alpha lives in Matroska BlockAdditions; plays in Chromium).
		name: 'overlay-alpha.webm',
		steps: (out) => [
			[
				...alphaOverlay,
				...['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuva420p'],
				...['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '20'],
				...['-auto-alt-ref', '0', '-row-mt', '1', ...bt709, '-f', 'webm', out],
			],
		],
	},
	{
		name: 'phone-rot90.mp4',
		steps: (out) => {
			const tmp = `${out}.tmp.mp4`;
			return [
				[
					...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=5'],
					...['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=5'],
					...h264,
					...aac,
					...['-t', '5', tmp],
				],
				// Stream copy with a 90 degree display matrix (phone portrait footage stored landscape).
				['-display_rotation', '90', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', out],
			];
		},
	},
];

let failed = false;
for (const fx of fixtures) {
	const target = join(outDir, fx.name);
	const stampFile = join(outDir, `.${fx.name}.recipe`);
	const recipe = createHash('sha256')
		.update(JSON.stringify(fx.steps('<out>')))
		.digest('hex')
		.slice(0, 16);
	const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : null;
	if (existsSync(target) && stamp === recipe) {
		console.log(`skip   ${fx.name} (exists)`);
		continue;
	}
	// Per-process partial name: parallel test workers may run this script at once.
	const partial = join(outDir, `.partial-${process.pid}-${fx.name}`);
	const steps = fx.steps(partial);
	let ok = true;
	for (const args of steps) {
		const r = spawnSync(ffmpeg, [...base, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
		if (r.error || r.status !== 0) {
			console.error(`failed ${fx.name}: ${r.error?.message ?? `ffmpeg exited ${r.status}`}`);
			ok = false;
			break;
		}
	}
	rmSync(`${partial}.tmp.mp4`, { force: true });
	if (ok) {
		renameSync(partial, target);
		writeFileSync(stampFile, recipe);
		console.log(`made   ${fx.name}`);
	} else {
		rmSync(partial, { force: true });
		failed = true;
	}
}
process.exit(failed ? 1 : 0);
