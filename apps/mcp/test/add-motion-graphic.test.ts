// add_motion_graphic (social-comments §7.10): single item and items[] in one transaction, first-free placement,
// the template fill hook, dry runs with preview stills, per-item errors and friendly times. The fake engine
// applies transactions with @jasper/project (as the real engine does) and serves the catalogue and stills.
import type { EngineJob, MgTemplateCatalogEntry, MgTemplatesResponse } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const cardParams = z.strictObject({
	handle: z.string().min(1).max(40).default('user'),
	text: z.string().max(200).default('Hello'),
	likes: z.number().int().min(0).default(0),
});
const lowerParams = z.strictObject({
	name: z.string().max(60).default('Name'),
	size: z.number().min(10).max(200).default(40),
});
const jsonSchema = (s: z.ZodType) =>
	z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;

const CARD: MgTemplateCatalogEntry = {
	id: 'card',
	version: 1,
	name: 'Card',
	category: 'Social',
	paramsSchema: jsonSchema(cardParams),
	defaults: cardParams.parse({}),
	introFrames: 9,
	outroFrames: 6,
	defaultDurationSeconds: 4,
	canvases: ['1920x1080'],
	native: false,
	renderer: 'anime',
	presets: [{ id: 'pro', name: 'Pro', params: { handle: 'brand', text: 'From the preset' } }],
	// per-instance params (like social-comment's identity and stats): never taken from a preset
	ui: { addAnother: { reroll: ['handle', 'likes'] } },
};
const LOWER: MgTemplateCatalogEntry = {
	id: 'lower-third',
	version: 1,
	name: 'Lower Third',
	category: 'Lower thirds',
	paramsSchema: jsonSchema(lowerParams),
	defaults: lowerParams.parse({}),
	canvases: ['1920x1080'],
	native: true,
};

/** A template with an image media param (like social-comment's avatar). */
const avatarParams = z.strictObject({
	name: z.string().max(40).default('user'),
	avatar: z.object({ mediaId: z.string() }).nullable().default(null),
});
const AVATAR: MgTemplateCatalogEntry = {
	id: 'avatar-card',
	version: 1,
	name: 'Avatar card',
	category: 'Social',
	paramsSchema: jsonSchema(avatarParams),
	defaults: avatarParams.parse({}),
	defaultDurationSeconds: 2,
	canvases: ['1920x1080'],
	native: false,
	renderer: 'anime',
};

