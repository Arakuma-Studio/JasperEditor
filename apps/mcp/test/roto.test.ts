// scripts/fixtures/roto.mjs supplies an ellipse with known per-frame geometry for rendered matte checks.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectDocument } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');
const PORT = Number(process.env.MCP_ROTO_TEST_PORT ?? 48563);
const PLATE = join(FIXTURES, 'roto-object.mp4');
const TRUTH = join(FIXTURES, 'roto-object.json');
const ARTIFACTS = join(ROOT, 'test-results', 'mcp');

type Ellipse = { cx: number; cy: number; rx: number; ry: number; angle: number };
type Truth = { width: number; height: number; frames: Ellipse[] };

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

let engine: ChildProcess | null = null;
let appdir = '';
let client: Client;
let truth: Truth;
const logs: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 900_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
	return JSON.parse(textOf(r)) as T;
}

function decodeRgb(input: Buffer | string, args: string[] = []): { w: number; h: number; rgb: Buffer } {
	const probe = spawnSync(
		'ffprobe',
		[
			'-v',
			'error',
			'-show_entries',
			'stream=width,height',
			'-of',
			'csv=p=0',
			...(typeof input === 'string' ? [input] : ['-i', 'pipe:0']),
		],
		typeof input === 'string' ? { encoding: 'utf8' } : { input, encoding: 'utf8' },
	);
	const [w, h] = probe.stdout.trim().split(',').map(Number) as [number, number];
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			...args,
			'-i',
			typeof input === 'string' ? input : 'pipe:0',
			'-frames:v',
			'1',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgb24',
			'pipe:1',
		],
		{ ...(typeof input === 'string' ? {} : { input }), maxBuffer: 256 * 1024 * 1024 },
	);
	if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
	return { w, h, rgb: r.stdout };
}

/** IoU of the non-black pixels of a 640×360 frame (Object Matte over black) against the ellipse. */
function iouOf(img: { w: number; h: number; rgb: Buffer }, e: Ellipse): number {
	const sx = truth.width / img.w;
	const c = Math.cos(-e.angle);
	const s = Math.sin(-e.angle);
	let i = 0;
	let u = 0;
	for (let y = 0; y < img.h; y++)
		for (let x = 0; x < img.w; x++) {
			const px = (x + 0.5) * sx - e.cx;
			const py = (y + 0.5) * sx - e.cy;
			const a = px * c - py * s;
			const b = px * s + py * c;
			const g = (a / e.rx) ** 2 + (b / e.ry) ** 2 <= 1;
			const k = (y * img.w + x) * 3;
			const m = img.rgb[k]! + img.rgb[k + 1]! + img.rgb[k + 2]! > 3 * 60;
			if (g && m) i++;
			if (g || m) u++;
		}
	return i / u;
}

beforeAll(async () => {
	if (!existsSync(PLATE) || !existsSync(TRUTH)) {
		const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
		if (r.status !== 0) throw new Error('fixture generation failed');
	}
	truth = JSON.parse(readFileSync(TRUTH, 'utf8')) as Truth;
	mkdirSync(ARTIFACTS, { recursive: true });
	appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-roto-'));
	const token = randomBytes(16).toString('hex');
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT, // A dev engine (as compositions.test / the QA harness): Remotion renders also without the LGPL FFmpeg folder,
			// which a clean CI checkout does not have (a built engine refuses with BINARY_MISSING, by design).
			env: cleanEnv({ JASPER_LOCAL_TOKEN: token, JASPER_DEV: '1' }),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
	await waitFor(
		async () =>
			existsSync(join(appdir, 'engine', 'runtime.json')) &&
			(await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		90_000,
		`the engine on ${PORT}: ${logs.join('')}`,
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
		cwd: ROOT,
		env: cleanEnv(),
		stderr: 'pipe',
	});
	client = new Client({ name: 'vitest-mcp-roto', version: '1.0.0' });
	await client.connect(transport);
}, 180_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (appdir) rmSync(appdir, { recursive: true, force: true });
}, 30_000);

