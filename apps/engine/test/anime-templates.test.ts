// Anime templates in the engine (wp-m2-anime-templates): the catalogue lists them as Remotion-rendered
// (S11:ATP-008), jasper-mg refuses them (render route, requestRender, master provider), the planner sends them to
// the bake extension or the Remotion path, and templates this build lacks block every export path (ATP-010,
// FIX-008) — exports, the Remotion path and stills.
import { MgTemplatesResponseSchema } from '@jasper/api';
import { mgRegistry, titleReveal } from '@jasper/mg-templates';
import {
	applyTransaction,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NativeExtension } from '../src/export/native-ext.ts';
import { PlanError, planExport } from '../src/export/planner.ts';
import {
	animeTemplateBlocker,
	createMgService,
	isAnimeTemplateClip,
	type MgService,
	missingTemplates,
	TEMPLATE_NOT_INSTALLED,
} from '../src/mg/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, type TestApp, tempAppdir, until } from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	app = await makeApp({ env: { JASPER_MG: '/nonexistent/jasper-mg' } });
}, 120_000);
afterAll(closeApps);

type Built = { doc: ProjectDocument; seqId: string; anime: string; fframes: string };

/** title-reveal (anime) on V2 at 0–150 and lower-third (fframes) on V1 at 0–150. */
function build(): Built {
	const ids = createSeededIdSource(5);
	const doc = createEmptyProject({ ids, name: 'Anime', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const { document, result } = applyTransaction(
		doc,
		{
			label: 'mg',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V2',
					template: { id: 'title-reveal', version: 1 },
					ref: '$a',
				},
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V1',
					template: { id: 'lower-third', version: 1 },
					ref: '$f',
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return { doc: document, seqId, anime: result.refs.$a!, fframes: result.refs.$f! };
}

/** The same document with the anime clip pointing at a template this build lacks. */
function withMissing(b: Built, opts: { start?: number } = {}): ProjectDocument {
	const doc = JSON.parse(JSON.stringify(b.doc)) as ProjectDocument;
	const clip = doc.sequences[b.seqId]!.clips[b.anime] as {
		template: { id: string; version: number };
		start: number;
	};
	clip.template.id = 'retired-reveal';
	clip.template.version = 7;
	if (opts.start !== undefined) clip.start = opts.start;
	return doc;
}

const envelope = (doc: ProjectDocument) => makeEnvelope(doc, { revision: 1, savedAt: 't', platform: 'test' });
const settings = (seqId: string, engine: 'auto' | 'native' | 'remotion' = 'auto') =>
	({
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mp4',
		video: {
			codec: 'h264',
			width: 1920,
			height: 1080,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 23 },
			encoderSpeed: 'fast',
			colorTags: 'rec709',
		},
		audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
		engine,
	}) as never;
const CAPS = { native: true, remotionLocal: 'ready' as const, fframes: 'ready' as const, mgMasters: true };

function plan(
	doc: ProjectDocument,
	seqId: string,
	o: { engine?: 'auto' | 'native' | 'remotion'; still?: boolean; exts?: NativeExtension[] } = {},
) {
	const core = coreServices(app);
	return planExport(
		{
			envelope: envelope(doc),
			sequenceId: seqId,
			settings: settings(seqId, o.engine),
			...(o.still ? { rangeOverride: { start: 10, end: 11 }, still: true } : {}),
		},
		{ registry: core.registry, fonts: core.fonts, capabilities: CAPS, extensions: o.exts ?? [] },
	);
}

describe('catalogue and jasper-mg routing (S11:ATP-008)', () => {
	it('lists anime templates with renderer anime and native false', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/motion-graphics/templates', headers: H });
		const body = MgTemplatesResponseSchema.parse(res.json());
		const anime = body.templates.filter((t) => t.renderer === 'anime');
		expect(anime.map((t) => t.id)).toEqual(['title-reveal', 'lower-third-anim', 'callout', 'counter']);
		expect(anime.every((t) => t.native === false && !!t.description && t.defaultDurationSeconds === 5)).toBe(
			true,
		);
		expect(body.templates.filter((t) => t.renderer === undefined).map((t) => t.id)).toEqual([
			'lower-third',
			'title-card',
		]);
	});

	it('the render route refuses anime templates whatever the fframes state (400 ANIME_TEMPLATE)', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/motion-graphics/render',
			headers: JSON_H,
			payload: {
				spec: {
					template: { id: 'counter', version: 1 },
					params: {},
					width: 1920,
					height: 1080,
					fps: { num: 30, den: 1 },
					durationFrames: 90,
				},
				quality: 'preview',
			},
		});
		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({
			code: 'ANIME_TEMPLATE',
			message: expect.stringMatching(/counter@1 is an anime template/),
		});
	});

	it('requestRender and the master provider never send anime templates to jasper-mg', async () => {
		const service: MgService = createMgService({
			mgDir: tempAppdir('jasper-mg-anime-'),
			env: { JASPER_MG: '/nonexistent' },
		});
		const spec = {
			template: { id: 'title-reveal', version: 1 },
			params: {},
			width: 640,
			height: 360,
			fps: { num: 30, den: 1 },
			durationFrames: 30,
		};
		expect(() => service.requestRender(spec, 'master')).toThrow(/anime template/);
		const clip = {
			source: {
				mg: {
					template: spec.template,
					params: {},
					canvas: { width: 640, height: 360 },
					renderer: 'anime' as const,
				},
			},
			duration: 30,
			sourceIn: 0,
		};
		expect(await service.mgMasterProvider(clip, { fps: { num: 30, den: 1 } })).toBeNull();
		// the registry decides for installed templates even against a wrong stamp
		expect(isAnimeTemplateClip({ source: { mg: { ...clip.source.mg, renderer: undefined } } })).toBe(true);
		expect(
			isAnimeTemplateClip({
				source: {
					mg: {
						template: { id: 'lower-third', version: 1 },
						params: {},
						canvas: clip.source.mg.canvas,
						renderer: 'anime',
					},
				},
			}),
		).toBe(false);
		// unknown templates follow their stamp
		expect(
			isAnimeTemplateClip({
				source: {
					mg: {
						template: { id: 'x', version: 1 },
						params: {},
						canvas: clip.source.mg.canvas,
						renderer: 'anime',
					},
				},
			}),
		).toBe(true);
	});
});