const HANDLES = ['ana', 'bo', 'cy', 'dee', 'eli'];
const infoOf = (
	t: MgTemplateCatalogEntry,
	schema: z.ZodType,
	fill?: MgTemplateInfo['fill'],
): MgTemplateInfo => ({
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
	...(fill ? { fill } : {}),
	...(t.ui ? { ui: t.ui as MgTemplateInfo['ui'] } : {}),
});
/** A fill hook like the social-comment one: identity and stats from the seed, given fields kept. */
const cardFill: MgTemplateInfo['fill'] = (partial, seed) => {
	if (partial.handle === '') return { ok: false, error: 'handle must not be empty' };
	const out = { ...partial };
	const filled: string[] = [];
	if (out.handle === undefined) {
		out.handle = HANDLES[seed % HANDLES.length]!;
		filled.push('handle');
	}
	if (out.likes === undefined) {
		out.likes = seed % 10_000;
		filled.push('likes');
	}
	return { ok: true, params: out, filled };
};
const registries = defaultRegistries(
	createStaticMgRegistry([
		infoOf(CARD, cardParams, cardFill),
		infoOf(LOWER, lowerParams),
		infoOf(AVATAR, avatarParams),
	]),
);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Agent API', preset: 'hd-1080p-30' });
	let revision = 1;
	let nextJob = 0;
	const txs: { commands: unknown[]; dryRun?: boolean }[] = [];
	const stills: { frame: number; width: number }[] = [];
	/** The document of every still requested (the preview document the engine would draw). */
	const stillDocs: ProjectDocument[] = [];
	const jobs = new Map<string, EngineJob>();
	const client: Record<string, unknown> = {
		mgTemplates: async (): Promise<MgTemplatesResponse> => ({
			templates: [CARD, LOWER, AVATAR],
			renderer: { status: 'unavailable', reason: 'not built' },
		}),
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: { dryRun?: boolean; commands: unknown[] } }) => {
			const tx = req.transaction;
			txs.push({ commands: tx.commands, ...(tx.dryRun ? { dryRun: true } : {}) });
			const r = applyTransaction(doc, { ...tx, origin: 'user' } as never, {
				ids,
				now: () => '2026-10-25T00:00:00.000Z',
				revision,
				registries,
			});
			if (r.result.ok && !tx.dryRun) {
				doc = r.document;
				revision++;
			}
			return { result: r.result, appliedBy: 'headless' };
		},
		requestStill: async (req: { frame: number; width: number; envelope: { document: ProjectDocument } }) => {
			stills.push({ frame: req.frame, width: req.width });
			stillDocs.push(req.envelope.document);
			const id = `job_still${++nextJob}`;
			const job = {
				id,
				kind: 'still',
				title: 'Frame',
				state: 'succeeded',
				progress: 1,
				createdAt: 't',
				result: { url: `/renders/${id}/output`, renderPath: 'remotion' },
			} as unknown as EngineJob;
			jobs.set(id, job);
			return { ...job, state: 'running', progress: 0 };
		},
		getJob: async (id: string) => {
			const j = jobs.get(id);
			if (!j) throw new EngineError('JOB_NOT_FOUND', `No job ${id}`, { status: 404 });
			return j;
		},
		fetchBytes: async () => ({ bytes: PNG, contentType: 'image/png' }),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return {
		link,
		txs,
		stills,
		stillDocs,
		doc: () => doc,
		revision: () => revision,
		/** Registers an image medium in the project (as import_media would). */
		addImage: (): string => {
			const r = applyTransaction(
				doc,
				{
					label: 'Import',
					origin: 'user',
					commands: [
						{
							type: 'media.register',
							asset: {
								kind: 'image',
								fingerprint: `q1:${'a'.repeat(64)}`,
								originalName: 'ana.png',
								sizeBytes: 1000,
								container: 'png_pipe',
								probe: {
									durationFlicks: null,
									startTimecode: null,
									streams: [
										{
											index: 0,
											type: 'video',
											codec: 'png',
											width: 64,
											height: 64,
											pixelAspect: { num: 1, den: 1 },
											frameRate: { num: 25, den: 1 },
											pixelFormat: 'rgb24',
											bitDepth: 8,
											color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'pc' },
											browserDecodable: true,
										},
									],
									rotationDegrees: 0,
									hasAlpha: false,
									variableFrameRate: false,
								},
								locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_ana' }],
								derivation: null,
							},
							name: 'Ana avatar',
							ref: '$m',
						},
					],
				} as never,
				{ ids, now: () => '2026-10-25T00:00:00.000Z', revision, registries },
			);
			if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
			doc = r.document;
			revision++;
			return r.result.refs.$m!;
		},
	};
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(engine: ReturnType<typeof fakeEngine>) {
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'agent-api-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'agent-api-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (args: Record<string, unknown>) =>
		(await client.callTool({
			name: 'add_motion_graphic',
			arguments: { projectId: engine.doc().projectId, ...args },
		})) as CallToolResult;
	return { client, call };
}

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
type Item = {
	index: number;
	clipId: string;
	template: string;
	preset?: string;
	track: string;
	trackId: string;
	createdTrack?: boolean;
	start: number;
	end: number;
	duration: number;
	startTimecode: string;
	params: Record<string, unknown>;
	filled: string[];
	seed: number;
	preview?: Record<string, unknown>;
};
type Body = { ok: true; dryRun?: true; seed: number; revision: number; items: Item[]; created: string[] };
const ok = (r: CallToolResult) => {
	expect(r.isError, textOf(r)).toBeFalsy();
	return JSON.parse(textOf(r)) as Body;
};
const err = (r: CallToolResult) => {
	expect(r.isError, textOf(r)).toBe(true);
	return (
		JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string; details?: never } }
	).error;
};
const seqOf = (doc: ProjectDocument) => Object.values(doc.sequences)[0]!;

