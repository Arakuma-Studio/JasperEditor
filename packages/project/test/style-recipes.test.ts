// Style recipes, Apply Style and Style Check (spec 15 EA-010…EA-013, EA-050): the recipe model and its built-ins, the
// project copy (commands with undo / redo / refusals, invariants, lenient read and repair), `cleanup.apply`'s piece
// refs, the combined planner (stage order, later stages planned on the cleaned-up timeline, one proposal, accept = one
// transaction, conflicts resolved: kits disjoint, punch-ins never on Ken Burns clips, reactions clear of subtitles —
// fast-check property), roles, Refresh / Reroll, the agent policy of embedded features, and Style Check.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	activeStyleRecipe,
	BUILTIN_STYLE_RECIPES,
	builtinStyleRecipe,
	type Clip,
	checkInvariants,
	createProposal,
	defaultRegistries,
	flicksPerFrame,
	frameAfterCuts,
	loadProject,
	markAccepted,
	motionKindOf,
	type Proposal,
	type ProposalContext,
	parseStyleRecipe,
	planAccept,
	planStyle,
	projectFeaturePolicy,
	projectStyleRecipes,
	refreshProposalItems,
	refreshStyleItems,
	repairDocument,
	resolveRecipeStages,
	STYLE_RECIPE_ITEM,
	STYLE_RECIPE_MODEL_STRINGS,
	type StyleHooks,
	type StyleRecipe,
	styleCheck,
	styleDraft,
	styleRecipesIssues,
	subtitleRegions,
	createCounterIdSource,
	clipRect,
	rectsOverlap,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const NOW = '2026-10-26T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
const OPTS = { registries: defaultRegistries(), now: () => NOW };
let idn = 0;
const nextId = () => `prp_${String(++idn).padStart(16, '0')}`;

const recipe = (id: string): StyleRecipe => {
	const r = builtinStyleRecipe(id);
	if (!r) throw new Error(id);
	return r;
};

/**
 * A talking-head edit: one camera media with sound and a transcript, placed as jump cuts (linked picture + sound) of
 * `lengths` frames, a word every `wordEvery` frames; optional overlay stills on V2, a "Reactions" bin, a "Music" bin.
 */
function talk(
	lengths: number[],
	opts: { vertical?: boolean; overlays?: number[]; reactions?: number; songs?: number; transcript?: boolean } = {},
) {
	const h = new Harness(opts.vertical ? { preset: 'vertical-1080x1920-30' } : {});
	const size = opts.vertical ? { width: 1080, height: 1920 } : {};
	const cam = h.registerVideo({ seconds: 3600, ...size });
	const F = flicksPerFrame(h.seq.settings.frameRate);
	const total = lengths.reduce((a, b) => a + b, 0);
	if (opts.transcript !== false) {
		// a word every 12 frames of source (the clips take source in steps with gaps: jump cuts)
		const words = [];
		for (let s = 0; s < (total + lengths.length * 40) / 12; s++)
			words.push({ text: s % 9 === 8 ? '¡wow!' : `palabra${s}`, start: s * 12 * F, end: (s * 12 + 9) * F });
		h.ok([{ type: 'transcript.create', mediaId: cam, language: 'es', origin: 'manual', words }]);
	}
	let at = 0;
	let src = 0;
	const r = h.ok(
		lengths.map((len) => {
			const c = {
				type: 'clip.place',
				source: { mediaId: cam },
				at,
				tracks: { video: 'V1', audio: 'A1' },
				sourceRange: { in: { flicks: src * F }, out: { flicks: (src + len) * F } },
			};
			at += len;
			src += len + 40;
			return c;
		}),
	);
	const placed = r.results.map((x) => (x as { clipIds: string[] }).clipIds);
	for (const o of opts.overlays ?? []) {
		const img = (h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image', width: 800, height: 600 }) }]).results[0] as { mediaId: string }).mediaId;
		h.ok([{ type: 'clip.place', source: { mediaId: img }, at: o, tracks: { video: 'V2' }, duration: 60 }]);
	}
	if (opts.reactions)
		h.ok([
			{ type: 'bin.create', name: 'Reactions', ref: '$b' },
			...Array.from({ length: opts.reactions }, (_, i) => ({
				type: 'media.register',
				asset: { ...videoAsset({ kind: 'image', width: 400, height: 400 }), originalName: `r${i}.png` },
				binId: '$b',
				name: `r${i}`,
			})),
		]);
	if (opts.songs)
		h.ok([
			{ type: 'bin.create', name: 'Music', ref: '$m' },
			...Array.from({ length: opts.songs }, (_, i) => ({
				type: 'media.register',
				asset: { ...videoAsset({ kind: 'audio', seconds: 200 }), originalName: `song${i}.wav` },
				binId: '$m',
				name: `song${i}`,
			})),
		]);
	return { h, F, total, video: placed.map((x) => x[0]!), audio: placed.map((x) => x[1]!) };
}

/** A cleanup hook removing `cut` frames inside each clip listed (as the engine's analysis would plan). */
function cleanupHook(t: ReturnType<typeof talk>, cuts: [number, number][]): StyleHooks['cleanup'] {
	return async () => ({
		ranges: cuts.map(([start, end]) => ({ start, end })),
		clipIds: t.audio,
		fadeMs: 4,
		jlFrames: 0,
		findings: cuts.length,
	});
}

function propose(h: Harness, draft: unknown): Proposal {
	const r = createProposal(
		h.doc,
		draft,
		{ id: nextId(), projectId: h.doc.projectId, author: { agent: 'test' }, now: NOW, revision: h.revision },
		{ ...CTX, revision: h.revision },
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors).slice(0, 3000));
	return r.proposal;
}

