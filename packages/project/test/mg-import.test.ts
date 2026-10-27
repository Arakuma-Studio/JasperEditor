// Motion-graphic bulk import planning (docs/wp-notes/social-comments.md "Add another & bulk import"): column
// mapping, cell coercion against the params' JSON Schema, sequential placement and the shared command builder.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	checkInvariants,
	coerceCell,
	createStaticMgRegistry,
	defaultRegistries,
	type MgImportTemplate,
	type MgTemplateInfo,
	mgImportCommand,
	mgImportText,
	mgItemSeed,
	normalizeColumnName,
	parseCellNumber,
	parseCellTime,
	parseTable,
	planMgImport,
	resolveMgTemplateParams,
	scheduleMgImport,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const VARIANTS = ['tok-reply', 'gram-post', 'ex-post'] as const;
const schema = z.strictObject({
	variant: z.enum(VARIANTS),
	displayName: z.string().min(1).max(64),
	handle: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[\p{L}\p{N}._-]+$/u),
	avatar: z.union([
		z.strictObject({ mediaId: z.string() }),
		z.strictObject({ generated: z.number().int() }),
		z.null(),
	]),
	verified: z.boolean(),
	likes: z.number().int().min(0).max(1e12),
	scale: z.number().min(0.5).max(2),
	text: z.string().max(400),
});
const defaults = {
	variant: 'tok-reply',
	displayName: 'Display Name',
	handle: 'username',
	avatar: null,
	verified: false,
	likes: 10,
	scale: 1,
	text: 'Write any comment',
};
const presets = [
	{ id: 'tok-reply', name: 'Tok reply', params: { variant: 'tok-reply' } },
	{ id: 'gram-post', name: 'Gram post', params: { variant: 'gram-post', likes: 114 } },
];
const ui = {
	params: { displayName: { label: 'Display Name' }, text: { label: 'Comment' }, variant: { label: 'Style' } },
	import: {
		aliases: {
			User: {
				byParam: 'variant',
				map: { 'tok-reply': 'displayName', 'gram-post': 'handle', 'ex-post': 'displayName' },
				otherwise: 'displayName',
			},
			Username: { byParam: 'variant', map: { 'tok-reply': 'displayName' }, otherwise: 'handle' },
			Message: 'text',
		},
		ignored: { 'Image URL': 'Pictures from web addresses are not imported' },
		trimPrefix: { handle: '@' },
	},
};
const template: MgImportTemplate = {
	id: 'comment',
	version: 1,
	name: 'Comment',
	paramsSchema: z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }),
	defaults,
	defaultDurationSeconds: 4,
	presets,
	ui,
};
const info: MgTemplateInfo = {
	id: 'comment',
	version: 1,
	name: 'Comment',
	category: 'Social',
	paramsSchema: schema,
	defaults,
	introFrames: 5,
	outroFrames: 5,
	canvasDefault: 'sequence',
	defaultDurationSeconds: 4,
	presets,
	ui,
	fill(partial, seed) {
		const out = { ...partial };
		const filled: string[] = [];
		for (const k of ['displayName', 'handle', 'likes'] as const)
			if (out[k] === undefined) {
				out[k] = k === 'likes' ? seed % 1000 : `${k === 'handle' ? 'h' : 'N'}${seed % 97}`;
				filled.push(k);
			}
		return { ok: true, params: out, filled };
	},
};
const rate = { num: 30, den: 1 };

const plan = (text: string, opts: { preset?: string } = {}) => {
	const t = parseTable(text);
	if (!t.ok) throw new Error(mgImportText(t.message));
	const p = planMgImport(t.table, template, { rate, ...opts });
	if (!p.ok) throw new Error(mgImportText(p.message));
	return p.plan;
};
describe('column mapping', () => {
	it('matches param names and labels ignoring case and punctuation; aliases; timing; ignored with reasons', () => {
		const p = plan(
			'display_name,COMMENT,Likes,User,Image URL,Start,Duration,Mood,,likes\nA,b,1,u,x,1,2,m,,3',
		);
		expect(
			p.columns.map((c) =>
				c.kind === 'param'
					? c.param
					: c.kind === 'ignored'
						? `ignored: ${c.reason.code}`
						: c.kind === 'alias'
							? 'alias'
							: c.kind,
			),
		).toEqual([
			'displayName',
			'text',
			'likes',
			'alias',
			'ignored: template',
			'start',
			'duration',
			'ignored: column-unknown',
			'ignored: column-unnamed',
			'ignored: column-duplicate',
		]);
	});

	it('refuses a header that names nothing, a table without data rows and an unknown preset', () => {
		const t = parseTable('foo,bar\n1,2');
		const r = t.ok ? planMgImport(t.table, template, { rate }) : null;
		expect(r).toMatchObject({ ok: false, message: { code: 'no-header' } });
		const h = parseTable('text');
		expect(h.ok && planMgImport(h.table, template, { rate })).toMatchObject({
			ok: false,
			message: { code: 'no-data' },
		});
		const ok = parseTable('text\nhi');
		expect(ok.ok && planMgImport(ok.table, template, { rate, preset: 'nope' })).toMatchObject({
			ok: false,
			message: { code: 'no-preset' },
		});
	});

	it('normalizeColumnName ignores case, spaces, separators and a leading @/#', () => {
		expect(normalizeColumnName(' Display_Name: ')).toBe('displayname');
		expect(normalizeColumnName('@handle')).toBe('handle');
		expect(normalizeColumnName('Ｌｉｋｅｓ')).toBe('likes');
	});
});

