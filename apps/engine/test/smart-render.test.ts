// Workstream `previews`: smart rendering (export path `copy`, ARCHITECTURE D-11) — GOP analysis, the copy/render
// split, and real exports: frame-exact output (frame codes), copied frames decode bit-identically to the source
// (framemd5), valid streams (ffprobe, a full decode without errors), and the plan's explanation when it cannot copy.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RenderPlan } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysePackets, smartPieces } from '../src/export/smart.ts';
import { coreServices } from '../src/tools/services.ts';
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

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

describe('GOP analysis and the copy/render split (pure)', () => {
	it('finds closed GOPs; an open GOP (leading pictures) is not a copy start', () => {
		// decode order: I0 P3 B1 B2 | I4 P7 B5 B6 | I8(open: B shows 7 before it) …
		const pk = (pts: number, key = false) => ({ pts, dts: pts, key });
		const packets = [
			pk(0, true),
			pk(3),
			pk(1),
			pk(2),
			pk(4, true),
			pk(7),
			pk(5),
			pk(6),
			pk(9, true),
			pk(8),
			pk(10),
		];
		const a = analysePackets(packets, 1 / 30);
		expect(a.times).toHaveLength(11);
		expect(a.gopStarts).toEqual([0, 4]);
		expect(a.allIntra).toBe(false);
		expect(analysePackets([pk(0, true), pk(1, true)], 1).allIntra).toBe(true);
	});

	it('copies whole GOPs inside a run and renders the frames around them', () => {
		const frames = {
			codec: 'h264',
			profile: 'High',
			pixFmt: 'yuv420p',
			width: 1,
			height: 1,
			times: Array.from({ length: 100 }, (_, i) => i / 30),
			gopStarts: [0, 30, 60, 90],
			allIntra: false,
		};
		const pieces = smartPieces(
			{ start: 0, end: 120 },
			[{ start: 0, end: 85, clipId: 'c', mediaId: 'm', sourceFrame: 10 }],
			() => frames,
		);
		// run shows source 10..95: GOPs 30..60, 60..90 copied (90..100 crosses the run end)
		expect(pieces).toEqual([
			{ kind: 'render', start: 0, end: 20 },
			{ kind: 'copy', start: 20, end: 80, mediaId: 'm', sourceFrame: 30 },
			{ kind: 'render', start: 80, end: 120 },
		]);
		const intra = { ...frames, allIntra: true };
		expect(
			smartPieces(
				{ start: 0, end: 50 },
				[{ start: 5, end: 45, clipId: 'c', mediaId: 'm', sourceFrame: 3 }],
				() => intra,
			),
		).toEqual([
			{ kind: 'render', start: 0, end: 5 },
			{ kind: 'copy', start: 5, end: 45, mediaId: 'm', sourceFrame: 3 },
			{ kind: 'render', start: 45, end: 50 },
		]);
	});
});

