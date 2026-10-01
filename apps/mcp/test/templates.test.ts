// wp-m2-anime-templates (S11:ANA-003, ANA-005) without a real engine: an in-memory MCP client talks to the
// server whose engine is a fake (catalogue, documents applied with @jasper/project, stills, capabilities).
// Covers list_motion_templates (renderer, native, params summary), the anime branch of
// render_motion_graphic_preview (one-clip envelope → requestStill → PNG), set_motion_graphic_params (static and
// keyframe commands, validation) and the render-failure hints of render_frame / start_export / wait_for_job.
import type { EngineJob, MgTemplateCatalogEntry, MgTemplatesResponse } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createEmptyProject,
	createSeededIdSource,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	type MotionGraphicClip,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REMOTION_HINT, renderHint, TEMPLATE_NOT_INSTALLED_HINT } from '../src/errors.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import {
	animePreviewDocument,
	paramsSummary,
	planParamCommands,
	previewFrames,
	previewPhases,
	TEMPLATES_GUIDE,
} from '../src/tools/templates.ts';

// ---------------------------------------------------------------- fixtures

const titleParams = z.strictObject({
	title: z.string().max(120).default('Title Reveal'),
	titleColor: z.array(z.number().min(0).max(1)).length(4).default([1, 1, 1, 1]),
	titleSize: z.number().min(24).max(240).default(110),
	lines: z.number().int().min(0).max(6).default(1),
	alignment: z.enum(['left', 'center', 'right']).default('center'),
	underline: z.boolean().default(true),
});
const lowerParams = z.strictObject({
	name: z.string().max(60).default('Name'),
	accent: z.array(z.number().min(0).max(1)).length(4).default([1, 0, 0, 1]),
	size: z.number().min(10).max(200).default(40),
});
const jsonSchema = (s: z.ZodType) =>
	z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;

const ANIME: MgTemplateCatalogEntry = {
	id: 'title-reveal',
	version: 1,
	name: 'Title Reveal',
	category: 'Titles',
	paramsSchema: jsonSchema(titleParams),
	defaults: titleParams.parse({}),
	introFrames: 36,
	outroFrames: 18,
	defaultDurationSeconds: 5,
	description: 'Characters rise in one by one.',
	canvases: ['1920x1080'],
	native: false,
	renderer: 'anime',
};
const FFRAMES: MgTemplateCatalogEntry = {
	id: 'lower-third',
	version: 1,
	name: 'Lower Third',
	category: 'Lower thirds',
	paramsSchema: jsonSchema(lowerParams),
	defaults: lowerParams.parse({}),
	canvases: ['1920x1080'],
	native: true,
};

const infoOf = (t: MgTemplateCatalogEntry, schema: z.ZodType): MgTemplateInfo => ({
	id: t.id,
	version: t.version,
	name: t.name,
	category: t.category,
	paramsSchema: schema,
	defaults: t.defaults,
	introFrames: t.introFrames ?? 0,
	outroFrames: t.outroFrames ?? 0,
	canvasDefault: 'sequence',
	...(t.renderer ? { renderer: t.renderer } : {}),
});
const registries = defaultRegistries(
	createStaticMgRegistry([infoOf(ANIME, titleParams), infoOf(FFRAMES, lowerParams)]),
);

/** A 1080p30 project with an anime clip (frames 30–180) and an fframes clip (0–150). */
function projectDoc() {
	const ids = createSeededIdSource(7);
	const doc = createEmptyProject({ ids, name: 'Templates', preset: 'hd-1080p-30' });
	const r = applyTransaction(
		doc,
		{
			protocol: 'jasper.tx/1',
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 30,
					duration: 150,
					track: 'V2',
					template: { id: 'title-reveal', version: 1 },
					ref: '$a',
				},
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V3',
					template: { id: 'lower-third', version: 1 },
					ref: '$f',
				},
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0, 1], ref: '$t' },
			],
		},
		{ ids, now: () => '2026-10-01T00:00:00.000Z', revision: 0, registries },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	return {
		ids,
		doc: r.document,
		anime: r.result.refs.$a!,
		fframes: r.result.refs.$f!,
		text: r.result.refs.$t!,
	};
}

// 1×1 PNG.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64',
);

