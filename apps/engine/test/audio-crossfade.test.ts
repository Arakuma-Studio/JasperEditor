import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp, tempAppdir } from './helpers.ts';

let app: TestApp;
let dir: string;
beforeAll(async () => {
	app = await makeApp();
	dir = tempAppdir('jasper-xfade-');
	// Two steady tones of the same level and different pitch (uncorrelated over a 20 ms window).
	for (const [name, hz] of [
		['tone-1000.wav', 1000],
		['tone-1500.wav', 1500],
	] as const) {
		const r = spawnSync('ffmpeg', [
			'-v',
			'error',
			'-f',
			'lavfi',
			'-i',
			`sine=frequency=${hz}:sample_rate=48000:duration=4`,
			'-ac',
			'2',
			'-c:a',
			'pcm_s16le',
			join(dir, name),
		]);
		if (r.status !== 0) throw new Error(`tone generation failed: ${r.stderr}`);
	}
}, 120_000);
afterAll(closeApps);

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 320,
		height: 180,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 30 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

/**
 * A1: tone 1000 Hz at 0…45 (media 0.5…2 s), tone 1500 Hz at 45…90 (media 0.5…2 s), joined by a centred
 * 20-frame crossfade: span [35, 55), 10 frames of handle on each side.
 */
async function crossfadeDoc(effectId: string, extra: Record<string, unknown> = {}) {
	const d = new DocBuilder();
	const a = d.addMedia(await register(app, join(dir, 'tone-1000.wav')));
	const b = d.addMedia(await register(app, join(dir, 'tone-1500.wav')));
	const place = (mediaId: string, at: number, ref: string) => ({
		type: 'clip.place',
		source: { mediaId },
		at,
		sourceRange: { in: { seconds: 0.5 }, out: { seconds: 2 } },
		ref,
	});
	d.tx([place(a, 0, '$a'), place(b, 45, '$b')]);
	d.tx([{ type: 'transition.add', trackId: d.track('A1'), at: 45, effectId, duration: 20, ...extra }]);
	return d;
}

async function exportedAudio(effectId: string, extra: Record<string, unknown> = {}): Promise<string> {
	const d = await crossfadeDoc(effectId, extra);
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	expect(start.statusCode).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	expect(done.result).toMatchObject({ frames: 90, renderPath: 'native' });
	return (await coreServices(app).exports.outputFile(start.json().id))!;
}

/** RMS level (dBFS) of consecutive 20 ms windows, from ffmpeg astats. */
function windowLevels(file: string): number[] {
	const r = spawnSync('ffmpeg', [
		'-v',
		'error',
		'-i',
		file,
		'-vn',
		'-af',
		'aresample=48000,asetnsamples=n=960:p=0,astats=metadata=1:reset=1:measure_perchannel=none,' +
			'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
		'-f',
		'null',
		'-',
	]);
	return [...r.stdout.toString().matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) =>
		m[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[1]),
	);
}

function pcm(file: string): Float32Array {
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
		{
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	const b = r.stdout;
	return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** Amplitude of a sine at `hz` in `x[from, from + n)` (Goertzel). */
function toneAmplitude(x: Float32Array, from: number, n: number, hz: number): number {
	const w = (2 * Math.PI * hz) / 48000;
	const k = 2 * Math.cos(w);
	let s1 = 0;
	let s2 = 0;
	for (let i = from; i < from + n; i++) {
		const s0 = x[i]! + k * s1 - s2;
		s2 = s1;
		s1 = s0;
	}
	return (2 * Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2)) / n;
}

describe('audio crossfades on the native path (S10:TUI-052)', () => {
	it('exports a constant-power crossfade between two tones without a gap or a level bump > 0.5 dB', async () => {
		const file = await exportedAudio('jasper.constant-power');

		// 3 s = 150 windows of 20 ms; skip the AAC edges (first / last 100 ms).
		const levels = windowLevels(file);
		expect(levels.length).toBeGreaterThanOrEqual(149);
		const inner = levels.slice(5, 145);
		const sorted = [...inner].sort((x, y) => x - y);
		const ref = sorted[sorted.length >> 1]!;
		expect(ref).toBeGreaterThan(-40);
		const worst = inner.reduce((m, l) => Math.max(m, Math.abs(l - ref)), 0);
		expect(worst).toBeLessThan(0.5);

		// The span really mixes the tones: cos / sin quarter waves of the steady amplitude.
		const x = pcm(file);
		const at = (frame: number, hz: number) => toneAmplitude(x, frame * 1600 - 480, 960, hz);
		const full = at(20, 1000);
		expect(at(20, 1500)).toBeLessThan(full * 0.02); // before the span: only A
		expect(at(75, 1500) / full).toBeCloseTo(1, 1); // after the span: only B
		expect(at(75, 1000)).toBeLessThan(full * 0.02);
		for (const f of [40, 45, 50]) {
			const p = (f - 35) / 20;
			expect(at(f, 1000) / full).toBeCloseTo(Math.cos((p * Math.PI) / 2), 1);
			expect(at(f, 1500) / full).toBeCloseTo(Math.sin((p * Math.PI) / 2), 1);
		}
	}, 180_000);

	it('exports a constant-gain crossfade with half of each tone at the cut', async () => {
		const x = pcm(await exportedAudio('jasper.constant-gain'));
		const at = (frame: number, hz: number) => toneAmplitude(x, frame * 1600 - 480, 960, hz);
		const full = at(20, 1000);
		expect(full).toBeGreaterThan(0);
		expect(at(45, 1000) / full).toBeCloseTo(0.5, 1);
		expect(at(45, 1500) / full).toBeCloseTo(0.5, 1);
	}, 180_000);

	it('exports an off-centre asymmetrical Custom Fade on the curves it asks for (Premiere port)', async () => {
		// span [40, 60): 5 frames before the cut; B fades in on Cosine @ 30, A fades out on Linear @ −10
		const x = pcm(
			await exportedAudio('jasper.custom-fade', {
				cutOffset: 5,
				params: {
					fadeShape: 'cosine',
					fadeValue: 30,
					symmetry: 'asymmetric',
					outFadeShape: 'linear',
					outFadeValue: -10,
				},
			}),
		);
		const at = (frame: number, hz: number) => toneAmplitude(x, frame * 1600 - 480, 960, hz);
		const full = at(20, 1000);
		expect(full).toBeGreaterThan(0);
		expect(at(35, 1500)).toBeLessThan(full * 0.02); // before the span: only A
		expect(at(65, 1000)).toBeLessThan(full * 0.02); // after it: only B
		// Independent values from the documented Custom Fade family (wp-notes/audio-crossfades.md),
		// evaluated at progress .1, .25, .5, .75 and .9. The 20 ms window is centred on frame f.
		for (const [f, incoming, outgoing] of [
			[42, 0.288831, 0.859207],
			[45, 0.525692, 0.660781],
			[50, 0.792935, 0.368504],
			[55, 0.948377, 0.135795],
			[58, 0.991741, 0.036287],
		] as const) {
			expect(at(f, 1500) / full).toBeCloseTo(incoming, 1);
			expect(at(f, 1000) / full).toBeCloseTo(outgoing, 1);
		}
	}, 180_000);
});
