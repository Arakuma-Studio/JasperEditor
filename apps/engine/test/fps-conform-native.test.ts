// Frame-rate conform on the native path (docs/wp-notes/time.md §15): every exported frame shows the source frame the
// time model picks (S01:CLP-004 / `frameIndexAt`, what the preview's retime pipeline shows), for 29.97 → 30,
// 23.976 → 24, 25 → 30, 60 → 30 and 30 → 29.97, a clip starting at a later in-point, a constant speed and a frame hold;
// plus the pure parts (seek window, timing filters, untagged matrix). Before the fix the builder showed the nearest
// frame counted from the first frame after the seek point (537 of 1040 frames wrong for 29.97 → 30).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inColor, seekWindow, sourceTimingFilters } from '../src/export/native.ts';
import type { LocalMedia } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	buildConform,
	CONFORM_CASES,
	type ConformCase,
	mismatches,
	modelFrames,
	readCodes,
	TIMING_EXTRA_CASES,
} from './fps-conform-support.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

describe('source timing filters (pure)', () => {
	it('seeks two media frames (at least 0.25 s) early, never before the start, in whole microseconds', () => {
		expect(seekWindow(10, 30000 / 1001)).toEqual({ seek: 9.75, lead: 0.25 });
		expect(seekWindow(10, 1)).toEqual({ seek: 8, lead: 2 });
		expect(seekWindow(0.1, 30)).toEqual({ seek: 0, lead: 0.1 });
		const w = seekWindow(1.2345678, null);
		expect(w.seek).toBe(0.984568);
		expect(w.lead).toBeCloseTo(0.25, 6);
	});
	it('maps media time to output slots with round=up from the layer start (2 µs tolerance)', () => {
		expect(sourceTimingFilters({ lead: 0.25, speed: 0.7, fps: { num: 30, den: 1 }, frames: 90 })).toEqual([
			'settb=AVTB',
			'setpts=(PTS-250000)/0.7-2',
			'fps=fps=30/1:round=up:start_time=0',
			'trim=end_frame=90',
		]);
	});
	it('decodes untagged video with BT.709 at every size, as the Program preview does; tags win', () => {
		const media = (matrix: string, height: number, range = 'tv') =>
			({
				record: {
					probe: {
						streams: [
							{
								type: 'video',
								width: (height * 16) / 9,
								height,
								color: { matrix, range },
								frameRate: { num: 30, den: 1 },
							},
						],
					},
				},
			}) as unknown as LocalMedia;
		expect(inColor(media('unknown', 360))).toBe(':in_color_matrix=bt709:in_range=tv');
		expect(inColor(media('unknown', 1080))).toBe(':in_color_matrix=bt709:in_range=tv');
		expect(inColor(media('smpte170m', 480))).toBe(':in_color_matrix=bt601:in_range=tv');
		expect(inColor(media('bt470bg', 1080, 'pc'))).toBe(':in_color_matrix=bt601:in_range=pc');
		expect(inColor(media('bt2020nc', 2160))).toBe(':in_color_matrix=bt2020:in_range=tv');
	});
});

let app: TestApp;
const media = new Map<string, Awaited<ReturnType<typeof register>>>();
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
	for (const c of [...CONFORM_CASES, ...TIMING_EXTRA_CASES])
		if (!media.has(c.file)) media.set(c.file, await register(app, fixture(c.file)));
}, 300_000);
afterAll(closeApps);

async function exportNative(d: DocBuilder, c: ConformCase): Promise<string> {
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
					width: 640,
					height: 360,
					frameRate: c.seq,
					scaling: 'fit',
					quality: { mode: 'crf', value: 16 },
					encoderSpeed: 'fast',
				},
				audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				engine: 'native',
			},
		},
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	expect((done.result as { renderPath: string }).renderPath).toBe('native');
	return (await coreServices(app).exports.outputFile(start.json().id))!;
}

describe('native export shows the time model’s source frame', () => {
	for (const c of [...CONFORM_CASES, ...TIMING_EXTRA_CASES])
		it(c.name, async () => {
			const d = new DocBuilder();
			const { clipId } = buildConform(d, media.get(c.file)!, c);
			const want = modelFrames(d, clipId, c);
			const got = readCodes(await exportNative(d, c), c.at, want.length);
			const bad = mismatches(want, got);
			expect(
				bad,
				`first wrong frames ${bad
					.slice(0, 8)
					.map((f) => `${f}: ${got[f]} ≠ ${want[f]}`)
					.join(', ')}`,
			).toEqual([]);
		}, 240_000);
});
