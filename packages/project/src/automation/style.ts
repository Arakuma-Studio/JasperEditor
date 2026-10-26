// Apply Style (spec 15 EA-012; docs/wp-notes/edit-automation.md "Apply Style"): a style recipe's stages run into ONE
// combined proposal of feature `edit-automation`, in the order cleanup → subtitles → kits → punch-ins → Ken Burns →
// reactions → slides → music → stingers.
//
// Later stages see what earlier stages planned: each stage's items are applied to a simulated copy of the document
// (sim ids, never stored) before the next stage plans on it. So the decorations are planned on the cleaned-up
// timeline with its subtitles on it, a punch-in never lands on a clip a Ken Burns move took (Ken Burns runs after the
// punch-ins and skips keyed clips), kits never overlap (Decorate Cuts), reactions avoid the subtitles' screen regions
// and the kits' FX track sits above the subtitles and reactions (they shake the whole composite, as in the user's
// stacks). Entities a stage creates are named in later stages' commands by the temp refs that create them: the
// cleanup's `cleanup.apply {pieceRefs: '$c'}` names every clip of the cleaned-up tracks (`$c_<clip>_<k>`), setup
// items name their tracks, bins and media. An item that would need an entity no ref names is left out (reported),
// never planned against an id that will not exist. Every decoration requires the cleanup item (its frames are those
// of the cleaned-up timeline) and the recipe copy item (`styleRecipe.add`, the project keeps the recipe it used).
//
// The engine drives the I/O through hooks (the cleanup analysis, folders, voice activity, loudness, subjects, library
// sounds); tests and the accuracy harness call the same function with fewer hooks. Accepting everything is one
// transaction (one undo step). Refresh / Reroll (`refreshStyleItems`) re-simulate the earlier stages' pending items
// and re-plan the requested ones with their pass's refresher. Pure apart from the hooks.

import { findSubtitleTemplate } from '../captions/subtitles/templates.ts';
import { applyTransaction } from '../commands/apply.ts';
import { substituteKnownRefs } from '../commands/context.ts';
import type { Registries } from '../commands/types.ts';
import { CROCKFORD_ALPHABET, type IdPrefix, type IdSource } from '../ids.ts';
import {
	EDIT_AUTOMATION_FEATURE,
	SUBTITLES_FEATURE,
	TRANSCRIPT_CLEANUP_FEATURE,
} from '../proposals/features.ts';
import type { Proposal, ProposalItem, ProposalItemInput } from '../proposals/schema.ts';
import { declaredRefs } from '../proposals/structure.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { SOUND_PROPOSAL_SETUP_GROUP } from '../sound/proposal-draft.ts';
import { findBin } from './assets.ts';
import { AutomationInputError, automationSequence, fpsValue, frameGeometry, timecodeOf } from './common.ts';
import type { AutomationPass, AutomationRange } from './params.ts';
import { AUTOMATION_PASS_GROUP } from './params.ts';
import {
	type AutomationPlan,
	type PassContext,
	parsePassParams,
	passItems,
	passSummary,
	planPass,
	type SfxNeeds,
	sfxNeeds,
} from './pass.ts';
import type { AutomationCost, PassSfx } from './proposal.ts';
import {
	type ResolvedStage,
	resolveRecipeStages,
	STYLE_STAGE_NAMES,
	type StageSwitches,
	type StyleRecipe,
	type StyleStage,
} from './recipes.ts';
import { refreshAutomationItems } from './refresh.ts';
import type { AutomationSummary } from './summary.ts';

/** `report.pass` of an Apply Style proposal (the refresher of `edit-automation` dispatches on it). */
export const STYLE_REPORT_PASS = 'apply-style';
export const STYLE_RECIPE_ITEM = 'style-recipe';
export const STYLE_CLEANUP_ITEM = 'cleanup';
export const STYLE_SUBTITLES_ITEM = 'subtitles';
/** Prefix of the cleanup's piece refs (`$c_<clip>_<k>`). */
export const STYLE_PIECE_REFS = '$c';

type Warning = { code: string; message: string };

/** What the sfx hook reports for a pass (the shape of `AutomationSfxReport`). */
export type StyleSfxReport = {
	enabled: boolean;
	type: string;
	available: number;
	placed: number;
	sounds: number;
	unsounded: number;
};

/** What the engine's cleanup analysis gives the cleanup stage (`cleanupApplyCommands`' inputs). */
export type StyleCleanupInput = {
	ranges: { start: number; end: number }[];
	clipIds: string[];
	fadeMs: number;
	jlFrames: number;
	/** The plan's statistics (spec 14 `CleanupStats`), reported as they are. */
	stats?: Record<string, unknown>;
	findings?: number;
	warnings?: Warning[];
};

export type StyleSkip = { skip: Warning };

export type StyleHooks = {
	/** The cleanup analysis of the live document (the engine's `cleanup-analysis` job). */
	cleanup?: (input: {
		doc: ProjectDocument;
		sequenceId: string;
		preset: string;
		overrides?: Record<string, unknown>;
		range?: AutomationRange;
	}) => Promise<StyleCleanupInput | StyleSkip>;
	/** A subtitle template the project and the built-ins do not have (the user library). */
	subtitleTemplate?: (id: string) => Promise<Record<string, unknown> | null>;
	/** A pass's engine inputs on the stage document (folder files, voice activity, loudness). */
	passInputs?: (
		pass: AutomationPass,
		doc: ProjectDocument,
		sequenceId: string,
		params: Record<string, unknown>,
	) => Promise<{ ctx: PassContext; warnings: Warning[] }>;
	/** After planning: more context to plan again with (punch-ins toward the subject), or null. */
	refine?: (
		pass: AutomationPass,
		doc: ProjectDocument,
		plan: AutomationPlan,
		params: Record<string, unknown>,
	) => Promise<PassContext | null>;
	/** The library sounds of a pass (registered for the proposal; a dry run only counts them). */
	sounds?: (
		pass: AutomationPass,
		doc: ProjectDocument,
		plan: AutomationPlan,
		needs: SfxNeeds,
	) => Promise<{ sfx?: PassSfx; report: StyleSfxReport; warnings: Warning[] }>;
	progress?: (fraction: number, stage: string) => void;
	signal?: { readonly aborted: boolean };
};

export type StyleRequest = {
	recipe: StyleRecipe;
	sequenceId?: string | null;
	/** Frames [start, end) of the live sequence (mapped onto the cleaned-up timeline for the later stages). */
	range?: AutomationRange;
	/** Seed of every pass (default each pass's own, else 1). */
	seed?: number;
	/** Turn stages on or off for this run. */
	passes?: StageSwitches;
};

