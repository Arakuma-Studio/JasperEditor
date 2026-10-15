// The fake engine supplies catalogue, stills and capabilities; document transactions use @jasper/project.
import type { EngineJob, MgTemplateCatalogEntry, MgTemplatesResponse } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	type MotionGraphicClip,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

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

function projectDoc() {
	const ids = createCounterIdSource(7);
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

function fakeEngine(over: Partial<Record<keyof EngineClient, unknown>> = {}) {
	const state = projectDoc();
	let doc = state.doc;
	let revision = 1;
	let nextJob = 0;
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
		mgTemplates: async (): Promise<MgTemplatesResponse> => ({
			templates: [ANIME, FFRAMES],
			renderer: { status: 'unavailable', reason: 'not built' },
		}),
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: { dryRun?: boolean; [key: string]: unknown } }) => {
			const tx = req.transaction;
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
		requestStill: async () => {
			const j = job(`job_still${++nextJob}`, { state: 'running', progress: 0 });
			jobs.set(j.id, job(j.id, stillResult));
			return j;
		},
		getJob: async (id: string) => {
			const j = jobs.get(id);
			if (!j) throw new EngineError('JOB_NOT_FOUND', `No job ${id}`, { status: 404 });
			return j;
		},
		capabilities: async () => ({ render }),
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
			}[];
		}>(r);
		const anime = body.templates.find((t) => t.id === 'title-reveal')!;
		expect(anime).toMatchObject({ renderer: 'anime', native: false });
		expect(anime.params.find((p) => p.name === 'titleSize')).toMatchObject({
			default: 110,
			keyframable: true,
		});
		expect(anime.params.find((p) => p.name === 'title')?.keyframable).toBe(false);
		const ff = body.templates.find((t) => t.id === 'lower-third')!;
		expect(ff).toMatchObject({ renderer: 'fframes', native: true });
		expect(ff.params.find((p) => p.name === 'size')?.keyframable).toBe(false);
	});
});

describe('render_motion_graphic_preview for anime templates (S11:ANA-003)', () => {
	it('rejects invalid parameter values and names with E_INVALID_PARAM', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		for (const params of [{ titleSize: 9999 }, { nope: 1 }]) {
			const e = errOf(await call('render_motion_graphic_preview', { template: 'title-reveal', params }));
			expect(e.code).toBe('E_INVALID_PARAM');
		}
	});

	it('keeps RENDERER_UNAVAILABLE for fframes templates', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const e = errOf(await call('render_motion_graphic_preview', { template: 'lower-third' }));
		expect(e.code).toBe('RENDERER_UNAVAILABLE');
		expect(errOf(await call('render_motion_graphic_preview', { template: 'nope' })).code).toBe('E_NOT_FOUND');
	});
});