describe('cells', () => {
	it('coerces numbers with separators and K/M/B, booleans, enums, strings and JSON', () => {
		const p = plan(
			'Style,likes,verified,scale,handle,avatar,text\n' +
				'Gram Post,"1,234",yes,1.5,@luna.makes,"{""generated"": 7}","  keep   inner  "\n' +
				'EX_POST,1.2K,0,2,bo,null,x\n' +
				'tok-reply,3.5M,✓,0.5,c,,y',
		);
		expect(p.rows.map((r) => r.errors)).toEqual([[], [], []]);
		expect(p.rows[0]!.params).toEqual({
			variant: 'gram-post',
			likes: 1234,
			verified: true,
			scale: 1.5,
			handle: 'luna.makes',
			avatar: { generated: 7 },
			text: 'keep   inner',
		});
		expect(p.rows[1]!.params).toMatchObject({
			variant: 'ex-post',
			likes: 1200,
			verified: false,
			avatar: null,
		});
		expect(p.rows[2]!.params).toMatchObject({ likes: 3_500_000, verified: true });
		expect('avatar' in p.rows[2]!.params).toBe(false);
	});

	it('reports bad cells per row with the column, keeping other rows', () => {
		const p = plan(
			'likes,verified,Style,scale,handle,avatar\nabc,maybe,facebook,9,"has space",{bad\n1.5,yes,,1,ok,',
		);
		expect(p.rows[0]!.errors.map(({ code, column }) => [code, column])).toEqual([
			['not-number', 'likes'],
			['not-boolean', 'verified'],
			['not-in-list', 'Style'],
			['above-maximum', 'scale'],
			['bad-characters', 'handle'],
			['not-json', 'avatar'],
		]);
		expect(p.rows[1]!.errors).toMatchObject([{ code: 'not-integer', column: 'likes', values: [1.5] }]);
	});

	it('resolves aliases per row by the variant (row, then preset, then defaults)', () => {
		const p = plan('Style,User\ntok-reply,Luna Park\ngram-post,luna.park\n,Default Tok', {});
		expect(p.rows.map((r) => r.params)).toEqual([
			{ variant: 'tok-reply', displayName: 'Luna Park' },
			{ variant: 'gram-post', handle: 'luna.park' },
			{ displayName: 'Default Tok' },
		]);
		const g = plan('User\n@luna', { preset: 'gram-post' });
		expect(g.rows[0]!.params).toEqual({ handle: 'luna' });
		expect(g.presetParams).toEqual({ variant: 'gram-post', likes: 114 });
	});

	it('a preset does not fix the params the template varies per instance (ui.addAnother.reroll)', () => {
		const varied = { ...template, ui: { ...ui, addAnother: { reroll: ['likes', 'handle'] } } };
		const t = parseTable('Comment\nhi');
		const r = t.ok ? planMgImport(t.table, varied, { rate, preset: 'gram-post' }) : null;
		expect(r?.ok && r.plan.presetParams).toEqual({ variant: 'gram-post' });
		const plain = t.ok ? planMgImport(t.table, template, { rate, preset: 'gram-post' }) : null;
		expect(plain?.ok && plain.plan.presetParams).toEqual({ variant: 'gram-post', likes: 114 });
	});

	it('a direct column wins over an alias for the same param (warning)', () => {
		const p = plan('Display Name,User\nGiven,Alias\n,Alias only');
		expect(p.rows[0]!.params).toEqual({ displayName: 'Given' });
		expect(p.rows[0]!.warnings).toEqual([
			{ code: 'alias-overridden', column: 'User', values: ['displayName'] },
		]);
		expect(p.rows[1]!.params).toEqual({ displayName: 'Alias only' });
	});

	it('reads start and duration cells as times', () => {
		const p = plan('text,start,duration\na,3,1.5s\nb,0:10,90f\nc,00:00:02:15,250ms\nd,soon,0\ne,,');
		expect(p.rows.map((r) => [r.start, r.duration])).toEqual([
			[90, 45],
			[300, 90],
			[75, 8],
			[undefined, undefined],
			[undefined, undefined],
		]);
		expect(p.rows[3]!.errors.map(({ code, column }) => [code, column])).toEqual([
			['not-time', 'start'],
			['duration-too-short', 'duration'],
		]);
		expect(parseCellTime('1:02:03', rate)).toBe((3600 + 120 + 3) * 30);
		expect(parseCellTime('-3', rate)).toBeNull();
	});

	it('marks extra cells and over-long cells', () => {
		const p = plan(`text,likes\na,1,extra,more\n"${'x'.repeat(10_050)}",2`);
		expect(p.rows[0]!.warnings).toEqual([{ code: 'extra-cells', values: [2] }]);
		expect(p.rows[1]!.errors).toContainEqual(expect.objectContaining({ code: 'cell-too-long' }));
	});

	it('parseCellNumber / coerceCell never throw (fast-check)', () => {
		const props = (template.paramsSchema as { properties: Record<string, unknown> }).properties;
		fc.assert(
			fc.property(
				fc.string({ unit: 'binary', maxLength: 30 }),
				fc.constantFrom(...Object.keys(props)),
				(s, p) => {
					const n = parseCellNumber(s);
					expect(n === null || Number.isFinite(n)).toBe(true);
					const c = coerceCell(s, props[p]);
					expect(typeof c.ok).toBe('boolean');
				},
			),
			{ numRuns: 1000 },
		);
		expect(parseCellNumber('12,34')).toBeNull();
		expect(parseCellNumber('1,234,567.5')).toBe(1_234_567.5);
		expect(parseCellNumber('2b')).toBe(2e9);
		expect(parseCellNumber('.5')).toBe(0.5);
		expect(parseCellNumber('k')).toBeNull();
	});

	it('planMgImport never throws on arbitrary tables (fast-check)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.array(fc.string({ maxLength: 10 }), { maxLength: 6 }), { minLength: 1, maxLength: 8 }),
				fc.constantFrom(undefined, 'tok-reply', 'gram-post'),
				(records, preset) => {
					const table = {
						delimiter: ',' as const,
						records,
						lines: records.map((_, i) => i + 1),
						issues: [],
					};
					const r = planMgImport(table, template, { rate, ...(preset ? { preset } : {}) });
					if (r.ok)
						for (const row of r.plan.rows) for (const m of [...row.errors, ...row.warnings]) mgImportText(m);
				},
			),
			{ numRuns: 400 },
		);
	});
});

