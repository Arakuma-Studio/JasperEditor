// Spec 19 §11: the titles toolset against an in-process engine stand-in: real commands, real agent queries, real proposal
// validation, and a small rasteriser for `still-sheet` jobs (a title is a box at a place the test chooses), so every row is
// computed from pixels with a known answer. Real rendering is in test/qa/titles.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TitleLookLibraryResponseSchema } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	appearanceFromRecipe,
	applyTransaction,
	type Colorway,
	createCounterIdSource,
	createEmptyProject,
	createProposal,
	defaultRegistries,
	FACTORY_COLORWAYS,
	FACTORY_LOOKS,
	FACTORY_TEMPLATES,
	type FactoryLook,
	type LookRecipe,
	type ProjectDocument,
	type Proposal,
	RECIPE_BOUNDS,
	runAgentQuery,
	TITLE_ART_FEATURE,
	TITLE_SAFE_MARGINS,
	type TitleTemplate,
	titleArtCheckOf,
	titleArtMetaOf,
	type UserLook,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildInstructions } from '../src/agent-guide.ts';
import type { EngineConnection } from '../src/link.ts';
import { decodePng, encodePng } from '../src/png.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { titleLintRows } from '../src/title-lint.ts';

const P = 'prj_title';
const registries = defaultRegistries();

/** Where the stand-in draws a title, fractions of the frame, and in what. */
type Painted = { x: number; y: number; w: number; h: number; face: [number, number, number] };
const CENTRED: Painted = { x: 0.3, y: 0.42, w: 0.4, h: 0.16, face: [255, 255, 255] };

type Job = {
	id: string;
	kind: string;
	title: string;
	state: string;
	progress: number | null;
	result?: unknown;
	error?: { code: string; message: string };
};

function fakeEngine(
	opts: { live?: boolean; paint?: Painted; stuck?: boolean; userLooks?: UserLook[] | 'broken' } = {},
) {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Titles', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const undo: ProjectDocument[] = [];
	const jobs = new Map<string, Job>();
	const png = new Map<string, Uint8Array>();
	const proposals = new Map<string, Proposal>();
	const sheets: { cells: { hide?: string[] }[]; width?: number; documents: number }[] = [];
	const cancelled: string[] = [];
	const state = { paint: opts.paint ?? CENTRED, live: opts.live ?? false, userLooks: opts.userLooks ?? [] };
	let n = 0;

	/** The picture: the V1 solid (or black), and the box of every enabled text clip. */
	const raster = (d: ProjectDocument, sequenceId: string, frame: number, width: number) => {
		const seq = d.sequences[sequenceId]!;
		const w = Math.min(width, 200);
		const height = Math.round((w * seq.settings.height) / seq.settings.width);
		const data = new Uint8Array(w * height * 4);
		let back: readonly number[] = [0, 0, 0];
		const clips = Object.values(seq.clips).filter((c) => frame >= c.start && frame < c.start + c.duration);
		for (const c of clips)
			if (c.kind === 'solid') {
				const syn = (d.synthetics as Record<string, { color?: readonly number[] }>)[
					(c as { syntheticId?: string }).syntheticId ?? ''
				];
				if (syn?.color) back = syn.color.map((v) => Math.round(v * 255));
			}
		const title = clips.some((c) => c.kind === 'text' && (c as { enabled?: boolean }).enabled !== false);
		const p = state.paint;
		for (let y = 0; y < height; y++)
			for (let x = 0; x < w; x++) {
				const fx = x / w;
				const fy = y / height;
				const inside = title && fx >= p.x && fx < p.x + p.w && fy >= p.y && fy < p.y + p.h;
				const c = inside ? p.face : back;
				const o = (y * w + x) * 4;
				data[o] = c[0]!;
				data[o + 1] = c[1]!;
				data[o + 2] = c[2]!;
				data[o + 3] = 255;
			}
		return encodePng({ width: w, height, data });
	};

	const tx = (t: Record<string, unknown>) => {
		const cmds = t.commands as { type: string }[];
		if (cmds[0]?.type === 'history.undo') {
			if (!state.live || !undo.length)
				return {
					ok: false,
					revision,
					errors: [{ commandIndex: 0, code: 'E_NO_SESSION', message: 'Undo needs an editor window' }],
				};
			doc = undo.pop()!;
			revision++;
			return {
				ok: true,
				revision,
				refs: {},
				created: [],
				changed: [],
				deleted: [],
				warnings: [],
				results: [{}],
			};
		}
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...t, origin: 'user' } as never, {
			ids,
			now: () => '2026-11-02T00:00:00.000Z',
			revision,
			registries,
		});
		if (r.result.ok && !t.dryRun) {
			undo.push(doc);
			doc = r.document;
			revision++;
		}
		return r.result;
	};

	const client = {
		agentQuery: async (req: { query: string; args?: unknown }) => ({
			result: runAgentQuery({ doc, revision, effects: registries.effects }, req.query, req.args ?? {}),
			revision,
			via: state.live ? 'session' : 'headless',
		}),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: tx(req.transaction),
			appliedBy: state.live ? 'session' : 'headless',
		}),
		agentSchema: async () => ({
			effects: registries.effects.list().filter((e) => !e.internal),
			commands: {},
		}),
		listFonts: async () => ({
			fonts: [{ family: 'Source Sans 3', files: [{ weight: 400, style: 'normal', url: '/f.woff2' }] }],
		}),
		planExport: async () => ({ path: 'hybrid', blockers: [] }),
		listProjects: async () => ({ projects: [] }),
		// TL-054: the user's library, as `GET /api/title-looks` answers it (parsed like the real client does).
		call: async (name: string) => {
			if (name !== 'titleLooksList') throw new Error(`no route ${name}`);
			if (state.userLooks === 'broken') throw new Error('the look library is unreadable');
			return TitleLookLibraryResponseSchema.parse({ revision: 1, readOnly: false, looks: state.userLooks });
		},
		requestStillSheet: async (req: {
			documents: { document: ProjectDocument }[];
			cells: { document: number; sequenceId: string; frame: number; tag?: string; hide?: string[] }[];
			width?: number;
			meta?: unknown;
		}) => {
			const id = `job_${String(++n).padStart(16, '0')}`;
			sheets.push({
				cells: req.cells,
				documents: req.documents.length,
				...(req.width ? { width: req.width } : {}),
			});
			if (opts.stuck) {
				const job = { id, kind: 'still-sheet', title: 'x', state: 'running', progress: 0.5 };
				jobs.set(id, job);
				return job;
			}
			const cells = req.cells.map((c, index) => {
				const d = structuredClone(req.documents[c.document]!.document) as ProjectDocument;
				for (const h of c.hide ?? []) {
					const clip = d.sequences[c.sequenceId]!.clips[h] as { enabled?: boolean } | undefined;
					if (clip) clip.enabled = false;
				}
				const url = `/renders/${id}/cells/${index}`;
				png.set(url, raster(d, c.sequenceId, c.frame, req.width ?? 960));
				return {
					index,
					url,
					document: c.document,
					sequenceId: c.sequenceId,
					frame: c.frame,
					...(c.tag ? { tag: c.tag } : {}),
					renderPath: 'hybrid',
				};
			});
			const job = {
				id,
				kind: 'still-sheet',
				title: 'x',
				state: 'succeeded',
				progress: 1,
				result: { cells, ...(req.meta ? { meta: req.meta } : {}) },
			};
			jobs.set(id, job);
			return job;
		},
		getJob: async (id: string) => {
			const j = jobs.get(id);
			if (!j) throw new Error(`no job ${id}`);
			return structuredClone(j);
		},
		cancelJob: async (id: string) => {
			cancelled.push(id);
			const j = jobs.get(id)!;
			j.state = 'cancelled';
			return structuredClone(j);
		},
		fetchBytes: async (url: string) => ({ bytes: png.get(url)!, contentType: 'image/png' }),
		createProposal: async (projectId: string, body: Record<string, unknown>) => {
			const { allOrNothing: _a, expectedRevision: _e, ...draft } = body;
			const r = createProposal(
				doc,
				draft,
				{
					id: `prp_${String(proposals.size + 1).padStart(16, '0')}`,
					projectId,
					author: { agent: 't' },
					now: '2026-11-02T00:00:00.000Z',
					revision,
				},
				{ registries, now: () => '2026-11-02T00:00:00.000Z' },
			);
			if (!r.ok) throw new Error(JSON.stringify(r.errors));
			proposals.set(r.proposal.id, r.proposal);
			return { proposal: r.proposal, revision, evicted: [], expiresAt: 'x' };
		},
		getProposal: async (_p: string, id: string) => {
			const p = proposals.get(id);
			if (!p) throw new Error('no proposal');
			return { proposal: p, revision, expiresAt: 'x' };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, seqId, sheets, proposals, cancelled, state, setDoc: tx, jobs };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
