import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileSpec, makeStepContext, runFrameStep } from '../src/processing/proc/dejudder/harness.ts';
import { createDejudderStep } from '../src/processing/proc/dejudder/step.ts';
import { decodeFrames } from '../src/processing/proc/ffio.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FFMPEG = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
const HAVE_FFMPEG = process.platform === 'linux' && process.arch === 'x64' && existsSync(FFMPEG);

describe.skipIf(!HAVE_FFMPEG)('automatic de-judder of a steady pan', () => {
	const W = 640;
	const H = 360;
	const N = 45;
	let dir = '';
	let steady = '';

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'jasper-dejudder-'));
		const ff = (args: string[]) => {
			const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
			if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
		};
		const still = join(dir, 'still.png');
		const octave = (w: number, h: number, tag: string) =>
			`color=gray:s=${w}x${h},noise=alls=100:allf=u,scale=2400:360:flags=bicubic[${tag}]`;
		ff([
			'-f',
			'lavfi',
			'-i',
			`${octave(300, 45, 'a')};${octave(1200, 180, 'b')};[a][b]blend=all_mode=average`,
			'-frames:v',
			'1',
			still,
		]);
		steady = join(dir, 'steady.mkv');
		ff([
			'-loop',
			'1',
			'-framerate',
			'30',
			'-i',
			still,
			'-vf',
			`crop=${W}:${H}:'n*10':0`,
			'-frames:v',
			String(N),
			'-c:v',
			'ffv1',
			'-pix_fmt',
			'gbrp',
			steady,
		]);
	}, 60_000);

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('copies every decoded frame when no uneven cadence exists', async () => {
		const spec = fileSpec(FFMPEG, steady, N, W, H);
		const ctx = makeStepContext(spec, { threads: 2 });
		const step = createDejudderStep({ op: 'dejudder', mode: 'auto' });
		const result = await runFrameStep(step, spec, ctx);
		expect(result.outputFrames).toBe(N);
		let index = 0;
		for await (const buf of decodeFrames(spec, { pixFmt: 'rgb48le' })) {
			const frame = result.frames[index++];
			expect(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).equals(buf)).toBe(
				true,
			);
		}
		expect(index).toBe(N);
	}, 60_000);
});