/** The 6-bit frame number burnt into frame-code.mp4 (see export.test.ts). */
function frameCode(file: string, frame: number): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=420:1:40:70`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	let code = 0;
	for (let b = 0; b < 6; b++) if (r.stdout[(30 + 70 * b) * 3]! > 127) code |= 1 << b;
	return code;
}

/** framemd5 lines (decoded picture hashes) of frames [from, to) of a file's video. */
function frameHashes(file: string, from: number, to: number): string[] {
	const out = execFileSync('ffmpeg', [
		...['-v', 'error', '-i', file, '-map', '0:v:0'],
		...['-vf', `select=between(n\\,${from}\\,${to - 1}),setpts=N/30/TB`, '-f', 'framemd5', '-'],
	]).toString();
	return out
		.split('\n')
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => l.split(',').pop()!.trim());
}

const settings = (seqId: string, extra: Record<string, unknown> = {}) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
	...extra,
});

async function plan(d: DocBuilder, s: Record<string, unknown>): Promise<RenderPlan> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as RenderPlan;
}

async function exportFile(
	d: DocBuilder,
	s: Record<string, unknown>,
): Promise<{ file: string; result: Record<string, unknown> }> {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return {
		file: (await coreServices(app).exports.outputFile(start.json().id))!,
		result: done.result as Record<string, unknown>,
	};
}

describe('smart rendering exports (real ffmpeg)', () => {
	it('H.264: copies the closed GOPs of an untouched clip, encodes the frames before them, frame-exact', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				audio: false,
				sourceRange: { in: { sourceFrames: 10 }, out: { sourceFrames: 64 } },
			},
		]);
		// opt-in for H.264: the plan says what it would copy
		const off = await plan(d, settings(d.seqId));
		expect(off.path).not.toBe('copy');
		expect(off.smart?.reasons.join(' ')).toMatch(/opt-in.*34 of 54/);
		const p = await plan(d, settings(d.seqId, { smartRender: true }));
		expect(p.path, JSON.stringify(p.smart)).toBe('copy');
		expect(p.smart?.used).toBe(true);
		expect(p.smart?.copiedFrames).toBe(34);
		expect(p.segments.map((s) => [s.startFrame, s.endFrame, s.mode])).toEqual([
			[0, 20, 'native'],
			[20, 54, 'copy'],
		]);
		const { file, result } = await exportFile(d, settings(d.seqId, { smartRender: true }));
		expect(result.renderPath).toBe('copy');
		const probe = JSON.parse(
			execFileSync('ffprobe', [
				'-v',
				'error',
				'-count_frames',
				'-show_entries',
				'stream=codec_name,codec_tag_string,nb_read_frames,codec_type',
				'-of',
				'json',
				file,
			]).toString(),
		) as { streams: { codec_type: string; codec_tag_string: string; nb_read_frames: string }[] };
		const v = probe.streams.find((s) => s.codec_type === 'video')!;
		expect(v.codec_tag_string).toBe('avc3');
		expect(Number(v.nb_read_frames)).toBe(54);
		expect(
			probe.streams.some((s) => s.codec_type === 'audio'),
			JSON.stringify(probe),
		).toBe(true);
		// a full decode reports nothing
		expect(spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']).stderr.toString().trim()).toBe(
			'',
		);
		for (const n of [0, 1, 19, 20, 21, 40, 53]) expect(frameCode(file, n), `frame ${n}`).toBe(n + 10);
		// the copied frames decode exactly as the source's
		expect(frameHashes(file, 20, 54)).toEqual(frameHashes(fixture('frame-code.mp4'), 30, 64));
	}, 300_000);

	it('ProRes: copies every untouched frame and encodes only the edited stretch', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'smart-prores-'));
		const src = join(dir, 'code-hq.mov');
		execFileSync('ffmpeg', [
			'-v',
			'error',
			'-y',
			'-i',
			fixture('frame-code.mp4'),
			'-c:v',
			'prores_ks',
			'-profile:v',
			'3',
			'-an',
			src,
		]);
		const reg = await register(app, src);
		const d = new DocBuilder();
		const m = d.addMedia(reg);
		const r = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				audio: false,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 30 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 30,
				audio: false,
				sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 50 } },
				ref: '$b',
			},
		]);
		void r;
		const b = Object.values(d.doc.sequences[d.seqId]!.clips).find((c) => c.start === 30)!;
		d.tx([{ type: 'param.set', target: ['clip', b.id, 'opacity'], value: 90 }]);
		const s = settings(d.seqId, {
			container: 'mov',
			video: { ...settings(d.seqId).video, codec: 'prores', proresProfile: 'hq' },
			audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
		});
		const p = await plan(d, s);
		expect(p.path).toBe('copy');
		expect(p.smart?.copiedFrames).toBe(30);
		const { file } = await exportFile(d, s);
		expect(
			Number(
				execFileSync('ffprobe', [
					'-v',
					'error',
					'-count_frames',
					'-select_streams',
					'v:0',
					'-show_entries',
					'stream=nb_read_frames',
					'-of',
					'csv=p=0',
					file,
				]).toString(),
			),
		).toBe(50);
		expect(frameHashes(file, 0, 30)).toEqual(frameHashes(src, 0, 30));
		expect(frameCode(file, 35)).toBe(35);
	}, 300_000);

	it('explains why it cannot copy', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, audio: false }]);
		const id = d.clipIds()[0]!;
		d.tx([{ type: 'param.set', target: ['clip', id, 'transform', 'scale'], value: 50 }]);
		const p = await plan(d, settings(d.seqId, { smartRender: true }));
		expect(p.path).not.toBe('copy');
		expect(p.smart?.used).toBe(false);
		expect(p.smart?.reasons.join(' ')).toMatch(/untouched/);
		const vp9 = await plan(
			d,
			settings(d.seqId, { container: 'webm', video: { ...settings(d.seqId).video, codec: 'vp9' } }),
		);
		expect(vp9.smart?.reasons.join(' ')).toMatch(/vp9/i);
		const off = await plan(d, settings(d.seqId, { smartRender: false }));
		expect(off.smart?.reasons.join(' ')).toMatch(/off/);
	}, 300_000);
});
