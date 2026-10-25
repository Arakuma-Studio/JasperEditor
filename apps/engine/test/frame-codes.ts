import { spawnSync } from 'node:child_process';

/** Decode the burned-in frame codes in one pass; starting ffmpeg for each frame dominated this suite. */
export function frameCodes(
	file: string,
	frames: readonly number[],
	offset: [number, number] = [0, 0],
): number[] {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...[
			'-vf',
			`select=${frames.map((f) => `eq(n\\,${f})`).join('+')},format=rgb24,crop=420:1:${40 + offset[0]}:${70 + offset[1]}`,
		],
		...['-vsync', '0', '-f', 'rawvideo', '-'],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	if (r.stdout.length !== frames.length * 420 * 3)
		throw new Error(`Expected ${frames.length} frame-code strips from ${file}, got ${r.stdout.length} bytes`);
	return frames.map((_, i) => {
		let code = 0;
		for (let b = 0; b < 6; b++) if (r.stdout[i * 420 * 3 + (30 + 70 * b) * 3]! > 127) code |= 1 << b;
		return code;
	});
}
