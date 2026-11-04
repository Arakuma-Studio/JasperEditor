// Export verification and delivery presets through MCP (spec 18 AF-VER-001…004; docs/wp-notes/agent-footage-verify.md),
// jasper-mcp over stdio against a real engine in LGPL-only mode: start_export {wait} returns the output's probe and the
// fast rows; verify_export runs every check on the recorded cut list (a jump cut and a cut to a gap: intended black)
// and the platform rows; a platform preset exports at the platform's size and loudness and verifies against it; a
// vertical platform preset on a horizontal sequence is refused with the auto_reframe_sequence hint.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExportVerifyResult } from '@jasper/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, engineReady, stopEngine, testPort } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_EXPORT_VERIFY_TEST_PORT);

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

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
	return JSON.parse(textOf(r)) as T;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-verify-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT,
			env: cleanEnv({
				JASPER_LOCAL_TOKEN: token,
				JASPER_EDITOR_KEY: editorKey,
				JASPER_SOUND_AUTO_INDEX: '0',
				JASPER_FFMPEG_LGPL_ONLY: '1',
				JASPER_HW_ENCODERS: '0',
			}),
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await engineReady(engine, PORT, engineLog);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
		cwd: ROOT,
		env: cleanEnv(),
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
	client = new Client({ name: 'vitest-mcp-export-verify', version: '1.0.0' });
	await client.connect(transport);
});

afterAll(async () => {
	await client?.close().catch(() => {});
	await stopEngine(engine);
	if (work) rmSync(work, { recursive: true, force: true });
});

type Fast = {
	state: string;
	verified: boolean;
	rows: { id: string; status: string }[];
	output: ExportVerifyResult['output'];
};

