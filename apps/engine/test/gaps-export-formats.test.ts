// Workstream gaps: HEVC exports through libkvazaar (EX-2) and the Sequence Settings delivery format — non-square
// pixel aspect ratio and field order (TL-11) — on real exports (ffprobe).
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	TEST_FFPROBE,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
const FFPROBE = TEST_FFPROBE;
const kvazaar = (() => {
	const r = spawnSync(TEST_FFMPEG, ['-hide_banner', '-encoders']);
	return r.stdout?.toString().includes('libkvazaar') ?? false;
})();

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

const settings = (d: DocBuilder, video: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
	const s = d.doc.sequences[d.seqId]!.settings;
	return {
		sequenceId: d.seqId,
		range: { type: 'custom', startFrame: 0, endFrame: 8 },
		container: 'mp4',
		video: {
			codec: 'h264',
			width: s.width,
			height: s.height,
			frameRate: s.frameRate,
			scaling: 'fit',
			quality: { mode: 'crf', value: 20 },
			encoderSpeed: 'fast',
			...video,
		},
		audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
		engine: 'native',
		...extra,
	};
};

async function plan(d: DocBuilder, s: Record<string, unknown>) {
	return app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
}

async function exportFile(d: DocBuilder, s: Record<string, unknown>): Promise<string> {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return (await coreServices(app).exports.outputFile(start.json().id))!;
}

function probe(file: string): Record<string, unknown> {
	const r = spawnSync(FFPROBE, [
		'-v',
		'error',
		'-select_streams',
		'v:0',
		'-show_streams',
		'-of',
		'json',
		file,
	]);
	return (JSON.parse(r.stdout.toString()) as { streams: Record<string, unknown>[] }).streams[0]!;
}

describe.runIf(kvazaar)('HEVC exports (libkvazaar)', () => {
	it('writes HEVC Main in MP4 tagged hvc1 with BT.709 VUI', async () => {
		const d = new DocBuilder('hd-720p-30');
		const m = d.addMedia(await register(app, fixture('clip-a.mp4')));
		d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const p = await plan(d, settings(d, { codec: 'hevc' }));
		expect(p.statusCode, p.body).toBe(200);
		expect(p.json().encoder.encoder).toBe('libkvazaar');
		const file = await exportFile(d, settings(d, { codec: 'hevc' }));
		const v = probe(file);
		expect(v.codec_name).toBe('hevc');
		expect(v.codec_tag_string).toBe('hvc1');
		expect(v.profile).toBe('Main');
		expect(v.color_primaries).toBe('bt709');
		expect(v.color_transfer).toBe('bt709');
		expect(Number(v.nb_frames)).toBe(8);
	}, 300_000);

	it('HDR (PQ) sequences: tagged SMPTE 2084 / BT.2020 at 8 bits with a warning; Main10 is refused with the reason', async () => {
		const d = new DocBuilder('hd-720p-30');
		d.tx([
			{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq' } },
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0.5, 0.5, 0.5, 1] },
		]);
		const ten = await plan(d, settings(d, { codec: 'hevc', bitDepth: 10 }));
		expect(ten.statusCode).toBe(400);
		expect(ten.json().message).toMatch(/libkvazaar writes 8-bit.*HEVC encoder \(Main10\)/);
		const p = await plan(d, settings(d, { codec: 'hevc' }));
		expect(p.json().warnings.map((w: { code: string }) => w.code)).toContain('HDR_8BIT');
		const v = probe(await exportFile(d, settings(d, { codec: 'hevc' })));
		expect(v.color_transfer).toBe('smpte2084');
		expect(v.color_primaries).toBe('bt2020');
	}, 300_000);
});

describe('Sequence Settings delivery format', () => {
	it('an HDV sequence (1440×1080 at 4:3, upper field) delivers anamorphic files and says fields are progressive', async () => {
		const d = new DocBuilder('hdv-1080i-29.97');
		const s = d.doc.sequences[d.seqId]!.settings;
		expect(s.width).toBe(1920);
		expect(s.storageWidth).toBe(1440);
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
		const p = await plan(d, settings(d, {}));
		expect(p.json().warnings.map((w: { code: string }) => w.code)).toContain('FIELDS_PROGRESSIVE');
		const v = probe(await exportFile(d, settings(d, {})));
		expect(v.width).toBe(1440);
		expect(v.height).toBe(1080);
		expect(v.sample_aspect_ratio).toBe('4:3');
		expect(v.display_aspect_ratio).toBe('16:9');
		expect(v.field_order ?? 'progressive').toBe('progressive');
	}, 300_000);

	it('another frame size is a square-pixel export', async () => {
		const d = new DocBuilder('dv-ntsc');
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 1, 0, 1] }]);
		const v = probe(await exportFile(d, settings(d, { width: 640, height: 480 })));
		expect(v.width).toBe(640);
		expect(['1:1', undefined, 'N/A']).toContain(v.sample_aspect_ratio);
	}, 300_000);
});
