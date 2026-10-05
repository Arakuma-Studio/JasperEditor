// Remotion with OUR LGPL FFmpeg (ARCHITECTURE D-13, docs/wp-notes/wp-lgpl.md). Gated like the other
// Remotion end-to-end test (REMOTION_E2E=1) and needs the LGPL binaries directory from `pnpm ffmpeg:lgpl`
// (or JASPER_REMOTION_BIN_DIR). The engine runs in strict (non-dev, packaged-like) mode, where Remotion
// is only allowed with an LGPL directory:
//   - capabilities report the directory and its LGPL license; its ffmpeg -buildconf has no --enable-gpl;
//   - an H.264 export renders a ProRes intermediate through Remotion (video clip + audio + text, so the
//     compositor's frame extraction runs on the LGPL libav*) and is encoded by OpenH264;
//   - a VP9 export is written by Remotion directly (libvpx-vp9 + libopus WebM);
//   - a still renders.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineCapabilitiesSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { findVendorDir, REMOTION_BIN_DIR_ENV } from '../src/tools/lgpl.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, fixture, register, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const LGPL_DIR = process.env[REMOTION_BIN_DIR_ENV] || findVendorDir();
const ffmpegIn = (dir: string) => join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

function probe(file: string) {
	const r = spawnSync('ffprobe', [
		'-v',
		'error',
		'-count_frames',
		'-show_entries',
		'stream=codec_type,codec_name,width,height,nb_read_frames,color_primaries,color_transfer:format=format_name',
		'-of',
		'json',
		file,
	]);
	return JSON.parse(r.stdout.toString()) as {
		streams: Record<string, string | number>[];
		format: { format_name: string };
	};
}