describe('export verification through MCP', () => {
	it('start_export returns the fast rows; verify_export the full and platform rows; platform presets', async () => {
		// 2 s of a grey picture over a 440 Hz tone (whole cycles: a cut between two copies is continuous)
		const clip = join(work, 'shot.mp4');
		execFileSync('ffmpeg', [
			'-v',
			'error',
			'-y',
			'-f',
			'lavfi',
			'-i',
			'color=c=0x808080:s=640x360:r=30:d=2',
			'-f',
			'lavfi',
			'-i',
			'aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*440*t):s=48000:d=2',
			'-c:v',
			'mpeg4',
			'-q:v',
			'3',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			'-b:a',
			'192k',
			clip,
		]);
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'Verify',
			preset: 'hd-1080p-30',
		});
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', { projectId, paths: [clip] });
		const mediaId = imp.imported[0]!.mediaId;
		// shot at 0, a copy at 60 (a jump cut), a 15-frame gap, a copy at 135
		await ok('apply_commands', {
			projectId,
			label: 'Cut',
			commands: [
				{ type: 'clip.place', source: { mediaId }, at: 0 },
				{ type: 'clip.place', source: { mediaId }, at: 60 },
				{ type: 'clip.place', source: { mediaId }, at: 135 },
			],
		});
		const presets = await ok<{ presets: { id: string; target?: string }[] }>('list_export_presets');
		expect(presets.presets.filter((p) => p.target).map((p) => p.id)).toEqual([
			'delivery-youtube',
			'delivery-youtube-shorts',
			'delivery-instagram-reels',
			'delivery-tiktok',
			'delivery-x',
			'delivery-linkedin',
		]);

		const started = await ok<Fast & { jobId: string }>('start_export', {
			projectId,
			preset: 'draft-720p-h264',
			engine: 'native',
			wait: true,
		});
		expect(started.state).toBe('succeeded');
		expect(started.rows.map((r) => [r.id, r.status])).toEqual([
			['streams', 'pass'],
			['duration', 'pass'],
			['av-skew', 'pass'],
		]);
		expect(started.verified).toBe(true);
		expect(started.output.streams.map((s) => s.type)).toEqual(['video', 'audio']);
		expect(started.output.sizeBytes).toBeGreaterThan(0);
		const waited = await ok<Fast>('wait_for_job', { jobId: started.jobId });
		expect(waited.rows).toEqual(started.rows);

		const full = await ok<ExportVerifyResult>('verify_export', { projectId, exportId: started.jobId });
		console.log(
			'verify_export',
			JSON.stringify(full.rows.map((r) => [r.id, r.status, r.measured, r.message])),
		);
		expect(full.rows.map((r) => r.id)).toEqual([
			'decode',
			'streams',
			'duration',
			'av-skew',
			'cut-black',
			'cut-flash',
			'cut-click',
			'loudness',
			'true-peak',
			'silence',
		]);
		expect(full.range).toEqual({ start: 0, end: 195 });
		// the jump cut at 60, to black at 120 and from black at 135
		expect(full.rows.find((r) => r.id === 'cut-black')!.message).toMatch(/^3 cuts checked/);
		expect(full.rows.filter((r) => r.status === 'fail')).toEqual([]);
		expect(full.verified).toBe(true);

		const shorts = await ok<ExportVerifyResult>('verify_export', {
			projectId,
			exportId: started.jobId,
			target: 'youtube-shorts',
			checks: 'fast',
		});
		expect(shorts.rows.find((r) => r.id === 'target-aspect')).toMatchObject({
			kind: 'format',
			status: 'fail',
		});
		expect(shorts.verified).toBe(false);

		const refused = await call('start_export', { projectId, preset: 'delivery-youtube-shorts' });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain('auto_reframe_sequence');

		const yt = await ok<Fast & { jobId: string }>('start_export', {
			projectId,
			preset: 'delivery-youtube',
			engine: 'native',
			wait: true,
		});
		expect(yt.state).toBe('succeeded');
		expect(yt.output.streams[0]).toMatchObject({ type: 'video', width: 1920, height: 1080 });
		const ytCheck = await ok<ExportVerifyResult>('verify_export', {
			projectId,
			exportId: yt.jobId,
			target: 'youtube',
		});
		console.log(
			'verify_export youtube',
			JSON.stringify(ytCheck.rows.map((r) => [r.id, r.status, r.measured])),
		);
		const byId = Object.fromEntries(ytCheck.rows.map((r) => [r.id, r]));
		expect(byId.loudness).toMatchObject({ status: 'pass', expected: -14 });
		expect(byId['target-loudness']).toMatchObject({ status: 'pass', expected: -14 });
		expect(byId['target-resolution']!.status).toBe('pass');
		expect(byId['target-aspect']!.status).toBe('pass');
		expect(ytCheck.verified).toBe(true);

		// AF-EXP deliverables: a GIF verifies with its picture rows only, an M4A with its sound rows only
		const gif = await ok<Fast & { jobId: string }>('start_export', {
			projectId,
			format: 'gif',
			gif: { fps: 10, width: 320 },
			wait: true,
		});
		expect(gif.state).toBe('succeeded');
		expect(gif.rows.map((r) => [r.id, r.status])).toEqual([
			['streams', 'pass'],
			['duration', 'pass'],
		]);
		expect(gif.verified).toBe(true);
		expect(gif.output.streams.map((s) => [s.type, s.codec, s.frames])).toEqual([['video', 'gif', 65]]);
		const gifFull = await ok<ExportVerifyResult>('verify_export', { projectId, exportId: gif.jobId });
		expect(gifFull.deliverable).toBe('gif');
		expect(gifFull.rows.map((r) => r.id)).toEqual([
			'decode',
			'streams',
			'duration',
			'cut-black',
			'cut-flash',
		]);
		expect(gifFull.verified).toBe(true);
		const m4a = await ok<Fast & { jobId: string }>('start_export', { projectId, format: 'm4a', wait: true });
		expect(m4a.rows.map((r) => [r.id, r.status])).toEqual([
			['streams', 'pass'],
			['duration', 'pass'],
		]);
		const m4aFull = await ok<ExportVerifyResult>('verify_export', { projectId, exportId: m4a.jobId });
		expect(m4aFull.rows.map((r) => r.id)).toEqual([
			'decode',
			'streams',
			'duration',
			'cut-click',
			'loudness',
			'true-peak',
			'silence',
		]);
		const gifTarget = await call('verify_export', { projectId, exportId: gif.jobId, target: 'youtube' });
		expect(gifTarget.isError).toBe(true);
		expect(textOf(gifTarget)).toMatch(/TARGET_NOT_APPLICABLE|not platform videos/);

		const strict = await call('verify_export', { projectId, exportId: started.jobId, bogus: 1 });
		expect(strict.isError).toBe(true);
		const notExport = await call('verify_export', { projectId, exportId: 'job_0000000000000000' });
		expect(notExport.isError).toBe(true);
	});
});
