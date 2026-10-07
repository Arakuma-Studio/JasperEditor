// wp interchange: pre-renders through the Remotion path (ProRes 4444 with alpha, one movie per clip) referenced by the
// exported document. Gated by REMOTION_E2E=1 like the other Remotion suites (bundles, starts a headless browser).
import { spawnSync } from 'node:child_process';
import type { InterchangeExportResult, RegisteredMedia } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, fixture, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
/** Optional fixed port (parallel worktrees get their own range); default 0 = any free port. */
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);

describe.runIf(enabled)('interchange pre-renders (REMOTION_E2E=1)', () => {
	it('renders a text clip to ProRes 4444 with alpha and references it from the EDL', async () => {
		ensureFixtures();
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
		const post = async (path: string, body: unknown) =>
			(
				await fetch(`${engine.url}${path}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			).json();
		try {
			const reg = (await post('/api/media/register', {
				projectId: 'prj_0000000000000001',
				paths: [fixture('clip-a.mp4')],
			})) as { items: RegisteredMedia[] };
			const d = new DocBuilder('hd-720p-30');
			const a = d.addMedia(reg.items[0]!);
			const text = d.tx([
				{
					type: 'clip.place',
					source: { mediaId: a },
					at: 0,
					sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 30 } },
				},
				{
					type: 'clip.addText',
					at: 5,
					duration: 15,
					track: 'V2',
					content: { text: 'Lower third' },
					ref: '$t',
				},
			]).refs.$t!;
			const job = (await post('/api/interchange/export', {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				format: 'edl',
				options: { prerender: 'unsupported', edl: { videoTrack: 1 } },
			})) as { id: string };
			const end = await coreServices(engine.app).queue.wait(job.id);
			expect(end.state, JSON.stringify(end.error)).toBe('succeeded');
			const res = end.result as InterchangeExportResult;
			// the text clip (and clip-a, scaled to fit the 720p frame: Motion, which an EDL cannot carry)
			expect(res.prerendered.map((p) => [p.clipId, p.reason])).toContainEqual([text, 'text clip']);
			const mov = res.files.find((f) => f.role === 'prerender' && f.name.includes(text))!;
			const bytes = await fetch(`${engine.url}${mov.downloadUrl}`);
			expect(bytes.status).toBe(200);
			const file = `${coreServices(engine.app).config.paths.renderDir(job.id)}/interchange/${mov.name}`;
			const probe = spawnSync(
				'ffprobe',
				[
					'-v',
					'error',
					'-count_frames',
					'-select_streams',
					'v:0',
					'-show_entries',
					'stream=codec_name,pix_fmt,nb_read_frames,width,height',
					'-of',
					'json',
					file,
				],
				{ encoding: 'utf8' },
			);
			const s = JSON.parse(probe.stdout).streams[0];
			expect([s.codec_name, s.width, s.height]).toEqual(['prores', 1280, 720]);
			// ProRes 4444 with alpha: ffmpeg's decoder reports the alpha plane (10- or 12-bit)
			expect(s.pix_fmt).toMatch(/^yuva444p1[02]le$/);
			expect(Number(s.nb_read_frames)).toBe(15);
			// a corner pixel is transparent, the text is not
			const alpha = spawnSync(
				'ffmpeg',
				[
					'-v',
					'error',
					'-ss',
					'0.2',
					'-i',
					file,
					'-frames:v',
					'1',
					'-vf',
					'alphaextract,scale=64:36',
					'-pix_fmt',
					'gray',
					'-f',
					'rawvideo',
					'pipe:1',
				],
				{ maxBuffer: 1 << 20 },
			).stdout as Buffer;
			expect(alpha[0]).toBe(0);
			expect(Math.max(...alpha)).toBeGreaterThan(200);
			const edl = await (
				await fetch(`${engine.url}${res.files.find((f) => f.role === 'document')!.downloadUrl}`)
			).text();
			expect(edl).toContain(mov.name);
		} finally {
			await engine.stop();
		}
	}, 300_000);
});