describe('add_motion_graphic: single item (backward compatible)', () => {
	it('adds one graphic first-free from V2 with defaults, returning the resolved params and the seed', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const body = ok(await call({ template: 'lower-third', at: 30, params: { name: 'Ana' } }));
		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({
			index: 0,
			template: 'lower-third@1',
			track: 'V2',
			start: 30,
			end: 180,
			duration: 150,
			startTimecode: '00:00:01:00',
			params: { name: 'Ana', size: 40 },
			filled: [],
		});
		expect(Number.isInteger(body.seed)).toBe(true);
		expect(engine.revision()).toBe(2);
		const clip = seqOf(engine.doc()).clips[body.items[0]!.clipId]!;
		expect(clip).toMatchObject({ kind: 'motion-graphic', start: 30, duration: 150 });
		// a second call at the same time never overwrites the first
		const again = ok(await call({ template: 'lower-third', at: 60 }));
		expect(again.items[0]!.track).toBe('V3');
		expect(seqOf(engine.doc()).clips[body.items[0]!.clipId]).toEqual(clip);
	});

	it('an explicit track keeps the old overwrite semantics; placement first-free searches from it', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const first = ok(await call({ template: 'lower-third', at: 0, duration: 90, track: 'V2' })).items[0]!;
		const over = ok(await call({ template: 'lower-third', at: 30, duration: 30, track: 'V2' })).items[0]!;
		expect(over.track).toBe('V2');
		const seq = seqOf(engine.doc());
		const onV2 = Object.values(seq.clips)
			.filter((c) => c.trackId === over.trackId)
			.map((c) => [c.start, c.duration])
			.sort((a, b) => a[0]! - b[0]!);
		expect(onV2).toEqual([
			[0, 30],
			[30, 30],
			[60, 30],
		]);
		expect(seq.clips[first.clipId]!.duration).toBe(30);
		const free = ok(
			await call({ template: 'lower-third', at: 30, duration: 30, track: 'V2', placement: 'first-free' }),
		).items[0]!;
		expect(free.track).toBe('V3');
	});
});