type Json = Record<string, any>;

async function connect(opts: Parameters<typeof fakeEngine>[0] = {}) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'titles-test', toolsets: 'all' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'titles-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string }).text;
		let json: Json = {};
		try {
			json = JSON.parse(text);
		} catch {}
		return {
			r,
			text,
			json,
			image: r.content.find((c) => c.type === 'image') as { data: string } | undefined,
		};
	};
	const ok = async (name: string, args: Record<string, unknown> = {}) => {
		const out = await call(name, args);
		expect(out.r.isError, `${name}: ${out.text}`).toBeFalsy();
		return out;
	};
	const fail = async (name: string, args: Record<string, unknown> = {}) => {
		const out = await call(name, args);
		expect(out.r.isError, `${name} should fail: ${out.text}`).toBe(true);
		return out.json.error as { code: string; message: string; hint?: string; details?: Json };
	};
	return { engine, client, call, ok, fail };
}

const RECIPE: LookRecipe = {
	palette: { face: [1, 1, 1, 1], keyline: [0, 0, 0, 1] },
	layers: [{ type: 'rim', params: { width: 6 } }, { type: 'face' }],
};
// The tools read the shipped library; these tests swap in a small stand-in with known answers and put the real one back.
type StandInLook = Pick<FactoryLook, 'libraryId' | 'name' | 'tags' | 'category' | 'recipe'> &
	Partial<FactoryLook>;
const looks = FACTORY_LOOKS as unknown as StandInLook[];
const ways = FACTORY_COLORWAYS as unknown as Colorway[];
const templates = FACTORY_TEMPLATES as unknown as TitleTemplate[];
const shipped = {
	looks: [...FACTORY_LOOKS] as StandInLook[],
	ways: [...FACTORY_COLORWAYS] as Colorway[],
	templates: [...FACTORY_TEMPLATES],
};
const dark = (r: number): Colorway['palette'] => ({ face: [r, 0.2, 0.2, 1] });

beforeAll(() => {
	looks.length = 0;
	ways.length = 0;
	// Templates insert library looks; the stand-in library has none of theirs.
	templates.length = 0;
	looks.push(
		{
			libraryId: 'look.test-chrome',
			name: 'Chrome Trailer',
			tags: ['cinematic', 'metal'],
			category: 'Cinematic',
			colorways: [{ id: 'cw.own', name: 'Own', palette: dark(0.1) }],
			recipe: RECIPE,
		},
		{
			libraryId: 'look.test-neon',
			name: 'Neon Sign',
			tags: ['neon', 'retro'],
			category: 'Neon & Retro',
			recipe: { ...RECIPE, layers: Array.from({ length: 9 }, () => ({ type: 'glow' })).slice(0, 8) },
		},
		{
			libraryId: 'look.test-plain',
			name: 'Plain Caption',
			tags: ['clean'],
			category: 'Clean',
			recipe: RECIPE,
		},
	);
	ways.push(
		{ id: 'cw.a', name: 'Alpha', palette: dark(0.3) },
		{ id: 'cw.b', name: 'Beta', palette: dark(0.5) },
		{ id: 'cw.c', name: 'Gamma', palette: dark(0.7) },
		{ id: 'cw.d', name: 'Delta', palette: dark(0.9) },
	);
});
afterAll(() => {
	looks.splice(0, looks.length, ...shipped.looks);
	ways.splice(0, ways.length, ...shipped.ways);
	templates.splice(0, templates.length, ...shipped.templates);
});

const footage = (color: number[]) => ({
	projectId: P,
	label: 'Footage',
	commands: [{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color }],
});
const BASE = { projectId: P, text: 'BIG NEWS', at: 0, lookId: 'look.test-plain' };
/** A look of the user's library (TL-054), as the engine's store holds it. */
const USER_LOOK: UserLook = {
	id: 'ulk_00000000000000B1',
	version: 1,
	name: 'Brand Gold',
	tags: ['brand', 'gold'],
	category: 'House',
	colorways: [{ id: 'cw.brand', name: 'Brand', palette: dark(0.6) }],
	recipe: RECIPE,
	createdAt: '2026-11-01T00:00:00.000Z',
	updatedAt: '2026-11-01T00:00:00.000Z',
};
const rowOf = (rows: Json[], id: string) => rows.find((r) => r.id === id)!;

