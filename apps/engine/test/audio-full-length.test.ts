// A sound whose length is not a whole number of frames plays to its last sample: a 1.128 s file placed on a 60 fps
// sequence is a 68-frame clip (67.68 frames rounded up), and the engine's mixer — the audio of every export path —
// renders the whole file, then silence for the rest of the last frame. Before the fix the clip was 67 frames and the
// last 11 ms of the file never played.
import { writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { renderMixdown, WAV_F32_HEADER_BYTES } from '../src/audio/mixdown.ts';
import { audioWorld } from '../src/sound-design/bed.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, tempAppdir } from './helpers.ts';

const SR = 48_000;
/** 1.128 s of a steady 1 kHz tone at half scale, loud to its last sample. */
const N = Math.round(1.128 * SR);

let app: FastifyInstance;
let file = '';
beforeAll(async () => {
	app = await makeApp();
	const tone = Float32Array.from({ length: N }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR));
	file = join(tempAppdir('jasper-full-length-'), 'keke.wav');
	writeFileSync(file, encodeWav([tone, tone], SR, 'f32'));
});
afterAll(closeApps);

it('mixes the whole sound of a clip placed from a file that is not a whole number of frames', async () => {
	const b = new DocBuilder('hd-1080p-60');
	const mediaId = b.addMedia(await register(app, file));
	b.tx([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: 'A1' } }]);
	const world = await audioWorld(b.doc, b.seqId, coreServices(app).registry);
	const scratch = tempAppdir('jasper-full-length-mix-');
	const out = await renderMixdown({
		ff: coreServices(app).ffmpeg,
		snapshot: world.snapshot,
		media: world.media,
		range: { start: 0, end: 72 },
		outputLayout: 'stereo',
		scratchDir: scratch,
		withoutLoudness: true,
	});
	const buf = await readFile(out.path!);
	const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset + WAV_F32_HEADER_BYTES));
	await rm(scratch, { recursive: true, force: true });
	const rms = (a: number, z: number) => {
		let s = 0;
		for (let i = a; i < z; i++) s += (pcm[i * 2] ?? 0) ** 2;
		return Math.sqrt(s / (z - a));
	};
	// the file's last 11 ms (past 67 frames = 53 600 samples) play at the tone's level (0.5 / √2)…
	expect(rms(53_600, N)).toBeGreaterThan(0.3);
	// …then silence to the end of frame 68 (54 400 samples) and after the clip
	expect(rms(N + 48, 72 * 800)).toBeLessThan(1e-4);
});