function accept(h: Harness, p: Proposal, ids: string[] | 'all' = 'all') {
	const plan = planAccept(h.doc, p, ids, { agent: 'test' }, { ...CTX, revision: h.revision });
	if (!plan.ok || !plan.composed) throw new Error(JSON.stringify(plan.ok ? 'nothing' : plan.errors).slice(0, 3000));
	const r = h.ok(plan.composed.tx.commands, { label: plan.composed.tx.label });
	return {
		r,
		proposal: markAccepted(plan.proposal, plan.composed.itemIds, { revision: r.revision, refs: r.refs, at: NOW, created: r.created }),
	};
}

const byTrackName = (h: Harness, name: string) => {
	const t = h.seq.videoTracks.find((x) => x.name === name);
	return t ? Object.values(h.seq.clips).filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start) : [];
};

// ---------------------------------------------------------------------------------------------------------------

describe('style recipes (EA-010, EA-011)', () => {
	it('the built-ins are valid recipes with neutral names, roles and targets; names are model strings', () => {
		expect(BUILTIN_STYLE_RECIPES.map((r) => r.name)).toEqual(['Fast Shorts', 'Fast Long-form', 'Clean']);
		for (const r of BUILTIN_STYLE_RECIPES) {
			expect(parseStyleRecipe(r)).toMatchObject({ ok: true });
			expect(r.assets?.reactionImages).toEqual({ bin: 'Reactions' });
		}
		const shorts = recipe('builtin:fast-shorts');
		expect(shorts.passes['decorate-cuts']).toEqual({ enabled: true, params: { pack: 'shorts-shake' } });
		expect(shorts.passes['ken-burns']?.params).toMatchObject({ share: 0.15, scale: 118 });
		expect(shorts.passes.music?.params).toMatchObject({ intro: { enabled: true, gainDb: -25 } });
		const long = recipe('builtin:fast-long-form');
		expect(long.passes['punch-ins']?.params).toMatchObject({ scale: 180, rampFrames: 7, minClipSeconds: 1.5 });
		expect(long.passes['ken-burns']?.params).toMatchObject({ scale: 130 });
		expect(recipe('builtin:clean').passes.cleanup).toEqual({ enabled: true, preset: 'builtin.natural' });
		expect(STYLE_RECIPE_MODEL_STRINGS).toEqual(expect.arrayContaining(['Fast Shorts', 'Clean', 'Voice cleanup']));
	});

	it('parses strictly: unknown keys, bad pass parameters, newer formats and oversized recipes are refused', () => {
		const r = recipe('builtin:fast-shorts');
		expect(parseStyleRecipe({ ...r, extra: 1 })).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		expect(
			parseStyleRecipe({ ...r, passes: { ...r.passes, 'ken-burns': { enabled: true, params: { share: 2 } } } }),
		).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		expect(
			parseStyleRecipe({ ...r, passes: { ...r.passes, reactions: { enabled: true, params: { nope: true } } } }),
		).toMatchObject({ ok: false });
		expect(parseStyleRecipe({ ...r, version: 2 })).toMatchObject({ ok: false, code: 'E_NEWER_VERSION' });
		expect(parseStyleRecipe({ ...r, description: 'x'.repeat(600_000) })).toMatchObject({ ok: false, code: 'E_TOO_LARGE' });
		expect(parseStyleRecipe({ ...r, id: 'rcp_bad' })).toMatchObject({ ok: false });
	});

	it('resolves the stages in run order with the asset roles filled in', () => {
		const r = recipe('builtin:fast-shorts');
		const s = resolveRecipeStages({ ...r, assets: { ...r.assets, whoosh: { type: 'whoosh', packId: 'pk1' } } }, {
			stingers: true,
		});
		expect(s.map((x) => x.stage)).toEqual([
			'cleanup',
			'subtitles',
			'decorate-cuts',
			'punch-ins',
			'ken-burns',
			'reactions',
			'slides',
			'music',
			'stingers',
		]);
		const kits = s.find((x) => x.stage === 'decorate-cuts') as { params: Record<string, unknown> };
		expect(kits.params.sfx).toEqual({ type: 'whoosh', packId: 'pk1' });
		expect((s.find((x) => x.stage === 'reactions') as { params: { assets: unknown } }).params.assets).toEqual({ bin: 'Reactions' });
		expect((s.find((x) => x.stage === 'music') as { params: { assets: unknown } }).params.assets).toEqual({ bin: 'Music' });
		expect(s.find((x) => x.stage === 'stingers')).toMatchObject({ enabled: true, params: { sound: 'generated' } });
	});
});

