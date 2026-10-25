import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