describe('title_look_find (TL-100)', () => {
	it('ranks by words and returns rows and one numbered sheet, with no schemas', async () => {
		const s = await connect();
		const r = await s.ok('title_look_find', { query: 'chrome cinematic' });
		expect(r.json.rows.map((x: Json) => x.lookId)).toEqual(['look.test-chrome']);
		expect(r.json.rows[0]).toMatchObject({
			n: 1,
			name: 'Chrome Trailer',
			tags: ['cinematic', 'metal'],
			colorways: ['cw.own'],
			costClass: 'light',
			renderPath: 'hybrid',
		});
		expect(r.json.libraryColorways.map((c: Json) => c.id)).toEqual(['cw.a', 'cw.b', 'cw.c', 'cw.d']);
		expect(r.r.content.filter((c) => c.type === 'image')).toHaveLength(1);
		expect(r.text).not.toContain('paramsSchema');
		expect(r.text).not.toContain('"recipe"');
		expect(decodePng(Buffer.from(r.image!.data, 'base64')).width).toBeLessThanOrEqual(640);
		expect(s.engine.sheets).toHaveLength(1);
	});

	it('pages with cursor, filters by tags, and costs heavy looks', async () => {
		const s = await connect();
		const first = await s.ok('title_look_find', { query: '', limit: 2 });
		expect(first.json.total).toBe(3);
		expect(first.json.rows).toHaveLength(2);
		expect(first.json.nextCursor).toBe('2');
		const next = await s.ok('title_look_find', { query: '', limit: 2, cursor: '2' });
		expect(next.json.rows).toHaveLength(1);
		expect(next.json.rows[0].n).toBe(3);
		expect(next.json.nextCursor).toBeUndefined();
		const neon = await s.ok('title_look_find', { query: '', tags: ['NEON'] });
		expect(neon.json.rows[0]).toMatchObject({ lookId: 'look.test-neon', costClass: 'medium' });
	});

	it('finds a project’s own looks, and says plainly when nothing matches', async () => {
		const s = await connect();
		const saved = await s.ok('title_look_save', {
			projectId: P,
			recipe: RECIPE,
			name: 'House Style',
			tags: ['house'],
		});
		const hit = await s.ok('title_look_find', { query: 'house', projectId: P });
		expect(hit.json.rows[0]).toMatchObject({ lookId: saved.json.lookId, source: 'project' });
		const none = await s.ok('title_look_find', { query: 'zzz' });
		expect(none.json).toMatchObject({ rows: [], total: 0 });
		expect(none.json.next).toMatch(/No look matches/);
		expect(none.image).toBeUndefined();
	});

	it('finds the user’s own looks (TL-054), says where each row comes from, and needs no project for them', async () => {
		const s = await connect({ userLooks: [USER_LOOK] });
		const r = await s.ok('title_look_find', { query: 'brand' });
		expect(r.json.rows).toHaveLength(1);
		expect(r.json.rows[0]).toMatchObject({
			n: 1,
			lookId: USER_LOOK.id,
			name: 'Brand Gold',
			tags: ['brand', 'gold'],
			colorways: ['cw.brand'],
			source: 'user',
		});
		expect(r.json.userLooksError).toBeUndefined();
		// one sheet, the user look drawn on it from its recipe
		expect(s.engine.sheets).toHaveLength(1);
		const all = await s.ok('title_look_find', { query: '' });
		expect(all.json.total).toBe(4);
		expect(new Set(all.json.rows.map((x: Json) => x.source))).toEqual(new Set(['library', 'user']));
	});

	it('a user look’s id works with title_propose and title_look_find, and its project copy is not a second row', async () => {
		const s = await connect({ userLooks: [USER_LOOK] });
		const recipe = await s.ok('title_look_find', { lookId: USER_LOOK.id });
		expect(recipe.json).toMatchObject({
			lookId: USER_LOOK.id,
			name: 'Brand Gold',
			recipe: { layers: [{ type: 'rim' }, { type: 'face' }] },
			colorways: [{ id: 'cw.brand' }],
		});
		await s.ok('apply_commands', footage([0.1, 0.1, 0.4, 1]));
		const applied = await s.ok('title_propose', {
			...BASE,
			lookId: USER_LOOK.id,
			colorway: 'cw.brand',
			mode: 'apply',
		});
		expect(applied.json.look).toMatchObject({ lookId: USER_LOOK.id, source: 'user' });
		const doc = s.engine.doc() as ProjectDocument & { titleLooks?: Record<string, { sourceId?: string }> };
		const copies = Object.values(doc.titleLooks ?? {}).filter((l) => l.sourceId === USER_LOOK.id);
		expect(copies).toHaveLength(1);
		const again = await s.ok('title_look_find', { query: 'brand', projectId: P });
		expect(again.json.rows.map((x: Json) => [x.lookId, x.source])).toEqual([[USER_LOOK.id, 'user']]);
		// applying it again reuses the project's copy
		await s.ok('title_propose', { ...BASE, at: 150, lookId: USER_LOOK.id, mode: 'apply' });
		const after = s.engine.doc() as typeof doc;
		expect(Object.values(after.titleLooks ?? {}).filter((l) => l.sourceId === USER_LOOK.id)).toHaveLength(1);
	});

	it('a user look deleted since it was used falls back to the project’s copy; an unknown one is not found', async () => {
		const s = await connect({ userLooks: [USER_LOOK] });
		await s.ok('title_propose', { ...BASE, lookId: USER_LOOK.id, mode: 'apply' });
		s.engine.state.userLooks = [];
		const hit = await s.ok('title_look_find', { query: 'brand', projectId: P });
		expect(hit.json.rows[0]).toMatchObject({ name: 'Brand Gold', source: 'project' });
		const r = await s.ok('title_propose', { ...BASE, at: 150, lookId: USER_LOOK.id, mode: 'dryRun' });
		expect(r.json.look).toMatchObject({ name: 'Brand Gold', source: 'project' });
		const e = await s.fail('title_look_find', { lookId: 'ulk_0000000000000ZZZ' });
		expect(e.code).toBe('E_NOT_FOUND');
		expect(e.message).toContain('user');
	});

	it('an unreadable user library still finds the rest, and says so', async () => {
		const s = await connect({ userLooks: 'broken' });
		const r = await s.ok('title_look_find', { query: '' });
		expect(r.json.rows).toHaveLength(3);
		expect(r.json.userLooksError).toMatch(/could not be read: the look library is unreadable/);
	});

	it('is honest about an empty library', async () => {
		const held = looks.splice(0);
		try {
			const s = await connect();
			const r = await s.ok('title_look_find', { query: '' });
			expect(r.json.rows).toEqual([]);
			expect(r.json.next).toMatch(/library of this build holds no looks/);
		} finally {
			looks.push(...held);
		}
	});

	it('searches the shipped library', async () => {
		const held = looks.splice(0, looks.length, ...shipped.looks);
		const heldWays = ways.splice(0, ways.length, ...shipped.ways);
		try {
			const s = await connect();
			const r = await s.ok('title_look_find', { query: 'neon' });
			expect(r.json.rows.length).toBeGreaterThan(0);
			const ids = new Set(shipped.looks.map((l) => l.libraryId));
			for (const row of r.json.rows as Json[]) expect(ids.has(row.lookId as string)).toBe(true);
			expect(r.json.libraryColorways.map((c: Json) => c.id)).toEqual(shipped.ways.map((c) => c.id));
		} finally {
			looks.splice(0, looks.length, ...held);
			ways.splice(0, ways.length, ...heldWays);
		}
	});

	it('lists the library’s title templates as rows of kind template, each drawn on its own sequence, inserted with title.insertTemplate', async () => {
		const held = looks.splice(0, looks.length, ...shipped.looks);
		const heldWays = ways.splice(0, ways.length, ...shipped.ways);
		templates.push(...shipped.templates);
		try {
			const s = await connect();
			const r = await s.ok('title_look_find', { query: 'lower third', limit: 12 });
			const rows = r.json.rows as Json[];
			const tpl = rows.filter((x) => x.kind === 'template');
			expect(tpl.length).toBeGreaterThan(0);
			expect(new Set(tpl.map((x) => x.templateId))).toEqual(
				new Set(shipped.templates.filter((t) => t.kind === 'lower-third').map((t) => t.id)),
			);
			const lower = shipped.templates.find((t) => t.id === tpl[0]!.templateId)!;
			expect(tpl[0]).toMatchObject({
				name: lower.name,
				tags: ['lower-third', ...lower.tags],
				seconds: lower.seconds,
				source: 'library',
				renderPath: 'hybrid',
			});
			expect(Object.keys(tpl[0]!.texts as Json)).toEqual(
				lower.clips.flatMap((c) => (c.kind === 'text' ? [c.slot] : [])),
			);
			expect(tpl[0]).not.toHaveProperty('lookId');
			for (const x of rows.filter((x) => x.kind !== 'template')) expect(x.kind).toBe('look');
			expect(r.json.next).toContain('title.insertTemplate');
			// one sheet, one document; every template on a sequence of its own, at the middle of its span
			expect(s.engine.sheets).toHaveLength(1);
			expect(s.engine.sheets[0]!.documents).toBe(1);
			const cells = s.engine.sheets[0]!.cells as unknown as { sequenceId: string; frame: number }[];
			const tplCells = rows.flatMap((x, i) => (x.kind === 'template' ? [cells[i]!] : []));
			expect(new Set(tplCells.map((c) => c.sequenceId)).size).toBe(tplCells.length);
			expect(tplCells[0]!.frame).toBe(Math.floor(Math.round(lower.seconds * 30) / 2));
			// the route the result names works, with a text of the template's own slot
			const slot = Object.keys(tpl[0]!.texts as Json)[0]!;
			const before = Object.keys(Object.values(s.engine.doc().sequences)[0]!.clips).length;
			await s.ok('apply_commands', {
				projectId: P,
				label: 'Lower third',
				commands: [
					{ type: 'title.insertTemplate', templateId: lower.id, at: 0, texts: { [slot]: 'Ana Ruiz' } },
				],
			});
			const after = Object.values(Object.values(s.engine.doc().sequences)[0]!.clips);
			expect(after.length).toBeGreaterThan(before);
			// a 3D template says what it costs
			const solid = await s.ok('title_look_find', { query: '', tags: ['3d'], limit: 12 });
			expect(solid.json.rows.length).toBeGreaterThanOrEqual(4);
			for (const x of solid.json.rows as Json[]) {
				expect(x.kind).toBe('template');
				expect(['3d', '3d-heavy']).toContain(x.costClass);
			}
		} finally {
			looks.splice(0, looks.length, ...held);
			ways.splice(0, ways.length, ...heldWays);
			templates.length = 0;
		}
	});

	it('bounds its arguments', async () => {
		const s = await connect();
		expect((await s.fail('title_look_find', { query: 'x', limit: 13 })).code).toBe('E_INVALID_ARGUMENT');
		expect((await s.fail('title_look_find', { query: 'x', cursor: 'abc' })).code).toBe('E_INVALID_ARGUMENT');
		expect((await s.fail('title_look_find', { query: 'x', sampleText: 'y'.repeat(41) })).code).toBe(
			'E_INVALID_ARGUMENT',
		);
		expect((await s.fail('title_look_find', { query: 'x', schema: true })).code).toBe('E_UNKNOWN_ARGUMENT');
	});

	it('past its timeout returns the rows, the job and what to do next', async () => {
		const s = await connect({ stuck: true });
		const r = await s.ok('title_look_find', { query: '', timeoutSeconds: 1 });
		expect(r.json.rows).toHaveLength(3);
		expect(r.json).toMatchObject({ timedOut: true, jobId: expect.stringMatching(/^job_/) });
		expect(r.json.next).toContain('render_frames');
		expect(r.image).toBeUndefined();
	});

	it('reads a library look as the resource jasper://title-looks/{id}', async () => {
		const s = await connect();
		const res = await s.client.readResource({ uri: 'jasper://title-looks/look.test-chrome' });
		expect(JSON.parse((res.contents[0] as { text: string }).text)).toMatchObject({
			lookId: 'look.test-chrome',
			recipe: { layers: expect.any(Array) },
		});
		const list = await s.client.listResources();
		expect(list.resources.map((r) => r.uri)).toContain('jasper://title-looks/look.test-neon');
		await expect(s.client.readResource({ uri: 'jasper://title-looks/look.none' })).rejects.toThrow();
	});
});

