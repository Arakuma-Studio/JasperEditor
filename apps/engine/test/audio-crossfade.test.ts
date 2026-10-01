// Two-sided audio crossfades on the native path (S10:TUI-052, §8 test 7): the audio chains play the clips'
// handles with an afade out / in pair over the span, and a constant-power crossfade between two tones has no
// gap and no level bump at the cut (measured with ffmpeg astats over 20 ms windows).
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

let app: TestApp;
let dir: string;
beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-xfade-'));
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
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

/**
 * A1: tone 1000 Hz at 0…45 (media 0.5…2 s), tone 1500 Hz at 45…90 (media 0.5…2 s), joined by a centred
 * 20-frame crossfade: span [35, 55), 10 frames of handle on each side.
 */
async function crossfadeDoc(effectId: string) {
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
	d.tx([{ type: 'transition.add', trackId: d.track('A1'), at: 45, effectId, duration: 20 }]);
	return d;
}

async function plan(d: DocBuilder) {
	const planned = await coreServices(app).exports.plan({
		envelope: d.envelope(),
		sequenceId: d.seqId,
		settings: settings(d.seqId) as never,
	});
	expect(planned.plan.path).toBe('native');
	expect(planned.plan.blockers).toEqual([]);
	return {
		planned,
		graph: buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mp4',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
		}),
	};
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

/** Mono float samples of the export's audio. */
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
	it('plays the handles and writes an afade out / in pair over the span', async () => {
		const { planned, graph } = await plan(await crossfadeDoc('jasper.constant-power'));
		const [sa, sb] = planned.snapshot.audioClips;
		expect(sa).toMatchObject({ start: 0, duration: 45, tailHandle: 10 });
		expect(sb).toMatchObject({ start: 45, duration: 45, headHandle: 10 });
		// A: 55 frames from 0.5 s (45 + 10 of tail handle), fade out over [35, 55).
		expect(graph.filter).toContain(
			'atrim=end_sample=88000,asetpts=PTS-STARTPTS,afade=t=out:ss=56000:ns=32000:curve=qsin[a0]',
		);
		// B: starts at frame 35 with media 0.5 s − 10 frames, fades in over the same span.
		expect(graph.filter).toContain(
			'atrim=end_sample=88000,asetpts=PTS-STARTPTS,afade=t=in:ss=0:ns=32000:curve=qsin,adelay=delays=56000S:all=1[a1]',
		);
		const seeks = graph.inputs.filter((i) => i.some((a) => a.endsWith('.wav'))).map((i) => i.slice(0, 2));
		expect(seeks).toEqual([
			['-ss', '0.500000'],
			['-ss', '0.166667'],
		]);
		// Constant gain uses the linear ramp.
		const linear = await plan(await crossfadeDoc('jasper.constant-gain'));
		expect(linear.graph.filter).toContain('afade=t=out:ss=56000:ns=32000:curve=tri');
		expect(linear.graph.filter).toContain('afade=t=in:ss=0:ns=32000:curve=tri');
	}, 60_000);

	it('exports a constant-power crossfade between two tones without a gap or a level bump > 0.5 dB', async () => {
		const d = await crossfadeDoc('jasper.constant-power');
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
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;

		// 3 s = 150 windows of 20 ms; skip the AAC edges (first / last 100 ms).
		const levels = windowLevels(file);
		expect(levels.length).toBeGreaterThanOrEqual(149);
		const inner = levels.slice(5, 145);
		const sorted = [...inner].sort((x, y) => x - y);
		const ref = sorted[sorted.length >> 1]!;
		expect(ref).toBeGreaterThan(-40); // not silent
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
});