type Still = { envelope: { document: ProjectDocument }; sequenceId: string; frame: number; width?: number };

/** A fake engine: documents live in memory and transactions are applied with @jasper/project. */
function fakeEngine(over: Partial<Record<keyof EngineClient, unknown>> = {}) {
	const state = projectDoc();
	let doc = state.doc;
	let revision = 1;
	const txs: { label: string; commands: unknown[]; dryRun?: boolean; sequenceId?: string }[] = [];
	const stills: Still[] = [];
	const calls: string[] = [];
	const jobs = new Map<string, EngineJob>();
	const job = (id: string, extra: Partial<EngineJob>): EngineJob =>
		({
			id,
			kind: 'still',
			title: 'Frame',
			state: 'succeeded',
			progress: 1,
			createdAt: '2026-10-01T00:00:00.000Z',
			...extra,
		}) as EngineJob;
	let stillResult: Partial<EngineJob> = { result: { url: '/renders/x/output', renderPath: 'remotion' } };
	let render: Record<string, unknown> = {
		native: true,
		remotionLocal: 'ready',
		fframes: 'unavailable',
	};
	const client: Record<string, unknown> = {
		mgTemplates: async (): Promise<MgTemplatesResponse> => {
			calls.push('mgTemplates');
			return { templates: [ANIME, FFRAMES], renderer: { status: 'unavailable', reason: 'not built' } };
		},
		mgRender: async () => {
			calls.push('mgRender');
			throw new Error('mgRender must not be called');
		},
		agentQuery: async (req: { query: string }) => {
			calls.push(`query:${req.query}`);
			return { result: doc, revision, via: 'headless' };
		},
		agentTx: async (req: { transaction: (typeof txs)[number] & { origin: unknown } }) => {
			const tx = req.transaction;
			txs.push({
				label: tx.label,
				commands: tx.commands,
				...(tx.dryRun ? { dryRun: true } : {}),
				...(tx.sequenceId ? { sequenceId: tx.sequenceId } : {}),
			});
			const r = applyTransaction(
				doc,
				{ ...tx, origin: 'user' },
				{
					ids: state.ids,
					now: () => '2026-10-01T00:00:00.000Z',
					revision,
					registries,
				},
			);
			if (r.result.ok && !tx.dryRun) {
				doc = r.document;
				revision++;
			}
			return { result: r.result, appliedBy: 'headless' };
		},
		requestStill: async (req: Still) => {
			calls.push('requestStill');
			stills.push(req);
			const j = job(`job_still${stills.length}`, { state: 'running', progress: 0 });
			jobs.set(j.id, job(j.id, stillResult));
			return j;
		},
		getJob: async (id: string) => {
			const j = jobs.get(id);
			if (!j) throw new EngineError('JOB_NOT_FOUND', `No job ${id}`, { status: 404 });
			return j;
		},
		fetchBytes: async (url: string) => {
			calls.push(`fetch:${url}`);
			return { bytes: new Uint8Array(PNG), contentType: 'image/png' };
		},
		capabilities: async () => {
			calls.push('capabilities');
			return { render };
		},
		...over,
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return {
		link,
		state,
		txs,
		stills,
		calls,
		jobs,
		doc: () => doc,
		setStill: (r: Partial<EngineJob>) => {
			stillResult = r;
		},
		setRender: (r: Record<string, unknown>) => {
			render = r;
		},
	};
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(engine: ReturnType<typeof fakeEngine>) {
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'templates-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'templates-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;
	return { client, call };
}

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
const bodyOf = <T = Record<string, unknown>>(r: CallToolResult) => JSON.parse(textOf(r)) as T;
const errOf = (r: CallToolResult) => {
	expect(r.isError, textOf(r)).toBe(true);
	return bodyOf<{ error: { code: string; message: string; hint?: string; details?: unknown } }>(r).error;
};

// ---------------------------------------------------------------- list_motion_templates

describe('list_motion_templates (S11:ANA-003)', () => {
	it('reports renderer, native and a compact params summary with keyframable flags', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const r = await call('list_motion_templates');
		expect(r.isError, textOf(r)).toBeFalsy();
		const body = bodyOf<{
			renderer: { status: string };
			templates: {
				id: string;
				renderer: string;
				native: boolean;
				params: { name: string; type: string; default: unknown; keyframable: boolean }[];
				paramsSchema: unknown;
				defaults: unknown;
			}[];
		}>(r);
		expect(body.renderer.status).toBe('unavailable');
		const anime = body.templates.find((t) => t.id === 'title-reveal')!;
		expect(anime).toMatchObject({ renderer: 'anime', native: false, defaults: ANIME.defaults });
		expect(anime.paramsSchema).toEqual(ANIME.paramsSchema);
		expect(anime.params).toEqual([
			{ name: 'title', type: 'string ≤120', default: 'Title Reveal', keyframable: false },
			{ name: 'titleColor', type: 'rgba', default: [1, 1, 1, 1], keyframable: true },
			{ name: 'titleSize', type: 'number 24…240', default: 110, keyframable: true },
			{ name: 'lines', type: 'integer 0…6', default: 1, keyframable: false },
			{ name: 'alignment', type: 'enum left|center|right', default: 'center', keyframable: false },
			{ name: 'underline', type: 'boolean', default: true, keyframable: false },
		]);
		const ff = body.templates.find((t) => t.id === 'lower-third')!;
		expect(ff).toMatchObject({ renderer: 'fframes', native: true });
		// fframes params stay static even when numeric or colour.
		expect(ff.params.every((p) => !p.keyframable)).toBe(true);
		expect(ff.params.find((p) => p.name === 'accent')!.type).toBe('rgba');
	});

	it('the tools and the guide mention anime templates and set_motion_graphic_params', async () => {
		const { client } = await connect(fakeEngine());
		const tools = (await client.listTools()).tools;
		const list = tools.find((t) => t.name === 'list_motion_templates')!;
		expect(list.description).toMatch(/Remotion/);
		expect(tools.map((t) => t.name)).toContain('set_motion_graphic_params');
		expect(client.getInstructions()).toContain(TEMPLATES_GUIDE);
		expect(TEMPLATES_GUIDE).toMatch(/set_motion_graphic_params/);
	});

	it('summarizes nullable, unbounded and unknown schema shapes', () => {
		const s = paramsSummary({
			renderer: 'anime',
			defaults: { a: 3 },
			paramsSchema: {
				type: 'object',
				properties: {
					a: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }], description: 'A' },
					b: { type: 'number', minimum: -1e12, maximum: 1e12, default: 2 },
					c: { type: 'array', minItems: 2, maxItems: 2 },
					d: { type: 'object' },
					e: { anyOf: [{ const: 'x' }, { const: 'y' }] },
					f: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
				},
			},
		});
		expect(s).toEqual([
			{ name: 'a', type: 'number ≥0', default: 3, keyframable: true, description: 'A' },
			{ name: 'b', type: 'number -1000000000000…1000000000000', default: 2, keyframable: true },
			{ name: 'c', type: 'vec2', default: undefined, keyframable: false },
			{ name: 'd', type: 'object', default: undefined, keyframable: false },
			{ name: 'e', type: 'enum x|y', default: undefined, keyframable: false },
			{ name: 'f', type: 'integer', default: undefined, keyframable: false },
		]);
	});
});

