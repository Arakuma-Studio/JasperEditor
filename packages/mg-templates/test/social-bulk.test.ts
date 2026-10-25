// "Add another" and bulk-import hints (docs/wp-notes/social-comments.md "Add another & bulk import"): the registry
// validates `ui.addAnother` / `ui.import`, the social hints map tokcomment's columns per variant, and the generic
// command / planner of @jasper/project do the right thing with a social-comment-shaped template.
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	mgImportCommand,
	mgImportTemplateOf,
	mgImportText,
	mgItemSeed,
	parseTable,
	planMgImport,
	resolveMgTemplateParams,
	scheduleMgImport,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { createMgRegistry } from '../src/registry.ts';
import {
	SOCIAL_KEEP_PARAMS,
	SOCIAL_PARAM_NAMES,
	SOCIAL_REROLL_PARAMS,
	VARIANT_CAPABILITIES,
} from '../src/social/index.ts';
import type { AnyMgTemplate } from '../src/types.ts';
import { SOCIAL_BULK_TEST_TEMPLATE as T } from './fixtures/social-bulk-template.ts';

const rate = { num: 30, den: 1 };
const reg = createMgRegistry([T]);
const info = reg.get(T.id, T.version)!;

describe('ui.addAnother / ui.import validation (createMgRegistry)', () => {
	const bad =
		(ui: unknown, extra: Partial<AnyMgTemplate> = {}) =>
		() =>
			createMgRegistry([{ ...T, ...extra, ui: ui as AnyMgTemplate['ui'] } as AnyMgTemplate]);
	it('accepts the social hints', () => {
		expect(() => createMgRegistry([T])).not.toThrow();
		expect(info.ui?.addAnother?.reroll).toEqual(SOCIAL_REROLL_PARAMS);
	});
	it('refuses malformed or dangling hints', () => {
		expect(bad({ addAnother: { reroll: ['nope'] } })).toThrow(/addAnother.reroll .* unknown param "nope"/);
		expect(bad({ addAnother: ['handle'] })).toThrow(/must be \{reroll/);
		expect(bad({ addAnother: { reroll: ['handle'] } }, { fill: undefined })).toThrow(/needs a fill hook/);
		expect(bad({ import: { aliases: { User: 'nope' } } })).toThrow(/aliases.User .* unknown param/);
		expect(bad({ import: { aliases: { User: { byParam: 'nope', map: {}, otherwise: 'handle' } } } })).toThrow(
			/byParam/,
		);
		expect(
			bad({ import: { aliases: { User: { byParam: 'variant', map: { a: 'x' }, otherwise: 'handle' } } } }),
		).toThrow(/map .* unknown param/);
		expect(bad({ import: { ignored: { Photo: '' } } })).toThrow(/non-empty reasons/);
		expect(bad({ import: { trimPrefix: { nope: '@' } } })).toThrow(/trimPrefix .* unknown param/);
		expect(bad({ import: { trimPrefix: { handle: '' } } })).toThrow(/non-empty string/);
		expect(bad({ import: [] })).toThrow(/ui.import .* must be an object/);
	});
	it('serialises the hints into the catalogue JSON', () => {
		const entry = reg.catalogJson()[0]!;
		expect(entry.ui?.addAnother).toEqual({ reroll: [...SOCIAL_REROLL_PARAMS] });
		expect(entry.ui?.import?.trimPrefix).toEqual({ handle: '@' });
		expect(entry.ui?.import?.aliases?.User).toMatchObject({ byParam: 'variant' });
	});
});

describe('social hints', () => {
	it('re-randomize identity and stats, keep everything else', () => {
		expect([...SOCIAL_KEEP_PARAMS, ...SOCIAL_REROLL_PARAMS].sort()).toEqual([...SOCIAL_PARAM_NAMES].sort());
		expect(SOCIAL_KEEP_PARAMS).toEqual(
			expect.arrayContaining([
				'variant',
				'theme',
				'emojiStyle',
				'text',
				'entrance',
				'wordReveal',
				'likeTick',
			]),
		);
	});

	const importRows = (csv: string, preset?: string) => {
		const t = parseTable(csv);
		if (!t.ok) throw new Error(mgImportText(t.message));
		const p = planMgImport(t.table, mgImportTemplateOf(info)!, { rate, ...(preset ? { preset } : {}) });
		if (!p.ok) throw new Error(mgImportText(p.message));
		return p.plan;
	};

	it('map tokcomment columns: User → the name the variant shows, Username → the handle, Verified yes/1/true', () => {
		const p = importRows(
			'Variant,User,Username,Comment,Verified,Image URL\n' +
				'tiktok-comment,Luna Park,,Love it,yes,https://x/a.png\n' +
				'instagram-post,luna.park,,Nice,1,\n' +
				'youtube-comment,@luna_p,,Wow,true,\n' +
				'x-post,Luna Park,@lunapark,So true,no,\n' +
				'tiktok-reply,,Nick Name,Hi,,',
		);
		expect(p.columns.at(-1)).toMatchObject({ kind: 'ignored' });
		expect(mgImportText((p.columns.at(-1) as { reason: Parameters<typeof mgImportText>[0] }).reason)).toMatch(
			/not imported/,
		);
		expect(p.rows.map((r) => r.errors)).toEqual([[], [], [], [], []]);
		expect(p.rows.map((r) => r.params)).toEqual([
			{ variant: 'tiktok-comment', displayName: 'Luna Park', text: 'Love it', verified: true },
			{ variant: 'instagram-post', handle: 'luna.park', text: 'Nice', verified: true },
			{ variant: 'youtube-comment', handle: 'luna_p', text: 'Wow', verified: true },
			{ variant: 'x-post', displayName: 'Luna Park', handle: 'lunapark', text: 'So true', verified: false },
			{ variant: 'tiktok-reply', displayName: 'Nick Name', text: 'Hi' },
		]);
		// every variant has a "User" target that it draws
		for (const v of Object.keys(VARIANT_CAPABILITIES))
			expect(importRows(`Variant,User\n${v},abc`).rows[0]!.params).toEqual(
				expect.objectContaining({ variant: v }),
			);
	});

	it('resolves rows to full, valid params (filled identity and stats) and inserts them as previewed', () => {
		const p = importRows(
			'User,Comment,Likes\nluna.park,First ==highlight==,1.2K\n,Second,\n',
			'instagram-post',
		);
		const ids = createCounterIdSource(1);
		let doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
		const valid = p.rows.filter((r) => r.errors.length === 0);
		const seed = 42;
		const preview = valid.map((r) =>
			resolveMgTemplateParams(
				info,
				{ ...p.presetParams, ...r.params },
				{ seed: mgItemSeed(seed, r.index), media: {} },
			),
		);
		for (const x of preview) expect(x.ok).toBe(true);
		const places = scheduleMgImport(valid, { startAt: 0, defaultDuration: p.defaultDuration });
		const { document, result } = applyTransaction(
			doc,
			{
				label: 'Import',
				origin: 'user',
				commands: valid.map((r, i) => mgImportCommand(p, r, places[i]!, { seed, track: 'V1' })),
			},
			{ ids, now: () => '2026-10-25T00:00:00Z', revision: 0, registries: defaultRegistries(reg) },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		doc = document;
		const params = (result.results as { params: Record<string, unknown> }[]).map((r) => r.params);
		expect(params).toEqual(preview.map((x) => (x.ok ? x.params : null)));
		expect(params[0]).toMatchObject({ variant: 'instagram-post', handle: 'luna.park', likes: 1200 });
		expect(params[1]).toMatchObject({ variant: 'instagram-post', text: 'Second' });
		expect(Object.values(Object.values(doc.sequences)[0]!.clips).map((c) => c.start)).toEqual([0, 150]);
	});

	it('Add another keeps the look and the text and gives a new identity and stats', () => {
		const ids = createCounterIdSource(1);
		const ctx = { ids, now: () => '2026-10-25T00:00:00Z', revision: 0, registries: defaultRegistries(reg) };
		const doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
		const add = applyTransaction(
			doc,
			{
				label: 'Add',
				origin: 'user',
				commands: [
					{
						type: 'clip.addMotionGraphic',
						at: 0,
						duration: 150,
						track: 'V2',
						template: { id: T.id, version: 1 },
						params: {
							variant: 'x-post',
							theme: 'dark',
							text: 'My ||secret|| take',
							entrance: 'drop-bounce',
							likeTick: true,
						},
						fill: { seed: 5 },
						ref: '$c',
					},
				],
			},
			ctx,
		);
		expect(add.result.ok).toBe(true);
		if (!add.result.ok) return;
		const clipId = add.result.refs.$c!;
		const source = (add.result.results[0] as { params: Record<string, unknown> }).params;
		const dup = applyTransaction(
			add.document,
			{
				label: 'Add Another',
				origin: 'user',
				commands: [{ type: 'clip.duplicateMotionGraphic', clipId, seed: 77 }],
			},
			{ ...ctx, revision: 1 },
		);
		expect(dup.result.ok).toBe(true);
		if (!dup.result.ok) return;
		const r = dup.result.results[0] as { params: Record<string, unknown>; start: number; rerolled: string[] };
		expect(r.start).toBe(150);
		for (const k of SOCIAL_KEEP_PARAMS) expect(r.params[k]).toEqual(source[k]);
		expect(r.params.displayName).not.toEqual(source.displayName);
		expect(r.params.handle).not.toEqual(source.handle);
		expect(r.params.avatar).not.toEqual(source.avatar);
		expect(r.rerolled.sort()).toEqual([...SOCIAL_REROLL_PARAMS].sort());
	});
});