describe('title_propose (TL-101)', () => {
	it('headless propose is refused with what to do, and stores nothing', async () => {
		const s = await connect();
		const e = await s.fail('title_propose', BASE);
		expect(e.code).toBe('E_NO_EDITOR');
		expect(e.message).toContain('Nothing was stored');
		expect(e.hint).toContain('open_project_in_editor');
		expect(e.hint).toContain('call_tool');
		expect(e.hint).toContain('apply');
		expect(s.engine.proposals.size).toBe(0);
		expect(s.engine.sheets).toHaveLength(0);
	});

	it('with an editor stores a title-art proposal: colourways as alternatives, nothing applied', async () => {
		const s = await connect({ live: true });
		await s.ok('apply_commands', footage([0.1, 0.1, 0.4, 1]));
		const before = s.engine.doc();
		const r = await s.ok('title_propose', { ...BASE, alternatives: 2, seed: 9, colorway: 'Alpha' });
		expect(s.engine.doc()).toBe(before);
		const p = s.engine.proposals.get(r.json.proposalId)!;
		expect(p.feature).toBe(TITLE_ART_FEATURE);
		expect(p.items).toHaveLength(1);
		const item = p.items[0]!;
		expect(item.alternatives).toHaveLength(2);
		expect(titleArtMetaOf(item)).toMatchObject({ lookId: 'look.test-plain', colorwayId: 'cw.a', seed: 9 });
		expect(titleArtMetaOf(item.alternatives![0]!)?.colorwayId).toBeDefined();
		// The rendered rows travel with the item, for Review: what the agent got, at the revision it measured.
		const stored = titleArtCheckOf(item)!;
		expect(stored).toMatchObject({ revision: r.json.check.revision, verified: r.json.check.verified });
		expect(stored.pending).toBeUndefined();
		expect(stored.rows).toEqual(r.json.check.rows);
		expect(stored.rows.find((x) => x.id === 'contrast')?.status).toBe('pass');
		expect(titleArtMetaOf(item)?.renderPath).toBe('hybrid');
		// Only the first option is measured: an alternative carries no rows rather than borrowed ones.
		expect(titleArtCheckOf(item.alternatives![0]!)).toBeNull();
		expect(r.json).toMatchObject({ seed: 9, colorway: { id: 'cw.a' }, timedOut: false });
		expect(r.json.alternatives).toHaveLength(2);
		// one sheet: intro, hold, outro × three options, 640 px wide, on one job
		expect(r.json.cells).toHaveLength(9);
		expect(s.engine.sheets).toHaveLength(1);
		const sheet = decodePng(Buffer.from(r.image!.data, 'base64'));
		expect(sheet.width).toBeLessThanOrEqual(640);
		expect(r.r.content.filter((c) => c.type === 'image')).toHaveLength(1);
		expect(r.json.next).toContain('wait_for_proposal');
		expect(r.json.check.rows.map((x: Json) => x.id)).toEqual(
			expect.arrayContaining([
				'safe-area',
				'off-frame',
				'contrast',
				'min-size',
				'read-time',
				'font-available',
				'export-path',
			]),
		);
	});

	it('the same seed picks the same alternatives', async () => {
		const pick = async () => {
			const s = await connect({ live: true });
			const r = await s.ok('title_propose', { ...BASE, alternatives: 3, seed: 1234 });
			return r.json.alternatives;
		};
		expect(await pick()).toEqual(await pick());
	});

	it('says so when fewer alternatives exist than were asked for', async () => {
		const held = ways.splice(0);
		try {
			const s = await connect({ live: true });
			const r = await s.ok('title_propose', { ...BASE, alternatives: 3 });
			expect(r.json.alternatives).toEqual([]);
			expect(r.json.alternativesNote).toMatch(/3 asked, 0 exist/);
		} finally {
			ways.push(...held);
		}
	});

	it('dryRun changes nothing and checks the title', async () => {
		const s = await connect();
		await s.ok('apply_commands', footage([0.1, 0.1, 0.4, 1]));
		const before = s.engine.doc();
		const r = await s.ok('title_propose', { ...BASE, mode: 'dryRun' });
		expect(r.json.dryRun).toBe(true);
		expect(s.engine.doc()).toBe(before);
		expect(rowOf(r.json.check.rows, 'contrast').status).toBe('pass');
		expect(r.json.next).toContain('Nothing changed');
	});

	it('headless apply adds the title, returns revert, and revert takes it out', async () => {
		const s = await connect();
		await s.ok('apply_commands', footage([0.1, 0.1, 0.4, 1]));
		const before = s.engine.doc();
		const r = await s.ok('title_propose', { ...BASE, mode: 'apply', energy: 'high', seed: 5 });
		const id = r.json.clipIds[0];
		const seq = s.engine.doc().sequences[s.engine.seqId]!;
		expect(seq.clips[id]?.kind).toBe('text');
		expect(r.json.next).toContain('no History');
		expect(r.json.revert.tool).toBe('apply_commands');
		expect(r.json.check.revision).toBe(r.json.revision);
		await s.ok('apply_commands', r.json.revert.arguments);
		const after = s.engine.doc();
		expect(Object.keys(after.sequences[s.engine.seqId]!.clips)).toEqual(
			Object.keys(before.sequences[s.engine.seqId]!.clips),
		);
		expect((after as { titleLooks?: object }).titleLooks ?? {}).toEqual({});
	});

	it('apply with an editor is one undo step and carries no revert', async () => {
		const s = await connect({ live: true });
		const before = s.engine.doc();
		const r = await s.ok('title_propose', { ...BASE, mode: 'apply' });
		expect(r.json.revert).toBeUndefined();
		expect(r.json.appliedLive).toBe(true);
		await s.ok('undo', { projectId: P });
		expect(s.engine.doc()).toBe(before);
	});

	it('apply respects the project’s Agent Proposals setting', async () => {
		const s = await connect();
		await s.ok('apply_commands', {
			projectId: P,
			label: 'off',
			commands: [{ type: 'project.updateSettings', settings: { agentProposals: { 'title-art': false } } }],
		});
		const e = await s.fail('title_propose', { ...BASE, mode: 'apply' });
		expect(e.code).toBe('E_APPROVAL_REQUIRED');
	});

	it('never lands on a clip already there, and defaults its length to the reading time', async () => {
		const s = await connect();
		await s.ok('apply_commands', {
			projectId: P,
			label: 'busy',
			commands: [{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V2', color: [1, 0, 0, 1] }],
		});
		const r = await s.ok('title_propose', { ...BASE, text: 'x'.repeat(90), mode: 'apply', energy: 'low' });
		const seq = s.engine.doc().sequences[s.engine.seqId]!;
		const clip = seq.clips[r.json.clipIds[0]]!;
		const track = seq.videoTracks.findIndex((t) => t.id === clip.trackId);
		expect(track).toBeGreaterThanOrEqual(2);
		// 90 characters at 15 a second, plus the animations
		expect(clip.duration).toBeGreaterThanOrEqual(180);
		expect(rowOf(r.json.check.rows, 'read-time').status).toBe('pass');
	});

	it('refuses what it cannot do, before touching anything', async () => {
		const s = await connect();
		expect((await s.fail('title_propose', { projectId: P, text: 'x', at: 0 })).code).toBe('E_INVALID_PARAM');
		expect(
			(await s.fail('title_propose', { projectId: P, text: 'x', at: 0, lookId: 'a', recipe: RECIPE })).code,
		).toBe('E_INVALID_PARAM');
		expect((await s.fail('title_propose', { ...BASE, lookId: 'look.none', mode: 'dryRun' })).code).toBe(
			'E_NOT_FOUND',
		);
		const cw = await s.fail('title_propose', { ...BASE, colorway: 'nope', mode: 'dryRun' });
		expect(cw.code).toBe('E_NOT_FOUND');
		expect(cw.hint).toContain('cw.a');
		expect((await s.fail('title_propose', { ...BASE, mode: 'dryRun', expectedRevision: 99 })).code).toBe(
			'E_REVISION_MISMATCH',
		);
		expect((await s.fail('title_propose', { ...BASE, alternatives: 4 })).code).toBe('E_INVALID_ARGUMENT');
		const unknownLayer = await s.fail('title_propose', {
			projectId: P,
			text: 'x',
			at: 0,
			mode: 'dryRun',
			recipe: { layers: [{ type: 'no-such-layer' }] },
		});
		expect(unknownLayer.code).toBe('E_INVALID_PARAM');
		expect(unknownLayer.hint).toContain('title_look_find');
		const badParam = await s.fail('title_propose', {
			projectId: P,
			text: 'x',
			at: 0,
			mode: 'dryRun',
			recipe: { layers: [{ type: 'rim', params: { width: 'wide' } }] },
		});
		expect(badParam.code).toBe('E_INVALID_PARAM');
	});

	it('past its timeout the title stands, with the plain rows and the job', async () => {
		const s = await connect({ stuck: true });
		const r = await s.ok('title_propose', { ...BASE, mode: 'apply', timeoutSeconds: 1 });
		expect(r.json.clipIds).toHaveLength(1);
		expect(r.json).toMatchObject({ timedOut: true, jobId: expect.stringMatching(/^job_/) });
		expect(r.json.check.verified).toBe(false);
		expect(r.json.check.notChecked.join(' ')).toContain('still running');
		expect(r.json.check.rows.map((x: Json) => x.id)).not.toContain('contrast');
		expect(r.image).toBeUndefined();
	});

	it('a proposal past its timeout is stored with the plain rows, marked pending', async () => {
		const s = await connect({ stuck: true, live: true });
		const r = await s.ok('title_propose', { ...BASE, timeoutSeconds: 1 });
		expect(r.json).toMatchObject({ timedOut: true, proposalId: expect.stringMatching(/^prp_/) });
		const stored = titleArtCheckOf(s.engine.proposals.get(r.json.proposalId)!.items[0]!)!;
		expect(stored).toMatchObject({ pending: true, verified: false });
		expect(stored.rows.map((x) => x.id)).toEqual(r.json.check.rows.map((x: Json) => x.id));
		expect(stored.rows.map((x) => x.id)).not.toContain('contrast');
	});
});

describe('recipe bounds (TL-106)', () => {
	const propose = (s: Awaited<ReturnType<typeof connect>>, recipe: unknown) =>
		s.call('title_propose', { projectId: P, text: 'x', at: 0, mode: 'dryRun', recipe });

	it('refuses hostile recipes by bytes, layers, depth and instances, and runs no render', async () => {
		const s = await connect();
		let deep: unknown = { end: true };
		for (let i = 0; i < 2000; i++) deep = { deep };
		const hostile: [string, unknown][] = [
			['bytes', { layers: [], padding: 'x'.repeat(RECIPE_BOUNDS.maxBytes + 1) }],
			['layers', { layers: Array.from({ length: RECIPE_BOUNDS.layers + 1 }, () => ({ type: 'face' })) }],
			['nests', { layers: [{ type: 'face', params: deep }] }],
			[
				'of one type',
				{ layers: Array.from({ length: RECIPE_BOUNDS.maxTypeInstances + 1 }, () => ({ type: 'rim' })) },
			],
			[
				'generator',
				{
					layers: Array.from({ length: RECIPE_BOUNDS.maxGeneratorInstances + 1 }, (_, i) => ({
						type: `generator:g${i}`,
					})),
				},
			],
		];
		for (const [word, recipe] of hostile) {
			const r = await propose(s, recipe);
			expect(r.r.isError, word).toBe(true);
			expect(r.json.error.code, word).toBe('E_INVALID_ARGUMENT');
			expect(r.text, word).toContain(word);
		}
		expect(s.engine.sheets).toHaveLength(0);
	});

	it('any JSON as a recipe is a refusal or a dry run, never a crash', async () => {
		const s = await connect();
		await fc.assert(
			fc.asyncProperty(
				fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 4 })),
				async (recipe) => {
					const r = await propose(s, recipe);
					if (r.r.isError) expect(typeof r.json.error.code).toBe('string');
				},
			),
			{ numRuns: 15 },
		);
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						type: fc.constantFrom('face', 'rim', 'glow', 'shadow', 'bogus'),
						params: fc.dictionary(
							fc.constantFrom('width', 'radius', 'paint', 'x'),
							fc.jsonValue({ maxDepth: 2 }),
						),
					}),
					{ maxLength: 6 },
				),
				async (layers) => {
					const r = await propose(s, { layers });
					if (r.r.isError) expect(typeof r.json.error.code).toBe('string');
				},
			),
			{ numRuns: 15 },
		);
	});
});

