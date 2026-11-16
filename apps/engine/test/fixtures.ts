import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegPath, ffprobePath } from '@jasper/testkit/oracle';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FIXTURES = join(ROOT, 'fixtures', 'media');
/** A clean CI checkout has no vendor binaries; use the engine's oracle resolution when the LGPL build is absent. */
const VENDOR_FFMPEG = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`);
export const TEST_FFMPEG = existsSync(join(VENDOR_FFMPEG, 'ffmpeg'))
	? join(VENDOR_FFMPEG, 'ffmpeg')
	: (ffmpegPath() ?? 'ffmpeg');
export const TEST_FFPROBE = existsSync(join(VENDOR_FFMPEG, 'ffprobe'))
	? join(VENDOR_FFMPEG, 'ffprobe')
	: (ffprobePath() ?? 'ffprobe');
export function ensureFixtures(): void {
	const needed = [
		'clip-a.mp4',
		'clip-b.mp4',
		'tone.wav',
		'still.png',
		'phone-rot90.mp4',
		'overlay-alpha.mov',
		'overlay-alpha.webm',
		'frame-code.mp4',
		'overlay-alpha-vp8.webm',
	];
	if (needed.every((n) => existsSync(join(FIXTURES, n)))) return;
	const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	if (r.status !== 0) throw new Error('fixture generation failed');
}

export function fixture(name: string): string {
	return join(FIXTURES, name);
}

/**
 * A real camera file for tests that export or measure (an offline media refuses both): `seconds` of a solid-colour
 * 1920×1080 30 fps MPEG-4 Part 2 picture (LGPL encoder) with, when `audio`, a silent 48 kHz stereo AAC track. One
 * second is encoded and looped by stream copy, so a long source costs about as much as a short one.
 */
export function writeSolidVideo(
	path: string,
	seconds: number,
	opts: { color: string; audio?: boolean },
): string {
	const ff = (args: string[]) => {
		const r = spawnSync(TEST_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
		if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString() ?? r.error}`);
	};
	const second = `${path}.1s.mp4`;
	ff([
		...['-f', 'lavfi', '-i', `color=c=${opts.color}:s=1920x1080:r=30:d=1`],
		...['-c:v', 'mpeg4', '-q:v', '31', '-g', '30', '-pix_fmt', 'yuv420p', second],
	]);
	ff([
		...['-stream_loop', String(Math.ceil(seconds) - 1), '-i', second],
		...(opts.audio ? ['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${seconds}`] : []),
		...['-map', '0:v', ...(opts.audio ? ['-map', '1:a', '-c:a', 'aac'] : [])],
		...['-c:v', 'copy', '-t', String(seconds), path],
	]);
	rmSync(second);
	return path;
}
