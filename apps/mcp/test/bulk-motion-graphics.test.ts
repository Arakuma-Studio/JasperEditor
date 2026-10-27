// duplicate_motion_graphic ("Add another") and import_motion_graphics_csv (docs/wp-notes/social-comments.md
// "Add another & bulk import"). The fake engine applies transactions with @jasper/project (as the real engine
// does) and serves a catalogue with a social-comment-shaped test template (re-roll and import hints, presets, fill
// hook) — @jasper/mg-templates is not a dependency of this app, so the real social-comment template is covered by
// packages/mg-templates/test/social-bulk.test.ts.
import {
	type MgTemplateCatalogEntry,
	type MgTemplatesResponse,
	MgTemplatesResponseSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	type MgTemplateUi,
	mgItemSeed,
	type ProjectDocument,
	TABLE_MAX_ROWS,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const VARIANTS = ['tok-reply', 'gram-post'] as const;
const commentParams = z.strictObject({
	variant: z.enum(VARIANTS).default('tok-reply'),
	displayName: z.string().min(1).max(64).default('Display Name'),
	handle: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9._-]+$/)
		.default('username'),
	verified: z.boolean().default(false),
	likes: z.number().int().min(0).max(1e12).default(10),
	text: z.string().max(400).default('Write any comment'),
	/** A template media param (like social-comment's avatar): `{mediaId}` of a medium in the project, or null. */
	avatar: z.object({ mediaId: z.string() }).nullable().default(null),
});
const lowerParams = z.strictObject({
	name: z.string().max(60).default('Name'),
	size: z.number().min(10).max(200).default(40),
});
const jsonSchema = (s: z.ZodType) =>
	z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;

