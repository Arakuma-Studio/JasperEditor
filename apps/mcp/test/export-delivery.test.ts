// start_export / wait_for_job / sound_check report the delivery of a lossy export (wp-note sound-design "Fix:
// lossy-codec true-peak headroom and loudness convergence") through jasper-mcp over stdio against a real engine: a
// loud mix normalised to −14 LUFS / −1 dBTP and exported with the draft preset (AAC 128 kb/s) — the plan names the
// limiter ceiling in front of the encoder (−2.5 dBTP: 1.5 dB of codec headroom), the result the delivered file's own
// decoded numbers under the target and how they were reached; sound_check {exportPreset} judges the same decoded
// audio (no TRUE_PEAK) with the same ceiling; strict arguments.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loudMix, writeMixWav } from '../../engine/test/loud-fixture.ts';
import { cleanEnv, testPort, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_EXPORT_DELIVERY_TEST_PORT);

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
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-delivery-'));
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
	client = new Client({ name: 'vitest-mcp-export-delivery', version: '1.0.0' });
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

type AudioLoudness = {
	integratedLufs: number;
	truePeakDbtp: number;
	measuredOn: string;
	pcm?: { integratedLufs: number; truePeakDbtp: number };
	targetLufs: number;
	truePeakTargetDbtp: number;
	limiterCeilingDbtp: number;
	codecHeadroomDb: number;
	loudnessPasses: number;
	encodePasses: number;
	localCorrections: { count: number; maxDb: number };
	ceilingLimited: boolean;
	truePeakMet: boolean;
};

describe('lossy export delivery through MCP', { timeout: 900_000 }, () => {
	it('start_export, wait_for_job and sound_check {exportPreset} report the ceiling and the decoded audio', async () => {
		const file = writeMixWav(join(work, 'loud.wav'), loudMix(10));
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'Delivery',
			preset: 'hd-1080p-30',
		});
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', { projectId, paths: [file] });
		await ok('apply_commands', {
			projectId,
			label: 'Loud mix',
			commands: [
				{ type: 'clip.place', source: { mediaId: imp.imported[0]!.mediaId }, at: 0, tracks: { audio: 'A1' } },
				{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
			],
		});
		const started = await ok<{
			jobId: string;
			state: string;
			plan: {
				loudness?: {
					targetLufs: number;
					truePeakDb: number;
					limiterCeilingDb: number;
					codecHeadroomDb: number;
				};
			};
			result?: { audioLoudness: AudioLoudness; audioCodec: string };
		}>('start_export', { projectId, preset: 'draft-720p-h264', engine: 'native', wait: true });
		expect(started.state).toBe('succeeded');
		expect(started.plan.loudness).toEqual({
			targetLufs: -14,
			truePeakDb: -1,
			limiterCeilingDb: -2.5,
			codecHeadroomDb: 1.5,
		});
		const a = started.result!.audioLoudness;
		console.log('mcp export', JSON.stringify(a));
		expect(started.result!.audioCodec).toBe('aac');
		expect(a.measuredOn).toBe('decoded-file');
		expect(a.truePeakDbtp).toBeLessThanOrEqual(-1);
		expect(Math.abs(a.integratedLufs + 14)).toBeLessThanOrEqual(0.5);
		expect(a.truePeakMet).toBe(true);
		expect(a.codecHeadroomDb).toBe(1.5);
		expect(a.limiterCeilingDbtp).toBeLessThanOrEqual(-2.5);
		expect(a.encodePasses).toBeGreaterThanOrEqual(1);
		expect(a.pcm!.truePeakDbtp).toBeLessThanOrEqual(a.limiterCeilingDbtp + 0.05);
		const waited = await ok<{ state: string; result: { audioLoudness: AudioLoudness } }>('wait_for_job', {
			jobId: started.jobId,
		});
		expect(waited.result.audioLoudness).toEqual(a);

		const check = await ok<{
			loudness: {
				normalization: { limiterCeilingDb: number; codecHeadroomDb: number; encodePasses: number };
				delivered: {
					codec: string;
					bitrateKbps: number;
					truePeakDb: number;
					integratedLufs: number;
					truePeakMet: boolean;
				};
			};
			issues: { code: string }[];
		}>('sound_check', { projectId, exportPreset: 'draft-720p-h264', images: false });
		console.log('mcp check', JSON.stringify(check.loudness));
		expect(check.loudness.normalization.codecHeadroomDb).toBe(1.5);
		expect(check.loudness.normalization.limiterCeilingDb).toBeCloseTo(a.limiterCeilingDbtp, 2);
		expect(check.loudness.delivered).toMatchObject({ codec: 'aac', bitrateKbps: 128, truePeakMet: true });
		expect(check.loudness.delivered.truePeakDb).toBeLessThanOrEqual(-1);
		// the same delivery: the check's decoded audio is the export's (the file adds only the mux)
		expect(Math.abs(check.loudness.delivered.truePeakDb - a.truePeakDbtp)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(check.loudness.delivered.integratedLufs - a.integratedLufs)).toBeLessThanOrEqual(0.1);
		expect(check.issues.map((i) => i.code)).not.toContain('TRUE_PEAK');
		expect(check.issues.map((i) => i.code)).not.toContain('LOUDNESS');

		const both = await call('sound_check', {
			projectId,
			exportPreset: 'draft-720p-h264',
			exportAudio: { codec: 'aac' },
		});
		expect(both.isError).toBe(true);
		expect(textOf(both)).toMatch(/exportPreset or exportAudio/);
		const unknown = await call('sound_check', { projectId, exportPreset: 'nope' });
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toMatch(/Unknown export preset/);
		const strict = await call('sound_check', { projectId, exportAudio: { codec: 'aac', bogus: 1 } });
		expect(strict.isError).toBe(true);
	});
});