describe('title_check (TL-102)', () => {
	async function titled(paint: Painted, back: number[], opts: { live?: boolean } = {}) {
		const s = await connect({ ...opts, paint });
		await s.ok('apply_commands', footage(back));
		const r = await s.ok('title_propose', { ...BASE, mode: 'apply', seed: 3 });
		return { s, clipId: r.json.clipIds[0] as string };
	}

	it('passes a clear title with real measurements, bound to the revision', async () => {
		const { s, clipId } = await titled(CENTRED, [0.05, 0.1, 0.3, 1]);
		const r = await s.ok('title_check', { projectId: P, clipId });
		expect(r.json.verified).toBe(true);
		expect(r.json.revision).toBe(2);
		const contrast = rowOf(r.json.rows, 'contrast');
		expect(contrast.status).toBe('pass');
		expect(contrast.measured.ratio).toBeGreaterThan(10);
		expect(contrast.at).toMatchObject({ frame: expect.any(Number), timecode: expect.any(String) });
		expect(rowOf(r.json.rows, 'safe-area').measured.bounds).toEqual(
			expect.objectContaining({ x0: expect.any(Number) }),
		);
		expect(rowOf(r.json.rows, 'export-path').measured).toEqual({ path: 'hybrid' });
		expect(rowOf(r.json.rows, 'font-available').status).toBe('pass');
		expect(r.json.notChecked.join(' ')).toMatch(/Taste/);
		// four renders per frame at rest, on one job
		const sheet = s.engine.sheets.at(-1)!;
		expect(sheet.cells.length % 4).toBe(0);
		expect(sheet.cells.filter((c) => c.hide?.includes(clipId)).length).toBe(sheet.cells.length / 4);
	});

	it('finds a title lost in the real background, with a fix that applies', async () => {
		const { s, clipId } = await titled({ ...CENTRED, face: [235, 235, 235] }, [0.95, 0.95, 0.95, 1]);
		const r = await s.ok('title_check', { projectId: P, clipId });
		expect(r.json.verified).toBe(false);
		const row = rowOf(r.json.rows, 'contrast');
		expect(row.status).toBe('fail');
		expect(row.measured.ratio).toBeLessThan(1.5);
		expect(row.fix.commands[0]).toMatchObject({ type: 'appearance.addLayer', layerType: 'rim' });
		await s.ok('apply_commands', { projectId: P, label: 'fix', commands: row.fix.commands });
	});

	it('finds a title off the frame and outside safe areas, with a move that applies', async () => {
		const { s, clipId } = await titled({ ...CENTRED, x: 0, w: 0.5 }, [0.05, 0.1, 0.3, 1]);
		const r = await s.ok('title_check', { projectId: P, clipId });
		expect(rowOf(r.json.rows, 'off-frame')).toMatchObject({
			status: 'fail',
			measured: { inkTouches: ['left'] },
		});
		const safe = rowOf(r.json.rows, 'safe-area');
		expect(safe.status).toBe('fail');
		await s.ok('apply_commands', { projectId: P, label: 'fix', commands: safe.fix.commands });
	});

	it('reports a title that draws nothing', async () => {
		const { s, clipId } = await titled({ ...CENTRED, w: 0 }, [0.05, 0.1, 0.3, 1]);
		const r = await s.ok('title_check', { projectId: P, clipId });
		expect(rowOf(r.json.rows, 'contrast')).toMatchObject({ status: 'fail', measured: { drawn: false } });
		expect(r.json.verified).toBe(false);
	});

	it('takes the platform from the brief, or target', async () => {
		const { s, clipId } = await titled(CENTRED, [0.05, 0.1, 0.3, 1]);
		const plain = await s.ok('title_check', { projectId: P, clipId });
		expect(rowOf(plain.json.rows, 'target-safe-area')).toBeUndefined();
		const r = await s.ok('title_check', { projectId: P, clipId, target: 'tiktok' });
		expect(rowOf(r.json.rows, 'target-safe-area').kind).toBe('judgement');
	});

	it('checks a proposal before anything is applied, without commands in its fixes', async () => {
		const s = await connect({ live: true, paint: { ...CENTRED, face: [235, 235, 235] } });
		await s.ok('apply_commands', footage([0.95, 0.95, 0.95, 1]));
		const made = await s.ok('title_propose', { ...BASE, alternatives: 1, seed: 2 });
		const before = s.engine.doc();
		const r = await s.ok('title_check', { projectId: P, proposalId: made.json.proposalId, alternative: 1 });
		expect(s.engine.doc()).toBe(before);
		const row = rowOf(r.json.rows, 'contrast');
		expect(row.status).toBe('fail');
		expect(row.fix.label).toBeDefined();
		expect(row.fix.commands).toBeUndefined();
		expect(
			(await s.fail('title_check', { projectId: P, proposalId: made.json.proposalId, alternative: 5 })).code,
		).toBe('E_INVALID_PARAM');
	});

	it('refuses what is not a title and mixed subjects', async () => {
		const s = await connect();
		await s.ok('apply_commands', footage([0, 0, 0, 1]));
		expect((await s.fail('title_check', { projectId: P })).code).toBe('E_INVALID_PARAM');
		expect((await s.fail('title_check', { projectId: P, clipId: 'clp_x', proposalId: 'prp_x' })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await s.fail('title_check', { projectId: P, clipId: 'clp_x', itemId: 'title' })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await s.fail('title_check', { projectId: P, clipId: 'clp_none' })).code).toBe('E_NOT_FOUND');
	});

	it('past its timeout returns the plain rows, and a later call picks up the job', async () => {
		const s = await connect({ stuck: true });
		await s.ok('apply_commands', footage([0.05, 0.1, 0.3, 1]));
		const applied = await s.ok('title_propose', { ...BASE, mode: 'apply', timeoutSeconds: 1 });
		const clipId = applied.json.clipIds[0];
		const r = await s.ok('title_check', { projectId: P, clipId, timeoutSeconds: 1 });
		expect(r.json).toMatchObject({ timedOut: true, verified: false });
		expect(r.json.next).toContain('jobId');
		const job = s.engine.jobs.get(r.json.jobId)!;
		job.state = 'failed';
		job.error = { code: 'RENDER_FAILED', message: 'boom' };
		expect((await s.fail('title_check', { projectId: P, clipId, jobId: r.json.jobId })).code).toBe(
			'RENDER_FAILED',
		);
	});
});

