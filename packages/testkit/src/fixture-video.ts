// Encoder arguments for generated test media. FFmpeg is LGPL only (AGENTS.md §2): the vendored build the engine tests
// prefer (vendor/ffmpeg-lgpl) has no x264 / x265, so a fixture made with libx264 cannot be made there at all. These use
// encoders every FFmpeg build has (its own MPEG-4 Part 2 and FFV1) or libvpx (BSD), which the LGPL build and the usual
// system builds both carry. `scripts/fixture-gpl-encoders.test.mjs` keeps GPL encoders out of every fixture.

/**
 * Media the engine decodes (ffmpeg): FFmpeg's own MPEG-4 Part 2 encoder at near-lossless constant quality (q 2:
 * ≈ 51 dB PSNR on testsrc2, more than x264's defaults). Works in `.mp4`, `.mov`, `.mkv`.
 */
export const ENGINE_VIDEO_ARGS: readonly string[] = ['-c:v', 'mpeg4', '-q:v', '2'];

/** Lossless video (FFV1; `.mov` keeps exact frame times, `.mkv` rounds them to 1 ms). Any pixel format. */
export const LOSSLESS_VIDEO_ARGS: readonly string[] = ['-c:v', 'ffv1'];

/**
 * Media a browser plays (Chrome / Chromium decode VP9 in every build, no proprietary codec needed): VP9 at constant
 * quality 12 (≈ 53 dB PSNR on testsrc2), real-time speed. Works in `.mp4` and `.webm`.
 */
export const BROWSER_VIDEO_ARGS: readonly string[] = [
	'-c:v',
	'libvpx-vp9',
	'-crf',
	'12',
	'-b:v',
	'0',
	'-deadline',
	'realtime',
	'-cpu-used',
	'8',
	'-row-mt',
	'1',
];
