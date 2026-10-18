import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoToneResponseSchema, ColorMatchResponseSchema, GradingScopesResponseSchema } from '@jasper/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FixedEngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { cleanEnv, testPort } from './helpers.ts';

const ScopeSummarySchema = GradingScopesResponseSchema.required({
	waveform: true,
	histogram: true,
	vectorscopeYuv: true,
}).extend({ stats: GradingScopesResponseSchema.shape.stats.unwrap() });
const HistogramSummarySchema = GradingScopesResponseSchema.required({ histogram: true });
const ColorMatchReportSchema = ColorMatchResponseSchema.pick({ params: true, skin: true }).extend({
	applied: z.boolean(),
	statisticsDistance: ColorMatchResponseSchema.pick({ before: true, after: true }),
});
const AutoToneReportSchema = z.object({
	params: AutoToneResponseSchema.shape.params.omit({ saturation: true }).strict(),
	lumaQuantiles: AutoToneResponseSchema.pick({ before: true, after: true }),
});

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');

const PORT = await testPort(process.env.MCP_GRADING_TEST_PORT);
const URL_BASE = `http://127.0.0.1:${PORT}`;

function ensureFixtures(): void {
	if (
		['clip-a.mp4', 'clip-b.mp4', 'look-33.cube', 'broken-number.cube'].every((n) =>
			existsSync(join(FIXTURES, n)),
		)
	)
		return;
	const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	if (r.status !== 0) throw new Error('fixture generation failed');
}

function pngPixels(png: Buffer): Buffer {
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
		{
			input: png,
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (r.status !== 0) throw new Error(`ffmpeg could not decode the PNG: ${r.stderr}`);
	return r.stdout;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
	expect(a.length).toBe(b.length);
	let s = 0;
	for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
	return s / a.length;
}

/** doc.changed events of a project while `fn` runs (engine NDJSON /events stream). */
async function docChangedDuring(token: string, projectId: string, fn: () => Promise<unknown>) {
	const ac = new AbortController();
	const res = await fetch(`${URL_BASE}/events?projectId=${projectId}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: ac.signal,
	});
	const reader = res.body!.getReader();
	const events: { type: string; payload: { label?: string; revision?: number } }[] = [];
	let buf = '';
	let ready!: () => void;
	const opened = new Promise<void>((r) => {
		ready = r;
	});
	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buf += Buffer.from(value).toString('utf8');
				let i = buf.indexOf('\n');
				while (i >= 0) {
					const line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					if (line.trim()) {
						const e = JSON.parse(line);
						if (e.type === 'engine.heartbeat') ready();
						else events.push(e);
					}
					i = buf.indexOf('\n');
				}
			}
		} catch {
			// aborted
		}
	})();
	await Promise.race([
		opened,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`no /events stream (HTTP ${res.status})`)), 15_000),
		),
	]);
	await fn();
	await new Promise((r) => setTimeout(r, 500));
	ac.abort();
	await pump;
	return events.filter((e) => e.type === 'doc.changed');
}

let engine: ChildProcess | null = null;
let appdir = '';
let token = '';
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 300_000,
	})) as CallToolResult;
}
const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
	return JSON.parse(textOf(r)) as T;
}
async function fails(name: string, args: Record<string, unknown>) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${textOf(r)}`).toBe(true);
	return (JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string } }).error;
}
async function frameAt(projectId: string, frame: number, artifact?: string): Promise<Buffer> {
	const r = await call('render_frame', { projectId, at: frame, width: 320 });
	expect(r.isError, textOf(r)).toBeFalsy();
	const img = r.content.find((c) => c.type === 'image') as { data: string };
	const png = Buffer.from(img.data, 'base64');
	if (artifact) {
		const artifacts = join(ROOT, 'test-results', 'mcp');
		mkdirSync(artifacts, { recursive: true });
		writeFileSync(join(artifacts, artifact), png);
	}
	return pngPixels(png);
}