describe('style lint rows (TL-056 through TL-102)', () => {
	const input = {
		appearance: { v: 1, palette: {}, light: {}, seed: 1, layers: [] } as never,
		clip: { id: 'clp_1', kind: 'text', content: { text: 'Hi' } } as never,
		effectInstanceId: 'fx_1',
		at: { frame: 4, sec: 0, timecode: 't' },
		fixes: true,
		time: 0,
		sizePx: 100,
		frameHeight: 1080,
		backdrops: [20, 80],
	};
	it('passes what was measured, keeps the worst answer per issue, and maps severities', () => {
		const seen: Json[] = [];
		const rows = titleLintRows(input, (_a, ctx) => {
			seen.push(ctx);
			const light = (ctx.rendered as { backdropL: number }).backdropL > 50;
			return {
				unmeasured: [],
				issues: [
					{
						id: 'backdrop',
						severity: light ? 'error' : 'warning',
						message: 'close',
						rule: 'rule',
						measured: 4,
						expected: 'ΔL ≥ 20',
						fixable: true,
						fix: { label: 'Add a soft halo', commands: [{ type: 'appearance.addLayer' }] },
					},
					{ id: 'flat', severity: 'info', message: 'one colour', rule: 'keep it simple', fixable: false },
				],
			};
		});
		expect(seen.map((c) => c.rendered)).toEqual([
			{ backdropL: 20, frames: 2 },
			{ backdropL: 80, frames: 2 },
		]);
		expect(seen[0]).toMatchObject({
			effectInstanceId: 'fx_1',
			clipKind: 'text',
			text: 'Hi',
			sizePx: 100,
			frameHeight: 1080,
		});
		expect(rows[0]).toMatchObject({
			id: 'lint-backdrop',
			kind: 'format',
			status: 'fail',
			measured: 4,
			expected: 'ΔL ≥ 20',
			fix: { label: 'Add a soft halo' },
		});
		expect(rows[1]).toMatchObject({
			id: 'lint-flat',
			kind: 'judgement',
			status: 'pass',
			expected: 'keep it simple',
		});
	});

	it('a rendered check that did not run is unverified, and a proposal gets no commands', () => {
		const rows = titleLintRows({ ...input, fixes: false, backdrops: [] }, () => ({
			unmeasured: ['backdrop-contrast'],
			issues: [{ id: 'thin', severity: 'warning', message: 'thin', rule: 'r', fixable: true }],
		}));
		expect(rows.map((r) => [r.id, r.status])).toEqual([
			['lint-thin', 'warn'],
			['lint-backdrop-contrast', 'unverified'],
		]);
		expect(rows[0]!.fix?.commands).toBeUndefined();
	});

	it('a build without the lint never reads as a clean look', () => {
		expect(titleLintRows(input, null)).toMatchObject([{ id: 'lint', status: 'unverified' }]);
	});

	it('runs the library lint by default: real issues, real fixes, and the measured backdrop', () => {
		let n = 0;
		const appearance = appearanceFromRecipe(
			{
				palette: { face: [1, 1, 1, 1], keyline: [0.95, 0.95, 0.95, 1] },
				layers: [{ type: 'rim', params: { width: 1 } }, { type: 'face' }],
			},
			() => `apl_${String(++n).padStart(16, '0')}`,
		);
		const rows = titleLintRows({ ...input, appearance, backdrops: [97] });
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get('lint-backdrop')).toMatchObject({ kind: 'format', status: 'fail' });
		expect(byId.get('lint-rims-thin')).toMatchObject({ status: 'warn' });
		expect(byId.get('lint-rims-thin')!.fix?.commands?.length).toBeGreaterThan(0);
		expect([...byId.keys()].some((id) => id.startsWith('lint-contrast-'))).toBe(true);
		expect(byId.has('lint')).toBe(false);
		const unmeasured = titleLintRows({ ...input, appearance, backdrops: [] });
		expect(unmeasured.find((r) => r.id === 'lint-backdrop-contrast')).toMatchObject({ status: 'unverified' });
	});
});

