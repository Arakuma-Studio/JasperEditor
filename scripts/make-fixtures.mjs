#!/usr/bin/env node
// Generates deterministic test media under fixtures/media/ with the system ffmpeg (ARCHITECTURE §14).
// Existing files are kept (delete them to regenerate). Outputs are gitignored.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fixtures', 'media');
const ffmpeg = process.env.JASPER_FFMPEG || 'ffmpeg';
mkdirSync(outDir, { recursive: true });

const base = ['-hide_banner', '-loglevel', 'error', '-y'];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30'];
const aac = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];

/** @type {{name: string, steps: (out: string) => string[][]}[]} */
const fixtures = [
	{
		name: 'clip-a.mp4',
		steps: (out) => [
			[
				...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10'],
				...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10'],
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
				...['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=6'],
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
				...['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=5'],
				...['-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out],
			],
		],
	},
	{
		name: 'still.png',
		steps: (out) => [['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1', '-frames:v', '1', out]],
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
	if (existsSync(target)) {
		console.log(`skip   ${fx.name} (exists)`);
		continue;
	}
	const partial = join(outDir, `.partial-${fx.name}`);
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
		console.log(`made   ${fx.name}`);
	} else {
		rmSync(partial, { force: true });
		failed = true;
	}
}
process.exit(failed ? 1 : 0);
