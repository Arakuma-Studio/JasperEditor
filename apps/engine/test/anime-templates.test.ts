// Anime template API contracts (S11:ATP-008/010): renderer classification, jasper-mg route refusal, and
// missing-template errors on export and still paths.
import { MgTemplatesResponseSchema } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planExport } from '../src/export/planner.ts';
import { missingTemplates } from '../src/mg/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, type TestApp, until } from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	app = await makeApp({ env: { JASPER_MG: '/nonexistent/jasper-mg' } });
}, 120_000);
afterAll(closeApps);

type Built = { doc: ProjectDocument; seqId: string; anime: string; fframes: string };

/** title-reveal (anime) on V2 at 0–150 and lower-third (fframes) on V1 at 0–150. */
function build(): Built {
	const ids = createCounterIdSource(5);
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
	o: { engine?: 'auto' | 'native' | 'remotion'; still?: boolean } = {},
) {
	const core = coreServices(app);
	return planExport(
		{
			envelope: envelope(doc),
			sequenceId: seqId,
			settings: settings(seqId, o.engine),
			...(o.still ? { rangeOverride: { start: 10, end: 11 }, still: true } : {}),
		},
		{ registry: core.registry, fonts: core.fonts, capabilities: CAPS, extensions: [] },
	);
}

describe('catalogue and jasper-mg routing (S11:ATP-008)', () => {
	it('lists anime templates with renderer anime and native false', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/motion-graphics/templates', headers: H });
		const body = MgTemplatesResponseSchema.parse(res.json());
		expect(body.templates.find((t) => t.id === 'title-reveal')).toMatchObject({
			renderer: 'anime',
			native: false,
		});
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
		});
	});
});

describe('templates that are not installed block every export path (S11:ATP-010, FIX-008)', () => {
	it('only clips inside the exported range count', async () => {
		const b = build();
		const doc = withMissing(b, { start: 400 });
		const p = await plan(doc, b.seqId, { still: true });
		expect(missingTemplates(p.snapshot)).toEqual([]);
	});

	it('POST /api/exports and /api/exports/plan answer 409; a still job fails with the same code', async () => {
		const b = build();
		const doc = withMissing(b);
		const body = { envelope: envelope(doc), sequenceId: b.seqId, settings: settings(b.seqId) };
		for (const url of ['/api/exports', '/api/exports/plan']) {
			const res = await app.inject({ method: 'POST', url, headers: JSON_H, payload: body });
			expect(res.statusCode, url).toBe(409);
			expect(res.json(), url).toMatchObject({ code: 'TEMPLATE_NOT_INSTALLED' });
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
			code: 'TEMPLATE_NOT_INSTALLED',
		});
	});
});