describe('render_frames extensions (TL-103)', () => {
	it('draws the margins the Program monitor draws', () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
		const monitor = readFileSync(join(root, 'apps/web/src/panels/program/TransformOverlay.tsx'), 'utf8');
		expect(monitor).toContain(
			`SAFE_MARGINS = { action: ${TITLE_SAFE_MARGINS.action}, title: ${TITLE_SAFE_MARGINS.title} }`,
		);
	});

	it('runs a sheet as one job, draws the safe area, and returns one image', async () => {
		const s = await connect();
		await s.ok('apply_commands', footage([0, 0, 0, 1]));
		const plain = await s.ok('render_frames', { projectId: P, times: [0, 10], width: 160 });
		const r = await s.ok('render_frames', { projectId: P, times: [0, 10], width: 160, overlay: 'safe-area' });
		expect(s.engine.sheets).toHaveLength(2);
		expect(r.json).toMatchObject({ timedOut: false, columns: 2, jobId: expect.stringMatching(/^job_/) });
		expect(r.json.cells.map((c: Json) => c.frame)).toEqual([0, 10]);
		const a = decodePng(Buffer.from(plain.image!.data, 'base64'));
		const b = decodePng(Buffer.from(r.image!.data, 'base64'));
		const lit = (img: typeof a) => img.data.reduce((n, v, i) => n + (i % 4 === 0 && v > 60 ? 1 : 0), 0);
		expect(lit(b)).toBeGreaterThan(lit(a));
	});

	it('wait: false and a timeout return {jobId, next}; jobId fetches the sheet later', async () => {
		const s = await connect();
		await s.ok('apply_commands', footage([0, 0, 0, 1]));
		const queued = await s.ok('render_frames', { projectId: P, times: [0, 5], width: 160, wait: false });
		expect(queued.json).toMatchObject({ timedOut: false, next: expect.stringContaining('render_frames') });
		expect(queued.image).toBeUndefined();
		const later = await s.ok('render_frames', { projectId: P, jobId: queued.json.jobId });
		expect(later.image).toBeDefined();
		expect(later.json.cells).toHaveLength(2);
		const stuck = await connect({ stuck: true });
		await stuck.ok('apply_commands', footage([0, 0, 0, 1]));
		const r = await stuck.ok('render_frames', { projectId: P, times: [0], timeoutSeconds: 1 });
		expect(r.json).toMatchObject({ timedOut: true, state: 'running' });
		expect(r.json.next).toContain('cancel_job');
	});

	it('cancelling the request cancels the job', async () => {
		const s = await connect({ stuck: true });
		await s.ok('apply_commands', footage([0, 0, 0, 1]));
		const ac = new AbortController();
		const pending = s.client.callTool(
			{ name: 'render_frames', arguments: { projectId: P, times: [0, 1] } },
			undefined,
			{ signal: ac.signal, onprogress: () => {} },
		);
		await expect.poll(() => s.engine.jobs.size, { timeout: 5000 }).toBe(1);
		ac.abort();
		await expect(pending).rejects.toThrow();
		await expect.poll(() => s.engine.cancelled.length, { timeout: 5000 }).toBe(1);
	});

	it('shows a proposal’s options, one row each, nothing applied', async () => {
		const s = await connect({ live: true });
		await s.ok('apply_commands', footage([0.1, 0.1, 0.4, 1]));
		const made = await s.ok('title_propose', { ...BASE, alternatives: 2, seed: 2 });
		const before = s.engine.doc();
		const r = await s.ok('render_frames', { projectId: P, proposalId: made.json.proposalId });
		expect(s.engine.doc()).toBe(before);
		expect(r.json.cells).toHaveLength(9);
		expect(r.json.columns).toBe(3);
		expect(r.json.cells[3].label).toContain('title 1:');
		expect(s.engine.sheets.at(-1)!.documents).toBe(3);
		const one = await s.ok('render_frames', {
			projectId: P,
			proposalId: made.json.proposalId,
			itemIds: ['title'],
			count: 1,
		});
		expect(one.json.cells).toHaveLength(3);
		expect(
			(await s.fail('render_frames', { projectId: P, proposalId: made.json.proposalId, itemIds: ['nope'] }))
				.code,
		).toBe('E_NOT_FOUND');
	});

	it('refuses mixed arguments, and caps alternatives × frames', async () => {
		const s = await connect({ live: true });
		await s.ok('apply_commands', footage([0, 0, 0, 1]));
		expect((await s.fail('render_frames', { projectId: P, itemIds: ['a'] })).code).toBe('E_INVALID_PARAM');
		expect((await s.fail('render_frames', { projectId: P, proposalId: 'p', clipId: 'c' })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await s.fail('render_frames', { projectId: P, jobId: 'j', count: 3 })).code).toBe(
			'E_INVALID_PARAM',
		);
		const made = await s.ok('title_propose', { ...BASE, alternatives: 3, seed: 2 });
		expect(
			(await s.fail('render_frames', { projectId: P, proposalId: made.json.proposalId, count: 7 })).code,
		).toBe('E_LIMIT');
	});
});