describe('add_motion_graphic: items[] in one transaction', () => {
	it('places a batch without collisions as one transaction (one undo step) with per-item results', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const body = ok(
			await call({
				seed: 11,
				items: [
					{ template: 'card', at: 0 },
					{ template: 'card', at: 30, params: { text: 'Second' } },
					{ template: 'lower-third', at: 60, duration: 30 },
					{ template: 'card', at: 200, track: 'V1' },
				],
			}),
		);
		expect(engine.txs).toHaveLength(1);
		expect(engine.revision()).toBe(2);
		expect(body.items.map((i) => [i.index, i.track, i.start, i.end])).toEqual([
			[0, 'V2', 0, 120],
			[1, 'V3', 30, 150],
			[2, 'V4', 60, 90],
			[3, 'V1', 200, 320],
		]);
		expect(body.items[2]!.createdTrack).toBe(true);
		expect(body.seed).toBe(11);
		// item 0 uses the call seed, the others derived ones (or their own)
		expect(body.items[0]!.seed).toBe(11);
		expect(new Set(body.items.map((i) => i.seed)).size).toBe(4);
		expect(body.created).toEqual(expect.arrayContaining(body.items.map((i) => i.clipId)));
	});

	it('fills omitted params through the template fill hook, deterministically for a seed', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const items = [
			{ template: 'card', at: 0, params: { text: 'Love it' } },
			{ template: 'card', at: 0, params: { handle: 'me', likes: 3 } },
			{ template: 'card', at: 0, seed: 2 },
		];
		const a = ok(await call({ seed: 5, items }));
		expect(a.items[0]).toMatchObject({
			params: { handle: HANDLES[5 % 5], text: 'Love it', likes: 5 },
			filled: ['handle', 'likes'],
			seed: 5,
		});
		expect(a.items[1]).toMatchObject({ params: { handle: 'me', text: 'Hello', likes: 3 }, filled: [] });
		expect(a.items[2]).toMatchObject({ params: { handle: 'cy', likes: 2 }, seed: 2 });
		const b = ok(await call({ seed: 5, items, dryRun: true }));
		expect(b.items.map((i) => i.params)).toEqual(a.items.map((i) => i.params));
		const stored = seqOf(engine.doc()).clips[a.items[0]!.clipId] as unknown as { params: unknown };
		expect(stored.params).toEqual(a.items[0]!.params);
	});

	it('is all or nothing: a refused item names its index and nothing is added', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const before = engine.doc();
		const e = err(
			await call({
				items: [
					{ template: 'card', at: 0 },
					{ template: 'lower-third', at: 0, params: { size: 9999 } },
				],
			}),
		);
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toContain('items[1] (lower-third)');
		expect(e.details).toMatchObject({
			items: [{ index: 1, template: 'lower-third', code: 'E_INVALID_PARAM' }],
		});
		const fill = err(await call({ items: [{ template: 'card', at: 0, params: { handle: '' } }] }));
		expect(fill.message).toContain('handle must not be empty');
		const kind = err(await call({ items: [{ template: 'card', at: 0, track: 'A1' }] }));
		expect(kind.code).toBe('E_TRACK_KIND');
		expect(engine.doc()).toBe(before);
	});

	it('reports every unknown template reference before applying anything', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const e = err(
			await call({
				items: [
					{ template: 'nope', at: 0 },
					{ template: 'card', at: 0 },
					{ template: 'card@9', at: 0 },
				],
			}),
		);
		expect(e.code).toBe('E_NOT_FOUND');
		expect(e.details).toMatchObject({ items: [{ index: 0 }, { index: 2 }] });
		expect(e.hint).toContain('card@1');
		expect(engine.txs).toHaveLength(0);
	});

	it('validates the call shape: items xor a single item, the item cap, unknown keys', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		expect(err(await call({ template: 'card', at: 0, items: [{ template: 'card', at: 0 }] })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect(err(await call({ template: 'card' })).code).toBe('E_INVALID_PARAM');
		expect(err(await call({})).code).toBe('E_INVALID_PARAM');
		const many = Array.from({ length: 201 }, () => ({ template: 'card', at: 0 }));
		expect(err(await call({ items: many })).code).toBe('E_INVALID_ARGUMENT');
		expect(err(await call({ items: [] })).code).toBe('E_INVALID_ARGUMENT');
		expect(err(await call({ items: [{ template: 'card', at: 0, colour: 1 }] })).code).toBe(
			'E_UNKNOWN_ARGUMENT',
		);
		expect(err(await call({ items: [{ template: 'card', at: 0 }], seed: -1 })).code).toBe(
			'E_INVALID_ARGUMENT',
		);
		expect(engine.txs).toHaveLength(0);
	});

	it('accepts 200 items in one call', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const items = Array.from({ length: 200 }, (_, i) => ({ template: 'lower-third', at: (i % 10) * 15 }));
		const body = ok(await call({ items, seed: 1 }));
		expect(body.items).toHaveLength(200);
		const seq = seqOf(engine.doc());
		for (const t of seq.videoTracks) {
			const spans = Object.values(seq.clips)
				.filter((c) => c.trackId === t.id)
				.map((c) => [c.start, c.start + c.duration] as const)
				.sort((a, b) => a[0] - b[0]);
			for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
		}
	});
});