const COMMENT_UI: MgTemplateUi = {
	params: { text: { label: 'Comment' }, displayName: { label: 'Display Name' }, variant: { label: 'Style' } },
	addAnother: { reroll: ['displayName', 'handle', 'likes'] },
	import: {
		aliases: {
			User: {
				byParam: 'variant',
				map: { 'tok-reply': 'displayName', 'gram-post': 'handle' },
				otherwise: 'displayName',
			},
			Username: 'handle',
		},
		ignored: { 'Image URL': 'Pictures from web addresses are not imported' },
		trimPrefix: { handle: '@' },
	},
};
const COMMENT: MgTemplateCatalogEntry = {
	id: 'comment',
	version: 1,
	name: 'Comment',
	category: 'Social comments',
	paramsSchema: jsonSchema(commentParams),
	defaults: commentParams.parse({}),
	introFrames: 6,
	outroFrames: 6,
	defaultDurationSeconds: 4,
	canvases: ['1080x1920'],
	native: false,
	renderer: 'anime',
	presets: [
		{ id: 'tok-reply', name: 'Tok reply', params: { variant: 'tok-reply' } },
		{ id: 'gram-post', name: 'Gram post', params: { variant: 'gram-post', likes: 114 } },
	],
	ui: JSON.parse(JSON.stringify(COMMENT_UI)),
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

/** A template with an age in one cell (`ui.import.age`, like social-comment's timeValue + timeUnit). */
const agedParams = z.strictObject({
	text: z.string().max(400).default('Hi'),
	timeValue: z.number().int().min(0).max(9999).default(1),
	timeUnit: z.enum(['minute', 'hour', 'day', 'week', 'month', 'year']).default('day'),
});
const AGED_UI: MgTemplateUi = {
	params: { timeValue: { label: 'Posted' } },
	import: { aliases: { Ago: 'timeValue' }, age: { value: 'timeValue', unit: 'timeUnit', columns: ['Time'] } },
};
const AGED: MgTemplateCatalogEntry = {
	id: 'aged',
	version: 1,
	name: 'Aged',
	category: 'Social comments',
	paramsSchema: jsonSchema(agedParams),
	defaults: agedParams.parse({}),
	defaultDurationSeconds: 4,
	canvases: ['1080x1920'],
	native: false,
	renderer: 'anime',
	ui: JSON.parse(JSON.stringify(AGED_UI)),
};

const NAMES = ['Ana', 'Bo', 'Cy', 'Dee', 'Eli'];
const commentFill: MgTemplateInfo['fill'] = (partial, seed) => {
	if (partial.text === 'refuse') return { ok: false, error: 'this text cannot be filled' };
	const out = { ...partial };
	const filled: string[] = [];
	if (out.displayName === undefined) {
		out.displayName = NAMES[seed % NAMES.length]!;
		filled.push('displayName');
	}
	if (out.handle === undefined) {
		out.handle = `h${seed % 1000}`;
		filled.push('handle');
	}
	if (out.likes === undefined) {
		out.likes = seed % 10_000;
		filled.push('likes');
	}
	return { ok: true, params: out, filled };
};
const infoOf = (
	t: MgTemplateCatalogEntry,
	schema: z.ZodType,
	extra: Partial<MgTemplateInfo> = {},
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
	defaultDurationSeconds: t.defaultDurationSeconds,
	...(t.renderer ? { renderer: t.renderer } : {}),
	...extra,
});
const registries = defaultRegistries(
	createStaticMgRegistry([
		infoOf(COMMENT, commentParams, { fill: commentFill, ui: COMMENT_UI, presets: COMMENT.presets }),
		infoOf(LOWER, lowerParams),
		infoOf(AGED, agedParams, { ui: AGED_UI }),
	]),
);

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Bulk', preset: 'hd-1080p-30' });
	let revision = 1;
	const txs: { label: string; commands: unknown[]; dryRun?: boolean }[] = [];
	const client: Record<string, unknown> = {
		mgTemplates: async (): Promise<MgTemplatesResponse> => ({
			templates: [COMMENT, LOWER, AGED],
			renderer: { status: 'unavailable', reason: 'not built' },
		}),
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: { label: string; dryRun?: boolean; commands: unknown[] } }) => {
			const tx = req.transaction;
			txs.push({ label: tx.label, commands: tx.commands, ...(tx.dryRun ? { dryRun: true } : {}) });
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
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	/** Applies commands directly (test setup). */
	const setup = (commands: unknown[]) => {
		const r = applyTransaction(doc, { label: 'setup', origin: 'user', commands } as never, {
			ids,
			now: () => '2026-10-25T00:00:00.000Z',
			revision,
			registries,
		});
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
		revision++;
		return r.result;
	};
	return { link, txs, setup, doc: () => doc, revision: () => revision };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(engine: ReturnType<typeof fakeEngine>) {
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'bulk-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'bulk-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) =>
		(await client.callTool({
			name,
			arguments: { projectId: engine.doc().projectId, ...args },
		})) as CallToolResult;
	return { client, call };
}

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
// biome-ignore lint/suspicious/noExplicitAny: test JSON bodies
type Json = any;
const ok = (r: CallToolResult): Json => {
	expect(r.isError, textOf(r)).toBeFalsy();
	return JSON.parse(textOf(r));
};
const err = (r: CallToolResult) => {
	expect(r.isError, textOf(r)).toBe(true);
	return (
		JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string; details?: Json } }
	).error;
};
const seqOf = (doc: ProjectDocument) => Object.values(doc.sequences)[0]!;

function addComment(engine: ReturnType<typeof fakeEngine>, extra: Record<string, unknown> = {}): string {
	const r = engine.setup([
		{
			type: 'clip.addMotionGraphic',
			at: 30,
			duration: 120,
			track: 'V2',
			template: { id: 'comment', version: 1 },
			params: {
				variant: 'gram-post',
				displayName: 'Orig',
				handle: 'orig',
				text: 'Keep me',
				likes: 7,
				verified: true,
			},
			ref: '$c',
			...extra,
		},
	]);
	return r.refs.$c!;
}