describe('roto tools', () => {
	it('create_roto → propagate → render_frame / export cut the object out (IoU ≥ 0.93), masks, refusals', async () => {
		const { projectId } = await ok<{ projectId: string }>('create_project', { name: 'Roto' });
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', { projectId, paths: [PLATE] });
		const mediaId = imp.imported[0]!.mediaId;
		const placed = await ok<{ refs: Record<string, string> }>('apply_commands', {
			projectId,
			label: 'Setup',
			commands: [
				{
					type: 'clip.place',
					source: { mediaId },
					at: 0,
					tracks: { video: 'V1' },
					audio: false,
					ref: '$plate',
				},
				{ type: 'clip.fitToFrame', clipIds: ['$plate'], mode: 'fit' },
			],
		});
		const clipId = placed.refs.$plate!;
		const created = await ok<{ rotoId: string; effectInstanceId: string; span: number[] }>('create_roto', {
			projectId,
			clipId,
			at: 10,
			points: [{ x: 230, y: 185 }],
			settings: { engine: 'classic' },
			propagate: 'none',
		});
		expect(created.span).toEqual([0, 44]);
		const refused = await call('start_export', { projectId, preset: 'draft-720p-h264' });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain('ROTO_NOT_COMPUTED');
		const prop = await ok<{ computedFrames: { start: number; end: number }; framesComputed: number }>(
			'propagate_roto',
			{
				projectId,
				rotoId: created.rotoId,
			},
		);
		expect(prop.computedFrames).toEqual({ start: 0, end: 44 });
		const info = await ok<{ stale: boolean; computed: { start: number; end: number } }>('get_roto', {
			projectId,
			rotoId: created.rotoId,
		});
		expect(info).toMatchObject({ stale: false, computed: { start: 0, end: 44 } });

		for (const at of [5, 25, 40]) {
			const r = await call('render_frame', { projectId, at, width: 640 });
			expect(r.isError, textOf(r)).toBeFalsy();
			const png = Buffer.from((r.content.find((c) => c.type === 'image') as { data: string }).data, 'base64');
			writeFileSync(join(ARTIFACTS, `roto-${at}.png`), png);
			expect(iouOf(decodeRgb(png), truth.frames[at]!)).toBeGreaterThan(0.93);
		}

		await ok('apply_object_matte', { projectId, rotoId: created.rotoId, params: { view: 'overlay' } });
		const ov = await call('render_frame', { projectId, at: 25, width: 640 });
		const ovImg = decodeRgb(
			Buffer.from((ov.content.find((c) => c.type === 'image') as { data: string }).data, 'base64'),
		);
		const k = (20 * ovImg.w + 20) * 3;
		expect(ovImg.rgb[k]!).toBeGreaterThan(100); // red tint over the blue background
		await ok('apply_object_matte', { projectId, rotoId: created.rotoId, params: { view: 'final' } });

		// The Object Matte composes with effect masks: limited to the left half, the right half keeps the plate.
		const v = (x: number, y: number) => ({ p: [x, y], in: [0, 0], out: [0, 0] });
		const masked = await ok<{ refs: Record<string, string> }>('apply_commands', {
			projectId,
			label: 'Effect mask',
			commands: [
				{
					type: 'mask.add',
					effectId: created.effectInstanceId,
					shape: 'bezier',
					path: { closed: true, vertices: [v(0, 0), v(0.5, 0), v(0.5, 1), v(0, 1)] },
					feather: 0,
					ref: '$m',
				},
			],
		});
		const mk = await call('render_frame', { projectId, at: 25, width: 640 });
		const mkImg = decodeRgb(
			Buffer.from((mk.content.find((c) => c.type === 'image') as { data: string }).data, 'base64'),
		);
		writeFileSync(
			join(ARTIFACTS, 'roto-effect-mask-25.png'),
			Buffer.from((mk.content.find((c) => c.type === 'image') as { data: string }).data, 'base64'),
		);
		const px = (x: number, y: number) => {
			const i = (y * mkImg.w + x) * 3;
			return mkImg.rgb[i]! + mkImg.rgb[i + 1]! + mkImg.rgb[i + 2]!;
		};
		expect(px(40, 40)).toBeLessThan(30);
		expect(px(600, 40)).toBeGreaterThan(60);
		expect(px(305, 200)).toBeGreaterThan(150);
		await ok('apply_commands', {
			projectId,
			label: 'Remove effect mask',
			commands: [{ type: 'mask.remove', maskIds: [masked.refs.$m] }],
		});

		const output = join(appdir, 'exports', 'roto.mp4');
		const job = await ok<{ jobId: string }>('start_export', {
			projectId,
			preset: 'draft-720p-h264',
			outputPath: output,
		});
		const done = await ok<{ state: string }>('wait_for_job', { jobId: job.jobId, timeoutSeconds: 600 });
		expect(done.state).toBe('succeeded');
		for (const f of [3, 30]) {
			const small = spawnSync(
				'ffmpeg',
				[
					'-v',
					'error',
					'-i',
					output,
					'-vf',
					`select=eq(n\\,${f}),scale=640:360`,
					'-frames:v',
					'1',
					'-f',
					'rawvideo',
					'-pix_fmt',
					'rgb24',
					'pipe:1',
				],
				{ maxBuffer: 64 * 1024 * 1024 },
			);
			expect(small.status, String(small.stderr)).toBe(0);
			writeFileSync(join(ARTIFACTS, `roto-export-${f}.rgb`), small.stdout);
			expect(iouOf({ w: 640, h: 360, rgb: small.stdout }, truth.frames[f]!)).toBeGreaterThan(0.93);
		}

		const masks = await ok<{ masks: number }>('convert_roto_to_masks', {
			projectId,
			rotoId: created.rotoId,
			at: 20,
		});
		expect(masks.masks).toBe(1);
		const resource = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
		const doc = JSON.parse((resource.contents[0] as { text: string }).text) as ProjectDocument;
		const clip = Object.values(doc.sequences)[0]!.clips[clipId] as {
			masks?: { path: { value: { vertices: unknown[] } } }[];
		};
		expect(clip.masks?.length).toBe(1);
		expect(clip.masks![0]!.path.value.vertices.length).toBeGreaterThan(4);

		const faces = await call('blur_faces', { projectId, clipId });
		expect(faces.isError).toBe(true);
		expect(textOf(faces)).toContain('FACE_MODEL_NOT_INSTALLED');
	}, 1_200_000);
});