describe('placement and commands', () => {
	it('schedules rows one after another from the start, explicit times win', () => {
		expect(
			scheduleMgImport([{ index: 0 }, { index: 1, duration: 30 }, { index: 2, start: 1000 }, { index: 4 }], {
				startAt: 100,
				defaultDuration: 120,
			}),
		).toEqual([
			{ row: 0, start: 100, duration: 120 },
			{ row: 1, start: 220, duration: 30 },
			{ row: 2, start: 1000, duration: 120 },
			{ row: 4, start: 1120, duration: 120 },
		]);
	});

	it('inserts every valid row as one transaction: sequential, first-free, filled, exactly as previewed', () => {
		const registries = defaultRegistries(createStaticMgRegistry([info]));
		const h = new Harness({ ctx: { registries } });
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 400, track: 'V2', color: [0, 0, 0, 1] }]);
		const p = plan('User,Comment,Likes\nLuna,First!,1.2K\nBo,Second,oops\nCy,Third,\n', {
			preset: 'gram-post',
		});
		const valid = p.rows.filter((r) => r.errors.length === 0);
		expect(valid.map((r) => r.index)).toEqual([0, 2]);
		const placements = scheduleMgImport(valid, { startAt: 60, defaultDuration: p.defaultDuration });
		const seed = 1234;
		const preview = valid.map((r) =>
			resolveMgTemplateParams(
				info,
				{ ...p.presetParams, ...r.params },
				{ seed: mgItemSeed(seed, r.index), media: {} },
			),
		);
		const commands = valid.map((r, i) => mgImportCommand(p, r, placements[i]!, { seed, track: 'V2' }));
		const res = h.ok(commands);
		const results = res.results as {
			clipId: string;
			track: string;
			start: number;
			params: unknown;
			filled: string[];
		}[];
		expect(results.map((r) => [r.track, r.start])).toEqual([
			['V3', 60],
			['V3', 180],
		]);
		expect(results.map((r) => r.params)).toEqual(preview.map((x) => (x.ok ? x.params : null)));
		expect(results[0]!.params).toMatchObject({
			variant: 'gram-post',
			handle: 'Luna',
			text: 'First!',
			likes: 1200,
		});
		// an empty cell is "not given": the preset's value (likes 114) stays, the fill only fills what both leave out
		expect(results[1]!.params).toMatchObject({ handle: 'Cy', text: 'Third', likes: 114 });
		expect(results[1]!.filled).toEqual(['displayName']);
		expect(results[1]!.params).toMatchObject({ displayName: `N${mgItemSeed(seed, 2) % 97}` });
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
