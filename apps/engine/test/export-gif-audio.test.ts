// spec 18 AF-EXP-001…003 (wp-note agent-footage-export): GIF and audio-only exports on a real engine, LGPL-only.
// - GIF: the plan renders the picture on the planner's path into a ProRes intermediate and converts it with
//   palettegen + paletteuse; the plan warns that the sound is left out; the file is a GIF with round(duration × fps)
//   frames, the requested size and loop count (NETSCAPE2.0 block); a GIF frame matches the Program frame (the still
//   render at the same time and width) with SSIM ≥ GIF_SSIM_MIN; the intermediate is deleted; cancelling removes
//   the partial output and the scratch directory.
// - Audio only: WAV (16/24-bit PCM), FLAC (16/24) and M4A (AAC) of the export range at the requested rate and
//   channels; the 24-bit WAV holds exactly the samples a MOV export's 24-bit PCM stream holds (the same mixer and
//   delivery); loudness normalisation is applied and measured on the delivered M4A.
// - Contradictory settings are refused by name (VALIDATION_FAILED), never ignored.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ExportResult, ExportSettings, RenderPlan } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { afterAll, describe, expect, it } from 'vitest';
import {
	audioOnlyMuxArgs,
	DeliverableError,
	deliverableOf,
	gifFrames,
	gifGraphs,
	gifSize,
	gifToRgb,
} from '../src/export/deliverables.ts';
import { assertLgplFilters } from '../src/processing/proc/filters.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	H,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	TEST_FFPROBE,
	type TestApp,
	until,
} from './helpers.ts';
import { writeBedFixture } from './sound-bed-fixture.ts';

/**
 * SSIM (ffmpeg `ssim` on RGB, all planes) of a GIF frame against the Program still at the same time and width. A
 * 256-colour palette with Sierra-2-4A dither over the moving test pattern measures 0.9755 (ffmpeg 6.1; 0.916 with a
 * 4:2:2 intermediate, which is why the intermediate is ProRes 4444); the neighbouring frames measure ≈ 0.85. 0.95
 * leaves room for other ffmpeg builds while failing a wrong frame, a wrong matrix or a chroma-subsampled path.
 */
const GIF_SSIM_MIN = 0.95;

const SEQ = { width: 640, height: 360, frameRate: { num: 30, den: 1 } };