describe('add_motion_graphic: presets (WP3a refs) with batches, placement and the fill', () => {
	it('layers defaults → preset → fill → item params, and reports the preset', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const body = ok(
			await call({
				seed: 5,
				items: [
					{ template: 'card:pro', at: 0 },
					{ template: 'card@1:pro', at: 0, params: { text: 'Mine' } },
					{ template: 'card', at: 0 },
					{ template: 'card:pro', at: 0, params: { handle: 'given' } },
				],
			}),
		);
		// presets set the look (text); the per-instance params (handle, likes) come from the fill hook, like bulk
		// import rows and Add another copies (mgInstanceParams)
		expect(body.items[0]).toMatchObject({
			template: 'card@1',
			preset: 'pro',
			track: 'V2',
			params: { handle: HANDLES[5 % HANDLES.length], text: 'From the preset', likes: 5 },
			filled: ['handle', 'likes'],
		});
		expect(body.items[1]).toMatchObject({
			preset: 'pro',
			track: 'V3',
			params: { text: 'Mine' },
		});
		expect(body.items[1]!.params.handle).not.toBe('brand');
		expect(body.items[1]!.filled).toEqual(['handle', 'likes']);
		expect(body.items[2]!.preset).toBeUndefined();
		expect(body.items[2]!.filled).toEqual(['handle', 'likes']);
		// a per-instance param the caller gives is kept
		expect(body.items[3]).toMatchObject({
			params: { handle: 'given', text: 'From the preset' },
			filled: ['likes'],
		});
	});

	it('reports unknown presets and malformed refs per item before applying anything', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const e = err(
			await call({
				items: [
					{ template: 'card:nope', at: 0 },
					{ template: 'card', at: 0 },
					{ template: 'card@x', at: 0 },
				],
			}),
		);
		expect(e.code).toBe('E_NOT_FOUND');
		expect(e.details).toMatchObject({
			items: [
				{ index: 0, code: 'E_NOT_FOUND' },
				{ index: 2, code: 'E_INVALID_PARAM' },
			],
		});
		expect(engine.txs).toHaveLength(0);
	});
});

