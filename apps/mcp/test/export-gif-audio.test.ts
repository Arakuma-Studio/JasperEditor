// spec 18 AF-EXP-003: start_export {format} writes an animated GIF or an audio-only WAV / FLAC / M4A through jasper-mcp
// over stdio against a real LGPL-only engine — the plan names the deliverable (GIF rate, size, frames, loop; audio
// codec, rate, channels) and warns that a GIF has no sound; the result gives the file's format; options of another
// format are refused by name; the GIF options are strict.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_FFMPEG, TEST_FFPROBE } from '../../engine/test/fixtures.ts';
import { cleanEnv, engineReady, stopEngine, testPort } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_EXPORT_GIF_AUDIO_TEST_PORT);

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
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-gif-audio-'));
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
	client = new Client({ name: 'vitest-mcp-export-gif-audio', version: '1.0.0' });
	await client.connect(transport);
});

afterAll(async () => {
	await client?.close().catch(() => {});
	await stopEngine(engine);
	if (work) rmSync(work, { recursive: true, force: true });
});

function probe(file: string) {
	const r = spawnSync(TEST_FFPROBE, [
		...['-v', 'error', '-count_packets', '-of', 'json'],
		...[
			'-show_entries',
			'stream=codec_name,width,height,sample_rate,channels,bits_per_raw_sample,nb_read_packets',
		],
		file,
	]);
	return JSON.parse(r.stdout.toString()) as {
		streams: {
			codec_name: string;
			width?: number;
			height?: number;
			sample_rate?: string;
			channels?: number;
			bits_per_raw_sample?: string;
			nb_read_packets?: string;
		}[];
	};
}

type Started = {
	jobId: string;
	state: string;
	format?: string;
	preset?: string;
	plan: { path: string; warnings?: string[]; deliverable?: Record<string, unknown> };
	result?: {
		path?: string;
		container?: string;
		encoder?: string;
		audioCodec?: string;
		renderPath?: string;
		gif?: { fps: number; width: number; height: number; frames: number; loop: number };
	};
};

describe('start_export {format} through MCP (AF-EXP-003)', () => {
	it('writes a GIF and an audio-only file; refuses misplaced options', async () => {
		const clip = join(work, 'pattern.mov');
		const made = spawnSync(TEST_FFMPEG, [
			...['-hide_banner', '-loglevel', 'error', '-y'],
			...['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2'],
			...['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=2'],
			...['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'pcm_s16le', clip],
		]);
		expect(made.status, made.stderr.toString()).toBe(0);
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'GIF and audio',
			preset: 'hd-1080p-30',
		});
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', { projectId, paths: [clip] });
		await ok('apply_commands', {
			projectId,
			label: 'Pattern',
			commands: [
				{
					type: 'clip.place',
					source: { mediaId: imp.imported[0]!.mediaId },
					at: 0,
					tracks: { video: 'V1', audio: 'A1' },
				},
			],
		});

		const gif = await ok<Started>('start_export', {
			projectId,
			format: 'gif',
			gif: { fps: 10, width: 480, loop: 2, dither: 'bayer', palette: 'diff' },
			outputPath: join(work, 'out', 'loop.mp4'),
			wait: true,
		});
		expect(gif.state).toBe('succeeded');
		expect(gif.format).toBe('gif');
		expect(gif.preset).toBeUndefined();
		expect(gif.plan.deliverable).toMatchObject({
			kind: 'gif',
			fps: 10,
			width: 480,
			height: 270,
			frames: 20,
			loop: 2,
			dither: 'bayer',
			bayerScale: 2,
			palette: 'diff',
		});
		expect(gif.plan.warnings?.[0]).toMatch(/GIF files have no sound/);
		expect(gif.result).toMatchObject({
			container: 'gif',
			encoder: 'gif',
			gif: { fps: 10, width: 480, height: 270, frames: 20, loop: 2 },
		});
		expect(gif.result!.audioCodec).toBeUndefined();
		// the extension follows the file: loop.mp4 → loop.gif
		expect(gif.result!.path).toBe(join(work, 'out', 'loop.gif'));
		expect(probe(gif.result!.path!).streams[0]).toMatchObject({
			codec_name: 'gif',
			width: 480,
			height: 270,
			nb_read_packets: '20',
		});
		const bytes = readFileSync(gif.result!.path!);
		expect(bytes.readUInt16LE(bytes.indexOf('NETSCAPE2.0') + 13)).toBe(1);

		const wav = await ok<Started>('start_export', {
			projectId,
			format: 'wav',
			audioBitDepth: 16,
			audioChannels: 1,
			audioSampleRate: 44100,
			range: { from: '00:00:00:15', to: '00:00:01:15' },
			outputPath: join(work, 'out', 'mix.wav'),
			wait: true,
		});
		expect(wav.plan.path).toBe('audio');
		expect(wav.plan.deliverable).toEqual({
			kind: 'audio',
			container: 'wav',
			codec: 'pcm_s16le',
			sampleRate: 44100,
			channels: 1,
			bitDepth: 16,
		});
		expect(wav.result).toMatchObject({ container: 'wav', audioCodec: 'pcm_s16le', renderPath: 'audio' });
		expect(probe(wav.result!.path!).streams).toEqual([
			expect.objectContaining({ codec_name: 'pcm_s16le', sample_rate: '44100', channels: 1 }),
		]);

		const m4a = await ok<Started>('start_export', {
			projectId,
			format: 'm4a',
			audioBitrateKbps: 128,
			wait: true,
		});
		expect(m4a.result).toMatchObject({ container: 'm4a', audioCodec: 'aac' });
		expect(m4a.plan.deliverable).toMatchObject({ container: 'm4a', codec: 'aac', bitrateKbps: 128 });

		for (const [args, msg] of [
			[{ format: 'gif', audioBitDepth: 16 }, /audioBitDepth does not apply to format "gif"/],
			[{ format: 'wav', preset: 'web-vp9' }, /preset does not apply to format "wav"/],
			[{ format: 'flac', audioBitrateKbps: 128 }, /audioBitrateKbps does not apply/],
			[{ gif: { fps: 10 } }, /gif does not apply to format "video"/],
			[{ format: 'gif', audioChannels: 2, crf: 20 }, /crf, audioChannels do not apply/],
		] as const) {
			const r = await call('start_export', { projectId, ...args });
			expect(r.isError, JSON.stringify(args)).toBe(true);
			expect((JSON.parse(textOf(r)) as { error: { message: string } }).error.message).toMatch(msg);
		}
		const strict = await call('start_export', { projectId, format: 'gif', gif: { fps: 10, bogus: 1 } });
		expect(strict.isError).toBe(true);
		const fast = await call('start_export', { projectId, format: 'gif', gif: { fps: 60 } });
		expect(fast.isError).toBe(true);
	});
});