// ---------------------------------------------------------------- render_motion_graphic_preview

describe('render_motion_graphic_preview for anime templates (S11:ANA-003)', () => {
	it('renders a one-clip document through the still path and returns the PNG', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const r = await call('render_motion_graphic_preview', {
			template: 'title-reveal',
			params: { title: 'Hello', titleSize: 140 },
			width: 801,
			height: 450,
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		// The fframes renderer is unavailable but irrelevant: no mgRender, no RENDERER_UNAVAILABLE.
		expect(engine.calls).not.toContain('mgRender');
		expect(engine.calls).not.toContain('capabilities');
		expect(engine.stills).toHaveLength(1);
		const still = engine.stills[0]!;
		const doc = still.envelope.document;
		const seq = doc.sequences[still.sequenceId]!;
		expect(seq.settings).toMatchObject({ width: 802, height: 450, frameRate: { num: 30, den: 1 } });
		const clips = Object.values(seq.clips);
		expect(clips).toHaveLength(1);
		const clip = clips[0] as MotionGraphicClip;
		expect(clip).toMatchObject({
			kind: 'motion-graphic',
			start: 0,
			duration: 150,
			canvas: 'sequence',
			template: { id: 'title-reveal', version: 1, renderer: 'anime' },
		});
		expect(clip.params).toEqual({ ...ANIME.defaults, title: 'Hello', titleSize: 140 });
		expect(seq.videoTracks[0]!.id).toBe(clip.trackId);
		expect(still.frame).toBe(84); // the middle of the hold: intro 36 + (150 − 36 − 18) / 2
		expect(still.width).toBe(802);
		expect(bodyOf(r)).toMatchObject({
			template: 'title-reveal@1',
			renderer: 'anime',
			renderedBy: 'remotion',
			frame: 84,
			jobId: 'job_still1',
			size: '802x450',
		});
		const img = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
		expect(img.mimeType).toBe('image/png');
		expect(Buffer.from(img.data, 'base64').equals(PNG)).toBe(true);
	});

	it('returns intro, hold and outro frames with frames: 3', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const r = await call('render_motion_graphic_preview', {
			template: 'title-reveal@1',
			durationSeconds: 2,
			fps: 25,
			frames: 3,
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		// 25 fps: intro 30, outro 15 frames (written at 30 fps), hold 5 → intro middle, hold middle, 50 − ceil(15/2)
		expect(engine.stills.map((s) => s.frame)).toEqual([15, 32, 42]);
		expect(r.content.filter((c) => c.type === 'image')).toHaveLength(3);
		expect(bodyOf(r)).toMatchObject({ frames: [15, 32, 42], durationFrames: 50, fps: 25 });
		expect(previewFrames(1, 3)).toEqual([0]);
	});

	it('previewFrames samples the template phases (outro included), compressed like animeTemplateTiming', () => {
		const t = { introFrames: 36, outroFrames: 18, fps: 30 };
		// 150 frames: intro 0–35, hold 36–131, outro 132–149
		expect(previewFrames(150, 1, t)).toEqual([84]);
		expect(previewFrames(150, 2, t)).toEqual([18, 84]);
		expect(previewFrames(150, 3, t)).toEqual([18, 84, 141]);
		expect(previewFrames(150, 4, t)).toEqual([12, 24, 84, 141]);
		expect(previewFrames(150, 5, t)).toEqual([12, 24, 84, 138, 144]);
		const six = previewFrames(150, 6, t);
		expect(six).toHaveLength(6);
		expect(six.filter((f) => f < 36)).toHaveLength(3);
		expect(six.filter((f) => f >= 132)).toHaveLength(2);
		// the outro sample always lies inside the outro, also when intro + outro are compressed to the clip
		for (const d of [10, 20, 40, 54, 60, 300]) {
			const { intro, outro } = previewPhases(d, t);
			expect(intro + outro).toBeLessThanOrEqual(d);
			const f = previewFrames(d, 3, t);
			expect(f.at(-1), `d=${d}`).toBe(d - Math.ceil(outro / 2));
			expect(f.at(-1)!).toBeGreaterThanOrEqual(d - outro);
			expect(f[0]).toBe(Math.floor(intro / 2));
		}
		expect(previewPhases(20, t)).toEqual({ intro: 13, outro: 7 });
		// at 60 fps the reference-rate lengths double
		expect(previewPhases(600, { ...t, fps: 60 })).toEqual({ intro: 72, outro: 36 });
		// no outro: its share goes to the hold; no timing: evenly spaced
		expect(previewFrames(150, 3, { introFrames: 30, outroFrames: 0, fps: 30 })).toEqual([15, 70, 110]);
		expect(previewFrames(50, 3)).toEqual([12, 25, 37]);
	});

	it('reports the still path that drew the preview (hybrid included)', async () => {
		const engine = fakeEngine();
		engine.setStill({ result: { url: '/renders/x/output', renderPath: 'hybrid' } });
		const { call } = await connect(engine);
		const r = await call('render_motion_graphic_preview', { template: 'title-reveal' });
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(bodyOf(r)).toMatchObject({ renderedBy: 'hybrid' });
	});

	it('rejects invalid params with E_INVALID_PARAM before rendering', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const e = errOf(
			await call('render_motion_graphic_preview', {
				template: 'title-reveal',
				params: { titleSize: 9999, nope: 1 },
			}),
		);
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toMatch(/titleSize/);
		expect(e.hint).toMatch(/nope/);
		expect(engine.stills).toHaveLength(0);
	});

	it('keeps RENDERER_UNAVAILABLE for fframes templates', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const e = errOf(await call('render_motion_graphic_preview', { template: 'lower-third' }));
		expect(e.code).toBe('RENDERER_UNAVAILABLE');
		expect(e.hint).toMatch(/anime/);
		expect(engine.stills).toHaveLength(0);
		expect(errOf(await call('render_motion_graphic_preview', { template: 'nope' })).code).toBe('E_NOT_FOUND');
	});

	it('explains a failed still (Remotion unavailable) with the Remotion hint', async () => {
		const engine = fakeEngine();
		engine.setStill({
			state: 'failed',
			error: {
				code: 'BINARY_MISSING',
				message: 'No Remotion bundle and no composition sources',
				retryable: false,
			},
		});
		engine.setRender({ native: true, remotionLocal: 'unavailable', fframes: 'unavailable' });
		const { call } = await connect(engine);
		const e = errOf(await call('render_motion_graphic_preview', { template: 'title-reveal' }));
		expect(e.code).toBe('BINARY_MISSING');
		expect(e.hint).toContain('JASPER_BROWSER_EXECUTABLE');
		expect(e.hint).toMatch(/pnpm build/);
		expect(e.hint).toMatch(/reports Remotion as unavailable/);
		expect(e.details).toMatchObject({ jobId: 'job_still1' });
	});

	it('builds the preview document with the catalogue entry as registry', () => {
		const { doc, sequenceId, clipId } = animePreviewDocument(ANIME, {
			params: ANIME.defaults,
			width: 1280,
			height: 720,
			fps: 24,
			durationFrames: 48,
		});
		const seq = doc.sequences[sequenceId] as Sequence;
		expect(seq.clips[clipId]).toMatchObject({ kind: 'motion-graphic', duration: 48 });
		expect(seq.settings.frameRate).toEqual({ num: 24, den: 1 });
	});
});

