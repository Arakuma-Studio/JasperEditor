// analyze_picture_motion and find_sound_cues' engine sources (spec 12 §2.10, P6-R2; wp-note "Phase 6 → WP6.2") through
// jasper-mcp over stdio against a real engine with generated footage (a box that rests, moves and stops): the events
// with timecodes, the PNG strip (decodes, thumbnails at the events), find_sound_cues {sources: ["pixel"]} waiting for the
// analysis and returning anchored cues, strict arguments and typed refusals.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../src/png.ts';
import { cleanEnv, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_SOUND_MOTION_TEST_PORT ?? 49571);
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const HAVE_FFMPEG = spawnSync(FFMPEG, ['-version']).status === 0;

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
const imagesOf = (r: CallToolResult) =>
	r.content.filter((c) => c.type === 'image') as { type: 'image'; data: string; mimeType: string }[];

let engine: ChildProcess | null = null;
let work = '';
let client: Client;
const token = randomBytes(16).toString('hex');
const editorKey = randomBytes(16).toString('hex');
const logs: string[] = [];
const engineLog: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 900_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('').slice(-2000)}`);
	return { json: JSON.parse(textOf(r)) as T, result: r };
}

describe.skipIf(!HAVE_FFMPEG)(
	'analyze_picture_motion / find_sound_cues engine sources',
	{ timeout: 900_000 },
	() => {
		beforeAll(async () => {
			work = mkdtempSync(join(tmpdir(), 'jasper-mcp-motion-'));
			const appdir = join(work, 'appdir');
			mkdirSync(appdir);
			const r = spawnSync(
				FFMPEG,
				[
					...['-hide_banner', '-v', 'error', '-y'],
					...['-f', 'lavfi', '-i', 'color=c=0x404040:s=1920x1080:r=30:d=4'],
					...['-f', 'lavfi', '-i', 'testsrc2=s=240x240:r=30:d=1'],
					'-filter_complex',
					"[1:v]trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/30/TB[b];[0:v][b]overlay=x='if(lt(t,1),200,if(lt(t,2),200+(t-1)*600,800))':y=400:shortest=1:eval=frame,format=yuv420p",
					...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-an', join(work, 'box.mp4')],
				],
				{ encoding: 'utf8' },
			);
			if (r.status !== 0) throw new Error(r.stderr);
			engine = spawn(
				process.execPath,
				['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
				{
					cwd: ROOT,
					env: cleanEnv({
						JASPER_LOCAL_TOKEN: token,
						JASPER_EDITOR_KEY: editorKey,
						JASPER_SOUND_AUTO_INDEX: '0',
					}),
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);
			engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
			engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
			await waitFor(
				async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
				300_000,
				`the engine on ${PORT}: ${engineLog.join('')}`,
			);
			const transport = new StdioClientTransport({
				command: process.execPath,
				args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
				cwd: ROOT,
				env: cleanEnv(),
				stderr: 'pipe',
			});
			transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
			client = new Client({ name: 'vitest-mcp-sound-motion', version: '1.0.0' });
			await client.connect(transport);
		}, 600_000);

		afterAll(async () => {
			await client?.close().catch(() => {});
			if (engine && engine.exitCode === null) {
				const exited = new Promise((r) => engine!.once('exit', r));
				engine.kill('SIGTERM');
				await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
			}
			if (work) rmSync(work, { recursive: true, force: true });
		}, 30_000);

		it('finds the box moving (00:00:01:01–00:00:02:01) and stopping, draws the strip, and gives anchored pixel cues', async () => {
			const { json: created } = await ok<{ projectId: string }>('create_project', {
				name: 'Motion',
				preset: 'hd-1080p-30',
			});
			const projectId = created.projectId;
			const { json: imp } = await ok<{ imported: { mediaId: string }[] }>('import_media', {
				projectId,
				paths: [join(work, 'box.mp4')],
			});
			await ok('apply_commands', {
				projectId,
				label: 'Footage',
				commands: [
					{
						type: 'clip.place',
						source: { mediaId: imp.imported[0]!.mediaId },
						at: 0,
						tracks: { video: 'V1' },
					},
				],
			});
			// find_sound_cues first: the analysis starts, the tool waits for it and derives again
			const { json: found } = await ok<{
				cues: { from: string; kind: string; frame: number; anchorText: string; window?: { start: number } }[];
				analysis: Record<string, { state: string }>;
				warnings: { code: string }[];
			}>('find_sound_cues', { projectId, sources: ['pixel'], density: 'rich' });
			expect(found.analysis.pixel!.state).toBe('ready');
			expect(found.warnings.filter((w) => w.code === 'W_ANALYSIS_PENDING')).toEqual([]);
			const move = found.cues.find((c) => c.from === 'pixel' && c.kind === 'move')!;
			expect(Math.abs(move.window!.start - 31)).toBeLessThanOrEqual(2);
			expect(move.anchorText).toContain('box.mp4');
			const land = found.cues.find((c) => c.from === 'pixel' && c.kind === 'land')!;
			expect(Math.abs(land.frame - 60)).toBeLessThanOrEqual(2);

			// analyze_picture_motion: cached now; events in words, the strip with thumbnails
			const { json, result } = await ok<{
				cached: boolean;
				events: { kind: string; frame: number; start?: number; end?: number; text: string }[];
				lines: string[];
				curve: { speed: number[] };
				cells: { events: { kind: string; x: number }[]; thumbs: unknown[] };
			}>('analyze_picture_motion', { projectId });
			expect(json.cached).toBe(true);
			const m = json.events.find((e) => e.kind === 'move')!;
			expect(Math.abs(m.start! - 31)).toBeLessThanOrEqual(2);
			expect(Math.abs(m.end! - 61)).toBeLessThanOrEqual(2);
			expect(json.lines.join('\n')).toContain('moves right');
			expect(json.curve.speed.length).toBe(120);
			const imgs = imagesOf(result);
			expect(imgs).toHaveLength(1);
			const png = decodePng(Buffer.from(imgs[0]!.data, 'base64'));
			expect(png.width).toBe(1200);
			expect(json.cells.thumbs.length).toBe(json.events.length);
			expect(json.cells.events.map((e) => e.kind)).toEqual(json.events.map((e) => e.kind));
			// the PNG for the wp-note (looked at by the author)
			const out = process.env.MOTION_STRIP_OUT;
			if (out) (await import('node:fs')).writeFileSync(out, Buffer.from(imgs[0]!.data, 'base64'));

			// strict arguments and refusals
			const bad = await call('analyze_picture_motion', { projectId, rangee: 1 });
			expect(bad.isError).toBe(true);
			expect(textOf(bad)).toContain('E_UNKNOWN_ARGUMENT');
			const empty = await call('analyze_picture_motion', { projectId, range: { start: 500, end: 600 } });
			expect(empty.isError).toBe(true);
			expect(textOf(empty)).toContain('RANGE_EMPTY');
			const inverted = await call('analyze_picture_motion', { projectId, range: { start: 50, end: 10 } });
			expect(textOf(inverted)).toContain('E_INVALID_PARAM');
		});
	},
);