describe('the project copy (ProjectDocument.styleRecipes, schema v9)', () => {
	it('styleRecipe.add / setActive / remove: one undo step each, invariants hold, undo is the document before', () => {
		const h = new Harness();
		const before = h.doc;
		const mine: StyleRecipe = { ...recipe('builtin:fast-shorts'), id: 'rcp_0000000000000001', name: 'Mine', builtIn: undefined };
		h.ok([{ type: 'styleRecipe.add', recipe: mine, activate: true }]);
		expect(projectStyleRecipes(h.doc).active).toBe('rcp_0000000000000001');
		expect(activeStyleRecipe(h.doc)?.name).toBe('Mine');
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before.styleRecipes).toBeUndefined();
		const mid = h.doc;
		h.ok([{ type: 'styleRecipe.setActive', recipeId: 'builtin:clean' }]);
		expect(activeStyleRecipe(h.doc)?.name).toBe('Clean');
		expect(mid.styleRecipes?.active).toBe('rcp_0000000000000001');
		h.ok([{ type: 'styleRecipe.remove', recipeId: 'rcp_0000000000000001' }]);
		expect(projectStyleRecipes(h.doc).recipes).toEqual({});
		expect(h.doc.styleRecipes?.active).toBe('builtin:clean');
		h.ok([{ type: 'styleRecipe.setActive', recipeId: null }]);
		expect(h.doc.styleRecipes).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses invalid recipes, unknown ids and recipes of a newer JasperEditor', () => {
		const h = new Harness();
		const bad = h.tx([{ type: 'styleRecipe.add', recipe: { format: 'jasper-style-recipe', version: 1 } }]);
		expect(bad).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		expect(h.tx([{ type: 'styleRecipe.setActive', recipeId: 'rcp_0000000000000009' }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_NOT_FOUND' }],
		});
		expect(h.tx([{ type: 'styleRecipe.remove', recipeId: 'builtin:clean' }])).toMatchObject({ ok: false });
		const newer = { ...recipe('builtin:clean'), id: 'rcp_0000000000000002', version: 3 };
		expect(h.tx([{ type: 'styleRecipe.add', recipe: newer }])).toMatchObject({ ok: false });
		expect(h.tx([{ type: 'styleRecipe.add', recipe: { ...recipe('builtin:clean'), unknown: 1 } }])).toMatchObject({ ok: false });
	});

	it('reads leniently and repairs on load: junk dropped, keys fixed, a dangling active cleared, newer recipes kept', () => {
		const h = new Harness();
		const good = { ...recipe('builtin:clean'), id: 'rcp_0000000000000003', builtIn: undefined };
		const newer = { ...good, id: 'rcp_0000000000000004', version: 9, future: { x: 1 } };
		const doc = {
			...h.doc,
			styleRecipes: {
				active: 'rcp_000000000000000Z',
				recipes: {
					rcp_0000000000000003: good,
					rcp_0000000000000004: newer,
					rcp_0000000000000005: { junk: true },
					'bad key': { ...good, id: 'rcp_0000000000000006' },
				},
			},
		} as unknown as typeof h.doc;
		expect(styleRecipesIssues(doc).length).toBeGreaterThan(0);
		const read = projectStyleRecipes(doc);
		expect(Object.keys(read.recipes)).toEqual(['rcp_0000000000000003']);
		expect(read.newer).toEqual(['rcp_0000000000000004']);
		expect(read.active).toBeNull();
		const r = repairDocument(doc, createCounterIdSource(900));
		const actions = r.report.map((x) => x.action);
		expect(actions).toEqual(expect.arrayContaining(['drop-style-recipe', 'fix-id', 'repair-style-recipes']));
		expect(Object.keys(r.document.styleRecipes!.recipes).sort()).toEqual([
			'rcp_0000000000000003',
			'rcp_0000000000000004',
			'rcp_0000000000000006',
		]);
		expect(r.document.styleRecipes!.recipes.rcp_0000000000000004).toEqual(newer);
		expect(styleRecipesIssues(r.document)).toEqual([]);
		// idempotent
		expect(repairDocument(r.document, createCounterIdSource(950)).report.filter((x) => x.action.includes('style'))).toEqual([]);
		// a load of junk never fails
		for (const junk of [42, 'x', [], { recipes: 5 }, { active: 3, recipes: {} }]) {
			const env = { format: 'jasper-project', schemaVersion: h.doc.schemaVersion, savedAt: NOW, savedBy: { app: 't', version: '0', platform: 'x' }, revision: 1, document: { ...h.doc, styleRecipes: junk } };
			const l = loadProject(env);
			expect(styleRecipesIssues(l.document)).toEqual([]);
			expect(l.repairs.some((x) => x.action.includes('style-recipe'))).toBe(true);
		}
	});
});

