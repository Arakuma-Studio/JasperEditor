// jasper-mcp tracking tools end to end (S09 §8 item 7, TRA-001/002): a real engine (token mode, temp appdir,
// port MCP_TRACK_TEST_PORT = 48553) and an MCP client over stdio. add_tracker + track (wait) + apply_tracking
// on the planar fixture plate, then render_frame: the pinned overlay's corners in the PNG are within 3 px of the
// fixture's ground truth.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');
const PORT = Number(process.env.MCP_TRACK_TEST_PORT ?? 48553);
const PLATE = join(FIXTURES, 'plate-planar.mp4');
const TRUTH = join(FIXTURES, 'plate-planar.json');

type Truth = {
	reference: { frame: number; corners: [number, number][] };
	corners: [number, number][][];
	occluded: number[];
};

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

let engine: ChildProcess | null = null;
let appdir = '';
let client: Client;
const logs: string[] = [];

async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 600_000,
	})) as CallToolResult;
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
	return JSON.parse(textOf(r)) as T;
}

/** Decodes a PNG to RGB24 with ffmpeg. */
function decodePng(png: Buffer): { w: number; h: number; rgb: Buffer } {
	const w = png.readUInt32BE(16);
	const h = png.readUInt32BE(20);
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
		{
			input: png,
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
	return { w, h, rgb: r.stdout };
}

/** Corners (TL, TR, BR, BL) of the magenta region: extreme points along the diagonals. */
function magentaCorners(img: { w: number; h: number; rgb: Buffer }): [number, number][] {
	const best = [
		{ v: Number.POSITIVE_INFINITY, p: [0, 0] as [number, number] }, // min x+y
		{ v: Number.NEGATIVE_INFINITY, p: [0, 0] as [number, number] }, // max x-y
		{ v: Number.NEGATIVE_INFINITY, p: [0, 0] as [number, number] }, // max x+y
		{ v: Number.POSITIVE_INFINITY, p: [0, 0] as [number, number] }, // min x-y
	];
	let n = 0;
	for (let y = 0; y < img.h; y++)
		for (let x = 0; x < img.w; x++) {
			const i = (y * img.w + x) * 3;
			const R = img.rgb[i]!;
			const G = img.rgb[i + 1]!;
			const B = img.rgb[i + 2]!;
			if (!(R > 180 && B > 180 && G < 90)) continue;
			n++;
			const cx = x + 0.5;
			const cy = y + 0.5;
			if (cx + cy < best[0]!.v) best[0] = { v: cx + cy, p: [cx, cy] };
			if (cx - cy > best[1]!.v) best[1] = { v: cx - cy, p: [cx, cy] };
			if (cx + cy > best[2]!.v) best[2] = { v: cx + cy, p: [cx, cy] };
			if (cx - cy < best[3]!.v) best[3] = { v: cx - cy, p: [cx, cy] };
		}
	if (n < 100) throw new Error('no pinned overlay found in the frame');
	return best.map((b) => b.p);
}

const available = existsSync(PLATE) && existsSync(TRUTH);

beforeAll(async () => {
	if (!available) {
		const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
		if (r.status !== 0) throw new Error('fixture generation failed');
	}
	appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-track-'));
	const token = randomBytes(16).toString('hex');
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{ cwd: ROOT, env: cleanEnv({ JASPER_LOCAL_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] },
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
	client = new Client({ name: 'vitest-mcp-tracking', version: '1.0.0' });
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

describe('tracking tools (S09:TRA-001/002, §8 item 7)', () => {
	it('add_tracker + track + apply_tracking + render_frame pins the overlay within 3 px of the ground truth', async () => {
		const truth = JSON.parse(readFileSync(TRUTH, 'utf8')) as Truth;
		const { projectId } = await ok<{ projectId: string }>('create_project', { name: 'Tracking' });
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
				{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V2', color: [1, 0, 1, 1], ref: '$target' },
			],
		});
		const plateId = placed.refs.$plate!;
		const targetId = placed.refs.$target!;

		const added = await ok<{ trackerId: string }>('add_tracker', {
			projectId,
			clipId: plateId,
			kind: 'planar',
			at: truth.reference.frame,
			corners: truth.reference.corners,
		});
		expect(added.trackerId).toMatch(/^tkr_/);
		const tracked = await ok<{ meanConfidence: number; trackedSourceFrames: { start: number; end: number } }>(
			'track',
			{ projectId, trackerId: added.trackerId },
		);
		expect(tracked.trackedSourceFrames).toEqual({ start: 0, end: 150 });
		expect(tracked.meanConfidence).toBeGreaterThan(0.5);
		const info = await ok<{ at: { frame: number; corners: [number, number][] }[] }>('get_tracker', {
			projectId,
			trackerId: added.trackerId,
			frames: [20, 130],
		});
		for (const a of info.at)
			for (let k = 0; k < 4; k++) {
				expect(Math.abs(a.corners[k]![0] - truth.corners[a.frame]![k]![0])).toBeLessThan(4);
				expect(Math.abs(a.corners[k]![1] - truth.corners[a.frame]![k]![1])).toBeLessThan(4);
			}
		await ok('apply_tracking', {
			projectId,
			trackerId: added.trackerId,
			targetClipId: targetId,
			mode: 'corner-pin',
		});
		// S09:TRK-023 / TRA-003: simplify the 150 per-frame keys of each corner (dry run first, then for real).
		type Simplified = {
			keyframesBefore: number;
			keyframesAfter: number;
			maxDeviation: number;
			dryRun?: boolean;
		};
		const dry = await ok<Simplified>('simplify_keyframes', {
			projectId,
			trackerId: added.trackerId,
			tolerance: 0.25,
			dryRun: true,
		});
		expect(dry.dryRun).toBe(true);
		expect(dry.keyframesBefore).toBe(4 * 150);
		expect(dry.keyframesAfter).toBeLessThan(dry.keyframesBefore);
		expect(dry.maxDeviation).toBeLessThanOrEqual(0.25);
		const done = await ok<Simplified>('simplify_keyframes', {
			projectId,
			clipId: targetId,
			trackedOnly: true,
			tolerance: 0.25,
		});
		expect(done.keyframesAfter).toBe(dry.keyframesAfter);

		const width = 1280;
		const s = width / 1920;
		for (const frame of [20, 75, 130]) {
			const r = (await client.callTool(
				{ name: 'render_frame', arguments: { projectId, at: frame, width } },
				undefined,
				{ timeout: 600_000 },
			)) as CallToolResult;
			expect(r.isError, textOf(r)).toBeFalsy();
			const img = r.content.find((c) => c.type === 'image') as { data: string };
			const png = Buffer.from(img.data, 'base64');
			const artifacts = join(ROOT, 'test-results', 'mcp');
			mkdirSync(artifacts, { recursive: true });
			writeFileSync(join(artifacts, `tracking-${frame}.png`), png);
			const got = magentaCorners(decodePng(png));
			const want = truth.corners[frame]!.map(([x, y]) => [x * s, y * s]);
			for (let k = 0; k < 4; k++) {
				const d = Math.hypot(got[k]![0] - want[k]![0]!, got[k]![1] - want[k]![1]!);
				expect(d, `frame ${frame} corner ${k}: got ${got[k]} want ${want[k]}`).toBeLessThan(3);
			}
		}
	}, 900_000);

	it('set_corner_pin places corners in sequence pixels', async () => {
		const { projectId } = await ok<{ projectId: string }>('create_project', { name: 'Pin' });
		const solid = await ok<{ refs: Record<string, string> }>('apply_commands', {
			projectId,
			label: 'Solid',
			commands: [{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 1, 1], ref: '$s' }],
		});
		const clipId = solid.refs.$s!;
		const r = await ok<{ normalizedCorners: [number, number][] }>('set_corner_pin', {
			projectId,
			clipId,
			corners: [
				[192, 108],
				[1728, 216],
				[1536, 972],
				[384, 864],
			],
		});
		expect(r.normalizedCorners[0]).toEqual([0.1, 0.1]);
		expect(r.normalizedCorners[2]).toEqual([0.8, 0.9]);
	});
});
