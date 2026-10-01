// Colour-grading MCP tools (S06:CGA-001…003, S06 §9 test 8). Units: the grade_clip input schema and its
// clamping to the registry ranges, LUT resolution, keyframe re-timing and the copy_grade plan. Integration: a
// real engine (token mode, own temp appdir and port) with the MCP server in-process: import_lut + grade_clip +
// render_frame produce a graded PNG and exactly one "Agent: Grade clip" change; get_grade, copy_grade, the
// keyframed-param policy and the line-numbered error of a broken .cube.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyTransaction,
	type Clip,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	type EffectInstance,
	EMPTY_PROBE,
	flicksPerFrame,
	LUMETRI_PARAMS,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolError } from '../src/errors.ts';
import { FixedEngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import {
	COLOR_GUIDE,
	GRADE_FIELDS,
	GradeClipSchema,
	normalizeGrade,
	planCopyGrade,
	rangeText,
	resolveLutRefs,
	retimeKeyframes,
} from '../src/tools/color.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');

// ---------------------------------------------------------------- units

describe('grade_clip input (units)', () => {
	it('maps every Lumetri param exactly once and describes the registry ranges', () => {
		expect(GRADE_FIELDS.map((f) => f.param).sort()).toEqual(LUMETRI_PARAMS.map((p) => p.name).sort());
		const exposure = LUMETRI_PARAMS.find((p) => p.name === 'exposure')!;
		expect(rangeText(exposure)).toBe('-5…5, default 0');
		const json = JSON.stringify(z.toJSONSchema(GradeClipSchema, { io: 'input' }));
		expect(json).toContain('-5…5, default 0');
		expect(json).toContain('0…200 %, default 100');
		expect(COLOR_GUIDE).toMatch(/input LUT.*white balance.*exposure.*look LUT.*curves.*wheels/s);
	});

	it('rejects unknown fields and malformed curves/wheels; accepts nulls for LUTs and curves', () => {
		const base = { projectId: 'prj_1', clipId: 'clp_1' };
		expect(GradeClipSchema.safeParse({ ...base, basic: { exposre: 1 } }).success).toBe(false);
		expect(GradeClipSchema.safeParse({ ...base, curves: { master: [[0, 0]] } }).success).toBe(false);
		expect(GradeClipSchema.safeParse({ ...base, wheels: { shadows: [1, 2, 3] } }).success).toBe(false);
		expect(GradeClipSchema.safeParse({ ...base, instance: 'last' }).success).toBe(false);
		expect(
			GradeClipSchema.safeParse({
				...base,
				basic: { inputLut: null, exposure: 1 },
				creative: { look: 'med_1', intensity: 50 },
				curves: { red: null },
				wheels: { midtones: [0.1, -0.2], midtonesLevel: 10 },
				instance: 'new',
				at: { seconds: 1 },
			}).success,
		).toBe(true);
	});

	it('clamps to the registry ranges and reports what was clamped', () => {
		const { params, clamped } = normalizeGrade({
			basic: { exposure: 9, saturation: -5, temperature: 20, inputLut: null },
			creative: { intensity: 150, look: 'Warm' },
			curves: {
				master: [
					[1.2, 1],
					[0, -0.1],
					[0.5, 0.6],
				],
				blue: null,
			},
			wheels: { shadows: [3, 4], highlights: [0.2, 0.1], highlightsLevel: -300 },
		});
		expect(params).toMatchObject({
			exposure: 5,
			saturation: 0,
			temperature: 20,
			lookIntensity: 100,
			inputLut: { lutRef: null },
			look: { lutRef: 'Warm' },
			curveMaster: {
				curve: [
					[0, 0],
					[0.5, 0.6],
					[1, 1],
				],
			},
			curveBlue: {
				curve: [
					[0, 0],
					[1, 1],
				],
			},
			shadowsWheel: [0.6, 0.8],
			highlightsWheel: [0.2, 0.1],
			highlightsLevel: -100,
		});
		expect(clamped.map((c) => c.field).sort()).toEqual(
			[
				'basic.exposure',
				'basic.saturation',
				'creative.intensity',
				'curves.master',
				'wheels.highlightsLevel',
				'wheels.shadows',
			].sort(),
		);
		expect(clamped.find((c) => c.field === 'basic.exposure')).toEqual({
			field: 'basic.exposure',
			given: 9,
			applied: 5,
		});
		expect(() =>
			normalizeGrade({
				curves: {
					red: [
						[0.5, 0],
						[0.5, 1],
					],
				},
			}),
		).toThrow(ToolError);
	});
});