describe('escape hatch (TL-104)', () => {
	it('title_look_find returns a library look, what its layers take, and every type, without schemas', async () => {
		const s = await connect();
		const r = await s.ok('title_look_find', { lookId: 'look.test-chrome' });
		expect(r.json.recipe).toEqual(RECIPE);
		expect(r.json.colorways[0].id).toBe('cw.own');
		expect(r.json.layerParams.rim.map((p: Json) => p.name)).toContain('width');
		expect(r.json.layerTypes.map((t: Json) => t.type)).toEqual(
			expect.arrayContaining(['face', 'rim', 'shadow', 'glow']),
		);
		expect(r.text).not.toContain('additionalProperties');
		expect((await s.fail('title_look_find', { lookId: 'look.none' })).code).toBe('E_NOT_FOUND');
	});

	it('title_look_save saves a recipe and a clip’s look; both apply and read back', async () => {
		const s = await connect();
		const saved = await s.ok('title_look_save', {
			projectId: P,
			recipe: RECIPE,
			name: 'Saved',
			tags: ['house'],
		});
		expect(saved.json.lookId).toMatch(/^tlk_/);
		const back = await s.ok('title_look_find', { lookId: saved.json.lookId, projectId: P });
		expect(back.json.recipe.layers.map((l: Json) => l.type)).toEqual(['rim', 'face']);
		expect((await s.fail('title_look_save', { projectId: P, recipe: RECIPE, name: 'saved' })).code).toBe(
			'E_INVALID_PARAM',
		);
		const applied = await s.ok('title_propose', {
			projectId: P,
			text: 'x',
			at: 0,
			lookId: saved.json.lookId,
			mode: 'apply',
		});
		const fromClip = await s.ok('title_look_save', {
			projectId: P,
			clipId: applied.json.clipIds[0],
			name: 'From clip',
			link: true,
		});
		expect(fromClip.json.lookId).toMatch(/^tlk_/);
		expect((await s.fail('title_look_save', { projectId: P, name: 'x' })).code).toBe('E_INVALID_PARAM');
		const hostile = await s.fail('title_look_save', {
			projectId: P,
			name: 'h',
			recipe: { layers: Array.from({ length: 25 }, () => ({ type: 'face' })) },
		});
		expect(hostile.code).toBe('E_INVALID_ARGUMENT');
	});

	it('title_propose takes a recipe, and a recipe’s look carries its name', async () => {
		const s = await connect();
		const r = await s.ok('title_propose', {
			projectId: P,
			text: 'x',
			at: 0,
			recipe: RECIPE,
			name: 'One Off',
			mode: 'apply',
		});
		expect(r.json.look).toMatchObject({ lookId: null, name: 'One Off', source: 'recipe' });
		const looksInDoc = Object.values(
			(s.engine.doc() as { titleLooks?: Record<string, { name: string }> }).titleLooks!,
		);
		expect(looksInDoc.map((l) => l.name)).toEqual(['One Off']);
	});

	it('title_generator_add places a standalone generator, and refuses without what it needs', async () => {
		const s = await connect();
		const generate = registries.effects.list().find((e) => e.category === 'Generate' && !e.internal)!;
		const r = await s.ok('title_generator_add', {
			projectId: P,
			generator: generate.id,
			at: 0,
			duration: 30,
		});
		expect(r.json.ok).toBe(true);
		expect(r.json.refs.$generator).toMatch(/^clp_/);
		expect((await s.fail('title_generator_add', { projectId: P, generator: generate.id })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect(
			(
				await s.fail('title_generator_add', {
					projectId: P,
					generator: generate.id,
					clipId: r.json.refs.$generator,
				})
			).code,
		).toBe('E_INVALID_PARAM');
		expect(
			(await s.fail('title_generator_add', { projectId: P, generator: 'x', clipId: 'c', at: 0 })).code,
		).toBe('E_INVALID_PARAM');
	});

	it('title_light_set sets, and clears, the sequence light', async () => {
		const s = await connect();
		await s.ok('title_light_set', { projectId: P, angle: 120, altitude: 30 });
		const seq = () => s.engine.doc().sequences[s.engine.seqId]!;
		expect((seq().settings as { globalLight?: { angle: { value: number } } }).globalLight?.angle.value).toBe(
			120,
		);
		await s.ok('title_light_set', { projectId: P, clear: true });
		expect((seq().settings as { globalLight?: unknown }).globalLight).toBeUndefined();
		expect((await s.fail('title_light_set', { projectId: P })).code).toBe('E_INVALID_PARAM');
		expect((await s.fail('title_light_set', { projectId: P, altitude: 91 })).code).toBe('E_INVALID_ARGUMENT');
	});

	it('get_clip_properties lists a look’s targets', async () => {
		const s = await connect();
		const r = await s.ok('title_propose', { ...BASE, mode: 'apply' });
		const props = await s.ok('get_clip_properties', {
			projectId: P,
			clipId: r.json.clipIds[0],
			keys: ['appearance'],
		});
		const width = props.json.properties.find((p: Json) => p.key.endsWith('.width'));
		expect(width.target[0]).toBe('appearance');
		await s.ok('apply_commands', {
			projectId: P,
			label: 'wider',
			commands: [{ type: 'param.set', target: width.target, value: 9 }],
		});
	});
});

describe('effects discovery (TL-105)', () => {
	it('lists without schemas, pages, searches and describes one effect', async () => {
		const s = await connect();
		const page = await s.ok('list_effects', { limit: 5 });
		expect(page.json.effects).toHaveLength(5);
		expect(page.json.total).toBeGreaterThan(5);
		expect(page.json.nextCursor).toBe('5');
		expect(page.text).not.toContain('"params"');
		expect(page.json.categories.length).toBeGreaterThan(1);
		const next = await s.ok('list_effects', { limit: 5, cursor: '5' });
		expect(next.json.effects[0].id).not.toBe(page.json.effects[0].id);
		const blur = await s.ok('list_effects', { query: 'gaussian blur' });
		expect(blur.json.effects.map((e: Json) => e.id)).toContain('jasper.gaussian-blur');
		const one = await s.ok('list_effects', { effectId: 'jasper.gaussian-blur' });
		expect(one.json.params.map((p: Json) => p.name)).toContain('radius');
		expect((await s.fail('list_effects', { effectId: 'nope' })).code).toBe('E_NOT_FOUND');
		const looks = await s.ok('list_effects', { query: 'title-look' });
		expect(looks.json.total).toBe(0);
	});

	it('describe_commands no longer drops effects: they are counted with its catalogues', async () => {
		const s = await connect();
		const lean = await s.ok('describe_commands');
		expect(lean.json.effects).toBeUndefined();
		const r = await s.ok('describe_commands', { catalogues: true });
		expect(r.json.effects.count).toBeGreaterThan(10);
		expect(r.json.effects.hint).toContain('list_effects');
	});

	it('the server instructions name list_effects and the titles toolset, so agents with core only find them', async () => {
		const instructions = buildInstructions();
		expect(instructions).toContain('`list_effects`');
		expect(instructions).toMatch(
			/titles \(styled title looks: `title_look_find`, `title_propose`, `title_check`\)/,
		);
	});

	it('adds an effect and sets and keys its params', async () => {
		const s = await connect();
		const placed = await s.ok('apply_commands', {
			projectId: P,
			label: 'x',
			commands: [{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1], ref: '$s' }],
		});
		const clipId = placed.json.refs.$s;
		const add = await s.ok('add_effect', {
			projectId: P,
			clipId,
			effectId: 'jasper.gaussian-blur',
			params: { radius: 4 },
		});
		expect(add.json.next).toContain('set_effect_param');
		const fx = (
			s.engine.doc().sequences[s.engine.seqId]!.clips[clipId] as never as {
				effects: { id: string; params: Json }[];
			}
		).effects[0]!;
		expect(fx.params.radius.value).toBe(4);
		await s.ok('set_effect_param', { projectId: P, effectInstanceId: fx.id, param: 'radius', value: 9 });
		const read = () =>
			(s.engine.doc().sequences[s.engine.seqId]!.clips[clipId] as never as { effects: { params: Json }[] })
				.effects[0]!;
		expect(read().params.radius.value).toBe(9);
		await s.ok('set_effect_param', {
			projectId: P,
			effectInstanceId: fx.id,
			param: 'radius',
			value: 12,
			at: 10,
			keyframe: true,
		});
		expect(read().params.radius.keyframes.length).toBeGreaterThan(0);
		expect(
			(
				await s.fail('set_effect_param', {
					projectId: P,
					effectInstanceId: fx.id,
					param: 'radius',
					value: 1,
					keyframe: true,
				})
			).code,
		).toBe('E_INVALID_PARAM');
		expect((await s.fail('add_effect', { projectId: P, effectId: 'x' })).code).toBe('E_INVALID_PARAM');
		expect(
			(await s.fail('add_effect', { projectId: P, clipId, effectId: 'jasper.title-look' })).code,
		).toMatch(/^E_/);
	});
});