describe('duplicate_motion_graphic', () => {
	it('adds one copy right after the source, re-randomizing only the hinted params', async () => {
		const engine = fakeEngine();
		const src = addComment(engine);
		const { call } = await connect(engine);
		const body = ok(await call('duplicate_motion_graphic', { clipId: src, seed: 3 }));
		expect(engine.txs).toHaveLength(1);
		expect(engine.txs[0]!.label).toBe('Add Another');
		expect(body.seed).toBe(3);
		expect(body.items).toHaveLength(1);
		const copy = body.items[0];
		expect(copy).toMatchObject({
			index: 0,
			sourceClipId: src,
			track: 'V2',
			start: 150,
			end: 270,
			duration: 120,
			startTimecode: '00:00:05:00',
			seed: mgItemSeed(3, 0),
		});
		expect(copy.params).toEqual({
			variant: 'gram-post',
			displayName: NAMES[3],
			handle: 'h3',
			text: 'Keep me',
			likes: 3,
			verified: true,
			avatar: null,
		});
		expect([...copy.rerolled].sort()).toEqual(['displayName', 'handle', 'likes']);
		expect((seqOf(engine.doc()).clips[copy.clipId] as unknown as { params: unknown }).params).toEqual(
			copy.params,
		);
	});

	it('count chains copies one after another in one transaction, deterministically for a seed', async () => {
		const engine = fakeEngine();
		const src = addComment(engine);
		const { call } = await connect(engine);
		const a = ok(await call('duplicate_motion_graphic', { clipId: src, count: 3, seed: 9, dryRun: true }));
		expect(a.note).toContain('Dry run');
		expect(engine.revision()).toBe(2);
		const b = ok(await call('duplicate_motion_graphic', { clipId: src, count: 3, seed: 9 }));
		expect(engine.txs.map((t) => t.label)).toEqual(['Add 3 More', 'Add 3 More']);
		expect(engine.revision()).toBe(3);
		expect(b.items.map((i: Json) => [i.track, i.start, i.end])).toEqual([
			['V2', 150, 270],
			['V2', 270, 390],
			['V2', 390, 510],
		]);
		expect(b.items.map((i: Json) => i.params)).toEqual(a.items.map((i: Json) => i.params));
		expect(b.items[1].sourceClipId).toBe(b.items[0].clipId);
		expect(new Set(b.items.map((i: Json) => i.seed)).size).toBe(3);
	});

	it('repeated calls on the same source continue the sequence after the last consecutive copy', async () => {
		const engine = fakeEngine();
		const src = addComment(engine);
		const { call } = await connect(engine);
		const a = ok(await call('duplicate_motion_graphic', { clipId: src, count: 2, seed: 4 }));
		expect(a.items.map((i: Json) => [i.track, i.start])).toEqual([
			['V2', 150],
			['V2', 270],
		]);
		const b = ok(await call('duplicate_motion_graphic', { clipId: src, seed: 5 }));
		expect(b.items.map((i: Json) => [i.track, i.start, i.end])).toEqual([['V2', 390, 510]]);
		expect(b.items[0].sourceClipId).toBe(src);
	});

	it('takes at, track and params (which win and are not re-randomized); never overwrites', async () => {
		const engine = fakeEngine();
		const src = addComment(engine);
		engine.setup([{ type: 'clip.addSolid', at: 0, duration: 600, track: 'V1', color: [0, 0, 0, 1] }]);
		const { call } = await connect(engine);
		const body = ok(
			await call('duplicate_motion_graphic', {
				clipId: src,
				at: '10s',
				track: 'V1',
				params: { text: 'New text', handle: 'given' },
				seed: 1,
			}),
		);
		expect(body.items[0]).toMatchObject({ track: 'V2', start: 300 });
		expect(body.items[0].params).toMatchObject({ text: 'New text', handle: 'given', verified: true });
		expect([...body.items[0].rerolled].sort()).toEqual(['displayName', 'likes']);
	});

	it('refuses an unknown clip, a clip that is not a motion graphic and bad params as MCP errors', async () => {
		const engine = fakeEngine();
		const src = addComment(engine);
		engine.setup([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0, 1], ref: '$s' },
		]);
		const solid = Object.values(seqOf(engine.doc()).clips).find((c) => c.kind === 'solid')!.id;
		const { call } = await connect(engine);
		const before = engine.doc();
		expect(err(await call('duplicate_motion_graphic', { clipId: 'clp_nope' })).code).toBe('E_NOT_FOUND');
		const kind = err(await call('duplicate_motion_graphic', { clipId: solid }));
		expect(kind.code).toBe('E_INVALID_PARAM');
		expect(kind.message).toContain('motion-graphic');
		const bad = err(await call('duplicate_motion_graphic', { clipId: src, count: 2, params: { likes: -1 } }));
		expect(bad.code).toBe('E_INVALID_PARAM');
		expect(bad.message).toMatch(/^copy 1: /);
		expect(bad.details.items[0]).toMatchObject({ index: 0, code: 'E_INVALID_PARAM' });
		expect(err(await call('duplicate_motion_graphic', { clipId: src, count: 51 })).code).toBe(
			'E_INVALID_ARGUMENT',
		);
		expect(engine.doc()).toBe(before);
	});
});