function unitDoc() {
	const ids = createSeededIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Colour unit', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => '2026-10-01T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
	const tx = (commands: unknown[]) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', label: 't', origin: 'user', commands } as never,
			ctx,
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
		return r.result;
	};
	return {
		tx,
		get doc() {
			return doc;
		},
	};
}

const clipOf = (doc: ProjectDocument, id: string) =>
	Object.values(doc.sequences)
		.map((s) => s.clips[id])
		.find(Boolean) as Clip & { effects?: EffectInstance[] };

describe('LUT references and copy_grade plan (units)', () => {
	it('resolves LUTs by id or name and refuses non-LUT media', () => {
		const u = unitDoc();
		u.tx([
			{
				type: 'media.register',
				asset: {
					kind: 'lut',
					fingerprint: 'fp-lut',
					originalName: 'warm.cube',
					sizeBytes: 10,
					container: 'cube',
					probe: EMPTY_PROBE,
					locators: [{ type: 'engine-store', engineId: 'local', key: 'lutkey' }],
					lut: {
						format: 'cube',
						dimensions: 3,
						size: 33,
						title: 'Warm',
						domainMin: [0, 0, 0],
						domainMax: [1, 1, 1],
					},
				},
				ref: '$m',
				itemRef: '$i',
			},
		]);
		const lutId = Object.keys(u.doc.media)[0]!;
		expect(
			resolveLutRefs(u.doc, { look: { lutRef: 'warm.cube' }, inputLut: { lutRef: null }, exposure: 1 }),
		).toEqual({
			look: { mediaId: lutId },
			inputLut: { mediaId: '' },
			exposure: 1,
		});
		expect(resolveLutRefs(u.doc, { look: { lutRef: lutId } })).toEqual({ look: { mediaId: lutId } });
		expect(() => resolveLutRefs(u.doc, { look: { lutRef: 'nope.cube' } })).toThrow(/No LUT/);
	});

	it('re-times keyframes to keep their offset from the clip start', () => {
		const rate = { num: 30, den: 1 };
		const F = flicksPerFrame(rate);
		const fwd = (sourceIn: number, start: number) => ({
			start,
			duration: 60,
			sourceIn,
			speed: { rate: 1, reverse: false },
		});
		const kf = (frame: number, value: number, sourceIn = 0) => ({
			id: `kf_${frame}`,
			time: sourceIn + frame * F,
			value,
			interpolation: 'linear' as const,
			easeIn: { influence: 1 / 3, slope: 1 },
			easeOut: { influence: 1 / 3, slope: 1 },
		});
		const out = retimeKeyframes([kf(0, 0, 90 * F), kf(10, 1, 90 * F)], fwd(90 * F, 0), fwd(5 * F, 200), rate);
		expect(out.map((k) => k.time)).toEqual([5 * F, 15 * F]);
		expect(out.map((k) => k.value)).toEqual([0, 1]);
		// A reversed target: frame offset 0 is its last source frame.
		const rev = { ...fwd(0, 0), speed: { rate: 1, reverse: true } };
		expect(retimeKeyframes([kf(0, 0)], fwd(0, 0), rev, rate)[0]!.time).toBe(59 * F);
	});

	it('replaces the colour effects of the targets, keeps other effects and applies in one transaction', () => {
		const u = unitDoc();
		const a = u.tx([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'A' }, ref: '$a' },
		]).refs.$a!;
		const b = u.tx([
			{ type: 'clip.addText', at: 100, duration: 60, track: 'V1', content: { text: 'B' }, ref: '$b' },
		]).refs.$b!;
		u.tx([
			{
				type: 'effect.add',
				target: { clipId: a },
				effectId: 'jasper.lumetri',
				params: { exposure: 1 },
				ref: '$l',
			},
			{
				type: 'param.setAnimated',
				target: ['effect', '$l', 'temperature'],
				animated: true,
				at: { frames: 0 },
			},
			{ type: 'param.set', target: ['effect', '$l', 'temperature'], value: 50, at: { frames: 30 } },
			{
				type: 'effect.add',
				target: { clipId: a },
				effectId: 'jasper.black-white',
				params: { amount: 40 },
				ref: '$bw',
			},
			{ type: 'effect.setEnabled', effectInstanceId: '$bw', enabled: false },
			{ type: 'effect.add', target: { clipId: b }, effectId: 'jasper.gaussian-blur' },
			{ type: 'effect.add', target: { clipId: b }, effectId: 'jasper.hue-saturation', params: { hue: 30 } },
		]);
		const plan = planCopyGrade(u.doc, a, [b, b]);
		expect(plan.removed).toBe(1);
		expect(plan.refs.map((r) => r.effectId)).toEqual(['jasper.lumetri', 'jasper.black-white']);
		u.tx(plan.commands);
		const fx = clipOf(u.doc, b).effects!;
		expect(fx.map((e) => e.effectId)).toEqual([
			'jasper.gaussian-blur',
			'jasper.lumetri',
			'jasper.black-white',
		]);
		expect(fx[1]!.params.exposure).toMatchObject({ value: 1 });
		expect(fx[2]!.enabled).toBe(false);
		const src = clipOf(u.doc, a).effects!;
		expect(fx[1]!.id).not.toBe(src[0]!.id);
		// Text clips have content time = frames since the clip start: keyframes keep their offsets.
		expect(fx[1]!.params.temperature!.keyframes.map((k) => k.time)).toEqual(
			src[0]!.params.temperature!.keyframes.map((k) => k.time),
		);
		expect(fx[1]!.params.temperature!.keyframes.map((k) => k.value)).toEqual([0, 50]);
		expect(() => planCopyGrade(u.doc, a, [a])).toThrow(/source clip/);
		const c = u.tx([
			{ type: 'clip.addText', at: 300, duration: 30, track: 'V1', content: { text: 'C' }, ref: '$c' },
		]).refs.$c!;
		expect(() => planCopyGrade(u.doc, c, [a])).toThrow(/no colour effects/);
	});
});

