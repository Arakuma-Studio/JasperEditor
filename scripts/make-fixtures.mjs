#!/usr/bin/env node
// Generates deterministic test media under fixtures/media/ with the system ffmpeg (ARCHITECTURE §14;
// `JASPER_FFMPEG` selects another one, e.g. the LGPL build in vendor/ffmpeg-lgpl/<platform>/).
// Existing files are kept while their recipe is unchanged: a `.<name>.recipe` stamp holds a hash of the
// ffmpeg arguments, and a missing or different stamp regenerates the file. Outputs are gitignored.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * 64 frames whose number is burned in as a 6-bit code: white/black 60×60 blocks at y=40, x=40+70·bit (bit 0
 * left). Tests read it back from exports to check that cuts and overlays land on the exact frame.
 */
const frameCode = (colour) => [
	'-f',
	'lavfi',
	'-i',
	`color=c=${colour}:size=1920x1080:rate=30:duration=3,format=rgb24,drawbox=x=30:y=30:w=440:h=80:color=black:t=fill${[
		0, 1, 2, 3, 4, 5,
	]
		.map(
			(b) =>
				`,drawbox=x=${40 + 70 * b}:y=40:w=60:h=60:color=white:t=fill:enable='eq(mod(floor(n/${1 << b}),2),1)'`,
		)
		.join('')},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
	'-frames:v',
	'64',
];

/** @type {({name: string, steps: (out: string) => string[][]} | {name: string, recipe: string, make: (out: string) => unknown})[]} */
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
		name: 'frame-code.mp4',
		steps: (out) => [
			[...frameCode('0x204080'), ...h264, ...bt709, '-movflags', '+faststart', '-f', 'mp4', out],
		],
	},
	{
		// frame-code.mp4 with an AAC track: AAC's encoder priming gives the audio a negative first timestamp that the
		// MP4 edit list hides (ffmpeg's start_time stays 0) — what most camera and phone files have (retime decoder).
		name: 'frame-code-aac.mp4',
		steps: (out) => [
			[
				...shapedTone(440, 3, '1'),
				...frameCode('0x204080'),
				...h264,
				...bt709,
				...aac,
				...['-shortest', '-movflags', '+faststart', '-f', 'mp4', out],
			],
		],
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
		// VP8 with alpha: libvpx cannot decode it after an input seek (the native path trims instead).
		name: 'overlay-alpha-vp8.webm',
		steps: (out) => [
			[
				...alphaOverlay,
				...['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuva420p'],
				...['-c:v', 'libvpx', '-pix_fmt', 'yuva420p', '-b:v', '2M', '-auto-alt-ref', '0'],
				...[...bt709, '-f', 'webm', out],
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

// M2 (ARCHITECTURE §19.11): feature packages add fixtures in their own module `scripts/fixtures/<name>.mjs`
// exporting `fixtures(ctx)` → entries `{name, steps(out)}` (ffmpeg argument lists, as above) or
// `{name, recipe, make(out)}` (custom generator; `recipe` is any string that changes when the output would).
const pluginDir = join(root, 'scripts', 'fixtures');
if (existsSync(pluginDir)) {
	for (const file of readdirSync(pluginDir)
		.filter((f) => f.endsWith('.mjs'))
		.sort()) {
		const mod = await import(pathToFileURL(join(pluginDir, file)).href);
		fixtures.push(...(await mod.fixtures({ ffmpeg, base, h264, aac })));
	}
}

// One generator at a time (verify workstream): several test files spawn this script at once on a clean checkout
// (CI), and concurrent runs made every fixture twice, replaced files other tests were reading, and failed renaming a
// directory fixture onto the other run's copy (ENOTEMPTY). The lock holds the owner's pid; a dead owner's lock is
// taken over. Whoever waited then finds the fixtures current and skips them.
const lockFile = join(outDir, '.make-fixtures.lock');
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === 'EPERM';
	}
};
for (let waited = 0; ; ) {
	try {
		const fd = openSync(lockFile, 'wx');
		writeSync(fd, String(process.pid));
		closeSync(fd);
		break;
	} catch (e) {
		if (e?.code !== 'EEXIST') throw e;
		const owner = Number(readFileSync(lockFile, 'utf8').trim());
		if (!(owner > 0) || !alive(owner)) {
			rmSync(lockFile, { force: true });
			continue;
		}
		if (waited === 0) console.log(`wait   fixtures are being made by process ${owner}`);
		await new Promise((r) => setTimeout(r, 250));
		waited += 250;
	}
}
const unlock = () => {
	try {
		if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) rmSync(lockFile, { force: true });
	} catch {
		// already gone
	}
};
process.on('exit', unlock);

let failed = false;
for (const fx of fixtures) {
	const target = join(outDir, fx.name);
	const stampFile = join(outDir, `.${fx.name}.recipe`);
	const recipe = createHash('sha256')
		.update(fx.make ? `make:${fx.recipe}` : JSON.stringify(fx.steps('<out>')))
		.digest('hex')
		.slice(0, 16);
	const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : null;
	if (existsSync(target) && stamp === recipe) {
		console.log(`skip   ${fx.name} (exists)`);
		continue;
	}
	// Per-process partial name: parallel test workers may run this script at once.
	const partial = join(outDir, `.partial-${process.pid}-${fx.name}`);
	let ok = true;
	if (fx.make) {
		try {
			await fx.make(partial);
		} catch (e) {
			console.error(`failed ${fx.name}: ${e?.message ?? e}`);
			ok = false;
		}
	}
	const steps = fx.make ? [] : fx.steps(partial);
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
		// A directory fixture (an image sequence) cannot be renamed over its previous version.
		rmSync(target, { recursive: true, force: true });
		renameSync(partial, target);
		writeFileSync(stampFile, recipe);
		console.log(`made   ${fx.name}`);
	} else {
		rmSync(partial, { force: true });
		failed = true;
	}
}
process.exit(failed ? 1 : 0);