// ---------------------------------------------------------------- set_motion_graphic_params

describe('set_motion_graphic_params (S11:ANA-003)', () => {
	it('sets static params with one clip.update (merged, one Agent transaction)', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const id = engine.state.anime;
		const r = await call('set_motion_graphic_params', {
			projectId: engine.doc().projectId,
			clipId: id,
			params: { title: 'Launch', titleSize: 150 },
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(engine.txs).toHaveLength(1);
		expect(engine.txs[0]!.commands).toEqual([
			{ type: 'clip.update', clipId: id, patch: { params: { title: 'Launch', titleSize: 150 } } },
		]);
		expect(engine.txs[0]!.label).toBe('Edit Title Reveal params');
		const body = bodyOf<{ clip: { params: Record<string, unknown>; renderer: string; template: string } }>(r);
		expect(body.clip).toMatchObject({ template: 'title-reveal@1', renderer: 'anime' });
		expect(body.clip.params).toMatchObject({ title: 'Launch', titleSize: 150, alignment: 'center' });
	});

	it('keyframes numeric and colour params of anime templates (setAnimated + set at the frame)', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const id = engine.state.anime;
		const projectId = engine.doc().projectId;
		const r1 = await call('set_motion_graphic_params', {
			projectId,
			clipId: id,
			params: { titleSize: 60, titleColor: [1, 0, 0, 1], title: 'Mixed' },
			at: 30,
			keyframe: true,
		});
		const e = errOf(r1);
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toMatch(/Not keyframable: title/);
		expect(e.hint).toMatch(/titleColor, titleSize/);
		const r = await call('set_motion_graphic_params', {
			projectId,
			clipId: id,
			params: { titleSize: 60, titleColor: [1, 0, 0, 1] },
			at: { seconds: 1 },
			keyframe: true,
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		const at = { sequenceFrame: 30 };
		expect(engine.txs.at(-1)!.commands).toEqual([
			{ type: 'param.setAnimated', target: ['clip', id, 'params', 'titleSize'], animated: true, at },
			{ type: 'param.set', target: ['clip', id, 'params', 'titleSize'], value: 60, at },
			{ type: 'param.setAnimated', target: ['clip', id, 'params', 'titleColor'], animated: true, at },
			{ type: 'param.set', target: ['clip', id, 'params', 'titleColor'], value: [1, 0, 0, 1], at },
		]);
		expect(bodyOf(r)).toMatchObject({ keyframed: ['titleSize', 'titleColor'], atFrame: 30 });
		// A second keyframe on the animated param: param.set only; a static param alongside → clip.update.
		const r2 = await call('set_motion_graphic_params', {
			projectId,
			clipId: id,
			params: { titleSize: 200, title: 'Big' },
			at: 120,
		});
		expect(r2.isError, textOf(r2)).toBeFalsy();
		expect(engine.txs.at(-1)!.commands).toEqual([
			{ type: 'clip.update', clipId: id, patch: { params: { title: 'Big' } } },
			{
				type: 'param.set',
				target: ['clip', id, 'params', 'titleSize'],
				value: 200,
				at: { sequenceFrame: 120 },
			},
		]);
		const clip = engine.doc().sequences[Object.keys(engine.doc().sequences)[0]!]!.clips[
			id
		] as MotionGraphicClip;
		expect(clip.paramKeyframes?.titleSize?.map((k) => k.value)).toEqual([60, 200]);
		expect(clip.paramKeyframes?.titleColor).toHaveLength(1);
		expect(bodyOf<{ clip: { keyframes: Record<string, number> } }>(r2).clip.keyframes).toEqual({
			titleSize: 2,
			titleColor: 1,
		});
		// Animated params need a time.
		const noAt = errOf(
			await call('set_motion_graphic_params', { projectId, clipId: id, params: { titleSize: 90 } }),
		);
		expect(noAt.code).toBe('E_INVALID_PARAM');
		expect(noAt.hint).toMatch(/Pass at/);
	});

	it('validates the clip, the param names, values, times and the renderer', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const projectId = engine.doc().projectId;
		const s = engine.state;
		const fails = async (args: Record<string, unknown>) =>
			errOf(await call('set_motion_graphic_params', { projectId, ...args }));
		expect((await fails({ clipId: 'clp_nope', params: { title: 'x' } })).code).toBe('E_NOT_FOUND');
		const text = await fails({ clipId: s.text, params: { title: 'x' } });
		expect(text.code).toBe('E_INVALID_PARAM');
		expect(text.message).toMatch(/solid clip/);
		const unknown = await fails({ clipId: s.anime, params: { colour: [1, 1, 1, 1] } });
		expect(unknown.code).toBe('E_INVALID_PARAM');
		expect(unknown.hint).toMatch(/title, titleColor, titleSize, lines, alignment, underline/);
		expect((await fails({ clipId: s.anime, params: { titleSize: 'big' } })).code).toBe('E_INVALID_PARAM');
		expect(
			(await fails({ clipId: s.anime, params: { titleSize: 50 }, at: 500, keyframe: true })).message,
		).toMatch(/outside the clip/);
		expect((await fails({ clipId: s.anime, params: { titleSize: 50 }, keyframe: true })).message).toMatch(
			/needs at/,
		);
		const ff = await fails({ clipId: s.fframes, params: { size: 50 }, at: 10, keyframe: true });
		expect(ff.message).toMatch(/fframes template/);
		expect(engine.txs).toHaveLength(0);
		// fframes params are set statically.
		const ok = await call('set_motion_graphic_params', {
			projectId,
			clipId: s.fframes,
			params: { size: 50 },
		});
		expect(ok.isError, textOf(ok)).toBeFalsy();
		expect(bodyOf(ok)).toMatchObject({ clip: { renderer: 'fframes', params: { size: 50 } } });
	});

	it('dry runs change nothing', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const r = await call('set_motion_graphic_params', {
			projectId: engine.doc().projectId,
			clipId: engine.state.anime,
			params: { title: 'Maybe' },
			dryRun: true,
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(bodyOf(r)).toMatchObject({ dryRun: true, clip: { params: { title: 'Title Reveal' } } });
		expect(engine.txs[0]!.dryRun).toBe(true);
	});

	it('planParamCommands keeps fframes params static', () => {
		const plan = planParamCommands(
			{ id: 'clp_1', params: {}, template: { id: 'lower-third', version: 1 } },
			FFRAMES,
			{ size: 20 },
			{ atFrame: 5 },
		);
		expect(plan.commands).toEqual([
			{ type: 'clip.update', clipId: 'clp_1', patch: { params: { size: 20 } } },
		]);
	});
});

// ---------------------------------------------------------------- render-failure hints (ANA-005)

describe('render failures carry actionable hints (S11:ANA-005)', () => {
	it('renderHint maps the codes', () => {
		expect(renderHint('TEMPLATE_NOT_INSTALLED', 'x')).toBe(TEMPLATE_NOT_INSTALLED_HINT);
		expect(renderHint('RENDER_FAILED', 'Failed to launch the browser process')).toContain(REMOTION_HINT);
		expect(renderHint('BROWSER_DOWNLOAD', 'x')).toContain(REMOTION_HINT);
		expect(renderHint('RENDER_FAILED', 'ffmpeg exited with 1')).toBeUndefined();
		expect(renderHint('RENDER_FAILED', 'ffmpeg exited with 1', { remotionLocal: 'unavailable' })).toContain(
			'JASPER_BROWSER_EXECUTABLE',
		);
		expect(renderHint('RENDER_FAILED', 'x', { remotionLocal: 'needs-browser-download' })).toMatch(
			/first Remotion render downloads/,
		);
		const path = renderHint('PATH_NOT_ELIGIBLE', 'The native path cannot render this sequence', undefined, {
			blockers: [{ reason: 'text clip' }, { reason: 'text clip' }, { reason: 'effect blur' }],
		});
		expect(path).toMatch(/\(text clip; effect blur\)/);
		expect(path).toMatch(/engine "auto"/);
		expect(path).not.toContain(REMOTION_HINT);
		expect(renderHint('WEBGL_UNAVAILABLE', 'x')).toMatch(/JASPER_REMOTION_GL/);
		expect(renderHint('NOT_FOUND', 'x', { remotionLocal: 'unavailable' })).toBeUndefined();
	});

	it('render_frame: TEMPLATE_NOT_INSTALLED and a missing browser', async () => {
		let failure = new EngineError('TEMPLATE_NOT_INSTALLED', 'Motion-graphic template x@9 is not installed', {
			status: 502,
		});
		const engine = fakeEngine({
			agentQuery: async (req: { query: string }) => {
				if (req.query === 'frame.capture') throw failure;
				return { result: engine.doc(), revision: 1, via: 'headless' };
			},
		});
		const { call } = await connect(engine);
		const projectId = engine.doc().projectId;
		const e = errOf(await call('render_frame', { projectId, at: 0 }));
		expect(e).toMatchObject({ code: 'TEMPLATE_NOT_INSTALLED', hint: TEMPLATE_NOT_INSTALLED_HINT });
		failure = new EngineError('RENDER_FAILED', 'Could not find Chrome (ver. 134). Run ensureBrowser()', {
			status: 502,
		});
		engine.setRender({ native: true, remotionLocal: 'needs-browser-download', fframes: 'ready' });
		const b = errOf(await call('render_frame', { projectId, at: 0 }));
		expect(b.code).toBe('RENDER_FAILED');
		expect(b.hint).toContain(REMOTION_HINT);
		expect(b.hint).toMatch(/first Remotion render downloads/);
		// Non-render errors keep their own hints and skip the capabilities fetch.
		const before = engine.calls.filter((c) => c === 'capabilities').length;
		failure = new EngineError('PROJECT_NOT_FOUND', 'Project not found', { status: 404 });
		expect(errOf(await call('render_frame', { projectId, at: 0 })).hint).toMatch(/list_projects/);
		expect(engine.calls.filter((c) => c === 'capabilities').length).toBe(before);
	});

	it('start_export: plan errors and Remotion warnings carry hints; the happy path skips capabilities', async () => {
		let planError: EngineError | null = new EngineError('TEMPLATE_NOT_INSTALLED', 'x@9 is not installed', {
			status: 409,
			detail: {
				blockers: [{ itemId: 'clp_1', path: 'native', reason: 'template x@9 is not installed (clip "X")' }],
				hint: 'engine hint',
			},
		});
		let warnings: { code: string; message: string }[] = [];
		const engine = fakeEngine({
			planExport: async () => {
				if (planError) throw planError;
				return { path: 'remotion', blockers: [], warnings, planId: 'pln_1' };
			},
			startExport: async () => ({ id: 'job_exp', state: 'queued' }),
		});
		const { call } = await connect(engine);
		const projectId = engine.doc().projectId;
		const e = errOf(await call('start_export', { projectId }));
		expect(e).toMatchObject({ code: 'TEMPLATE_NOT_INSTALLED', hint: TEMPLATE_NOT_INSTALLED_HINT });
		expect(e.details).toMatchObject({ blockers: [{ itemId: 'clp_1' }], httpStatus: 409 });
		planError = new EngineError('PATH_NOT_ELIGIBLE', 'Remotion rendering is unavailable on this engine', {
			status: 409,
			detail: { blockers: [{ path: 'hybrid', reason: 'Remotion renderer or compositions bundle missing' }] },
		});
		engine.setRender({ native: true, remotionLocal: 'unavailable', fframes: 'ready' });
		const p = errOf(await call('start_export', { projectId, engine: 'remotion' }));
		expect(p.code).toBe('PATH_NOT_ELIGIBLE');
		expect(p.hint).toMatch(/Remotion renderer or compositions bundle missing/);
		expect(p.hint).toContain(REMOTION_HINT);
		planError = null;
		const capsBefore = engine.calls.filter((c) => c === 'capabilities').length;
		const ok = await call('start_export', { projectId });
		expect(ok.isError, textOf(ok)).toBeFalsy();
		expect(bodyOf(ok).hint).toBeUndefined();
		expect(engine.calls.filter((c) => c === 'capabilities').length).toBe(capsBefore);
		warnings = [
			{ code: 'BROWSER_DOWNLOAD', message: 'The first Remotion render downloads a headless browser' },
		];
		engine.setRender({ native: true, remotionLocal: 'needs-browser-download', fframes: 'ready' });
		const w = bodyOf<{ hint: string; plan: { warnings: string[] } }>(
			await call('start_export', { projectId }),
		);
		expect(w.hint).toMatch(/first Remotion render downloads/);
		expect(w.plan.warnings).toEqual([warnings[0]!.message]);
	});

	it('wait_for_job: a failed export explains Remotion; cancelled jobs get no hint', async () => {
		const engine = fakeEngine();
		engine.jobs.set('job_fail', {
			id: 'job_fail',
			kind: 'export',
			title: 'Export',
			state: 'failed',
			progress: null,
			error: { code: 'RENDER_FAILED', message: 'Failed to launch the browser process!', retryable: true },
		} as unknown as EngineJob);
		engine.jobs.set('job_cancel', {
			id: 'job_cancel',
			kind: 'export',
			title: 'Export',
			state: 'cancelled',
			progress: null,
			error: { code: 'JOB_CANCELLED', message: 'Cancelled', retryable: false },
		} as unknown as EngineJob);
		engine.jobs.set('job_ff', {
			id: 'job_ff',
			kind: 'export',
			title: 'Export',
			state: 'failed',
			progress: null,
			error: { code: 'RENDER_FAILED', message: 'ffmpeg exited with code 1', retryable: true },
		} as unknown as EngineJob);
		const { call } = await connect(engine);
		const e = errOf(await call('wait_for_job', { jobId: 'job_fail', timeoutSeconds: 1 }));
		expect(e.code).toBe('RENDER_FAILED');
		expect(e.hint).toContain(REMOTION_HINT);
		expect(e.details).toMatchObject({ jobId: 'job_fail', state: 'failed' });
		const c = errOf(await call('wait_for_job', { jobId: 'job_cancel', timeoutSeconds: 1 }));
		expect(c.code).toBe('JOB_CANCELLED');
		expect(c.hint).toBeUndefined();
		const f = errOf(await call('wait_for_job', { jobId: 'job_ff', timeoutSeconds: 1 }));
		expect(f.hint).toMatch(/Check the job error/);
	});
});