// ---------------------------------------------------------------- integration (real engine)

const PORT = Number(process.env.MCP_COLOR_TEST_PORT ?? 48587);
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

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) out[k] = v;
	return { ...out, ...extra };
}

/** RGB24 pixels of a PNG (decoded by ffmpeg). */
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
async function frameAt(projectId: string, frame: number): Promise<Buffer> {
	const r = await call('render_frame', { projectId, at: frame, width: 320 });
	expect(r.isError, textOf(r)).toBeFalsy();
	const img = r.content.find((c) => c.type === 'image') as { data: string };
	return pngPixels(Buffer.from(img.data, 'base64'));
}

describe('colour tools against a real engine (S06 §9 test 8)', () => {
	beforeAll(async () => {
		ensureFixtures();
		appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-color-'));
		token = randomBytes(16).toString('hex');
		engine = spawn(
			process.execPath,
			['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
			{ cwd: ROOT, env: cleanEnv({ JASPER_LOCAL_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] },
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
			agentName: 'color-test',
		});
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		client = new Client({ name: 'color-test', version: '1' });
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
	let lutId = '';
	let gradeFx = '';

	it('advertises the colour tools with ranges and the order of operations', async () => {
		const { tools } = await client.listTools();
		for (const n of ['import_lut', 'grade_clip', 'get_grade', 'copy_grade'])
			expect(tools.map((t) => t.name)).toContain(n);
		const grade = tools.find((t) => t.name === 'grade_clip')!;
		expect(grade.description).toMatch(/exposure -5…5/);
		expect(grade.description).toMatch(/1 input LUT, 2 white balance/);
		expect(client.getInstructions()).toContain('Colour grading');
	});

	it('imports a .cube LUT and reports the broken one with its line number', async () => {
		const p = await ok<{ projectId: string }>('create_project', { name: 'Colour MCP' });
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

		const lut = await ok<{ mediaId: string; size: number; title: string; dimensions: number }>('import_lut', {
			projectId,
			path: join(FIXTURES, 'look-33.cube'),
		});
		expect(lut).toMatchObject({ size: 33, dimensions: 3, title: 'Warm Teal 33' });
		expect(lut.mediaId).toMatch(/^med_/);
		lutId = lut.mediaId;

		const bad = await fails('import_lut', { projectId, path: join(FIXTURES, 'broken-number.cube') });
		expect(bad.code).toBe('INVALID_LUT');
		expect(bad.message).toMatch(/line \d+/i);
		expect((await fails('import_lut', { projectId, path: 'relative.cube' })).code).toBe('NOT_ABSOLUTE');
		expect((await fails('import_lut', { projectId, path: join(FIXTURES, 'still.png') })).code).toBe(
			'NOT_A_LUT',
		);
	});

	it('grade_clip grades in one "Agent: Grade clip" change and render_frame shows it', async () => {
		const before = await frameAt(projectId, 30);
		let res: Record<string, unknown> = {};
		const changes = await docChangedDuring(token, projectId, async () => {
			res = await ok('grade_clip', {
				projectId,
				clipId: clipA,
				basic: { exposure: 0.8, temperature: 40, contrast: 20, saturation: 140 },
				creative: { look: lutId, intensity: 80 },
				curves: {
					master: [
						[0, 0.05],
						[0.5, 0.55],
						[1, 1],
					],
				},
				wheels: { shadows: [0.4, 0], highlightsLevel: 10 },
			});
		});
		expect(changes.map((e) => e.payload.label)).toEqual(['Agent: Grade clip']);
		expect(res).toMatchObject({
			ok: true,
			created: true,
			appliedBy: 'headless',
			applied: {
				basic: { exposure: 0.8, temperature: 40, contrast: 20, saturation: 140 },
				creative: { look: lutId, intensity: 80 },
				wheels: { shadows: [0.4, 0], highlightsLevel: 10 },
			},
		});
		expect(res.clamped).toBeUndefined();
		gradeFx = res.effectInstanceId as string;
		expect(gradeFx).toMatch(/^fx_/);

		const after = await frameAt(projectId, 30);
		expect(meanAbsDiff(before, after)).toBeGreaterThan(8);

		// A second call edits the same instance (one change again) and clamps out-of-range values.
		const changes2 = await docChangedDuring(token, projectId, async () => {
			res = await ok('grade_clip', { projectId, clipId: clipA, basic: { exposure: 12 } });
		});
		expect(changes2.map((e) => e.payload.label)).toEqual(['Agent: Grade clip']);
		expect(res).toMatchObject({
			effectInstanceId: gradeFx,
			created: false,
			applied: { basic: { exposure: 5 } },
			clamped: [{ field: 'basic.exposure', given: 12, applied: 5 }],
		});
		await ok('grade_clip', { projectId, clipId: clipA, basic: { exposure: 0.8 } });
		expect(
			(await fails('grade_clip', { projectId, clipId: clipA, creative: { look: 'nope.cube' } })).code,
		).toBe('E_NOT_FOUND');
	});

	it('get_grade returns the evaluated values and LUT names', async () => {
		const g = await ok<{
			evaluatedAt: string;
			frame: number;
			effects: {
				effectInstanceId: string;
				effectId: string;
				basic: Record<string, unknown>;
				creative: Record<string, unknown>;
				curves: Record<string, unknown>;
				wheels: Record<string, unknown>;
				luts: { param: string; mediaId: string; name: string; title: string; size: number }[];
			}[];
		}>('get_grade', { projectId, clipId: clipA });
		expect(g.evaluatedAt).toBe('clip-start');
		expect(g.effects).toHaveLength(1);
		const fx = g.effects[0]!;
		expect(fx).toMatchObject({
			effectInstanceId: gradeFx,
			effectId: 'jasper.lumetri',
			basic: { exposure: 0.8, temperature: 40, tint: 0, saturation: 140, inputLut: null },
			creative: { look: lutId, intensity: 80, vibrance: 0 },
			curves: {
				master: [
					[0, 0.05],
					[0.5, 0.55],
					[1, 1],
				],
				red: [
					[0, 0],
					[1, 1],
				],
			},
			wheels: { shadows: [0.4, 0], midtones: [0, 0], highlightsLevel: 10 },
		});
		expect(fx.luts).toEqual([
			{ param: 'look', mediaId: lutId, name: 'look-33.cube', title: 'Warm Teal 33', size: 33 },
		]);
	});

	it('keyframed params need a time: rejected without one, keyed at `at`', async () => {
		await ok('apply_commands', {
			projectId,
			label: 'Animate temperature',
			commands: [
				{
					type: 'param.setAnimated',
					target: ['effect', gradeFx, 'temperature'],
					animated: true,
					at: { frames: 0 },
				},
			],
		});
		const e = await fails('grade_clip', { projectId, clipId: clipA, basic: { temperature: -30 } });
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toMatch(/temperature is keyframed/);
		expect(e.hint).toMatch(/"at"/);
		expect(
			(await fails('grade_clip', { projectId, clipId: clipA, basic: { temperature: -30 }, at: 400 })).message,
		).toMatch(/outside the clip/);
		const r = await ok<{ keyframed: { params: string[]; frame: number } }>('grade_clip', {
			projectId,
			clipId: clipA,
			basic: { temperature: -30 },
			at: 60,
		});
		expect(r.keyframed).toMatchObject({ params: ['temperature'], frame: 60 });
		const g = await ok<{ effects: { basic: { temperature: number }; keyframed: string[] }[] }>('get_grade', {
			projectId,
			clipId: clipA,
			at: 60,
		});
		expect(g.effects[0]!.basic.temperature).toBe(-30);
		expect(g.effects[0]!.keyframed).toEqual(['temperature']);
		const g0 = await ok<{ effects: { basic: { temperature: number } }[] }>('get_grade', {
			projectId,
			clipId: clipA,
			at: 0,
		});
		expect(g0.effects[0]!.basic.temperature).toBe(40);
	});

	it('instance "new" stacks a second Lumetri; copy_grade replaces the target grade in one change', async () => {
		await ok('apply_commands', {
			projectId,
			label: 'Old grade on B',
			commands: [{ type: 'effect.add', target: { clipId: clipB }, effectId: 'jasper.black-white' }],
		});
		const stacked = await ok<{ effectInstanceId: string; created: boolean }>('grade_clip', {
			projectId,
			clipId: clipA,
			instance: 'new',
			basic: { tint: 10 },
		});
		expect(stacked.created).toBe(true);
		expect(stacked.effectInstanceId).not.toBe(gradeFx);

		const beforeB = await frameAt(projectId, 330);
		let res: {
			targets: { clipId: string; effects: { effectInstanceId: string; effectId: string }[] }[];
			replacedEffects: number;
		} = {
			targets: [],
			replacedEffects: 0,
		};
		const changes = await docChangedDuring(token, projectId, async () => {
			res = await ok('copy_grade', { projectId, fromClipId: clipA, toClipIds: [clipB] });
		});
		expect(changes).toHaveLength(1);
		expect(res.replacedEffects).toBe(1);
		expect(res.targets).toEqual([
			{
				clipId: clipB,
				effects: [
					{ effectInstanceId: expect.stringMatching(/^fx_/), effectId: 'jasper.lumetri' },
					{ effectInstanceId: expect.stringMatching(/^fx_/), effectId: 'jasper.lumetri' },
				],
			},
		]);
		const g = await ok<{
			effects: {
				effectId: string;
				effectInstanceId: string;
				basic: Record<string, unknown>;
				keyframed?: string[];
			}[];
		}>('get_grade', { projectId, clipId: clipB });
		expect(g.effects.map((e) => e.effectId)).toEqual(['jasper.lumetri', 'jasper.lumetri']);
		expect(g.effects[0]!.effectInstanceId).not.toBe(gradeFx);
		expect(g.effects[0]!.basic).toMatchObject({ exposure: 0.8, saturation: 140, temperature: 40 });
		expect(g.effects[0]!.keyframed).toEqual(['temperature']);
		expect(g.effects[1]!.basic).toMatchObject({ tint: 10 });
		const afterB = await frameAt(projectId, 330);
		expect(meanAbsDiff(beforeB, afterB)).toBeGreaterThan(8);
	});
});