describe('grading tools against a real engine (color-grade)', () => {
	beforeAll(async () => {
		ensureFixtures();
		appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-grading-'));
		token = randomBytes(16).toString('hex');
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
		const log: string[] = [];
		engine.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
		engine.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
		const until = Date.now() + 120_000;
		for (;;) {
			const up = await fetch(`${URL_BASE}/health`)
				.then((r) => r.ok)
				.catch(() => false);
			if (up) break;
			if (Date.now() > until || engine.exitCode !== null)
				throw new Error(`engine did not start: ${log.join('')}`);
			await new Promise((r) => setTimeout(r, 250));
		}
		const { server } = createJasperMcpServer({
			link: new FixedEngineLink(URL_BASE, token),
			agentName: 'grading-test',
		});
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		client = new Client({ name: 'grading-test', version: '1' });
		await client.connect(b);
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

	let projectId = '';
	let clipA = '';
	let clipB = '';

	it('sets every new Lumetri section in one change; get_grade reads them back', async () => {
		const p = await ok<{ projectId: string }>('create_project', { name: 'Grading MCP' });
		projectId = p.projectId;
		const media = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [join(FIXTURES, 'clip-a.mp4'), join(FIXTURES, 'clip-b.mp4')],
		});
		const placeA = await ok<{ clips: { id: string; kind: string }[] }>('add_clip', {
			projectId,
			media: media.imported[0]!.mediaId,
			at: 0,
			videoOnly: true,
		});
		clipA = placeA.clips.find((c) => c.kind === 'video')!.id;
		const placeB = await ok<{ clips: { id: string; kind: string }[] }>('add_clip', {
			projectId,
			media: media.imported[1]!.mediaId,
			at: 300,
			videoOnly: true,
		});
		clipB = placeB.clips.find((c) => c.kind === 'video')!.id;
		let res: Record<string, unknown> = {};
		const changes = await docChangedDuring(token, projectId, async () => {
			res = await ok('grade_clip', {
				projectId,
				clipId: clipB,
				creative: { builtInLook: 'teal-orange', fadedFilm: 20, shadowTint: [0.3, 0.1], tintBalance: 10 },
				curves: {
					hueVsSat: [
						[0, 0.7],
						[0.5, 0.5],
					],
				},
				secondary: { hueCenter: 30, hueRange: 20, hueSoftness: 15, saturation: 140 },
				vignette: { amount: -2, feather: 60 },
				sections: { wheels: false },
			});
		});
		expect(changes).toHaveLength(1);
		expect(res.applied).toMatchObject({
			creative: { builtInLook: 'teal-orange', fadedFilm: 20 },
			vignette: { amount: -2, feather: 60 },
			sections: { wheels: false },
		});
		const g = await ok<{ effects: Record<string, Record<string, unknown>>[] }>('get_grade', {
			projectId,
			clipId: clipB,
			at: 330,
		});
		expect(g.effects[0]!.secondary).toMatchObject({ hueCenter: 30, hueRange: 20, saturation: 140 });
		expect(g.effects[0]!.vignette).toMatchObject({ amount: -2 });
		const bad = await fails('grade_clip', { projectId, clipId: clipB, creative: { builtInLook: 'nope' } });
		expect(bad.code).toBe('E_INVALID_ARGUMENT');
	});

	it('the spatial stage (vignette, HSL Secondary) renders: render_frame changes when the vignette is switched off', async () => {
		const withVignette = await frameAt(projectId, 330, 'grading-vignette.png');
		await ok('grade_clip', { projectId, clipId: clipB, sections: { vignette: false } });
		const without = await frameAt(projectId, 330, 'grading-no-vignette.png');
		expect(meanAbsDiff(withVignette, without)).toBeGreaterThan(1.5);
		await ok('grade_clip', { projectId, clipId: clipB, sections: { vignette: true } });
	}, 600_000);

	it('list_looks lists the built-in looks', async () => {
		const r = await ok<{ looks: { id: string }[] }>('list_looks');
		expect(r.looks.length).toBeGreaterThanOrEqual(16);
		expect(r.looks.map((l) => l.id)).toContain('bleach-bypass');
	});

	it('scopes_read measures a frame as numbers (and one clip alone)', async () => {
		const r = ScopeSummarySchema.parse(await ok('scopes_read', { projectId, at: 30, columns: 4, peaks: 3 }));
		expect(r.stats.samples).toBeGreaterThan(1000);
		expect(r.waveform.traces.R).toHaveLength(4);
		expect(r.vectorscopeYuv.peaks).toHaveLength(3);
		expect(r.histogram.r).toBeUndefined();
		const c = HistogramSummarySchema.parse(
			await ok('scopes_read', {
				projectId,
				clipId: clipA,
				scopes: ['histogram'],
				bins: true,
			}),
		);
		expect(c.clipId).toBe(clipA);
		expect(c.histogram.r).toHaveLength(256);
	});

	it('color_match solves clip A towards a frame of clip B in one Apply Match change', async () => {
		let body: Record<string, unknown> = {};
		const changes = await docChangedDuring(token, projectId, async () => {
			body = await ok('color_match', { projectId, clipId: clipA, at: 30, reference: { at: 330 } });
		});
		const res = ColorMatchReportSchema.parse(body);
		expect(changes).toHaveLength(1);
		expect(changes[0]!.payload.label).toMatch(/Apply Match/);
		expect(res.applied).toBe(true);
		expect(res.statisticsDistance.after).toBeLessThan(res.statisticsDistance.before);
		expect(res.skin).toMatch(/hue|faces/);
		const g = await ok<{ effects: Record<string, Record<string, unknown>>[] }>('get_grade', {
			projectId,
			clipId: clipA,
			at: 30,
		});
		expect(g.effects[0]!.wheels).toMatchObject({ midtonesLevel: res.params.midtonesLevel });
		const dry = ColorMatchReportSchema.parse(
			await ok('color_match', {
				projectId,
				clipId: clipA,
				at: 30,
				reference: { at: 330 },
				faceDetection: false,
				apply: false,
			}),
		);
		expect(dry.applied).toBe(false);
		expect(dry.skin).toBe('off');
		expect(
			(await fails('color_match', { projectId, clipId: clipA, at: 400, reference: { at: 330 } })).code,
		).toBe('E_INVALID_PARAM');
	});

	it('auto_tone writes the tone sliders (one change)', async () => {
		let body: Record<string, unknown> = {};
		const changes = await docChangedDuring(token, projectId, async () => {
			body = await ok('auto_tone', { projectId, clipId: clipA, at: 30 });
		});
		const res = AutoToneReportSchema.parse(body);
		expect(changes).toHaveLength(1);
		expect(Object.keys(res.params).sort()).toEqual([
			'blacks',
			'contrast',
			'exposure',
			'highlights',
			'shadows',
			'whites',
		]);
		expect(res.lumaQuantiles.after).toHaveLength(5);
	});
});
