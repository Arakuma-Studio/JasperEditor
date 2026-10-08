// Workstream gaps (AU-7): Modify ▸ Audio Channels routings rendered by the export mixer (real ffmpeg): a source
// channel routed to both clip channels, a muted clip channel, and the decode arguments.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clipDecodeArgs } from '../src/audio/decode.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, ROOT, register, type TestApp } from './helpers.ts';

let app: TestApp;
const FFMPEG = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
const dir = mkdtempSync(join(tmpdir(), 'jasper-channels-'));
const src = join(dir, 'lr.wav');

beforeAll(async () => {
	// L = 440 Hz, R = 1000 Hz, 2 s.
	const r = spawnSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'sine=frequency=440:sample_rate=48000:duration=2',
		'-f',
		'lavfi',
		'-i',
		'sine=frequency=1000:sample_rate=48000:duration=2',
		'-filter_complex',
		'[0][1]amerge=inputs=2[a]',
		'-map',
		'[a]',
		'-c:a',
		'pcm_s16le',
		src,
	]);
	expect(r.status, r.stderr.toString()).toBe(0);
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

/** Decoded export audio: per channel, RMS and zero-crossing frequency. */
function analyse(file: string): { rms: number; hz: number }[] {
	const raw = spawnSync(
		FFMPEG,
		['-v', 'error', '-i', file, '-ss', '0.3', '-t', '1', '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'],
		{
			maxBuffer: 1 << 26,
		},
	).stdout;
	const n = raw.length / 8;
	const out = [0, 1].map(() => ({ sum: 0, zc: 0, prev: 0 }));
	for (let i = 0; i < n; i++)
		for (let c = 0; c < 2; c++) {
			const v = raw.readFloatLE((i * 2 + c) * 4);
			const o = out[c]!;
			o.sum += v * v;
			if ((o.prev < 0 && v >= 0) || (o.prev >= 0 && v < 0)) o.zc++;
			o.prev = v;
		}
	return out.map((o) => ({ rms: Math.sqrt(o.sum / n), hz: o.zc / 2 / (n / 48000) }));
}

describe('Audio Channels in the export mix', () => {
	it('decodes a muted clip channel as silence', () => {
		const { args } = clipDecodeArgs({
			clip: {
				start: 0,
				duration: 30,
				sourceIn: 0,
				speed: { rate: 1, reverse: false, maintainPitch: true },
				channels: { streamIndex: 0, map: [1, 1], mute: [1] },
			} as never,
			path: src,
			stream: {
				index: 0,
				type: 'audio',
				codec: 'pcm_s16le',
				sampleRate: 48000,
				channels: 2,
				channelLayout: 'stereo',
			},
			fps: { num: 30, den: 1 },
			sampleRate: 48000,
			offset: 0,
			length: 4800,
			soxr: false,
		});
		expect(args.join(' ')).toContain('pan=stereo|c0=c1|c1=0*c0');
	});

	it('routes the right source channel to the left clip channel and mutes the right one', async () => {
		const reg = await register(app, src);
		const d = new DocBuilder('hd-720p-30');
		const m = d.addMedia(reg);
		const placed = d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		void placed;
		const clipId = Object.values(d.doc.sequences[d.seqId]!.clips).find((c) => c.kind === 'audio')!.id;
		d.tx([
			{
				type: 'clip.setAudioChannels',
				clipIds: [clipId],
				channels: [{ streamIndex: reg.probe.streams[0]!.index, map: [1, 1], mute: [1] }],
			},
		]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'custom', startFrame: 0, endFrame: 45 },
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
					audio: { codec: 'aac', sampleRate: 48000, channels: 2, normalize: null },
					engine: 'native',
				},
			},
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const [l, r] = analyse((await coreServices(app).exports.outputFile(start.json().id))!);
		expect(l!.rms).toBeGreaterThan(0.05);
		expect(l!.hz).toBeGreaterThan(900);
		expect(l!.hz).toBeLessThan(1100);
		expect(r!.rms).toBeLessThan(0.002);
	}, 300_000);
});
