// Remotion path end to end (S04:RR-001…006): bundles @jasper/compositions, renders with a headless browser.
// Gated by REMOTION_E2E=1 because it may download a browser and takes ~30 s.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
/** Optional fixed port (parallel worktrees get their own range); default 0 = any free port. */
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const BROWSER = process.env.JASPER_BROWSER_EXECUTABLE
	? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
	: {};

describe.runIf(enabled)('Remotion render (REMOTION_E2E=1)', () => {
	it('renders 30 frames of a text-only sequence and a still', async () => {
		const engine: RunningEngine = await startEngine({
			appdir: tempAppdir(),
			port: PORT,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		try {
			const d = new DocBuilder('hd-720p-30');
			d.tx([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hello Jasper' } }]);
			const base = {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					engine: 'auto',
					video: {
						codec: 'h264',
						width: 1280,
						height: 720,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 23 },
						encoderSpeed: 'fast',
						colorTags: 'rec709',
					},
				},
			};
			const plan = await (
				await fetch(`${engine.url}/api/exports/plan`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(base),
				})
			).json();
			expect(plan.path).toBe('remotion');
			const job = await (
				await fetch(`${engine.url}/api/exports`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(base),
				})
			).json();
			const done = await coreServices(engine.app).queue.wait(job.id);
			expect(done.error).toBeUndefined();
			expect(done.state).toBe('succeeded');
			expect(done.result).toMatchObject({ frames: 30, renderPath: 'remotion' });
			const file = (await coreServices(engine.app).exports.outputFile(job.id))!;
			const r = spawnSync('ffprobe', [
				'-v',
				'error',
				'-count_frames',
				'-select_streams',
				'v:0',
				'-show_entries',
				'stream=nb_read_frames,width,height',
				'-of',
				'json',
				file,
			]);
			const s = JSON.parse(r.stdout.toString()).streams[0];
			expect(Number(s.nb_read_frames)).toBe(30);
			expect(s).toMatchObject({ width: 1280, height: 720 });

			const still = await (
				await fetch(`${engine.url}/api/stills`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ envelope: d.envelope(), sequenceId: d.seqId, frame: 5 }),
				})
			).json();
			const stillDone = await coreServices(engine.app).queue.wait(still.id);
			expect(stillDone.state).toBe('succeeded');
			expect(stillDone.result).toMatchObject({ renderPath: 'remotion' });
			const png = await fetch(`${engine.url}${(stillDone.result as { url: string }).url}`);
			expect(png.status).toBe(200);
			expect(png.headers.get('content-type')).toBe('image/png');
		} finally {
			await engine.stop();
		}
	}, 300_000);
});

describe.runIf(enabled)('Remotion render in LGPL-only mode (REMOTION_E2E=1)', () => {
	it('renders a ProRes intermediate and encodes it with the selected LGPL-compatible encoder', async () => {
		const engine: RunningEngine = await startEngine({
			appdir: tempAppdir(),
			port: PORT ? PORT + 1 : 0,
			dev: true,
			env: { PATH: process.env.PATH, JASPER_FFMPEG_LGPL_ONLY: '1', ...BROWSER },
		});
		try {
			const d = new DocBuilder('hd-720p-30');
			d.tx([{ type: 'clip.addText', at: 0, duration: 20, track: 'V1', content: { text: 'LGPL' } }]);
			const body = {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					engine: 'remotion',
					video: {
						codec: 'h264',
						width: 1280,
						height: 720,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 23 },
						encoderSpeed: 'fast',
						colorTags: 'rec709',
					},
				},
			};
			const plan = await (
				await fetch(`${engine.url}/api/exports/plan`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			).json();
			expect(plan.path).toBe('remotion');
			expect(plan.encoder.gpl).toBe(false);
			const job = await (
				await fetch(`${engine.url}/api/exports`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			).json();
			const done = await coreServices(engine.app).queue.wait(job.id);
			expect(done.error).toBeUndefined();
			expect(done.state).toBe('succeeded');
			expect(done.result).toMatchObject({
				frames: 20,
				renderPath: 'remotion',
				encoder: plan.encoder.encoder,
			});
			const file = (await coreServices(engine.app).exports.outputFile(job.id))!;
			const r = spawnSync('ffprobe', [
				'-v',
				'error',
				'-count_frames',
				'-select_streams',
				'v:0',
				'-show_entries',
				'stream=nb_read_frames,width,height,codec_name',
				'-of',
				'json',
				file,
			]);
			const s = JSON.parse(r.stdout.toString()).streams[0];
			expect(s).toMatchObject({
				width: 1280,
				height: 720,
				codec_name: plan.encoder.codec,
				nb_read_frames: '20',
			});
		} finally {
			await engine.stop();
		}
	}, 300_000);
});