describe('cleanup.apply piece refs', () => {
	it('names every clip of the cleaned-up tracks by its piece so later commands of the transaction address it', () => {
		const t = talk([90, 90]);
		const [v0, v1] = t.video;
		const r = t.h.ok([
			{ type: 'cleanup.apply', clipIds: t.audio, ranges: [{ start: 30, end: 40 }, { start: 120, end: 130 }], pieceRefs: '$c' },
			{
				type: 'keyframe.addBatch',
				targets: [{ clipId: `$c_${v0}_1`, path: ['transform', 'scale'], keys: [{ at: { frames: 0 }, value: 100 }, { at: { frames: 5 }, value: 150 }] }],
			},
		]);
		expect(r.refs[`$c_${v0}_0`]).toBe(v0);
		expect(r.refs[`$c_${v1}_0`]).toBe(v1);
		const piece = t.h.seq.clips[r.refs[`$c_${v0}_1`]!]!;
		expect(piece.start).toBe(30);
		expect(piece.duration).toBe(50);
		expect((piece as { transform: { scale: { keyframes: unknown[] } } }).transform.scale.keyframes).toHaveLength(2);
		// the sound pieces too
		expect(r.refs[`$c_${t.audio[0]}_1`]).toBeTruthy();
	});
});

describe('frameAfterCuts', () => {
	it('maps live frames onto the cleaned-up timeline', () => {
		const cuts = [
			{ start: 10, end: 20 },
			{ start: 50, end: 55 },
		];
		expect([0, 10, 15, 20, 49, 50, 60].map((f) => frameAfterCuts(cuts, f))).toEqual([0, 10, 10, 10, 39, 40, 45]);
	});
});

// ---------------------------------------------------------------------------------------------------------------