describe.runIf(enabled && !!LGPL_DIR)('Remotion with the LGPL binaries directory (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	let d: DocBuilder;
	const host = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir(),
			port: PORT ? PORT + 2 : 0,
			dev: false,
			env: {
				PATH: process.env.PATH,
				[REMOTION_BIN_DIR_ENV]: LGPL_DIR!,
				JASPER_FFMPEG: ffmpegIn(LGPL_DIR!),
				JASPER_FFPROBE: join(LGPL_DIR!, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
				JASPER_HW_ENCODERS: '0',
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		const clip = await register(engine.app, fixture('clip-a.mp4'), host());
		d = new DocBuilder('hd-720p-30');
		const mediaId = d.addMedia(clip);
		d.tx([
			{ type: 'clip.place', source: { mediaId }, at: 0 },
			{ type: 'clip.addText', at: 0, duration: 24, track: 'V2', content: { text: 'LGPL FFmpeg' } },
		]);
	}, 120_000);

	afterAll(async () => {
		await engine?.stop();
	});

	const settings = (codec: 'h264' | 'vp9') => ({
		sequenceId: d.seqId,
		range: { type: 'custom', startFrame: 0, endFrame: 24 },
		container: codec === 'vp9' ? 'webm' : 'mp4',
		engine: 'remotion',
		video: {
			codec,
			width: 640,
			height: 360,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 23 },
			encoderSpeed: 'fast',
			colorTags: 'rec709',
		},
		audio: { codec: codec === 'vp9' ? 'opus' : 'aac', sampleRate: 48000, channels: 2 },
	});

	async function exportWith(codec: 'h264' | 'vp9') {
		const body = { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(codec) };
		const plan = await engine.app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: { ...host(), 'content-type': 'application/json' },
			payload: body,
		});
		expect(plan.statusCode).toBe(200);
		expect(plan.json().path).toBe('remotion');
		const start = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...host(), 'content-type': 'application/json' },
			payload: body,
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(engine.app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(done.state).toBe('succeeded');
		const id = start.json().id as string;
		const file = (await coreServices(engine.app).exports.outputFile(id))!;
		return { plan: plan.json(), result: done.result as Record<string, unknown>, file };
	}

	it('reports the LGPL directory in /api/capabilities (strict mode accepts it)', async () => {
		const r = await engine.app.inject({ method: 'GET', url: '/api/capabilities', headers: host() });
		const caps = EngineCapabilitiesSchema.parse(r.json());
		expect(caps.engine.mode).toBe('local');
		expect(caps.render.remotionLocal).toBe('ready');
		expect(caps.render.remotionBinaries).toMatchObject({ source: 'env', lgpl: true, license: 'lgpl' });
		expect(caps.render.remotionBinaries!.message).toBeUndefined();
		expect(caps.media.ffmpegSource).toBe('env');
		expect(caps.media.encoding!.license).toBe('lgpl');
	});

	it('its ffmpeg is an LGPL build (no --enable-gpl / --enable-nonfree / x264)', () => {
		const conf = spawnSync(ffmpegIn(LGPL_DIR!), ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
		expect(conf.status).toBe(0);
		expect(conf.stdout).toContain('--enable-shared');
		expect(conf.stdout).not.toMatch(/--enable-(gpl|nonfree|libx264|libx265|libfdk-aac)\b/);
		const lic = spawnSync(ffmpegIn(LGPL_DIR!), ['-hide_banner', '-L'], { encoding: 'utf8' });
		// LGPL 2.1 (source build) and 3 (BtbN) wrap the text differently.
		expect(lic.stdout.replace(/\s+/g, ' ')).toContain('GNU Lesser General Public License');
	});

	it('exports H.264 via a Remotion ProRes intermediate encoded with OpenH264', async () => {
		const { plan, result, file } = await exportWith('h264');
		expect(plan.encoder).toMatchObject({ codec: 'h264', encoder: 'libopenh264', gpl: false });
		expect(result).toMatchObject({
			frames: 24,
			renderPath: 'remotion',
			remotionOutput: 'intermediate',
			encoder: 'libopenh264',
			container: 'mp4',
		});
		const info = probe(file);
		const v = info.streams.find((s) => s.codec_type === 'video')!;
		const a = info.streams.find((s) => s.codec_type === 'audio')!;
		expect(v).toMatchObject({
			codec_name: 'h264',
			width: 640,
			height: 360,
			nb_read_frames: '24',
			color_primaries: 'bt709',
			color_transfer: 'bt709',
		});
		expect(a).toMatchObject({ codec_name: 'aac' });
		// x264 leaves its version banner in an SEI message; OpenH264 does not.
		expect(readFileSync(file).includes('x264 - core')).toBe(false);
	}, 300_000);

	it('exports VP9/Opus WebM directly through Remotion', async () => {
		const { plan, result, file } = await exportWith('vp9');
		expect(plan.encoder).toMatchObject({ codec: 'vp9', encoder: 'libvpx-vp9', container: 'webm' });
		expect(result).toMatchObject({
			frames: 24,
			renderPath: 'remotion',
			remotionOutput: 'direct',
			container: 'webm',
		});
		const info = probe(file);
		expect(info.format.format_name).toContain('webm');
		const v = info.streams.find((s) => s.codec_type === 'video')!;
		expect(v).toMatchObject({ codec_name: 'vp9', width: 640, height: 360, nb_read_frames: '24' });
		expect(info.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'opus' });
	}, 300_000);

	it('renders a still through the LGPL compositor', async () => {
		const stillDoc = new DocBuilder('hd-720p-30');
		stillDoc.tx([
			{ type: 'clip.addText', at: 0, duration: 24, track: 'V1', content: { text: 'LGPL still' }, ref: '$t' },
		]);
		stillDoc.tx([{ type: 'clip.update', clipIds: stillDoc.clipIds(), patch: { blendMode: 'screen' } }]);
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...host(), 'content-type': 'application/json' },
			payload: { envelope: stillDoc.envelope(), sequenceId: stillDoc.seqId, frame: 10 },
		});
		const job = await coreServices(engine.app).queue.wait(r.json().id);
		expect(job.state).toBe('succeeded');
		expect(job.result).toMatchObject({ renderPath: 'remotion' });
		const png = await engine.app.inject({
			method: 'GET',
			url: (job.result as { url: string }).url,
			headers: host(),
		});
		expect(png.statusCode).toBe(200);
		expect(png.headers['content-type']).toBe('image/png');
	}, 300_000);
});