export type StyleStageStatus = 'planned' | 'empty' | 'off' | 'skipped';

export type StyleStageReport = {
	stage: StyleStage;
	name: string;
	status: StyleStageStatus;
	/** Decorations (cuts for the cleanup, subtitles, kits…). */
	count: number;
	/** Proposal items of the stage (setup items included). */
	items: number;
	reason?: string;
	summary?: AutomationSummary;
	sfx?: StyleSfxReport | null;
	/** Cleanup: removed frames and the plan's statistics. */
	cleanup?: { ranges: number; removedFrames: number; findings: number; stats?: Record<string, unknown> };
	/** Items planned but left out (an entity no ref names, a failing command). */
	dropped: { itemId: string; reason: string }[];
	cost: AutomationCost['class'] | null;
	warnings: Warning[];
};

export type StyleReport = {
	pass: typeof STYLE_REPORT_PASS;
	version: 1;
	recipe: { id: string; name: string; revision: number };
	sequenceId: string;
	seed: number | null;
	range: AutomationRange | null;
	piecePrefix: string | null;
	/** Per stage, what the refresher re-plans with (the pass parameters as planned). */
	stages: {
		stage: StyleStage;
		status: StyleStageStatus;
		params?: Record<string, unknown>;
		count: number;
		summary?: AutomationSummary;
	}[];
	warnings: Warning[];
};

export type StylePlan = {
	sequenceId: string;
	items: ProposalItemInput[];
	stages: StyleStageReport[];
	warnings: Warning[];
	/** The highest export cost class of the planned stages (subtitles are judged by the engine's export planner). */
	cost: AutomationCost['class'];
	report: StyleReport;
	/** The simulated result of accepting everything (sim ids): for the engine's export-route check and tests. */
	simulated: ProjectDocument;
	title: string;
	summary: string;
};

export type StyleOptions = {
	registries: Registries;
	now?: () => string;
};

// ---------------------------------------------------------------------------------------------------------------
// Sim ids and the id ↔ ref maps

/** Sim ids: `<prefix>_ZS` + 14 Crockford digits of a counter. Never stored (every one is named by a ref or dropped). */
export function styleSimIds(start = 1): IdSource {
	let n = start;
	return {
		next(prefix: IdPrefix) {
			let v = n++;
			let body = '';
			while (v > 0) {
				body = CROCKFORD_ALPHABET[v % 32] + body;
				v = Math.floor(v / 32);
			}
			return `${prefix}_ZS${body.padStart(14, '0')}`;
		},
	};
}
const ID_IN_TEXT = /(?<![a-z])[a-z]{2,3}_[0-9A-HJKMNP-TV-Z]{16}(?![0-9A-Z])/g;
const isSimId = (s: string) => /^[a-z]{2,3}_ZS[0-9A-HJKMNP-TV-Z]{14}$/.test(s);

const ID_KEY_RE = /(?:Id|Ids)$|^(?:target|track|tracks|matteTrack)$/;
const DECL_KEYS = new Set(['ref', 'itemRef', 'type', 'payload', 'preset']);

/**
 * How ids of the simulation are written in the proposal: `exact` ids are addressed by their ref (commands' id
 * fields, meta), `token` ids are spelled by their token inside other strings (item ids, ref names, labels).
 */
type IdMaps = {
	exact: Map<string, string>;
	token: Map<string, string>;
	/** ref → the item that declares it (its `requires`). */
	refItem: Map<string, string>;
};

const metaKeyPath = new Set(['meta']);