describe('Apply Style (EA-012)', () => {
	it('plans Fast Long-form into one proposal on the cleaned-up timeline; accepting is one transaction', async () => {
		const t = talk([150, 90, 120, 200, 60, 180, 150, 240], { overlays: [400, 800], songs: 2 });
		const plan = await planStyle(
			t.h.doc,
			{ recipe: recipe('builtin:fast-long-form'), seed: 3 },
			{ cleanup: cleanupHook(t, [[30, 45], [300, 310], [700, 720]]) },
			OPTS,
		);
		const status = Object.fromEntries(plan.stages.map((s) => [s.stage, s.status]));
		expect(status).toMatchObject({
			cleanup: 'planned',
			subtitles: 'planned',
			'decorate-cuts': 'planned',
			'punch-ins': 'planned',
			'ken-burns': 'planned',
			reactions: 'off',
			slides: 'planned',
			music: 'planned',
			stingers: 'off',
		});
		// order: recipe, cleanup, subtitles, then the passes in order
		const groups = plan.items.map((it) => (it.meta as { pass?: string; setup?: boolean }).pass ?? 'setup');
		const firstOf = (g: string) => groups.indexOf(g);
		expect(plan.items[0]!.id).toBe(STYLE_RECIPE_ITEM);
		expect(firstOf('cleanup')).toBeLessThan(firstOf('subtitles'));
		expect(firstOf('subtitles')).toBeLessThan(firstOf('decorate-cuts'));
		expect(firstOf('decorate-cuts')).toBeLessThan(firstOf('punch-ins'));
		expect(firstOf('punch-ins')).toBeLessThan(firstOf('ken-burns'));
		expect(firstOf('ken-burns')).toBeLessThan(firstOf('music'));
		for (const it of plan.items.slice(1)) expect(it.requires).toContain(STYLE_RECIPE_ITEM);
		for (const it of plan.items.slice(2)) expect(it.requires).toContain('cleanup');
		// no planned id leaks from the simulation
		expect(JSON.stringify(plan.items)).not.toMatch(/[a-z]{2,3}_ZS[0-9A-Z]{14}/);
		const draft = styleDraft(plan)!;
		const p = propose(t.h, draft);
		expect(p.items.filter((it) => it.state === 'invalid').map((it) => [it.id, it.reason])).toEqual([]);
		const before = t.h.doc;
		const { r } = accept(t.h, p);
		expect(r.ok).toBe(true);
		expect(checkInvariants(t.h.doc)).toEqual([]);
		expect(before).not.toBe(t.h.doc);
		// the recipe is kept and active
		expect(activeStyleRecipe(t.h.doc)?.id).toBe('builtin:fast-long-form');
		// kits sit on the cuts of the cleaned-up timeline (35 frames removed: the A-roll ends 45 frames earlier)
		const fx = byTrackName(t.h, 'FX');
		expect(fx.length).toBeGreaterThan(0);
		for (let i = 1; i < fx.length; i++) expect(fx[i]!.start).toBeGreaterThanOrEqual(fx[i - 1]!.start + fx[i - 1]!.duration);
		const aroll = Object.values(t.h.seq.clips).filter((c) => c.kind === 'video' && c.trackId === t.h.seq.videoTracks[0]!.id);
		const end = Math.max(...aroll.map((c) => c.start + c.duration));
		expect(end).toBe(t.total - 45);
		const cutFrames = new Set(aroll.map((c) => c.start).filter((f) => f > 0));
		for (const k of plan.items.filter((it) => (it.meta as { kind?: string }).kind === 'kit'))
			expect(cutFrames.has((k.meta as { frame: number }).frame)).toBe(true);
		// punch-ins and Ken Burns never share a clip
		const kinds = aroll.map((c) => motionKindOf(t.h.seq, c)?.kind ?? null);
		expect(kinds.filter((k) => k === 'punch-in').length).toBeGreaterThan(0);
		expect(kinds.filter((k) => k === 'ken-burns').length).toBeGreaterThan(0);
		// subtitles and music
		expect(Object.keys((t.h.seq as { captionGroups?: object }).captionGroups ?? {})).toHaveLength(1);
		const music = t.h.seq.audioTracks.find((x) => x.name === 'Music');
		expect(music).toBeTruthy();
		// determinism: the same inputs give the same proposal
		const again = await planStyle(before, { recipe: recipe('builtin:fast-long-form'), seed: 3 }, { cleanup: cleanupHook(t, [[30, 45], [300, 310], [700, 720]]) }, OPTS);
		expect(JSON.stringify(again.items)).toBe(JSON.stringify(plan.items));
	});

	it('accepting the cleanup alone, then the decorations, gives the same edit as accepting everything', async () => {
		const t = talk([150, 120, 200, 180]);
		const cuts: [number, number][] = [[40, 50], [200, 215]];
		const r0 = recipe('builtin:fast-long-form');
		const plan = await planStyle(t.h.doc, { recipe: r0, seed: 2, passes: { subtitles: false, music: false, slides: false } }, { cleanup: cleanupHook(t, cuts) }, OPTS);
		const start = t.h.doc;
		const p = propose(t.h, styleDraft(plan)!);
		const all = accept(t.h, p);
		const together = t.h.doc;
		t.h.doc = start;
		t.h.revision = 0;
		const first = accept(t.h, p, ['cleanup']);
		const rest = accept(t.h, first.proposal, 'all');
		expect(rest.r.ok).toBe(true);
		const shape = (d: typeof together) =>
			Object.values(Object.values(d.sequences)[0]!.clips)
				.map((c) => `${c.kind}:${c.start}:${c.duration}:${JSON.stringify((c as { transform?: { scale?: unknown } }).transform?.scale ?? null)}`)
				.sort();
		expect(shape(t.h.doc)).toEqual(shape(together));
		expect(all.r.ok).toBe(true);
	});

	it('reports missing roles and a missing transcript with actionable messages, never silently', async () => {
		const t = talk([150, 120, 200], { vertical: true, transcript: false });
		const plan = await planStyle(t.h.doc, { recipe: recipe('builtin:fast-shorts') }, {}, OPTS);
		const by = Object.fromEntries(plan.stages.map((s) => [s.stage, s]));
		expect(by.cleanup!.status).toBe('skipped');
		expect(by.subtitles).toMatchObject({ status: 'skipped' });
		expect(by.subtitles!.reason).toMatch(/transcri/i);
		expect(by.reactions).toMatchObject({ status: 'skipped' });
		expect(by.reactions!.reason).toMatch(/no bin named “Reactions”/);
		expect(by.music!.reason).toMatch(/no bin named “Music”/);
		expect(plan.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['W_ROLE_MISSING', 'W_NO_TRANSCRIPT']));
		expect(by['decorate-cuts']!.status).toBe('planned');
		expect(by['ken-burns']!.status).toBe('planned');
	});

	it('Fast Shorts: reactions avoid the subtitles, the shake kits sit above them, music has the intro step', async () => {
		const t = talk([90, 60, 120, 90, 60, 150, 90, 120], { vertical: true, reactions: 3, songs: 1 });
		t.h.ok([{ type: 'marker.add', frame: 100, name: 'reaction' }, { type: 'marker.add', frame: 400, name: 'reaction' }]);
		const plan = await planStyle(t.h.doc, { recipe: recipe('builtin:fast-shorts'), seed: 5, passes: { cleanup: false } }, {}, OPTS);
		const p = propose(t.h, styleDraft(plan)!);
		expect(p.items.filter((it) => it.state === 'invalid')).toEqual([]);
		accept(t.h, p);
		const seq = t.h.seq;
		const regions = subtitleRegions(t.h.doc, seq);
		expect(regions.length).toBeGreaterThan(0);
		const names = seq.videoTracks.map((x) => x.name);
		expect(names.indexOf('FX')).toBeGreaterThan(names.indexOf('Subtitles'));
		expect(names.indexOf('FX')).toBeGreaterThan(names.indexOf('Reactions'));
		const music = seq.audioTracks.find((x) => x.name === 'Music')!;
		const beds = Object.values(seq.clips).filter((c) => c.trackId === music.id).sort((a, b) => a.start - b.start);
		expect((beds[0] as { gainDb: number }).gainDb).toBe(-25);
		expect((beds[1] as { gainDb: number }).gainDb).toBe(-33);
	});

	it('property: whatever the edit and seed, the combined proposal applies, kits are disjoint, punch-ins never share a Ken Burns clip, reactions stay clear of subtitles', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 20, max: 240 }), { minLength: 3, maxLength: 12 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.boolean(),
				fc.array(fc.tuple(fc.integer({ min: 0, max: 600 }), fc.integer({ min: 2, max: 25 })), { maxLength: 4 }),
				async (lengths, seed, vertical, rawCuts) => {
					const t = talk(lengths, { vertical, reactions: 2, songs: 2, overlays: [lengths[0]!] });
					t.h.ok([{ type: 'marker.add', frame: lengths[0]! + 2, name: 'reaction' }]);
					const total = t.total;
					const cuts = rawCuts
						.map(([a, n]) => [Math.min(a, total - 1), Math.min(a + n, total)] as [number, number])
						.filter(([a, b]) => b > a)
						.sort((x, y) => x[0] - y[0])
						.filter((c, i, list) => i === 0 || c[0] >= list[i - 1]![1]);
					const r0 = recipe(vertical ? 'builtin:fast-shorts' : 'builtin:fast-long-form');
					const plan = await planStyle(t.h.doc, { recipe: r0, seed, passes: { reactions: true } }, { cleanup: cleanupHook(t, cuts) }, OPTS);
					const draft = styleDraft(plan);
					if (!draft) return;
					const p = propose(t.h, draft);
					expect(p.items.filter((it) => it.state === 'invalid').map((it) => it.reason)).toEqual([]);
					accept(t.h, p);
					expect(checkInvariants(t.h.doc)).toEqual([]);
					const seq = t.h.seq;
					const fx = byTrackName(t.h, 'FX');
					for (let i = 1; i < fx.length; i++)
						expect(fx[i]!.start).toBeGreaterThanOrEqual(fx[i - 1]!.start + fx[i - 1]!.duration);
					const aroll = Object.values(seq.clips).filter((c) => c.kind === 'video' && c.trackId === seq.videoTracks[0]!.id);
					for (const c of aroll) {
						const k = motionKindOf(seq, c);
						// a clip is decorated by at most one of them (keyed once)
						const keys = (c as { transform?: { scale?: { keyframes?: unknown[] } } }).transform?.scale?.keyframes ?? [];
						if (k) expect(keys.length).toBe(2);
					}
					const regions = subtitleRegions(t.h.doc, seq);
					for (const rc of byTrackName(t.h, 'Reactions')) {
						const rect = clipRect(t.h.doc, seq, rc);
						expect(rect).not.toBeNull();
						for (const g of regions)
							if (g.start < rc.start + rc.duration && g.end > rc.start) expect(rectsOverlap(g.rect, rect!)).toBe(false);
					}
				},
			),
			{ numRuns: 25 },
		);
	}, 120_000);

	it('Reroll of a decoration planned on the cleaned-up timeline keeps its id and refs and re-plans on that timeline', async () => {
		const t = talk([150, 120, 200, 180, 150]);
		const plan = await planStyle(t.h.doc, { recipe: recipe('builtin:fast-long-form'), seed: 4, passes: { subtitles: false, music: false } }, { cleanup: cleanupHook(t, [[60, 80]]) }, OPTS);
		const p = propose(t.h, styleDraft(plan)!);
		const kb = p.items.find((it) => (it.meta as { kind?: string }).kind === 'ken-burns');
		const kit = p.items.find((it) => (it.meta as { kind?: string }).kind === 'kit')!;
		const ids = [kit.id, ...(kb ? [kb.id] : [])];
		const r = await refreshStyleItems(t.h.doc, p, ids, { ...OPTS, reroll: true });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.items.map((it) => it.id).sort()).toEqual([...ids].sort());
		expect(JSON.stringify(r.items)).not.toMatch(/[a-z]{2,3}_ZS[0-9A-Z]{14}/);
		const out = refreshProposalItems(t.h.doc, p, ids, { items: r.items, dropped: r.dropped }, { ...CTX, revision: t.h.revision }, NOW);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.proposal.items.filter((it) => ids.includes(it.id)).map((it) => it.state)).toEqual(ids.map(() => 'pending'));
		accept(t.h, out.proposal);
		expect(checkInvariants(t.h.doc)).toEqual([]);
		// the cleanup's refresh is a re-run of Apply Style
		const c = await refreshStyleItems(t.h.doc, p, ['cleanup'], OPTS);
		expect(c.ok && c.dropped[0]?.reason).toMatch(/Apply Style again/);
	});

	it('agents need every embedded feature allowed: a combined proposal with a cleanup is refused when cleanup is off', async () => {
		const t = talk([150, 120, 200]);
		const plan = await planStyle(t.h.doc, { recipe: recipe('builtin:fast-long-form'), passes: { subtitles: false } }, { cleanup: cleanupHook(t, [[20, 30]]) }, OPTS);
		const p = propose(t.h, styleDraft(plan)!);
		const policy = projectFeaturePolicy('edit-automation');
		expect(policy(t.h.doc, p)).toEqual({ allowed: true });
		t.h.ok([{ type: 'project.updateSettings', settings: { agentProposals: { 'transcript-cleanup': false } } }]);
		expect(policy(t.h.doc, p)).toMatchObject({ allowed: false, reason: expect.stringContaining('transcript cleanup') });
	});
});