describe('planner routing of anime templates (S11:ATP-002/008)', () => {
	it('without a claiming extension: a native blocker, auto plans remotion, forced native is refused', async () => {
		const b = build();
		const p = await plan(b.doc, b.seqId);
		expect(p.plan.path).toBe('remotion');
		expect(p.plan.blockers).toContainEqual(
			expect.objectContaining({ itemId: b.anime, reason: expect.stringMatching(/anime template/) }),
		);
		await expect(plan(b.doc, b.seqId, { engine: 'native' })).rejects.toMatchObject({
			code: 'PATH_NOT_ELIGIBLE',
		});
	});

	it('a claiming extension (layer-bake) removes the anime blocker', async () => {
		const b = build();
		const bake: NativeExtension = { id: 'test-bake', claimsLayer: (c) => isAnimeTemplateClip(c) };
		const p = await plan(b.doc, b.seqId, { exts: [bake] });
		expect(p.plan.blockers.filter((x) => x.itemId === b.anime)).toEqual([]);
		expect(
			animeTemplateBlocker(
				p.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === b.anime)!,
				true,
			),
		).toBeNull();
	});

	it('re-stamps a renderer that contradicts the registry before planning', async () => {
		const b = build();
		const doc = JSON.parse(JSON.stringify(b.doc)) as ProjectDocument;
		delete (doc.sequences[b.seqId]!.clips[b.anime] as { template: { renderer?: string } }).template.renderer;
		const p = await plan(doc, b.seqId);
		const clip = p.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === b.anime)!;
		expect('mg' in clip.source && clip.source.mg.renderer).toBe('anime');
	});
});

describe('templates that are not installed block every export path (S11:ATP-010, FIX-008)', () => {
	it('planExport throws TEMPLATE_NOT_INSTALLED for auto, native, remotion and stills', async () => {
		const b = build();
		const doc = withMissing(b);
		for (const o of [{}, { engine: 'native' as const }, { engine: 'remotion' as const }, { still: true }]) {
			const err = await plan(doc, b.seqId, o).catch((e) => e);
			expect(err, JSON.stringify(o)).toBeInstanceOf(PlanError);
			expect(err).toMatchObject({
				code: TEMPLATE_NOT_INSTALLED,
				status: 409,
				message: 'Motion-graphic template retired-reveal@7 is not installed',
			});
			expect(err.detail.blockers).toEqual([
				expect.objectContaining({
					itemId: b.anime,
					reason: expect.stringMatching(/retired-reveal@7 is not installed/),
				}),
			]);
		}
	});

	it('only clips inside the exported range count', async () => {
		const b = build();
		const doc = withMissing(b, { start: 400 });
		const p = await plan(doc, b.seqId, { still: true });
		expect(p.plan.path).toBeDefined();
		expect(missingTemplates(p.snapshot)).toEqual([]);
	});

	it('POST /api/exports and /api/exports/plan answer 409; a still job fails with the same code', async () => {
		const b = build();
		const doc = withMissing(b);
		const body = { envelope: envelope(doc), sequenceId: b.seqId, settings: settings(b.seqId) };
		for (const url of ['/api/exports', '/api/exports/plan']) {
			const res = await app.inject({ method: 'POST', url, headers: JSON_H, payload: body });
			expect(res.statusCode, url).toBe(409);
			expect(res.json(), url).toMatchObject({ code: TEMPLATE_NOT_INSTALLED });
		}
		const still = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: { envelope: envelope(doc), sequenceId: b.seqId, frame: 10 },
		});
		expect(still.statusCode).toBe(202);
		const job = await until(async () => {
			const j = coreServices(app).queue.get(still.json().id);
			return j && ['failed', 'succeeded'].includes(j.state) ? j : null;
		});
		expect(job.state).toBe('failed');
		expect(job.error).toMatchObject({
			code: TEMPLATE_NOT_INSTALLED,
			message: expect.stringMatching(/retired-reveal@7/),
		});
	});

	it('installed templates of both renderers plan normally', async () => {
		const b = build();
		expect(missingTemplates((await plan(b.doc, b.seqId)).snapshot)).toEqual([]);
		expect(titleReveal.renderer).toBe('anime');
	});
});