/** An item rewritten from sim ids to refs / tokens (see `IdMaps`); `unmapped` lists ids nothing names. */
function mapItem<T extends ProposalItemInput>(
	item: T,
	m: IdMaps,
): { item: T; unmapped: string[]; refs: Set<string> } {
	const unmapped = new Set<string>();
	const refs = new Set<string>();
	const sub = (s: string) =>
		s.replace(ID_IN_TEXT, (id) => {
			const t = m.token.get(id);
			if (t !== undefined) return t;
			if (isSimId(id)) unmapped.add(id);
			return id;
		});
	const walk = (
		v: unknown,
		ctx: { inCommands: boolean; id: boolean; decl: boolean },
		depth: number,
	): unknown => {
		if (depth > 64) return v;
		if (typeof v === 'string') {
			if (!ctx.decl) {
				const ref = m.exact.get(v);
				if (ref !== undefined) {
					if (!ctx.inCommands || ctx.id) {
						refs.add(ref);
						return ref;
					}
					unmapped.add(v);
					return v;
				}
			}
			return sub(v);
		}
		if (Array.isArray(v)) return v.map((x) => walk(x, ctx, depth + 1));
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) {
				const next = {
					inCommands: ctx.inCommands,
					id: ctx.id || ID_KEY_RE.test(k),
					decl: DECL_KEYS.has(k),
				};
				Object.defineProperty(out, k, {
					value: walk(x, next, depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			return out;
		}
		return v;
	};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(item)) {
		if (k === 'commands') out[k] = walk(v, { inCommands: true, id: false, decl: false }, 0);
		else if (k === 'alternatives')
			out[k] = (v as Record<string, unknown>[]).map((a) => {
				const o: Record<string, unknown> = {};
				for (const [ak, av] of Object.entries(a))
					o[ak] = walk(av, { inCommands: ak === 'commands', id: false, decl: false }, 0);
				return o;
			});
		else if (k === 'requires') out[k] = (v as string[]).map(sub);
		else if (metaKeyPath.has(k)) out[k] = walk(v, { inCommands: false, id: false, decl: false }, 0);
		else out[k] = typeof v === 'string' ? sub(v) : walk(v, { inCommands: false, id: false, decl: true }, 0);
	}
	return { item: out as T, unmapped: [...unmapped], refs };
}

/** The reverse view: refs and tokens of earlier stages spelled as the ids the simulation has for them. */
function viewItem(item: ProposalItem, simOfRef: ReadonlyMap<string, string>): ProposalItem {
	if (!simOfRef.size) return item;
	const tokens = new Map<string, string>();
	for (const [ref, id] of simOfRef) tokens.set(ref.slice(1), id);
	const tokenRe = tokens.size
		? new RegExp(
				`(?<![\\w])(${[...tokens.keys()]
					.sort((a, b) => b.length - a.length)
					.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
					.join('|')})(?![\\w])`,
				'g',
			)
		: null;
	const walk = (v: unknown, decl: boolean, depth: number): unknown => {
		if (depth > 64) return v;
		if (typeof v === 'string') {
			if (!decl && simOfRef.has(v)) return simOfRef.get(v);
			// declarations and uses of refs keep the proposal's names (the simulation declares them as they are)
			if (decl || !tokenRe || v.startsWith('$')) return v;
			// tokens inside item ids, ref names and labels (`punch:c_clp_…_1`, `$punchCue_punch_c_clp_…_1`)
			return v.replace(tokenRe, (t) => tokens.get(t) ?? t);
		}
		if (Array.isArray(v)) return v.map((x) => walk(x, decl, depth + 1));
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v))
				Object.defineProperty(out, k, {
					value: walk(x, DECL_KEYS.has(k), depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			return out;
		}
		return v;
	};
	return walk(item, false, 0) as ProposalItem;
}

// ---------------------------------------------------------------------------------------------------------------
// The simulation

type Sim = {
	doc: ProjectDocument;
	ids: IdSource;
	/** ref → id in the simulated document (refs of items applied so far). */
	simOfRef: Map<string, string>;
	maps: IdMaps;
	opts: StyleOptions;
	sequenceId: string;
};

const SIM_ORIGIN = { agent: 'apply-style' } as const;

/**
 * Applies items (proposal form) to the simulation: refs of earlier items become their sim ids, the items' own refs are
 * declared. A failing item (and the items of this batch that require it) is left out and reported; the rest applies.
 */
function applyToSim(
	sim: Sim,
	items: ProposalItemInput[],
	refItemOf: (ref: string, itemId: string) => boolean,
): {
	applied: ProposalItemInput[];
	failed: { itemId: string; reason: string }[];
	results: Map<string, unknown[]>;
} {
	const failed: { itemId: string; reason: string }[] = [];
	let todo = [...items];
	for (let attempt = 0; attempt < 64 && todo.length; attempt++) {
		const commands: Record<string, unknown>[] = [];
		const ranges: { id: string; start: number; end: number }[] = [];
		for (const it of todo) {
			const start = commands.length;
			for (const c of it.commands) commands.push(substituteKnownRefs(c, sim.simOfRef));
			ranges.push({ id: it.id, start, end: commands.length });
		}
		const r = applyTransaction(
			sim.doc,
			{ label: 'Apply Style (simulation)', origin: SIM_ORIGIN, sequenceId: sim.sequenceId, commands },
			{
				ids: sim.ids,
				now: sim.opts.now ?? (() => new Date().toISOString()),
				revision: 0,
				registries: sim.opts.registries,
				maxCommands: Number.MAX_SAFE_INTEGER,
			},
		);
		if (r.result.ok) {
			sim.doc = r.document;
			for (const [ref, id] of Object.entries(r.result.refs)) {
				sim.simOfRef.set(ref, id);
				const owner = todo.find((it) => refItemOf(ref, it.id));
				if (owner) sim.maps.refItem.set(ref, owner.id);
			}
			const results = new Map<string, unknown[]>();
			for (const rg of ranges) results.set(rg.id, r.result.results.slice(rg.start, rg.end));
			return { applied: todo, failed, results };
		}
		const e = r.result.errors[0];
		const hit = e ? ranges.find((rg) => e.commandIndex >= rg.start && e.commandIndex < rg.end) : undefined;
		if (!hit) {
			// a transaction-level failure (an invariant): nothing of this batch can be told apart
			for (const it of todo)
				failed.push({
					itemId: it.id,
					reason: e ? `${e.code}: ${e.message}`.slice(0, 300) : 'the commands fail',
				});
			return { applied: [], failed, results: new Map() };
		}
		const out = new Set([hit.id]);
		for (const it of todo) if ((it.requires ?? []).some((x) => out.has(x))) out.add(it.id);
		for (const id of out)
			failed.push({
				itemId: id,
				reason: id === hit.id ? `${e!.code}: ${e!.message}`.slice(0, 300) : `requires ${hit.id}, which fails`,
			});
		todo = todo.filter((it) => !out.has(it.id));
	}
	return { applied: [], failed, results: new Map() };
}

/** Records the sim ids the applied items' refs name: later stages address them by ref (and by token in names). */
function recordRefs(sim: Sim, applied: ProposalItemInput[], before: ReadonlySet<string>, exactAlso: boolean) {
	for (const [ref, id] of sim.simOfRef) {
		if (before.has(ref)) continue;
		if (!applied.some((it) => sim.maps.refItem.get(ref) === it.id)) continue;
		if (isSimId(id) || exactAlso) sim.maps.exact.set(id, ref);
		if (isSimId(id)) sim.maps.token.set(id, ref.slice(1));
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Ranges through the cleanup

/** Maps a live frame onto the cleaned-up timeline (removed ranges sorted, disjoint). */
export function frameAfterCuts(ranges: readonly { start: number; end: number }[], f: number): number {
	let removed = 0;
	for (const r of ranges) {
		if (r.end <= f) removed += r.end - r.start;
		else if (r.start < f) {
			removed += f - r.start;
			break;
		} else break;
	}
	return f - removed;
}

function mergedRanges(list: readonly { start: number; end: number }[]) {
	const s = [...list].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start || a.end - b.end);
	const out: { start: number; end: number }[] = [];
	for (const r of s) {
		const l = out[out.length - 1];
		if (l && r.start <= l.end) l.end = Math.max(l.end, r.end);
		else out.push({ ...r });
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Roles (EA-011)

const ROLE_TEXT = {
	reactions: { what: 'reaction pictures', field: 'assets.reactionImages' },
	music: { what: 'songs', field: 'assets.musicFolder' },
} as const;

/** A role a stage cannot resolve: an actionable message (never a silent skip). */
function roleProblem(
	doc: ProjectDocument,
	stage: 'reactions' | 'music',
	params: Record<string, unknown>,
	recipe: string,
): Warning | null {
	const a = params.assets as { bin?: string; folder?: string; mediaIds?: string[] } | undefined;
	const t = ROLE_TEXT[stage];
	if (!a)
		return {
			code: 'W_ROLE_MISSING',
			message: `“${recipe}” places ${stage === 'reactions' ? 'reactions' : 'music beds'} from your ${t.what}, but no source is set: choose a bin or folder for them (${t.field})`,
		};
	if (a.bin !== undefined && a.folder === undefined && a.mediaIds === undefined && !findBin(doc, a.bin))
		return {
			code: 'W_ROLE_MISSING',
			message: `“${recipe}” places ${stage === 'reactions' ? 'reactions' : 'music beds'} from your ${t.what}, but the project has no bin named “${a.bin}”: import your ${t.what} into a bin with that name, or choose another bin or a folder for them (${t.field})`,
		};
	return null;
}

/** Tracks the passes put their own output on (never the picture they decorate). */
const PASS_TRACK_NAMES = /^(fx|zoom|reactions|stingers|subtitles)(?: \d+)?$/i;
const PICTURE_KINDS = new Set(['video', 'nest-video', 'still', 'animated-image', 'solid']);

/** The last frame + 1 of the picture (picture clips of the video tracks other than the passes' own). */
export function pictureEnd(seq: Sequence): number {
	const own = new Set(
		seq.videoTracks.filter((t) => PASS_TRACK_NAMES.test((t.name ?? '').trim())).map((t) => t.id),
	);
	let end = 0;
	for (const c of Object.values(seq.clips ?? {}))
		if (PICTURE_KINDS.has(c.kind) && c.enabled !== false && !own.has(c.trackId))
			end = Math.max(end, c.start + c.duration);
	return end;
}

/** Effects the native export draws (crop, flips): anything else on a clip is baked by the layer bake. */
const NATIVE_CLIP_EFFECTS = new Set(['jasper.crop', 'jasper.flip-horizontal', 'jasper.flip-vertical']);

/** Export cost of subtitles made with a template: text clips with GPU effects → `hybrid`; caption tracks native. */
function subtitleCost(
	t: { output?: string; animation?: { preset?: { effects?: { effectId?: string }[] } | null } } | null,
	output: string | undefined,
): AutomationCost['class'] {
	if ((output ?? t?.output) === 'caption-track') return 'native';
	const fx = t?.animation?.preset?.effects ?? [];
	return fx.some((e) => typeof e.effectId === 'string' && !NATIVE_CLIP_EFFECTS.has(e.effectId))
		? 'hybrid'
		: 'native';
}

const COST_ORDER: Record<AutomationCost['class'], number> = { native: 0, hybrid: 1, remotion: 2 };
const maxCost = (a: AutomationCost['class'], b: AutomationCost['class']) =>
	COST_ORDER[b] > COST_ORDER[a] ? b : a;

const nonSetup = (items: readonly ProposalItemInput[]) =>
	items.filter((it) => (it.meta as { setup?: unknown } | undefined)?.setup !== true);

/** Drops `anchorOn.cuts` (frames of the cleaned-up timeline) and refs from an item's anchors. */
function stripCutAnchors(item: ProposalItemInput): ProposalItemInput {
	const meta = item.meta as Record<string, unknown> | undefined;
	const on = meta?.anchorOn as { clips?: unknown[]; cuts?: unknown[] } | undefined;
	if (!meta || !on) return item;
	const clips = (on.clips ?? []).filter((x) => typeof x === 'string' && !x.startsWith('$'));
	const { anchorOn: _a, ...rest } = meta;
	return { ...item, meta: { ...rest, ...(clips.length ? { anchorOn: { clips } } : {}) } };
}

// ---------------------------------------------------------------------------------------------------------------
// planStyle

/**
 * Plans a recipe on a sequence (see the file comment). Never throws for what the stages find (a missing role, no
 * transcript, an unknown bin: the stage is skipped with the reason); throws `AutomationInputError` for an unknown
 * sequence.
 */
export async function planStyle(
	doc: ProjectDocument,
	req: StyleRequest,
	hooks: StyleHooks,
	opts: StyleOptions,
): Promise<StylePlan> {
	const seq = automationSequence(doc, req.sequenceId);
	const recipe = req.recipe;
	const stages = resolveRecipeStages(recipe, req.passes);
	const sim: Sim = {
		doc,
		ids: styleSimIds(),
		simOfRef: new Map(),
		maps: { exact: new Map(), token: new Map(), refItem: new Map() },
		opts,
		sequenceId: seq.id,
	};
	const items: ProposalItemInput[] = [];
	const reports: StyleStageReport[] = [];
	const warnings: Warning[] = [];
	const usedIds = new Set<string>();
	const declared = new Set<string>();
	let cost: AutomationCost['class'] = 'native';
	let cuts: { start: number; end: number }[] = [];
	let cleanupItem: string | null = null;
	const progress = (k: number, name: string) => hooks.progress?.(0.05 + (0.85 * k) / stages.length, name);
	const aborted = () => hooks.signal?.aborted === true;

	// the recipe copy: every other item requires it (accepting any part keeps the recipe in the project)
	const { builtIn: _b, ...recipeCopy } = recipe;
	items.push({
		id: STYLE_RECIPE_ITEM,
		label: `Keep the recipe “${recipe.name}” in the project`.slice(0, 200),
		group: SOUND_PROPOSAL_SETUP_GROUP,
		commands: [{ type: 'styleRecipe.add', recipe: recipeCopy, activate: true }],
		meta: { setup: true, kind: 'style-recipe', recipeId: recipe.id },
	});
	usedIds.add(STYLE_RECIPE_ITEM);
	{
		const r = applyToSim(sim, [items[0]!], () => false);
		if (r.failed.length)
			throw new AutomationInputError(
				'E_INVALID_PARAM',
				`The recipe cannot be stored in the project: ${r.failed[0]!.reason}`,
			);
	}

	const report = (s: ResolvedStage, rest: Partial<StyleStageReport> & { status: StyleStageStatus }) => {
		const r: StyleStageReport = {
			stage: s.stage,
			name: STYLE_STAGE_NAMES[s.stage],
			count: 0,
			items: 0,
			dropped: [],
			cost: null,
			warnings: [],
			...rest,
		};
		reports.push(r);
		return r;
	};
	const baseRequires = () => [STYLE_RECIPE_ITEM, ...(cleanupItem ? [cleanupItem] : [])];

	/** Adds a stage's items (proposal form) and applies them to the simulation. */
	const commit = (stageItems: ProposalItemInput[], dropped: { itemId: string; reason: string }[]) => {
		const mapped: ProposalItemInput[] = [];
		for (const raw of stageItems) {
			const m = mapItem(raw, sim.maps);
			if (m.unmapped.length) {
				dropped.push({
					itemId: raw.id,
					reason: `it needs ${m.unmapped[0]}, which no earlier step names`,
				});
				continue;
			}
			let it = m.item;
			if (usedIds.has(it.id)) {
				dropped.push({ itemId: it.id, reason: 'another step planned an item with the same id' });
				continue;
			}
			const own = declaredRefs(it.commands);
			if (own.some((r) => declared.has(r))) {
				dropped.push({ itemId: it.id, reason: 'it declares a temp ref another step declares' });
				continue;
			}
			const req = new Set(it.requires ?? []);
			for (const r of m.refs) {
				const owner = sim.maps.refItem.get(r);
				if (owner && owner !== it.id) req.add(owner);
			}
			for (const r of baseRequires()) req.add(r);
			if (cleanupItem) it = stripCutAnchors(it);
			it = { ...it, requires: [...req].filter((r) => r !== it.id) };
			mapped.push(it);
		}
		// items requiring a dropped one of this stage
		let changed = true;
		while (changed) {
			changed = false;
			const ids = new Set(mapped.map((x) => x.id));
			for (const it of [...mapped])
				for (const r of it.requires ?? [])
					if (!usedIds.has(r) && !ids.has(r)) {
						mapped.splice(mapped.indexOf(it), 1);
						dropped.push({ itemId: it.id, reason: `it requires ${r}, which was left out` });
						changed = true;
						break;
					}
		}
		const before = new Set(sim.simOfRef.keys());
		const ownRefs = new Map(mapped.map((it) => [it.id, new Set(declaredRefs(it.commands))]));
		const r = applyToSim(sim, mapped, (ref, id) =>
			ref.startsWith(`${STYLE_PIECE_REFS}_`) ? id === STYLE_CLEANUP_ITEM : !!ownRefs.get(id)?.has(ref),
		);
		dropped.push(...r.failed);
		recordRefs(sim, r.applied, before, true);
		for (const it of r.applied) {
			usedIds.add(it.id);
			for (const ref of declaredRefs(it.commands)) declared.add(ref);
			items.push(it);
		}
		return r;
	};

	for (const [k, s] of stages.entries()) {
		if (aborted()) throw new AutomationInputError('E_INVALID_PARAM', 'Cancelled');
		progress(k, STYLE_STAGE_NAMES[s.stage]);
		if (!s.enabled) {
			report(s, { status: 'off' });
			continue;
		}
		// ---- cleanup
		if (s.stage === 'cleanup') {
			if (!hooks.cleanup) {
				report(s, {
					status: 'skipped',
					reason: 'The voice cleanup needs the engine (its voice analysis)',
					warnings: [
						{
							code: 'W_CLEANUP_UNAVAILABLE',
							message: 'The voice cleanup needs the engine (its voice analysis)',
						},
					],
				});
				continue;
			}
			const got = await hooks.cleanup({
				doc,
				sequenceId: seq.id,
				preset: s.preset,
				...(s.overrides ? { overrides: s.overrides as Record<string, unknown> } : {}),
				...(req.range ? { range: req.range } : {}),
			});
			if ('skip' in got) {
				report(s, { status: 'skipped', reason: got.skip.message, warnings: [got.skip] });
				continue;
			}
			const ranges = mergedRanges(got.ranges);
			if (!ranges.length) {
				report(s, {
					status: 'empty',
					reason: 'Nothing to cut: the voice is clean already',
					warnings: got.warnings ?? [],
					cleanup: {
						ranges: 0,
						removedFrames: 0,
						findings: got.findings ?? 0,
						...(got.stats ? { stats: got.stats } : {}),
					},
				});
				continue;
			}
			const removed = ranges.reduce((n, r) => n + (r.end - r.start), 0);
			const fps = fpsValue(frameGeometry(seq).fps);
			const item: ProposalItemInput = {
				id: STYLE_CLEANUP_ITEM,
				label: `Clean up the voice: ${ranges.length} cuts, ${(removed / fps).toFixed(1)} s removed`.slice(
					0,
					200,
				),
				group: 'cleanup',
				commands: [
					{
						type: 'cleanup.apply',
						sequenceId: seq.id,
						clipIds: got.clipIds,
						ranges,
						mode: 'extract',
						fadeMs: got.fadeMs,
						jlFrames: got.jlFrames,
						pieceRefs: STYLE_PIECE_REFS,
					},
				],
				requires: [STYLE_RECIPE_ITEM],
				meta: {
					group: 'cleanup',
					pass: 'cleanup',
					kind: 'cleanup',
					feature: TRANSCRIPT_CLEANUP_FEATURE,
					frame: ranges[0]!.start,
					timecode: timecodeOf(seq, ranges[0]!.start),
					range: { start: ranges[0]!.start, end: ranges[ranges.length - 1]!.end },
					why: `Clean Up Voice (${s.preset === 'builtin.natural' ? 'Natural' : s.preset === 'builtin.fast' ? 'Fast' : s.preset}): ${ranges.length} cuts remove ${(removed / fps).toFixed(1)} s. The decorations of this proposal are planned on the cleaned-up timeline: accepting any of them applies these cuts too.`.slice(
						0,
						600,
					),
					rerollable: false,
					cuts: ranges.length,
					removedFrames: removed,
					preset: s.preset,
					...(got.stats ? { stats: got.stats } : {}),
				},
			};
			const dropped: { itemId: string; reason: string }[] = [];
			const r = commit([item], dropped);
			if (!r.applied.length) {
				report(s, {
					status: 'skipped',
					reason: dropped[0]?.reason ?? 'the cuts do not apply',
					dropped,
					warnings: got.warnings ?? [],
				});
				continue;
			}
			cleanupItem = STYLE_CLEANUP_ITEM;
			cuts = ranges;
			report(s, {
				status: 'planned',
				count: ranges.length,
				items: 1,
				cost: 'native',
				cleanup: {
					ranges: ranges.length,
					removedFrames: removed,
					findings: got.findings ?? 0,
					...(got.stats ? { stats: got.stats } : {}),
				},
				warnings: got.warnings ?? [],
			});
			continue;
		}
		const range = req.range
			? (() => {
					const a = frameAfterCuts(cuts, req.range!.start);
					const b = frameAfterCuts(cuts, req.range!.end);
					return b > a ? { start: a, end: b } : null;
				})()
			: undefined;
		if (range === null) {
			report(s, { status: 'empty', reason: 'The cleanup removes the whole range' });
			continue;
		}
		// ---- subtitles
		if (s.stage === 'subtitles') {
			const existing = (automationSequence(sim.doc, seq.id) as { captionGroups?: Record<string, unknown> })
				.captionGroups;
			if (existing && Object.keys(existing).length) {
				report(s, {
					status: 'skipped',
					reason: 'The sequence has subtitles already (Text ▸ Subtitles): they are kept as they are',
					warnings: [
						{
							code: 'W_HAS_SUBTITLES',
							message:
								'The sequence has subtitles already: Apply Style keeps them (regenerate them in Text ▸ Subtitles)',
						},
					],
				});
				continue;
			}
			let template: unknown = s.template;
			if (!findSubtitleTemplate(sim.doc, s.template)) {
				const t = hooks.subtitleTemplate ? await hooks.subtitleTemplate(s.template) : null;
				if (!t) {
					const message = `The recipe's subtitle template ${s.template} is neither built in, in the project nor in your template library: choose another template for the recipe`;
					report(s, { status: 'skipped', reason: message, warnings: [{ code: 'W_ROLE_MISSING', message }] });
					continue;
				}
				template = t;
			}
			const cmd: Record<string, unknown> = {
				type: 'captions.generate',
				sequenceId: seq.id,
				template,
				...(s.rules ? { rules: s.rules } : {}),
				...(s.text ? { text: s.text } : {}),
				...(s.cutAware !== undefined ? { cutAware: s.cutAware } : {}),
				...(s.output ? { output: s.output } : {}),
				...(s.language ? { language: s.language } : {}),
				...(range ? { range: { start: range.start, end: range.end } } : {}),
			};
			const name =
				typeof template === 'string'
					? (findSubtitleTemplate(sim.doc, template)?.name ?? template)
					: String((template as { name?: unknown }).name ?? 'template');
			const item: ProposalItemInput = {
				id: STYLE_SUBTITLES_ITEM,
				label: `Subtitles (${name})`.slice(0, 200),
				group: 'subtitles',
				commands: [cmd],
				requires: baseRequires(),
				meta: {
					group: 'subtitles',
					pass: 'subtitles',
					kind: 'subtitles',
					feature: SUBTITLES_FEATURE,
					frame: range?.start ?? 0,
					why: `Subtitles from the transcript with the template “${name}”, aligned to the cuts of the cleaned-up timeline`.slice(
						0,
						600,
					),
					rerollable: false,
					template: typeof template === 'string' ? template : (template as { id?: unknown }).id,
				},
			};
			const dropped: { itemId: string; reason: string }[] = [];
			const r = commit([item], dropped);
			if (!r.applied.length) {
				const why = dropped[0]?.reason ?? 'the subtitles do not apply';
				const noWords = /transcri|words/i.test(why);
				const message = noWords
					? 'Subtitles need a transcript of the dialogue: transcribe the sequence first (Transcript ▸ Transcribe…), or turn Subtitles off for this run'
					: `The subtitles could not be made: ${why}`;
				report(s, {
					status: 'skipped',
					reason: message,
					warnings: [{ code: noWords ? 'W_NO_TRANSCRIPT' : 'W_SUBTITLES_FAILED', message }],
				});
				continue;
			}
			const res = (r.results.get(STYLE_SUBTITLES_ITEM)?.[0] ?? {}) as {
				count?: number;
				stats?: { warnings?: string[] };
			};
			// text clips with the template's GPU effects (Pixel Pop's Transform + S_Shake) are baked by the layer bake
			const t =
				typeof template === 'string'
					? findSubtitleTemplate(sim.doc, template)
					: (template as Parameters<typeof subtitleCost>[0]);
			const subCost = subtitleCost(t, s.output);
			if ((res.count ?? 0) > 0) cost = maxCost(cost, subCost);
			report(s, {
				status: (res.count ?? 0) > 0 ? 'planned' : 'empty',
				count: res.count ?? 0,
				items: 1,
				cost: subCost,
				warnings: (res.stats?.warnings ?? [])
					.slice(0, 20)
					.map((m) => ({ code: 'W_SUBTITLES', message: String(m).slice(0, 300) })),
			});
			continue;
		}
		// ---- an automation pass
		const pass = s.stage as AutomationPass;
		const raw: Record<string, unknown> = { ...(s as { params: Record<string, unknown> }).params };
		if (req.seed !== undefined) raw.seed = req.seed;
		// the passes decorate the picture: never past its end (subtitles may hold a little longer, the end is no cut)
		const end = pictureEnd(automationSequence(sim.doc, seq.id));
		const passRange =
			end > 0 ? { start: Math.min(range?.start ?? 0, end), end: Math.min(range?.end ?? end, end) } : range;
		if (passRange && passRange.end > passRange.start) raw.range = passRange;
		else if (passRange) {
			report(s, { status: 'empty', reason: 'No picture in the range' });
			continue;
		} else delete raw.range;
		delete raw.excludeClipIds;
		let params: Record<string, unknown>;
		try {
			params = parsePassParams(pass, raw);
		} catch (e) {
			const message = `${STYLE_STAGE_NAMES[pass]}: ${(e as Error).message}`;
			report(s, { status: 'skipped', reason: message, warnings: [{ code: 'E_INVALID_PARAM', message }] });
			continue;
		}
		if (pass === 'reactions' || pass === 'music') {
			const w = roleProblem(sim.doc, pass, params, recipe.name);
			if (w) {
				report(s, { status: 'skipped', reason: w.message, warnings: [w] });
				continue;
			}
		}
		const stageWarnings: Warning[] = [];
		let plan: AutomationPlan;
		try {
			const inputs = hooks.passInputs
				? await hooks.passInputs(pass, sim.doc, seq.id, params)
				: { ctx: {}, warnings: [] };
			stageWarnings.push(...inputs.warnings);
			plan = planPass(sim.doc, pass, seq.id, params, inputs.ctx);
			const more = hooks.refine ? await hooks.refine(pass, sim.doc, plan, params) : null;
			if (more) plan = planPass(sim.doc, pass, seq.id, params, { ...inputs.ctx, ...more });
		} catch (e) {
			if (!(e instanceof AutomationInputError) && !(e instanceof Error && (e as { status?: number }).status))
				throw e;
			const message = `${STYLE_STAGE_NAMES[pass]}: ${(e as Error).message}`;
			report(s, {
				status: 'skipped',
				reason: message,
				warnings: [{ code: 'W_STAGE_SKIPPED', message }, ...stageWarnings],
			});
			continue;
		}
		const needs = sfxNeeds(sim.doc, plan, params as { sfx?: never });
		let sfx: PassSfx | undefined;
		let sfxReport: StyleSfxReport | null = null;
		if (needs && hooks.sounds) {
			const got = await hooks.sounds(pass, sim.doc, plan, needs);
			sfx = got.sfx;
			sfxReport = got.report;
			stageWarnings.push(...got.warnings);
			if (got.report.available === 0 && (pass === 'decorate-cuts' || pass === 'punch-ins'))
				stageWarnings.push({
					code: 'W_ROLE_MISSING',
					message: `No ${needs.sfx.type} sound for the ${pass === 'decorate-cuts' ? 'kits' : 'punch-ins'} of “${recipe.name}”: install a CC0 sound pack or the starter kit (Sound ▸ Sound Library), or add a folder of your sounds, then run Apply Style again; they are planned without sound`,
				});
		}
		const pi = passItems(sim.doc, plan, sfx);
		const summary = passSummary(plan, pi);
		const allWarnings = [...summary.warnings, ...stageWarnings];
		if (
			(pass === 'reactions' || pass === 'music') &&
			summary.count === 0 &&
			allWarnings.some((w) => w.code === 'W_NO_ASSETS')
		) {
			const t = ROLE_TEXT[pass];
			allWarnings.unshift({
				code: 'W_ROLE_MISSING',
				message: `“${recipe.name}” has no ${t.what} to use: put your ${t.what} in the source the recipe names (${t.field})`,
			});
		}
		if (!nonSetup(pi.items).length) {
			report(s, {
				status: 'empty',
				summary: { ...summary, warnings: allWarnings },
				sfx: sfxReport,
				warnings: allWarnings,
				cost: pi.cost.class,
			});
			continue;
		}
		const dropped: { itemId: string; reason: string }[] = [];
		const r = commit(pi.items, dropped);
		const planned = nonSetup(r.applied).length;
		if (planned) cost = maxCost(cost, pi.cost.class);
		report(s, {
			status: planned ? 'planned' : 'empty',
			count: planned,
			items: r.applied.length,
			summary: { ...summary, warnings: allWarnings },
			sfx: sfxReport,
			dropped,
			cost: pi.cost.class,
			warnings: [
				...allWarnings,
				...(dropped.length
					? [
							{
								code: 'W_STYLE_DROPPED',
								message: `${dropped.length} planned ${STYLE_STAGE_NAMES[pass].toLowerCase()} were left out (${dropped[0]!.reason})`,
							},
						]
					: []),
			],
		});
	}
	for (const r of reports)
		for (const w of r.warnings)
			if (w.code === 'W_ROLE_MISSING' || w.code === 'W_NO_TRANSCRIPT') warnings.push(w);
	hooks.progress?.(0.92, 'Proposal');
	const planned = reports.filter((r) => r.status === 'planned');
	const parts = planned.map((r) => `${r.count} ${r.name.toLowerCase()}`);
	const summary = `${recipe.name}: ${parts.length ? parts.join(', ') : 'nothing to propose'}${cost !== 'native' ? `; export: ${cost === 'remotion' ? 'Remotion path' : 'native with baked layers'}` : ''}`;
	const styleReport: StyleReport = {
		pass: STYLE_REPORT_PASS,
		version: 1,
		recipe: { id: recipe.id, name: recipe.name, revision: recipe.revision },
		sequenceId: seq.id,
		seed: req.seed ?? null,
		range: req.range ?? null,
		piecePrefix: cleanupItem ? STYLE_PIECE_REFS : null,
		stages: reports.map((r) => {
			const s = stages.find((x) => x.stage === r.stage)!;
			const params = 'params' in s ? { ...s.params } : undefined;
			if (params && req.seed !== undefined) params.seed = req.seed;
			return {
				stage: r.stage,
				status: r.status,
				count: r.count,
				...(params ? { params } : {}),
				...(r.summary
					? {
							summary: {
								...r.summary,
								skipped: { ...r.summary.skipped, first: r.summary.skipped.first.slice(0, 20) },
							},
						}
					: {}),
			};
		}),
		warnings,
	};
	return {
		sequenceId: seq.id,
		items: planned.length ? items : [],
		stages: reports,
		warnings,
		cost,
		report: styleReport,
		simulated: sim.doc,
		title: `Apply Style: ${recipe.name}`.slice(0, 200),
		summary: summary.slice(0, 4000),
	};
}

/** The proposal draft of a planned style (null when nothing was planned). */
export function styleDraft(plan: StylePlan) {
	if (!nonSetup(plan.items).length) return null;
	return {
		sequenceId: plan.sequenceId,
		feature: EDIT_AUTOMATION_FEATURE,
		title: plan.title,
		summary: plan.summary,
		items: plan.items,
		report: plan.report,
	};
}

/** The Apply Style report of a proposal, or null. */
export function styleReportOf(p: Pick<Proposal, 'report'>): StyleReport | null {
	const r = p.report as Partial<StyleReport> | undefined;
	if (!r || typeof r !== 'object' || r.pass !== STYLE_REPORT_PASS || !Array.isArray(r.stages)) return null;
	return r as StyleReport;
}

// ---------------------------------------------------------------------------------------------------------------
// Refresh / Reroll

type Meta = Record<string, unknown>;
const metaOf = (it: Pick<ProposalItem, 'meta'>): Meta =>
	it.meta && typeof it.meta === 'object' ? (it.meta as Meta) : {};

/** The stage an item of a style proposal belongs to (setup items: the stage of the first item that requires them). */
function stageOfItem(p: Proposal, it: ProposalItem): StyleStage | null {
	const m = metaOf(it);
	const pass = m.pass;
	if (pass === 'cleanup' || pass === 'subtitles') return pass;
	if (typeof pass === 'string' && pass in AUTOMATION_PASS_GROUP) return pass as AutomationPass;
	if (it.id === STYLE_RECIPE_ITEM) return null;
	for (const other of p.items)
		if (other.requires.includes(it.id) && other.id !== it.id) {
			const s = stageOfItem(p, other);
			if (s) return s;
		}
	return null;
}

export type StyleRefresh =
	| { ok: true; items: ProposalItemInput[]; dropped: { itemId: string; reason: string }[] }
	| { ok: false; code: 'E_INVALID_PARAM' | 'E_NOT_FOUND'; message: string };

/**
 * Replacement items for `itemIds` of an Apply Style proposal on the live `doc`: the earlier stages' pending items are
 * simulated (accepted ones are in the document already), then each requested decoration is re-planned by its pass's
 * refresher on that stage's document with the item's own seed (Refresh) or the next (Reroll), keeping its id and
 * refs. The voice cleanup is planned from the whole sequence's analysis: a stale cleanup item is dropped (run Apply
 * Style again); the subtitles item is returned as it is (it is laid out when applied).
 */
export async function refreshStyleItems(
	doc: ProjectDocument,
	p: Proposal,
	itemIds: readonly string[],
	opts: StyleOptions & { reroll?: boolean },
	hooks: Pick<StyleHooks, 'passInputs' | 'refine'> = {},
): Promise<StyleRefresh> {
	const rep = styleReportOf(p);
	if (!rep)
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The proposal is not an Apply Style proposal' };
	let seqId: string;
	try {
		seqId = automationSequence(doc, p.sequenceId).id;
	} catch (e) {
		return { ok: false, code: 'E_NOT_FOUND', message: (e as Error).message };
	}
	const wanted = new Set(itemIds);
	const applied = new Map<string, string>();
	for (const it of p.items)
		if (it.state === 'accepted' && it.applied)
			for (const [k, v] of Object.entries(it.applied.refs)) applied.set(k, v);
	const sim: Sim = {
		doc,
		ids: styleSimIds(),
		simOfRef: new Map(applied),
		maps: { exact: new Map(), token: new Map(), refItem: new Map() },
		opts,
		sequenceId: seqId,
	};
	// accepted entities keep their ids in replacements; their tokens spell them inside names
	for (const [ref, id] of applied) sim.maps.token.set(id, ref.slice(1));
	const out: ProposalItemInput[] = [];
	const dropped: { itemId: string; reason: string }[] = [];
	const live = (it: ProposalItem) => it.state === 'pending' || it.state === 'stale' || it.state === 'invalid';
	const byStage = new Map<StyleStage | null, ProposalItem[]>();
	for (const it of p.items) {
		const s = stageOfItem(p, it);
		const list = byStage.get(s) ?? [];
		list.push(it);
		byStage.set(s, list);
	}
	const ownRefs = new Map(p.items.map((it) => [it.id, new Set(declaredRefs(it.commands as unknown[]))]));
	const refItemOf = (ref: string, id: string) =>
		ref.startsWith(`${STYLE_PIECE_REFS}_`) ? id === STYLE_CLEANUP_ITEM : !!ownRefs.get(id)?.has(ref);
	const simulate = (list: ProposalItem[]) => {
		const todo = list.filter(live).map((it) => viewItem(it, sim.simOfRef));
		const before = new Set(sim.simOfRef.keys());
		const r = applyToSim(sim, todo as ProposalItemInput[], refItemOf);
		recordRefs(sim, r.applied, before, true);
	};
	// the recipe item first
	const recipeItem = p.items.find((it) => it.id === STYLE_RECIPE_ITEM);
	if (recipeItem && live(recipeItem)) simulate([recipeItem]);
	for (const stage of ['cleanup', 'subtitles', ...Object.keys(AUTOMATION_PASS_GROUP)] as StyleStage[]) {
		const list = byStage.get(stage) ?? [];
		if (!list.length) continue;
		const requested = list.filter((it) => wanted.has(it.id) && live(it) && metaOf(it).setup !== true);
		if (stage === 'cleanup') {
			for (const it of requested)
				dropped.push({
					itemId: it.id,
					reason:
						'the voice cleanup is planned from an analysis of the whole sequence: run Apply Style again',
				});
			if (!requested.length) simulate(list);
			continue;
		}
		if (stage === 'subtitles') {
			for (const it of requested) {
				const {
					state: _s,
					reason: _r,
					anchors: _a,
					applied: _ap,
					note: _n,
					selectedAlternative: _sa,
					...input
				} = it as ProposalItem & { anchors?: unknown };
				out.push(input as ProposalItemInput);
			}
			simulate(list);
			continue;
		}
		const pass = stage as AutomationPass;
		const st = rep.stages.find((x) => x.stage === pass);
		if (requested.length && st?.params) {
			const view = {
				...p,
				report: { pass, params: st.params },
				items: p.items.map((it) => viewItem(it, sim.simOfRef)),
			} as Proposal;
			let ctx: PassContext = {};
			if (hooks.passInputs) {
				try {
					ctx = (await hooks.passInputs(pass, sim.doc, seqId, st.params)).ctx;
				} catch {
					ctx = {};
				}
			}
			const r = refreshAutomationItems(
				sim.doc,
				view,
				requested.map((it) => viewItem(it, sim.simOfRef).id),
				{
					...(opts.reroll ? { reroll: true } : {}),
					ctx,
				},
			);
			if (!r.ok) return r;
			const viewIds = new Map(requested.map((it) => [viewItem(it, sim.simOfRef).id, it.id]));
			for (const d of r.dropped)
				dropped.push({ itemId: viewIds.get(d.itemId) ?? d.itemId, reason: d.reason });
			const replaced = new Map<string, ProposalItemInput>();
			for (const raw of r.items) {
				const m = mapItem(raw, sim.maps);
				const id = viewIds.get(raw.id) ?? m.item.id;
				if (m.unmapped.length) {
					dropped.push({ itemId: id, reason: `it needs ${m.unmapped[0]}, which no earlier step names` });
					continue;
				}
				const old = p.items.find((x) => x.id === id);
				const req = new Set([...(old?.requires ?? []), ...(m.item.requires ?? [])]);
				for (const ref of m.refs) {
					const owner = sim.maps.refItem.get(ref);
					if (owner && owner !== id) req.add(owner);
				}
				let it: ProposalItemInput = { ...m.item, id, requires: [...req].filter((x) => x !== id) };
				if (rep.piecePrefix) it = stripCutAnchors(it);
				replaced.set(id, it);
				out.push(it);
			}
			// the stage as it will be: the replacements in place of the old items
			const next = list
				.map((it) => {
					const rep2 = replaced.get(it.id);
					return rep2 ? ({ ...it, ...rep2, state: 'pending' } as ProposalItem) : it;
				})
				.filter((it) => !dropped.some((d) => d.itemId === it.id));
			simulate(next);
		} else {
			for (const it of requested)
				dropped.push({ itemId: it.id, reason: 'the proposal has no parameters for its pass' });
			simulate(list);
		}
	}
	return { ok: true, items: out, dropped };
}

/** The stage names of a style report (for the dialog and MCP). */
export function styleStageNames(): Record<StyleStage, string> {
	return { ...STYLE_STAGE_NAMES };
}