describe('add_motion_graphic: dryRun and preview', () => {
	it('dryRun resolves placement and params without changing the project', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const before = engine.doc();
		const body = ok(
			await call({
				dryRun: true,
				seed: 3,
				items: [
					{ template: 'card', at: 0 },
					{ template: 'card', at: 0 },
				],
			}),
		);
		expect(body.dryRun).toBe(true);
		expect(body.items.map((i) => i.track)).toEqual(['V2', 'V3']);
		expect(body.items[0]!.params).toMatchObject({ handle: HANDLES[3], likes: 3 });
		expect(engine.doc()).toBe(before);
		expect(engine.revision()).toBe(1);
		// the same call applied gives the same result
		const applied = ok(
			await call({
				seed: 3,
				items: [
					{ template: 'card', at: 0 },
					{ template: 'card', at: 0 },
				],
			}),
		);
		expect(applied.items.map((i) => [i.track, i.params])).toEqual(body.items.map((i) => [i.track, i.params]));
	});

	it('preview returns a still per item at the middle of its hold', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const r = await call({ dryRun: true, preview: true, template: 'card', at: 15, params: { text: 'Hi' } });
		const body = ok(r);
		const images = r.content.filter((c) => c.type === 'image');
		expect(images).toHaveLength(1);
		expect(body.items[0]!.preview).toMatchObject({ image: 0, renderedBy: 'remotion', template: 'card@1' });
		// 4 s at 30 fps: intro 9, outro 6 → hold 9…113, middle 61; the preview fits the 1920×1080 sequence in 960×960
		expect(engine.stills).toEqual([{ frame: 61, width: 960 }]);
		expect(engine.revision()).toBe(1);
		// fframes without the native renderer: reported on the item, the dry run still succeeds
		const ff = ok(await call({ dryRun: true, preview: true, template: 'lower-third', at: 0 }));
		expect(ff.items[0]!.preview).toMatchObject({ error: { code: 'RENDERER_UNAVAILABLE' } });
	});

	it('previews draw the project media the params reference (avatar), in add_motion_graphic and render_motion_graphic_preview', async () => {
		const engine = fakeEngine();
		const mediaId = engine.addImage();
		const { client, call } = await connect(engine);
		const r = await call({
			dryRun: true,
			preview: true,
			template: 'avatar-card',
			at: 0,
			params: { avatar: { mediaId } },
		});
		const body = ok(r);
		expect(body.items[0]!.preview).toMatchObject({ image: 0, template: 'avatar-card@1' });
		expect(body.items[0]!.preview).not.toHaveProperty('error');
		const drawn = (d: ProjectDocument) => {
			const clip = Object.values(seqOf(d).clips).find((c) => c.kind === 'motion-graphic') as unknown as {
				params: Record<string, unknown>;
			};
			return {
				avatar: clip.params.avatar,
				asset: d.media[mediaId],
				item: Object.values(d.items).find((it) => it.kind === 'media' && it.mediaId === mediaId),
			};
		};
		const source = engine.doc().media[mediaId]!;
		expect(drawn(engine.stillDocs[0]!)).toMatchObject({
			avatar: { mediaId },
			asset: { id: mediaId, fingerprint: source.fingerprint, locators: source.locators },
			item: { name: 'Ana avatar' },
		});
		// render_motion_graphic_preview: the same with projectId; without it the media reference is refused by name
		const preview = (args: Record<string, unknown>) =>
			client.callTool({
				name: 'render_motion_graphic_preview',
				arguments: { template: 'avatar-card', params: { avatar: { mediaId } }, ...args },
			}) as Promise<CallToolResult>;
		const p = await preview({ projectId: engine.doc().projectId });
		expect(p.isError, textOf(p)).toBeFalsy();
		expect(p.content.filter((c) => c.type === 'image')).toHaveLength(1);
		expect(drawn(engine.stillDocs[1]!)).toMatchObject({ avatar: { mediaId }, asset: { id: mediaId } });
		const noProject = err(await preview({}));
		expect(noProject).toMatchObject({ code: 'E_INVALID_PARAM', message: expect.stringContaining(mediaId) });
		expect(noProject.hint).toContain('projectId');
		const unknown = err(
			(await client.callTool({
				name: 'render_motion_graphic_preview',
				arguments: {
					template: 'avatar-card',
					projectId: engine.doc().projectId,
					params: { avatar: { mediaId: 'med_nope' } },
				},
			})) as CallToolResult,
		);
		expect(unknown).toMatchObject({ code: 'E_NOT_FOUND', message: expect.stringContaining('med_nope') });
		expect(engine.stillDocs).toHaveLength(2);
	});

	it('refuses preview without dryRun and above the preview cap', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		expect(err(await call({ preview: true, template: 'card', at: 0 })).code).toBe('E_INVALID_PARAM');
		const items = Array.from({ length: 11 }, () => ({ template: 'card', at: 0 }));
		expect(err(await call({ dryRun: true, preview: true, items })).code).toBe('E_INVALID_PARAM');
		expect(engine.txs).toHaveLength(0);
	});
});

describe('add_motion_graphic: friendly times', () => {
	it('accepts M:SS, H:MM:SS, s and ms besides frames, {seconds} and timecode', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const body = ok(
			await call({
				items: [
					{ template: 'card', at: '00:03', duration: '2s' },
					{ template: 'card', at: '1.5s', duration: '250ms' },
					{ template: 'card', at: '0:01:00', duration: { seconds: 1 } },
					{ template: 'card', at: '00:00:02:10', duration: 12 },
				],
			}),
		);
		expect(body.items.map((i) => [i.start, i.duration])).toEqual([
			[90, 60],
			[45, 8],
			[1800, 30],
			[70, 12],
		]);
		const e = err(await call({ template: 'card', at: '3 s' }));
		expect(e.code).toBe('E_INVALID_ARGUMENT');
		expect(err(await call({ template: 'card', at: '1:02:03.5s' })).code).toBe('E_INVALID_ARGUMENT');
	});
});
