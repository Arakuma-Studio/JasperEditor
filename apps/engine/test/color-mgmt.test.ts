import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bakeLut, serializeCube, write3dl } from '@jasper/project';
import { ffmpegPath, ffprobePath } from '@jasper/testkit/oracle';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	ROOT,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
const tmp = mkdtempSync(join(tmpdir(), 'jasper-cm-'));
// A clean CI checkout has no vendor directory; resolve FFmpeg the same way as the engine.
const VENDOR = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`);
const FFMPEG = existsSync(join(VENDOR, 'ffmpeg')) ? join(VENDOR, 'ffmpeg') : (ffmpegPath() ?? 'ffmpeg');
const FFPROBE = existsSync(join(VENDOR, 'ffprobe')) ? join(VENDOR, 'ffprobe') : (ffprobePath() ?? 'ffprobe');

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

function ff(args: string[]): void {
	const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 26 });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
}

function probe(file: string) {
	const r = spawnSync(FFPROBE, [
		'-v',
		'error',
		'-show_streams',
		'-select_streams',
		'v:0',
		'-of',
		'json',
		file,
	]);
	return (JSON.parse(r.stdout.toString()) as { streams: Record<string, unknown>[] }).streams[0]!;
}

/** One frame as packed RGB48 (16 bits per channel, normalised 0..1 per value) through the stream's matrix. */
function rgbAt(file: string, matrix: 'bt709' | 'bt2020', frame = 0, x = 0, y = 0, w = 0, h = 0) {
	const crop = w ? `,crop=${w}:${h}:${x}:${y}` : '';
	const r = spawnSync(
		FFMPEG,
		[
			...['-v', 'error', '-i', file],
			...[
				'-vf',
				`select=eq(n\\,${frame}),scale=in_color_matrix=${matrix}:in_range=tv:flags=accurate_rnd+full_chroma_int${crop}`,
			],
			...['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-'],
		],
		{ maxBuffer: 1 << 28 },
	);
	const b = r.stdout;
	const out: number[] = [];
	for (let i = 0; i + 1 < b.length; i += 2) out.push(b.readUInt16LE(i) / 65535);
	return out;
}
const mean = (v: number[], ch: number) => {
	let s = 0;
	let n = 0;
	for (let i = ch; i < v.length; i += 3) {
		s += v[i]!;
		n++;
	}
	return s / n;
};

async function job(
	url: string,
	payload: Record<string, unknown>,
): Promise<{ id: string; result: Record<string, unknown> }> {
	const r = await app.inject({ method: 'POST', url, headers: JSON_H, payload });
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return { id: r.json().id, result: done.result as Record<string, unknown> };
}

async function still(d: DocBuilder, frame = 0): Promise<string> {
	const { id } = await job('/api/stills', { envelope: d.envelope(), sequenceId: d.seqId, frame });
	const png = await app.inject({ method: 'GET', url: `/renders/${id}/output`, headers: H });
	const f = join(mkdtempSync(join(tmp, 's-')), 'still.png');
	writeFileSync(f, png.rawPayload);
	return f;
}

const exportSettings = (seqId: string, video: Record<string, unknown>, container = 'mp4') => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: 6 },
	container,
	video: {
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
		...video,
	},
	audio: { codec: container === 'mov' ? 'pcm' : 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

async function exportOf(d: DocBuilder, video: Record<string, unknown>, container = 'mp4') {
	const { id, result } = await job('/api/exports', {
		envelope: d.envelope(),
		sequenceId: d.seqId,
		settings: exportSettings(d.seqId, video, container),
	});
	const file = (await coreServices(app).exports.outputFile(id))!;
	return { file, result };
}

function whiteSolidDoc(space: string, color: [number, number, number, number] = [1, 1, 1, 1]): DocBuilder {
	const d = new DocBuilder();
	d.tx([
		{ type: 'sequence.updateSettings', settings: { workingColorSpace: space } },
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color },
	]);
	return d;
}

describe('export colour spaces', () => {
	it('HLG working space → AV1 10-bit MP4: BT.2100 HLG tags, graphics white at 75 % HLG, mastering metadata', async () => {
		const d = whiteSolidDoc('rec2100-hlg');
		const { file } = await exportOf(d, { codec: 'av1', encoder: 'libsvtav1', bitDepth: 10 });
		const s = probe(file);
		expect(s.color_primaries).toBe('bt2020');
		expect(s.color_transfer).toBe('arib-std-b67');
		expect(s.color_space).toBe('bt2020nc');
		expect(s.pix_fmt).toBe('yuv420p10le');
		const sd = (s.side_data_list as { side_data_type: string; max_luminance?: string }[]) ?? [];
		expect(
			sd.some((x) => /Mastering display/.test(x.side_data_type) && x.max_luminance === '10000000/10000'),
		).toBe(true);
		const px = rgbAt(file, 'bt2020', 2, 300, 160, 40, 40);
		for (const ch of [0, 1, 2]) expect(mean(px, ch)).toBeCloseTo(0.75, 2);
	}, 240_000);

	it('PQ working space → ProRes MOV: SMPTE ST 2084 tags, mdcv and clli boxes with the given MaxCLL', async () => {
		const d = whiteSolidDoc('rec2100-pq');
		const { file } = await exportOf(
			d,
			{ codec: 'prores', hdrMetadata: { maxCll: 800, maxFall: 200 } },
			'mov',
		);
		const s = probe(file);
		expect(s.color_transfer).toBe('smpte2084');
		const sd = (s.side_data_list as { side_data_type: string; max_content?: number }[]) ?? [];
		expect(sd.find((x) => /Content light/.test(x.side_data_type))?.max_content).toBe(800);
		expect(sd.some((x) => /Mastering display/.test(x.side_data_type))).toBe(true);
		const px = rgbAt(file, 'bt2020', 2, 300, 160, 40, 40);
		for (const ch of [0, 1, 2]) expect(mean(px, ch)).toBeCloseTo(0.5807, 2);
	}, 240_000);

	it('PQ sequence exported as Rec. 709 is tone mapped (BT.2390) and tagged BT.709', async () => {
		const d = whiteSolidDoc('rec2100-pq');
		const { file } = await exportOf(d, { codec: 'av1', encoder: 'libsvtav1', colorSpace: 'rec709' });
		const s = probe(file);
		expect(s.color_transfer).toBe('bt709');
		// Recorded reference-white target: docs/wp-notes/color-mgmt.md §5.
		const px = rgbAt(file, 'bt709', 2, 300, 160, 40, 40);
		for (const ch of [0, 1, 2]) expect(mean(px, ch)).toBeCloseTo(230.3 / 255, 1);
	}, 240_000);

	it('Rec. 2020 SDR: BT.709 red converted into BT.2020 (BT.2087) and tagged', async () => {
		const d = whiteSolidDoc('rec2020', [1, 0, 0, 1]);
		const { file } = await exportOf(d, { codec: 'av1', encoder: 'libsvtav1', bitDepth: 10 });
		const s = probe(file);
		expect([s.color_primaries, s.color_transfer, s.color_space]).toEqual(['bt2020', 'bt2020-10', 'bt2020nc']);
		// BT.2087 red-column linear-light coefficients, displayed through BT.1886.
		const want = [0.6274, 0.0691, 0.0164].map((v) => v ** (1 / 2.4));
		const px = rgbAt(file, 'bt2020', 2, 300, 160, 40, 40);
		for (const ch of [0, 1, 2]) expect(mean(px, ch)).toBeCloseTo(want[ch]!, 1);
	}, 240_000);

	it('refuses a 10-bit H.264 export', async () => {
		const d = whiteSolidDoc('rec2100-hlg');
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: exportSettings(d.seqId, { codec: 'h264', bitDepth: 10 }),
			},
		});
		expect(r.statusCode).toBe(400);
		expect(r.body).toMatch(/8-bit/);
	});

	it('stills of an HDR sequence are the display rendition', async () => {
		const d = whiteSolidDoc('rec2100-pq');
		const f = await still(d);
		const px = rgbAt(f, 'bt709', 0, 900, 500, 20, 20);
		// Recorded display reference-white target: docs/wp-notes/color-mgmt.md §5.
		expect(mean(px, 0)).toBeCloseTo(230.3 / 255, 1);
	}, 120_000);
});

describe('interpreted sources and probe metadata', () => {
	it('an HLG source is detected from its tags, its HDR metadata probed, and it is tone mapped into Rec. 709', async () => {
		const src = join(tmp, 'hlg.mov');
		const v = 0.75; // BT.2408 HDR reference white, 203 cd/m².
		// A flat HLG grey (signal v) tagged BT.2100 HLG, ProRes 10-bit, with mastering metadata written by our box writer.
		ff([
			...['-f', 'lavfi', '-i', `color=c=0x808080:s=320x180:d=1:r=30`],
			...[
				'-vf',
				`format=rgb48le,geq=r='${v}*65535':g='${v}*65535':b='${v}*65535',scale=out_color_matrix=bt2020:out_range=tv,format=yuv422p10le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv`,
			],
			...[
				'-c:v',
				'prores_ks',
				'-profile:v',
				'3',
				'-color_primaries',
				'bt2020',
				'-color_trc',
				'arib-std-b67',
				'-colorspace',
				'bt2020nc',
			],
			src,
		]);
		const { writeHdrBoxes } = await import('../src/color/hdr-boxes.ts');
		await writeHdrBoxes(
			src,
			{
				r: [0.708, 0.292],
				g: [0.17, 0.797],
				b: [0.131, 0.046],
				white: [0.3127, 0.329],
				maxNits: 1000,
				minNits: 0.005,
			},
			{ maxCll: 600, maxFall: 100 },
		);
		const m = await register(app, src);
		const vs = m.probe.streams.find((x) => x.type === 'video') as { hdr?: Record<string, number> };
		expect(vs.hdr).toMatchObject({ masteringMaxNits: 1000, maxCll: 600, maxFall: 100 });
		const d = new DocBuilder();
		const id = d.addMedia(m);
		d.tx([{ type: 'clip.place', source: { mediaId: id }, at: 0, tracks: { video: 'V1' } }]);
		const f = await still(d);
		const px = rgbAt(f, 'bt709', 0, 900, 500, 20, 20);
		expect(mean(px, 1)).toBeCloseTo(230.3 / 255, 1);
	}, 180_000);

	it('an offline input LUT is announced by the plan (LUT_OFFLINE), never skipped silently', async () => {
		const lut = bakeLut(5, () => {});
		const file = join(tmp, 'input.cube');
		writeFileSync(file, serializeCube(lut));
		const m = await register(app, file);
		const chart = await register(app, fixture('chart.png'));
		const d = new DocBuilder();
		const offline = d.addMedia({
			...m,
			locators: [{ type: 'engine-store', engineId: 'x', key: 'mk_ffffffffffffffffffffffff' }],
		});
		const c = d.addMedia(chart);
		const r = d.tx([{ type: 'clip.place', source: { mediaId: c }, at: 0, tracks: { video: 'V1' } }]);
		const clipId = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		d.tx([{ type: 'clip.setColorInterpretation', clipIds: [clipId], color: { inputLut: offline } }]);
		const plan = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: exportSettings(d.seqId, { codec: 'h264' }),
			},
		});
		expect(plan.statusCode, plan.body).toBe(200);
		const w = (plan.json().warnings as { code: string; itemIds?: string[] }[]).find(
			(x) => x.code === 'LUT_OFFLINE',
		);
		expect(w?.itemIds).toEqual([clipId]);
	});

	it('a .3dl look LUT imports and grades like its .cube twin', async () => {
		const lut = bakeLut(17, (c) => {
			const r = c[0];
			c[0] = c[2] * 0.9;
			c[2] = r;
		});
		const file = join(tmp, 'swap.3dl');
		writeFileSync(file, write3dl(lut));
		const m = await register(app, file);
		expect(m.kind).toBe('lut');
		expect(m.lut).toMatchObject({ format: '3dl', size: 17 });
		const chart = await register(app, fixture('chart.png'));
		const d = new DocBuilder();
		const look = d.addMedia(m);
		const c = d.addMedia(chart);
		const r = d.tx([{ type: 'clip.place', source: { mediaId: c }, at: 0, tracks: { video: 'V1' } }]);
		const clipId = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		d.tx([
			{
				type: 'effect.add',
				target: { clipId },
				effectId: 'jasper.lumetri',
				params: { look: { mediaId: look } },
			},
		]);
		const f = await still(d);
		const px = rgbAt(f, 'bt709', 0, 0, 0, 0, 0);
		const src = rgbAt(fixture('chart.png'), 'bt709', 0, 0, 0, 0, 0);
		const want = [src[3002]! * 0.9, src[3001]!, src[3000]!] as const;
		expect(Math.abs(px[3000]! - want[0])).toBeLessThan(3 / 255);
		expect(Math.abs(px[3002]! - want[2])).toBeLessThan(3 / 255);
	}, 180_000);
});