describe('import_motion_graphics_csv', () => {
	it('reads an age in one Time / Ago / Posted cell into the count and unit params (same planner as the editor)', async () => {
		// the catalogue schema the engine client parses keeps the hint
		const parsed = MgTemplatesResponseSchema.parse({
			templates: [AGED],
			renderer: { status: 'unavailable', reason: 'x' },
		});
		expect(parsed.templates[0]!.ui?.import?.age).toEqual({
			value: 'timeValue',
			unit: 'timeUnit',
			columns: ['Time'],
		});
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const body = ok(
			await call('import_motion_graphics_csv', {
				template: 'aged',
				csv: 'text,Time\nA,3h\nB,2 weeks\nC,just now\nD,10 months ago',
				seed: 1,
			}),
		);
		expect(body.columns).toEqual([
			{ column: 'text', param: 'text' },
			{ column: 'Time', param: 'timeValue' },
		]);
		expect(body.rows.map((r: Json) => [r.params.timeValue, r.params.timeUnit])).toEqual([
			[3, 'hour'],
			[2, 'week'],
			[0, 'day'],
			[10, 'month'],
		]);
		const bad = err(
			await call('import_motion_graphics_csv', { template: 'aged', csv: 'text,Posted\nA,soon', seed: 1 }),
		);
		expect(JSON.stringify(bad)).toContain('Posted: \\"soon\\" is not an age');
	});

	it('imports one graphic per row, sequentially from startAt, with aliases, labels and the preset', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const csv =
			'User,Comment,Likes,Verified,Image URL,Mood\n' +
			'@luna.park,"First, with comma",1.2K,yes,https://x/a.png,happy\n' +
			'bo,Second,,no,,\n' +
			'cy,"Line 1\nLine 2",3,1,,\n';
		const body = ok(
			await call('import_motion_graphics_csv', {
				template: 'comment:gram-post',
				csv,
				startAt: '2s',
				seed: 5,
			}),
		);
		expect(engine.txs).toHaveLength(1);
		expect(engine.txs[0]!.label).toBe('Import 3 motion graphics');
		expect(body).toMatchObject({ template: 'comment@1:gram-post', delimiter: 'comma', seed: 5 });
		expect(body.columns).toEqual([
			{
				column: 'User',
				param: 'by variant: tok-reply → displayName, gram-post → handle; otherwise displayName',
			},
			{ column: 'Comment', param: 'text' },
			{ column: 'Likes', param: 'likes' },
			{ column: 'Verified', param: 'verified' },
			{ column: 'Image URL', ignored: 'Pictures from web addresses are not imported' },
			{ column: 'Mood', ignored: 'Not a parameter of Comment' },
		]);
		expect(body.rows.map((r: Json) => [r.row, r.line, r.track, r.start, r.end])).toEqual([
			[1, 2, 'V2', 60, 180],
			[2, 3, 'V2', 180, 300],
			[3, 4, 'V2', 300, 420],
		]);
		expect(body.rows[0].params).toMatchObject({
			variant: 'gram-post',
			handle: 'luna.park',
			text: 'First, with comma',
			likes: 1200,
			verified: true,
		});
		// an empty cell is not given: likes is a per-instance param (ui.addAnother.reroll), so the fill hook gives
		// this row its own value instead of the preset's placeholder (114)
		expect(body.rows[1].params).toMatchObject({ handle: 'bo', verified: false });
		expect(body.rows[1].params.likes).not.toBe(114);
		expect([...body.rows[1].filled].sort()).toEqual(['displayName', 'likes']);
		expect(body.rows[2].params.text).toBe('Line 1\nLine 2');
		expect(Object.keys(seqOf(engine.doc()).clips)).toHaveLength(3);
	});

	it('reads TSV pasted from a spreadsheet and start / duration columns', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const body = ok(
			await call('import_motion_graphics_csv', {
				template: 'lower-third',
				csv: 'name\tsize\tstart\tduration\nAna\t50\t1\t2s\nBo\t\t\t0:03\n',
				seed: 1,
			}),
		);
		expect(body.delimiter).toBe('tab');
		expect(body.rows.map((r: Json) => [r.start, r.duration, r.params.name, r.params.size])).toEqual([
			[30, 60, 'Ana', 50],
			[90, 90, 'Bo', 40],
		]);
	});

	it('refuses rows with errors listing all of them, or skips them with skipInvalid', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const csv = 'Display Name,Likes,Style\nOk,1,\nBad,lots,facebook\nAlso ok,2,gram-post\nWorse,-3,\n';
		const e = err(await call('import_motion_graphics_csv', { template: 'comment', csv }));
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toContain('2 of 4 rows have errors');
		expect(e.details.rows).toEqual([
			{
				row: 2,
				line: 3,
				errors: ['Likes: "lots" is not a number', 'Style: "facebook" is not one of tok-reply, gram-post'],
			},
			{ row: 4, line: 5, errors: ['Likes: -3 is below the minimum 0'] },
		]);
		// the other rows were only dry-run (to report the command's refusals too): nothing changed
		expect(engine.txs.every((t) => t.dryRun)).toBe(true);
		expect(engine.revision()).toBe(1);
		const body = ok(
			await call('import_motion_graphics_csv', { template: 'comment', csv, skipInvalid: true }),
		);
		expect(body.rows.map((r: Json) => r.row)).toEqual([1, 3]);
		expect(body.rows.map((r: Json) => r.start)).toEqual([0, 120]);
		expect(body.skipped.map((r: Json) => r.row)).toEqual([2, 4]);
	});

	it('a row the command refuses (fill hook) is a row error naming its CSV row', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const e = err(
			await call('import_motion_graphics_csv', { template: 'comment', csv: 'text\nfine\n\nrefuse\n' }),
		);
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(e.message).toMatch(
			/^1 of 2 rows have errors \(first: row 2, .*this text cannot be filled.*Nothing was imported/,
		);
		expect(e.details.rows).toEqual([
			{ row: 2, line: 4, errors: [expect.stringContaining('this text cannot be filled')] },
		]);
		expect(Object.keys(seqOf(engine.doc()).clips)).toHaveLength(0);
	});

	it('rows that pass the coercion but that the command refuses (missing media, fill) are skipped with skipInvalid, and reported with every other bad row without it', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const csv =
			'Comment\tAvatar\tLikes\n' +
			'one\t\t1\n' +
			'two\t{"mediaId":"nope"}\t2\n' +
			'refuse\t\t3\n' +
			'four\t\tlots\n' +
			'five\t{"mediaId":"gone"}\t5\n' +
			'six\t\t6\n';
		// without skipInvalid: the coercion error (row 4) and the command's refusals (rows 2, 3, 5) together
		const e = err(await call('import_motion_graphics_csv', { template: 'comment', csv, seed: 4 }));
		expect(e.message).toMatch(/^4 of 6 rows have errors \(first: row 2, Media not found: nope/);
		expect(e.details.rows).toEqual([
			{ row: 2, line: 3, errors: [expect.stringContaining('Media not found: nope')] },
			{ row: 3, line: 4, errors: [expect.stringContaining('this text cannot be filled')] },
			{ row: 4, line: 5, errors: ['Likes: "lots" is not a number'] },
			{ row: 5, line: 6, errors: [expect.stringContaining('Media not found: gone')] },
		]);
		expect(engine.txs.every((t) => t.dryRun)).toBe(true);
		expect(engine.revision()).toBe(1);
		// with skipInvalid: the good rows are imported one after another, the others reported
		const body = ok(
			await call('import_motion_graphics_csv', { template: 'comment', csv, seed: 4, skipInvalid: true }),
		);
		expect(body.rows.map((r: Json) => [r.row, r.start, r.params.text])).toEqual([
			[1, 0, 'one'],
			[6, 120, 'six'],
		]);
		expect(body.skipped.map((r: Json) => r.row)).toEqual([2, 3, 4, 5]);
		expect(Object.keys(seqOf(engine.doc()).clips)).toHaveLength(2);
		expect(engine.revision()).toBe(2);
		// a dry run reports the same without changing anything
		const dry = ok(
			await call('import_motion_graphics_csv', {
				template: 'comment',
				csv,
				seed: 4,
				skipInvalid: true,
				dryRun: true,
			}),
		);
		expect(dry.skipped.map((r: Json) => r.row)).toEqual([2, 3, 4, 5]);
		expect(engine.revision()).toBe(2);
	});

	it('dry runs resolve without changing the project, deterministically for a seed', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const args = { template: 'comment', csv: 'Comment\nA\nB\n', seed: 77 };
		const a = ok(await call('import_motion_graphics_csv', { ...args, dryRun: true }));
		expect(a.note).toContain('Dry run');
		expect(engine.revision()).toBe(1);
		const b = ok(await call('import_motion_graphics_csv', args));
		expect(b.rows.map((r: Json) => r.params)).toEqual(a.rows.map((r: Json) => r.params));
		expect(b.rows[1].seed).toBe(mgItemSeed(77, 1));
	});

	it('refuses a header naming nothing, an unknown template or preset, too many rows and too much text', async () => {
		const engine = fakeEngine();
		const { call } = await connect(engine);
		const h = err(await call('import_motion_graphics_csv', { template: 'comment', csv: 'foo,bar\n1,2' }));
		expect(h).toMatchObject({ code: 'E_INVALID_PARAM' });
		expect(h.message).toContain('first row must name the columns');
		expect(err(await call('import_motion_graphics_csv', { template: 'nope', csv: 'text\na' })).code).toBe(
			'E_NOT_FOUND',
		);
		expect(
			err(await call('import_motion_graphics_csv', { template: 'comment:nope', csv: 'text\na' })).code,
		).toBe('E_NOT_FOUND');
		const many = `text\n${Array.from({ length: TABLE_MAX_ROWS + 1 }, (_, i) => `r${i}`).join('\n')}`;
		const rows = err(await call('import_motion_graphics_csv', { template: 'comment', csv: many }));
		expect(rows.code).toBe('E_INVALID_PARAM');
		expect(rows.message).toContain(`at most ${TABLE_MAX_ROWS} rows`);
		const big = err(
			await call('import_motion_graphics_csv', {
				template: 'comment',
				csv: `text\n${'x'.repeat(2 * 1024 * 1024)}`,
			}),
		);
		expect(big.code).toBe('E_INVALID_ARGUMENT');
		expect(
			err(await call('import_motion_graphics_csv', { template: 'comment', csv: 'text\na', startAt: -30 }))
				.code,
		).toBe('E_INVALID_PARAM');
		expect(engine.txs).toHaveLength(0);
	});
});