describe('deliverableOf: what the settings ask for, or a refusal by name', () => {
	const base = {
		sequenceId: 's',
		range: { type: 'entire' },
		engine: 'auto',
		destination: { type: 'download' },
	} as const;
	it('a GIF renders a ProRes 4444 intermediate at the GIF size and the sequence rate, picture only', () => {
		const d = deliverableOf({ ...base, container: 'gif', gif: { fps: 12, width: 321 } }, SEQ);
		expect(d.kind).toBe('gif');
		if (d.kind !== 'gif') return;
		expect(d.gif).toEqual({
			fps: 12,
			width: 322,
			height: 182,
			loop: 0,
			dither: 'sierra2_4a',
			palette: 'full',
		});
		expect(d.render).toMatchObject({
			container: 'mov',
			videoOnly: true,
			smartRender: false,
			video: {
				codec: 'prores',
				proresProfile: '4444',
				width: 322,
				height: 182,
				frameRate: { num: 30, den: 1 },
			},
		});
		expect('gif' in d.render).toBe(false);
	});
	it('GIF defaults: 15 fps, the sequence width capped at 1080, forever', () => {
		const d = deliverableOf({ ...base, container: 'gif' }, { ...SEQ, width: 1920, height: 1080 });
		expect(d.kind === 'gif' && d.gif).toMatchObject({ fps: 15, width: 1080, height: 608, loop: 0 });
		const small = deliverableOf({ ...base, container: 'gif' }, SEQ);
		expect(small.kind === 'gif' && small.gif).toMatchObject({ width: 640, height: 360 });
		const bayer = deliverableOf({ ...base, container: 'gif', gif: { dither: 'bayer' } }, SEQ);
		expect(bayer.kind === 'gif' && bayer.gif.bayerScale).toBe(2);
	});
	it('audio-only containers pick their encoder', () => {
		expect(deliverableOf({ ...base, container: 'wav' }, SEQ)).toEqual({
			kind: 'audio',
			audio: { container: 'wav', codec: 'pcm_s24le', bitDepth: 24 },
		});
		expect(
			deliverableOf(
				{
					...base,
					container: 'wav',
					audio: { codec: 'pcm', sampleRate: 48000, channels: 2, bitDepth: 16 },
				},
				SEQ,
			),
		).toMatchObject({ audio: { codec: 'pcm_s16le', bitDepth: 16 } });
		expect(deliverableOf({ ...base, container: 'flac' }, SEQ)).toMatchObject({
			audio: { codec: 'flac', bitDepth: 24 },
		});
		expect(deliverableOf({ ...base, container: 'm4a' }, SEQ)).toEqual({
			kind: 'audio',
			audio: { container: 'm4a', codec: 'aac' },
		});
		expect(deliverableOf({ ...base, container: 'mp4' }, SEQ)).toEqual({ kind: 'video' });
	});
	it('refuses contradictions instead of ignoring them', () => {
		const video = {
			codec: 'h264' as const,
			width: 640,
			height: 360,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit' as const,
			quality: { mode: 'crf' as const, value: 18 },
			encoderSpeed: 'fast' as const,
		};
		const audio = { codec: 'aac' as const, sampleRate: 48000 as const, channels: 2 as const };
		const bad: [ExportSettings, RegExp][] = [
			[{ ...base, container: 'gif', video }, /size and rate from `gif`/],
			[{ ...base, container: 'gif', audio }, /no sound/],
			[{ ...base, container: 'gif', captions: { embed: true } }, /caption streams/],
			[{ ...base, container: 'mp4', gif: { fps: 10 } }, /container: "gif"/],
			[{ ...base, container: 'wav', audio }, /PCM audio, not AAC/],
			[{ ...base, container: 'flac', audio: { ...audio, codec: 'pcm' } }, /FLAC audio, not PCM/],
			[{ ...base, container: 'm4a', audio: { ...audio, bitDepth: 24 } }, /no bit depth/],
			[{ ...base, container: 'wav', video }, /sound only/],
			[{ ...base, container: 'wav', videoOnly: true }, /contradicts/],
			[{ ...base, container: 'mp4', audio: { ...audio, codec: 'flac' } }, /FLAC files/],
			[{ ...base, container: 'mov', audio: { ...audio, codec: 'pcm', bitDepth: 16 } }, /WAV and FLAC/],
		];
		for (const [s, msg] of bad) {
			expect(() => deliverableOf(s, SEQ), JSON.stringify(s)).toThrow(DeliverableError);
			expect(() => deliverableOf(s, SEQ)).toThrow(msg);
		}
	});
});

describe('GIF helpers', () => {
	it('frames = round(duration × fps), at least one (as the fps filter writes them)', () => {
		expect(gifFrames(2, 15)).toBe(30);
		expect(gifFrames(7 / 30, 15)).toBe(4);
		expect(gifFrames(1 / 30, 15)).toBe(1);
		expect(gifFrames(45 / 30, 12.5)).toBe(19);
		expect(gifFrames(3 / 25, 10)).toBe(1);
		expect(gifFrames(0, 15)).toBe(1);
		expect(gifFrames(Number.NaN, 15)).toBe(1);
	});
	it('sizes are even and keep the aspect', () => {
		expect(gifSize({ width: 1920, height: 1080 }, undefined)).toEqual({ width: 1080, height: 608 });
		expect(gifSize({ width: 1080, height: 1920 }, 301)).toEqual({ width: 302, height: 536 });
	});
	it('graphs: two passes for full / diff, one with per-frame palettes; LGPL filters only', () => {
		const rgb = gifToRgb({ width: 320, height: 180 }, 'bt709', null, 'flags=bicubic');
		expect(rgb).toContain('in_color_matrix=bt709');
		const full = gifGraphs({ fps: 15, width: 320, height: 180, dither: 'sierra2_4a', palette: 'full' }, rgb);
		expect(full.palette).toContain('palettegen=stats_mode=full');
		expect(full.encode).toContain('paletteuse=dither=sierra2_4a');
		expect(full.encode).toContain('fps=15000/1000');
		const diff = gifGraphs(
			{ fps: 12.5, width: 320, height: 180, dither: 'bayer', bayerScale: 3, palette: 'diff' },
			rgb,
		);
		expect(diff.palette).toContain('stats_mode=diff');
		expect(diff.encode).toContain('dither=bayer:bayer_scale=3:diff_mode=rectangle');
		const single = gifGraphs({ fps: 10, width: 320, height: 180, dither: 'none', palette: 'single' }, rgb);
		expect(single.palette).toBeNull();
		expect(single.encode).toContain('palettegen=stats_mode=single');
		expect(single.encode).toContain('paletteuse=new=1:dither=none');
		for (const g of [full.palette!, full.encode, diff.palette!, diff.encode, single.encode])
			expect(() => assertLgplFilters(g)).not.toThrow();
		expect(audioOnlyMuxArgs('wav')).toEqual(['-rf64', 'auto', '-f', 'wav']);
		expect(audioOnlyMuxArgs('m4a')).toContain('ipod');
	});
});