describe('Style Check (EA-013)', () => {
	it('an undecorated edit deviates from Fast Long-form with look-here frames; after Apply Style it is on target', async () => {
		const lengths = Array.from({ length: 30 }, (_, i) => 60 + ((i * 37) % 90));
		const t = talk(lengths, { songs: 3 });
		const r0 = recipe('builtin:fast-long-form');
		const bare = styleCheck(t.h.doc, null, r0, { deadAir: { perMinute: 0.5, pauses: [] } });
		const m = Object.fromEntries(bare.metrics.map((x) => [x.id, x]));
		expect(m.kitCoverage).toMatchObject({ status: 'off', value: 0 });
		expect(m.kitCoverage!.lookHere.length).toBeGreaterThan(0);
		expect(m.kitCoverage!.lookHere[0]).toMatchObject({ frame: lengths[0], timecode: expect.any(String) });
		expect(m.punchInsPerMinute!.status).toBe('off');
		expect(m.deadAirPerMinute!.status).toBe('ok');
		expect(m.subtitleOnCut!.status).toBe('unmeasured');
		expect(m.musicGainDb!.status).toBe('unmeasured');
		const plan = await planStyle(t.h.doc, { recipe: r0, seed: 1, passes: { cleanup: false } }, {}, OPTS);
		accept(t.h, propose(t.h, styleDraft(plan)!));
		const after = Object.fromEntries(styleCheck(t.h.doc, null, r0).metrics.map((x) => [x.id, x]));
		expect(after.kitCoverage!.value).toBeGreaterThan(0.9);
		expect(after.kenBurnsShare!.value).toBeGreaterThan(0.05);
		expect(after.musicGainDb).toMatchObject({ status: 'ok', value: -33 });
		expect(after.subtitleOnCut!.value).toBeGreaterThanOrEqual(0.95);
		expect(after.deadAirPerMinute!.status).toBe('unmeasured');
	});

	it('Clean checks only dead air and subtitles', () => {
		const t = talk([90, 90]);
		const r = styleCheck(t.h.doc, null, recipe('builtin:clean'));
		expect(r.metrics.filter((m) => m.status !== 'unchecked').map((m) => m.id).sort()).toEqual(['deadAirPerMinute', 'subtitleOnCut']);
	});

	it('motionKindOf tells a punch-in from a Ken Burns move', () => {
		const t = talk([120, 120]);
		const [a, b] = t.video;
		t.h.ok([
			{ type: 'keyframe.addBatch', targets: [{ clipId: a, path: ['transform', 'scale'], keys: [{ at: { frames: 60 }, value: 100 }, { at: { frames: 67 }, value: 180 }] }] },
			{ type: 'keyframe.addBatch', targets: [{ clipId: b, path: ['transform', 'scale'], keys: [{ at: { frames: 0 }, value: 100 }, { at: { frames: 119 }, value: 130 }] }] },
		]);
		expect(motionKindOf(t.h.seq, t.h.seq.clips[a] as Clip)).toEqual({ kind: 'punch-in', start: 60 });
		expect(motionKindOf(t.h.seq, t.h.seq.clips[b] as Clip)).toEqual({ kind: 'ken-burns' });
	});
});