describe('set_motion_graphic_params (S11:ANA-003)', () => {
	it('sets static params and preserves template defaults', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const id = engine.state.anime;
		const r = await call('set_motion_graphic_params', {
			projectId: engine.doc().projectId,
			clipId: id,
			params: { title: 'Launch', titleSize: 150 },
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		const body = bodyOf<{ clip: { params: Record<string, unknown>; renderer: string; template: string } }>(r);
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
		const r = await call('set_motion_graphic_params', {
			projectId,
			clipId: id,
			params: { titleSize: 60, titleColor: [1, 0, 0, 1] },
			at: { seconds: 1 },
			keyframe: true,
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(bodyOf(r)).toMatchObject({ keyframed: ['titleSize', 'titleColor'], atFrame: 30 });
		const r2 = await call('set_motion_graphic_params', {
			projectId,
			clipId: id,
			params: { titleSize: 200, title: 'Big' },
			at: 120,
		});
		expect(r2.isError, textOf(r2)).toBeFalsy();
		const clip = engine.doc().sequences[Object.keys(engine.doc().sequences)[0]!]!.clips[
			id
		] as MotionGraphicClip;
		expect(clip.params.title).toBe('Big');
		expect(clip.paramKeyframes?.titleSize?.map((k) => k.value)).toEqual([60, 200]);
		expect(clip.paramKeyframes?.titleColor?.[0]?.value).toEqual([1, 0, 0, 1]);
		const noAt = errOf(
			await call('set_motion_graphic_params', { projectId, clipId: id, params: { titleSize: 90 } }),
		);
		expect(noAt.code).toBe('E_INVALID_PARAM');
	});

	it('validates the clip, the param names, values, times and the renderer', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const before = engine.doc();
		const projectId = engine.doc().projectId;
		const s = engine.state;
		const fails = async (args: Record<string, unknown>) =>
			errOf(await call('set_motion_graphic_params', { projectId, ...args }));
		expect((await fails({ clipId: 'clp_nope', params: { title: 'x' } })).code).toBe('E_NOT_FOUND');
		const text = await fails({ clipId: s.text, params: { title: 'x' } });
		expect(text.code).toBe('E_INVALID_PARAM');
		const unknown = await fails({ clipId: s.anime, params: { colour: [1, 1, 1, 1] } });
		expect(unknown.code).toBe('E_INVALID_PARAM');
		expect((await fails({ clipId: s.anime, params: { titleSize: 'big' } })).code).toBe('E_INVALID_PARAM');
		expect((await fails({ clipId: s.anime, params: { titleSize: 50 }, at: 500, keyframe: true })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await fails({ clipId: s.anime, params: { titleSize: 50 }, keyframe: true })).code).toBe(
			'E_INVALID_PARAM',
		);
		const ff = await fails({ clipId: s.fframes, params: { size: 50 }, at: 10, keyframe: true });
		expect(ff.code).toBe('E_INVALID_PARAM');
		expect(engine.doc()).toEqual(before);
		const ok = await call('set_motion_graphic_params', {
			projectId,
			clipId: s.fframes,
			params: { size: 50 },
		});
		expect(ok.isError, textOf(ok)).toBeFalsy();
		expect(bodyOf(ok)).toMatchObject({ clip: { renderer: 'fframes', params: { size: 50 } } });
	});
});

describe('render failures carry actionable hints (S11:ANA-005)', () => {
	it('render_frame: TEMPLATE_NOT_INSTALLED and a missing browser', async () => {
		let failure = new EngineError('TEMPLATE_NOT_INSTALLED', 'Motion-graphic template x@9 is not installed', {
			status: 502,
		});
		// render_frame submits its own still job so cancellation can stop the engine work.
		const engine = fakeEngine({
			requestStill: async () => {
				throw failure;
			},
		});
		const { call } = await connect(engine);
		const projectId = engine.doc().projectId;
		const e = errOf(await call('render_frame', { projectId, at: 0 }));
		expect(e.code).toBe('TEMPLATE_NOT_INSTALLED');
		failure = new EngineError('RENDER_FAILED', 'Could not find Chrome (ver. 134). Run ensureBrowser()', {
			status: 502,
		});
		engine.setRender({ native: true, remotionLocal: 'needs-browser-download', fframes: 'ready' });
		const b = errOf(await call('render_frame', { projectId, at: 0 }));
		expect(b.code).toBe('RENDER_FAILED');
		expect(b.hint).toContain('JASPER_BROWSER_EXECUTABLE');
		const failing = fakeEngine();
		failing.setStill({
			state: 'failed',
			error: { code: 'RENDER_FAILED', message: 'Failed to launch the browser process!', retryable: true },
		});
		failing.setRender({ native: true, remotionLocal: 'needs-browser-download', fframes: 'ready' });
		const c2 = await connect(failing);
		const j = errOf(await c2.call('render_frame', { projectId: failing.doc().projectId, at: 0 }));
		expect(j.code).toBe('RENDER_FAILED');
		expect(j.hint).toContain('JASPER_BROWSER_EXECUTABLE');
	});

	it('start_export preserves plan errors and explains unavailable rendering', async () => {
		let planError = new EngineError('TEMPLATE_NOT_INSTALLED', 'x@9 is not installed', {
			status: 409,
			detail: {
				blockers: [{ itemId: 'clp_1', path: 'native', reason: 'template x@9 is not installed (clip "X")' }],
				hint: 'engine hint',
			},
		});

		const engine = fakeEngine({
			planExport: async () => {
				throw planError;
			},
		});
		const { call } = await connect(engine);
		const projectId = engine.doc().projectId;
		const e = errOf(await call('start_export', { projectId }));
		expect(e.code).toBe('TEMPLATE_NOT_INSTALLED');
		expect(e.details).toMatchObject({ blockers: [{ itemId: 'clp_1' }] });
		planError = new EngineError('PATH_NOT_ELIGIBLE', 'Remotion rendering is unavailable on this engine', {
			status: 409,
			detail: { blockers: [{ path: 'hybrid', reason: 'Remotion renderer or compositions bundle missing' }] },
		});
		engine.setRender({ native: true, remotionLocal: 'unavailable', fframes: 'ready' });
		const p = errOf(await call('start_export', { projectId, engine: 'remotion' }));
		expect(p.code).toBe('PATH_NOT_ELIGIBLE');
		expect(p.hint).toContain('JASPER_BROWSER_EXECUTABLE');
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
		const { call } = await connect(engine);
		const e = errOf(await call('wait_for_job', { jobId: 'job_fail', timeoutSeconds: 1 }));
		expect(e.code).toBe('RENDER_FAILED');
		expect(e.hint).toContain('JASPER_BROWSER_EXECUTABLE');
		const c = errOf(await call('wait_for_job', { jobId: 'job_cancel', timeoutSeconds: 1 }));
		expect(c.code).toBe('JOB_CANCELLED');
		expect(c.hint).toBeUndefined();
	});
});
