// AF-SEC-003 (spec 18 §2.1): the native export checks its generated filtergraph for GPL-only filters before FFmpeg
// starts. The graph builder is wrapped to append one (as a regression in a filter mapping would), and the graph is
// made long enough to go through a -filter_complex_script file, which an argument check alone would not see.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, type TestApp } from './helpers.ts';

vi.mock('../src/export/native.ts', async (importOriginal) => {
	const orig = await importOriginal<typeof import('../src/export/native.ts')>();
	return {
		...orig,
		buildNativeGraph: (o: Parameters<typeof orig.buildNativeGraph>[0]) => {
			const g = orig.buildNativeGraph(o);
			// A no-op null chain pads the graph past the 60 000-character script threshold.
			const pad = Array.from({ length: 4000 }, (_, i) => `nullsrc=s=2x2:d=0.04,null[pad${i}]`).join(';\n');
			const filter = g.filter.replace('[vout]', '[vgpl];\n[vgpl]hqdn3d=1[vout]').concat(';\n', pad);
			const k = g.args.indexOf('-filter_complex');
			return { ...g, filter, args: [...g.args.slice(0, k + 1), filter, ...g.args.slice(k + 2)] };
		},
	};
});

let app: TestApp;
beforeAll(async () => {
	app = await makeApp();
}, 60_000);
afterAll(closeApps);

describe('AF-SEC-003: native export refuses a GPL-only filter before FFmpeg starts', () => {
	it('fails with GPL_FILTER_REFUSED and never starts the composite', async () => {
		const d = new DocBuilder();
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 0, 0, 1] }]);
		const core = coreServices(app);
		const spawned: string[][] = [];
		const run = core.ffmpeg.run.bind(core.ffmpeg);
		core.ffmpeg.run = (args, opts) => {
			spawned.push([...args]);
			return run(args, opts);
		};
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					video: {
						codec: 'h264',
						width: 320,
						height: 180,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 23 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
					engine: 'native',
				},
			},
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await core.queue.wait(start.json().id);
		expect(done.state).toBe('failed');
		expect(done.error).toMatchObject({ code: 'GPL_FILTER_REFUSED', retryable: false });
		expect(done.error?.message).toContain('"hqdn3d"');
		const composite = spawned.filter(
			(a) => a.includes('-filter_complex') || a.includes('-filter_complex_script'),
		);
		expect(composite).toEqual([]);
	}, 120_000);
});