// ---- real engine ------------------------------------------------------------------------------------------------

let app: TestApp;
let work: string;
let clip: string;
let bed: ReturnType<typeof writeBedFixture>;

async function setup() {
	if (app) return;
	app = await makeApp({ env: { JASPER_FFMPEG_LGPL_ONLY: '1' } });
	work = mkdtempSync(join(tmpdir(), 'jasper-gif-audio-'));
	bed = writeBedFixture(work);
	// a busy picture (moving test pattern) with a tone: 4 s at 30 fps, 640×360, MPEG-4 Part 2 (LGPL) + PCM
	clip = join(work, 'pattern.mov');
	const r = spawnSync(TEST_FFMPEG, [
		...['-hide_banner', '-loglevel', 'error', '-y'],
		...['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4'],
		...['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=4'],
		...['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'pcm_s16le', clip],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
}

async function doc(frames = 60) {
	await setup();
	const d = new DocBuilder('hd-1080p-30', 900);
	// a 640×360 sequence (the clip's size)
	d.tx([{ type: 'sequence.updateSettings', settings: { width: 640, height: 360 } }]);
	const pattern = d.addMedia(await register(app, clip));
	const music = d.addMedia(await register(app, bed.music));
	const range = { in: { seconds: 0 }, out: { seconds: frames / 30 } };
	d.tx([
		{
			type: 'clip.place',
			source: { mediaId: pattern },
			sourceRange: range,
			at: 0,
			tracks: { video: 'V1' },
			audio: false,
		},
		{ type: 'clip.place', source: { mediaId: music }, sourceRange: range, at: 0, tracks: { audio: 'A1' } },
	]);
	return d;
}

function settings(d: DocBuilder, over: Partial<ExportSettings>): ExportSettings {
	return {
		sequenceId: d.seqId,
		destination: { type: 'download' },
		range: { type: 'entire' },
		container: 'gif',
		engine: 'auto',
		...over,
	};
}

async function plan(d: DocBuilder, s: ExportSettings) {
	return app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
}

async function start(d: DocBuilder, s: ExportSettings): Promise<string> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(r.statusCode, r.body).toBe(202);
	return (r.json() as EngineJob).id;
}

async function exportFile(d: DocBuilder, s: ExportSettings) {
	const id = await start(d, s);
	const job = (await coreServices(app).queue.wait(id)) as EngineJob & { result: ExportResult };
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	const file = (await coreServices(app).exports.outputFile(id))!;
	return { id, job, file };
}

function probe(file: string) {
	const r = spawnSync(TEST_FFPROBE, [
		...['-v', 'error', '-count_packets', '-of', 'json'],
		...[
			'-show_entries',
			'format=format_name,duration:stream=codec_type,codec_name,width,height,sample_rate,channels,sample_fmt,bits_per_raw_sample,bits_per_sample,nb_read_packets,duration',
		],
		file,
	]);
	return JSON.parse(r.stdout.toString()) as {
		format: { format_name: string; duration: string };
		streams: {
			codec_type: string;
			codec_name: string;
			width?: number;
			height?: number;
			sample_rate?: string;
			channels?: number;
			sample_fmt?: string;
			bits_per_raw_sample?: string;
			bits_per_sample?: number;
			nb_read_packets?: string;
			duration?: string;
		}[];
	};
}

/** The NETSCAPE2.0 loop count of a GIF (null = no block: plays once). */
function netscapeLoop(file: string): number | null {
	const b = readFileSync(file);
	const i = b.indexOf('NETSCAPE2.0');
	return i < 0 ? null : b.readUInt16LE(i + 13);
}

/** Frame `index` of a file as a PNG (`select` by decode order). */
function framePng(file: string, index: number, out: string): string {
	const r = spawnSync(TEST_FFMPEG, [
		...['-hide_banner', '-loglevel', 'error', '-y', '-i', file],
		...['-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-update', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

function ssim(a: string, b: string): number {
	const r = spawnSync(TEST_FFMPEG, [
		...['-hide_banner', '-i', a, '-i', b],
		...['-filter_complex', '[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]ssim', '-f', 'null', '-'],
	]);
	const m = /SSIM .*All:([0-9.]+)/.exec(r.stderr.toString());
	if (!m) throw new Error(`ssim failed: ${r.stderr.toString().slice(-2000)}`);
	return Number(m[1]);
}

/** Decoded PCM of the first audio stream as signed 32-bit samples (24-bit values shifted up). */
function pcm32(file: string): Int32Array {
	const r = spawnSync(
		TEST_FFMPEG,
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-i',
			file,
			'-map',
			'0:a:0',
			'-f',
			's32le',
			'-c:a',
			'pcm_s32le',
			'-',
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	const buf = r.stdout;
	return new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

describe('GIF export on a real engine (AF-EXP-001)', { timeout: 600_000 }, () => {
	it('plans the picture path with GIF_NO_AUDIO and the GIF numbers; refuses contradictions', async () => {
		const d = await doc();
		const r = await plan(d, settings(d, { gif: { fps: 15, width: 320 } }));
		expect(r.statusCode, r.body).toBe(200);
		const p = r.json() as RenderPlan;
		expect(p.path).toBe('native');
		expect(p.deliverable).toEqual({
			kind: 'gif',
			fps: 15,
			width: 320,
			height: 180,
			frames: 30,
			loop: 0,
			dither: 'sierra2_4a',
			palette: 'full',
		});
		expect(p.warnings.map((w) => w.code)).toContain('GIF_NO_AUDIO');
		expect(p.encoder?.encoder).toBe('prores_ks');
		const bad = await plan(d, settings(d, { audio: { codec: 'aac', sampleRate: 48000, channels: 2 } }));
		expect(bad.statusCode).toBe(400);
		expect(bad.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
		const fps = await plan(d, settings(d, { gif: { fps: 60 } }));
		expect(fps.statusCode).toBe(400);
	});

	it('writes a looping GIF with round(duration × fps) frames; a frame matches the Program frame (SSIM)', async () => {
		const d = await doc();
		const { id, job, file } = await exportFile(d, settings(d, { gif: { fps: 15, width: 320 } }));
		expect(file.endsWith('output.gif')).toBe(true);
		expect(job.result).toMatchObject({
			container: 'gif',
			encoder: 'gif',
			renderPath: 'native',
			frames: 30,
			gif: { fps: 15, width: 320, height: 180, frames: 30, loop: 0 },
		});
		expect(job.result.audioCodec).toBeUndefined();
		const info = probe(file);
		expect(info.format.format_name).toBe('gif');
		expect(info.streams).toHaveLength(1);
		expect(info.streams[0]).toMatchObject({
			codec_name: 'gif',
			width: 320,
			height: 180,
			nb_read_packets: '30',
		});
		expect(Number(info.format.duration)).toBeCloseTo(2, 1);
		expect(netscapeLoop(file)).toBe(0);
		// the intermediate and the job's scratch directory are gone
		expect(existsSync(join(appdirPaths(app.appdir).tmpDir, id))).toBe(false);
		// GIF frame 10 (t = 10/15 s) is sequence frame 20: the still render of that frame at the GIF width
		const still = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 20, width: 320 },
		});
		expect(still.statusCode, still.body).toBe(202);
		const sj = await coreServices(app).queue.wait((still.json() as EngineJob).id);
		expect(sj.error, JSON.stringify(sj.error)).toBeUndefined();
		const program = (await coreServices(app).exports.outputFile(sj.id))!;
		const gifFrame = framePng(file, 10, join(work, 'gif-10.png'));
		const value = ssim(gifFrame, program);
		writeFileSync(join(work, 'ssim.txt'), String(value));
		console.log(`GIF frame 10 vs Program frame 20 at 320 px: SSIM ${value.toFixed(4)}`);
		expect(value).toBeGreaterThanOrEqual(GIF_SSIM_MIN);
		// a neighbouring frame is measurably different (the comparison is not blind to time)
		const other = framePng(file, 20, join(work, 'gif-20.png'));
		expect(ssim(other, program)).toBeLessThan(value);
	});

	it('loop count, Bayer dither, per-frame palettes and a custom range', async () => {
		const d = await doc();
		const once = await exportFile(
			d,
			settings(d, {
				range: { type: 'custom', startFrame: 15, endFrame: 45 },
				gif: { fps: 10, width: 160, loop: 1, dither: 'bayer', bayerScale: 4, palette: 'single' },
			}),
		);
		// 1 s at 10 fps
		expect(probe(once.file).streams[0]).toMatchObject({ width: 160, height: 90, nb_read_packets: '10' });
		expect(netscapeLoop(once.file)).toBeNull();
		const thrice = await exportFile(
			d,
			settings(d, { gif: { fps: 12.5, width: 160, loop: 3, dither: 'none', palette: 'diff' } }),
		);
		// 2 s at 12.5 fps
		expect(probe(thrice.file).streams[0]).toMatchObject({ nb_read_packets: '25' });
		expect(netscapeLoop(thrice.file)).toBe(2);
	});

	it('cancelling during the GIF render removes the partial output and the scratch directory', async () => {
		const d = await doc(120);
		const id = await start(d, settings(d, { gif: { fps: 30, width: 640 } }));
		const q = coreServices(app).queue;
		// cancelled in the GIF's render phase (its stages are named "GIF 1/2 · …")
		await until(() => q.get(id)?.state === 'running' && q.get(id)?.stage?.startsWith('GIF'), 60_000, 10);
		const cancel = await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H });
		expect(cancel.statusCode, cancel.body).toBeLessThan(300);
		const done = await q.wait(id);
		expect(done.state).toBe('cancelled');
		expect(existsSync(join(appdirPaths(app.appdir).rendersDir, id))).toBe(false);
		expect(existsSync(join(appdirPaths(app.appdir).tmpDir, id))).toBe(false);
		expect(await coreServices(app).exports.outputFile(id)).toBeNull();
	});
});

describe('audio-only export on a real engine (AF-EXP-002)', { timeout: 600_000 }, () => {
	const audio = (
		over: Partial<NonNullable<ExportSettings['audio']>>,
	): NonNullable<ExportSettings['audio']> => ({
		codec: 'pcm',
		sampleRate: 48000,
		channels: 2,
		normalize: null,
		...over,
	});

	it('plans the mix alone: path audio, no picture blockers, the file format', async () => {
		const d = await doc();
		const r = await plan(
			d,
			settings(d, { container: 'flac', audio: audio({ codec: 'flac', bitDepth: 16 }) }),
		);
		expect(r.statusCode, r.body).toBe(200);
		const p = r.json() as RenderPlan;
		expect(p.path).toBe('audio');
		expect(p.segments).toEqual([]);
		expect(p.blockers).toEqual([]);
		expect(p.audio).toMatchObject({ mode: 'native-mix', codec: 'flac', sampleRate: 48000, channels: 2 });
		expect(p.deliverable).toEqual({
			kind: 'audio',
			container: 'flac',
			codec: 'flac',
			sampleRate: 48000,
			channels: 2,
			bitDepth: 16,
		});
		const bad = await plan(d, settings(d, { container: 'wav', audio: audio({ codec: 'aac' }) }));
		expect(bad.statusCode).toBe(400);
	});

	it('WAV 16/24, FLAC 16/24 and M4A carry the codec, rate, channels and duration asked for', async () => {
		const d = await doc();
		const cases: {
			s: Partial<ExportSettings>;
			codec: string;
			ext: string;
			rate: string;
			channels: number;
			bits?: string;
			dur: number;
		}[] = [
			{
				s: { container: 'wav', audio: audio({ bitDepth: 16 }) },
				codec: 'pcm_s16le',
				ext: 'wav',
				rate: '48000',
				channels: 2,
				dur: 2,
			},
			{
				s: { container: 'wav', audio: audio({}) },
				codec: 'pcm_s24le',
				ext: 'wav',
				rate: '48000',
				channels: 2,
				dur: 2,
			},
			{
				s: { container: 'flac', audio: audio({ codec: 'flac', bitDepth: 16, sampleRate: 44100 }) },
				codec: 'flac',
				ext: 'flac',
				rate: '44100',
				channels: 2,
				bits: '16',
				dur: 2,
			},
			{
				s: { container: 'flac', audio: audio({ codec: 'flac', channels: 1 }) },
				codec: 'flac',
				ext: 'flac',
				rate: '48000',
				channels: 1,
				bits: '24',
				dur: 2,
			},
			{
				s: {
					container: 'm4a',
					range: { type: 'custom', startFrame: 15, endFrame: 45 },
					audio: audio({ codec: 'aac', bitrateKbps: 128, sampleRate: 44100 }),
				},
				codec: 'aac',
				ext: 'm4a',
				rate: '44100',
				channels: 2,
				dur: 1,
			},
		];
		for (const c of cases) {
			const { job, file } = await exportFile(d, settings(d, c.s));
			expect(file.endsWith(`output.${c.ext}`), file).toBe(true);
			expect(job.result).toMatchObject({ container: c.ext, audioCodec: c.codec, renderPath: 'audio' });
			const info = probe(file);
			expect(info.streams.map((s) => s.codec_type)).toEqual(['audio']);
			const a = info.streams[0]!;
			expect(a, c.ext).toMatchObject({ codec_name: c.codec, sample_rate: c.rate, channels: c.channels });
			if (c.bits) expect(a.bits_per_raw_sample).toBe(c.bits);
			expect(Math.abs(Number(a.duration ?? info.format.duration) - c.dur), `${c.ext} duration`).toBeLessThan(
				0.05,
			);
		}
	});

	it('the 24-bit WAV holds exactly the samples of a MOV export’s 24-bit PCM (one mixer for every path)', async () => {
		const d = await doc();
		const range = { type: 'custom' as const, startFrame: 10, endFrame: 50 };
		const wav = await exportFile(d, settings(d, { container: 'wav', range, audio: audio({}) }));
		const mov = await exportFile(
			d,
			settings(d, {
				container: 'mov',
				range,
				engine: 'native',
				video: {
					codec: 'prores',
					width: 320,
					height: 180,
					frameRate: { num: 30, den: 1 },
					scaling: 'fit',
					quality: { mode: 'crf', value: 20 },
					encoderSpeed: 'fast',
				},
				audio: audio({}),
			}),
		);
		expect(mov.job.result.audioCodec).toBe('pcm_s24le');
		const a = pcm32(wav.file);
		const b = pcm32(mov.file);
		expect(a.length).toBe(48000 * 2 * (40 / 30));
		expect(b.length).toBe(a.length);
		let diff = 0;
		let energy = 0;
		for (let i = 0; i < a.length; i++) {
			diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
			energy += Math.abs(a[i]!);
		}
		expect(energy).toBeGreaterThan(0);
		expect(diff).toBe(0);
	});

	it('loudness normalisation is delivered and measured on the M4A itself', async () => {
		const d = await doc();
		const { job } = await exportFile(
			d,
			settings(d, {
				container: 'm4a',
				audio: audio({ codec: 'aac', bitrateKbps: 192, normalize: { targetLufs: -20, truePeakDb: -1 } }),
			}),
		);
		const l = job.result.audioLoudness!;
		expect(l.measuredOn).toBe('decoded-file');
		expect(l.targetLufs).toBe(-20);
		expect(Math.abs(l.integratedLufs! + 20)).toBeLessThanOrEqual(0.5);
		expect(l.truePeakDbtp!).toBeLessThanOrEqual(-1 + 0.1);
	});
});

afterAll(closeApps);
