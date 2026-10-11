/** @param {string} encoders @param {boolean} lgplOnly @returns {string[]} */
export function fixtureH264Args(encoders, lgplOnly) {
	if (!lgplOnly && /\blibx264\b/.test(encoders))
		return ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30'];
	if (/\blibopenh264\b/.test(encoders))
		return [
			'-c:v',
			'libopenh264',
			'-b:v',
			'4M',
			'-allow_skip_frames',
			'0',
			'-pix_fmt',
			'yuv420p',
			'-g',
			'30',
		];
	throw new Error(
		`Fixture generation needs ${lgplOnly ? 'libopenh264' : 'libopenh264 or libx264'}; set JASPER_FFMPEG to a build with a supported H.264 encoder`,
	);
}
