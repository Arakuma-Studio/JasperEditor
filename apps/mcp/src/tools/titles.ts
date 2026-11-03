// Title art for agents (spec 19 §11, TL-100…TL-107; docs/wp-notes/title-looks-agents.md): search → sheet → propose →
// check, the way the sound tools work. `title_look_find` searches the library and shows it on one numbered sheet;
// `title_propose` turns a brief into a title on the real footage, with colourways as alternatives, and checks it;
// `title_check` measures rendered frames and reports rows bound to a revision. The rest is the escape hatch: recipes,
// saved looks, generators and the sequence's global light.
import {
	type ProposalCreateResponse,
	type ProposalResponse,
	resolveCatalogFont,
	type StillSheetCell,
	type StillSheetResult,
	type TitleLookLibraryResponse,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	type Appearance,
	agentProposalsAllowed,
	appearanceFromRecipe,
	appearanceProblem,
	applyTransaction,
	type Clip,
	type Colorway,
	clipLook,
	contentTimeAt,
	createEmptyProject,
	createRandomIdSource,
	DELIVERY_TARGET_IDS,
	type DeliveryTargetId,
	defaultRegistries,
	FACTORY_COLORWAYS,
	FACTORY_LOOKS,
	type FactoryLook,
	factoryLook,
	fpsOf,
	GENERATOR_LAYER_PREFIX,
	type LookRecipe,
	LookRecipeSchema,
	latestTextAnimationSpec,
	makeSequenceSettings,
	measureTitleFrame,
	type ProjectDocument,
	type Proposal,
	previewProposal,
	type Rational,
	RECIPE_BOUNDS,
	recipeBoundsProblem,
	recipeFromAppearance,
	type Sequence,
	scaleAnimationFrames,
	sequenceTimecode,
	summarizeTitleRows,
	TITLE_ART_FEATURE,
	TITLE_ART_GROUP,
	TITLE_LAYER_TYPES,
	TITLE_LOOK_CLIP_KINDS,
	TITLE_NOT_CHECKED,
	type TitleArtMeta,
	type TitleCheckAt,
	type TitleCheckRow,
	type TitleFrameMeasure,
	type TitleLook,
	titleArtCheck,
	titleArtDraft,
	titleCheckFrames,
	titleLayerType,
	titleLookOf,
	titleReadSeconds,
	titleRenderedRows,
	titleSizePx,
	titleTextRows,
	titleTiming,
	USER_LOOK_ID,
	type UserLook,
	userLookSource,
} from '@jasper/project';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	findClip,
	frameOf,
	type LoadedDoc,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import {
	awaitSheet,
	composeSheet,
	DEFAULT_SHEET_TIMEOUT_SEC,
	MAX_SHEET_TIMEOUT_SEC,
	type SheetMeta,
	sheetImages,
	sheetNext,
	sheetOfJob,
	submitSheet,
} from '../still-sheet.ts';
import { titleLintRows } from '../title-lint.ts';
import { APPROVAL_REQUIRED_HINT } from './proposals.ts';
import { durationFrames } from './trim-paths.ts';

export const TITLE_ART_GUIDE = `Title art: stylized titles from a brief, in three to five calls (spec 19). A look is a reusable appearance on a clip (rims, glows, shadows, finishes, generators); a colourway is a palette that fills a look's colour roles without changing its structure. The tools are in the titles toolset: run them with call_tool (describe_tool shows the arguments).
- Workflow: title_look_find → title_propose → title_check. title_look_find {query, tags?, aspect?, sampleText?, projectId?} searches the library, the user's own looks (ulk_…, saved in the editor and shared by every project) and the project's, and returns rows (source says which) and one numbered sheet of real renders; any row's lookId works with title_propose and title_look_find {lookId} (its recipe); title_propose {projectId, text, at, lookId, alternatives?} puts the title on the timeline or in Review, and returns one sheet of intro, hold and outro × alternatives over the real footage, plus its check; title_check {projectId, clipId | proposalId, target?} measures it again after any change.
- Modes of title_propose. "propose" (default) stores a title-art proposal: colourways are the item's alternatives, the user reviews it in the Review panel, wait_for_proposal gives the decision, accept_proposal applies it where Project Settings ▸ Agent Proposals allows it. It needs the project open in an editor window: without one nobody can review it and it is refused with E_NO_EDITOR, nothing stored. "dryRun" changes nothing. "apply" adds the title now: with an editor it is one undoable History entry; on a headless engine there is no History and undo cannot reach it, so the result carries revert, the apply_commands arguments that take it out again. Ask before leaving a headless apply in place when the user did not ask for it.
- energy (low, medium, high) picks the in and out animations. duration defaults to the time the text needs to be read. colorway names a colourway by id or name; alternatives (0–3) adds others, chosen from seed, which every result returns so a run can be repeated. An empty library is said plainly: pass recipe instead.
- title_check rows are {id, kind, status, measured, expected, at, message, fix?}, as verify_export's: kind "format" = you may fix it unasked (fix.commands go to apply_commands, then check again), kind "judgement" = tell the user what was measured and ask. safe-area and off-frame use the title's real alpha bounds; contrast compares it with the rendered picture behind it, tile by tile, at the frames it is at rest; min-size, read-time, font-available and export-path (from the planner) follow, then every style lint issue. target adds the platform's interface zones, which are estimates and only warn. verified = no fail row and no unverified format row, at the returned revision: after any edit it says nothing, run it again. notChecked lists what no row measures: taste above all. Report those as not checked, never as fine.
- Sheets are one engine job. Past timeoutSeconds a call returns {jobId, timedOut: true, next}; render_frames {jobId} (sheets) or title_check {jobId, …} (rows) picks the job up. render_frames {proposalId, overlay: "safe-area"} shows a proposal with the Program monitor's safe margins.
- Escape hatch. title_look_find {lookId} returns a look as JSON and the layer types it uses; title_propose {recipe} and title_look_save {clipId | recipe, name, tags} take such a recipe (${RECIPE_BOUNDS.layers} layers, ${RECIPE_BOUNDS.maxBytes / 1024} KB, ${RECIPE_BOUNDS.maxDepth} levels of nesting, ${RECIPE_BOUNDS.maxTypeInstances} layers of a type, ${RECIPE_BOUNDS.maxGeneratorInstances} generators). title_generator_add adds a generator behind a title or as a layer of its look; title_light_set moves the light of every look that follows the sequence. get_clip_properties lists a look's palette, light and layer params with their param.set targets, so keyframes and expressions reach them. list_effects, add_effect and set_effect_param add ordinary effects on top.`;

const LookIdArg = z
	.string()
	.min(1)
	.max(128)
	.describe('A library ("look.…"), user ("ulk_…") or project ("tlk_…") look: title_look_find');

/** TL-106: checked before anything reads the value; an arbitrary JSON object otherwise. */
const RecipeArg = z
	.record(z.string(), z.unknown())
	.superRefine((v, c) => {
		const p = recipeBoundsProblem(v);
		if (p) c.addIssue({ code: 'custom', message: p.message });
	})
	.describe(
		'A look as JSON: {layers: [{type, name?, enabled?, params?}], palette?, light?, font?}. title_look_find {lookId} gives examples',
	);

const TimeoutArg = z
	.number()
	.int()
	.min(1)
	.max(MAX_SHEET_TIMEOUT_SEC)
	.optional()
	.describe('How long to wait for the renders (default 120); past it the result carries jobId');

/** One image per call: 640 px wide by default (TL-106). */
const DEFAULT_SHEET_WIDTH = 640;
const MAX_TOOL_SHEET_WIDTH = 1280;
const SheetWidthArg = z
	.number()
	.int()
	.min(160)
	.max(MAX_TOOL_SHEET_WIDTH)
	.optional()
	.describe(`Width of the sheet in px (default ${DEFAULT_SHEET_WIDTH})`);

/** Width the check measures at: enough for a 1 px rim at 1080p to survive, small enough for software GL. */
const ANALYSIS_WIDTH = 960;
const SHEET_GAP = 4;
const MAX_ALTERNATIVES = 3;
const MAX_FIND_LIMIT = 12;
const PHASES = ['intro', 'hold', 'outro'] as const;
/** Backdrop of the library sheet: a mid grey, so light and dark looks both show. */
const LOOK_BACKDROP: [number, number, number, number] = [0.32, 0.34, 0.38, 1];
const MAX_SAMPLE_TEXT = 40;
const DEFAULT_SAMPLE_TEXT = 'Your Title';

const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
	'16:9': { width: 1280, height: 720 },
	'9:16': { width: 720, height: 1280 },
	'1:1': { width: 960, height: 960 },
	'4:5': { width: 864, height: 1080 },
};

/** In and out animations per energy (preset ids of `TEXT_ANIMATION_SPECS`). */
const ENERGY = {
	low: { in: 'fade', out: 'fade' },
	medium: { in: 'slide-up', out: 'fade' },
	high: { in: 'pop', out: 'slide-down' },
} as const;
type Energy = keyof typeof ENERGY;

/** A look wherever it lives, as `look.apply` takes it. */
type LookEntry = {
	lookId: string | null;
	name: string;
	tags: readonly string[];
	category?: string;
	source: 'library' | 'user' | 'project' | 'recipe';
	recipe: LookRecipe;
	colorways: readonly Colorway[];
	apply:
		| { lookId: string }
		| {
				look: {
					name: string;
					recipe: LookRecipe;
					sourceId?: string;
					tags?: readonly string[];
					category?: string;
					colorways?: readonly Colorway[];
				};
		  };
};

const factoryEntry = (l: FactoryLook): LookEntry => ({
	lookId: l.libraryId,
	name: l.name,
	tags: l.tags ?? [],
	...(l.category ? { category: l.category } : {}),
	source: 'library',
	recipe: l.recipe,
	colorways: l.colorways ?? [],
	apply: { lookId: l.libraryId },
});

const projectEntry = (l: TitleLook): LookEntry => ({
	lookId: l.id,
	name: l.name,
	tags: l.tags ?? [],
	...(l.category ? { category: l.category } : {}),
	source: 'project',
	recipe: recipeFromAppearance(l.appearance),
	colorways: l.colorways ?? [],
	apply: { lookId: l.id },
});

/**
 * A look of the user's library (TL-054, the engine's store shared by every project). It travels whole, with its id as
 * `sourceId`: `look.apply` copies it into the project once and reuses that copy afterwards, as for a library look.
 */
const userEntry = (l: UserLook): LookEntry => ({
	lookId: l.id,
	name: l.name,
	tags: l.tags ?? [],
	...(l.category ? { category: l.category } : {}),
	source: 'user',
	recipe: l.recipe,
	colorways: l.colorways ?? [],
	apply: { look: userLookSource(l) },
});

/** The user's looks, or why they could not be read: an engine without the store still finds the library. */
async function userLooks(ctx: ToolContext): Promise<{ looks: UserLook[]; error?: string }> {
	try {
		const r: TitleLookLibraryResponse = await ctx.engine((c) => c.call('titleLooksList'));
		return { looks: r.looks };
	} catch (e) {
		return { looks: [], error: (e as Error).message };
	}
}

/** The project's looks that are not a copy of a library or user look (those are the original's row). */
function projectLooks(doc: ProjectDocument | null, user: readonly UserLook[]): TitleLook[] {
	const userIds = new Set(user.map((l) => l.id));
	return Object.keys((doc as { titleLooks?: object } | null)?.titleLooks ?? {})
		.map((id) => (doc ? titleLookOf(doc as never, id) : null))
		.filter(
			(l): l is TitleLook => !!l && !(l.sourceId && (factoryLook(l.sourceId) || userIds.has(l.sourceId))),
		);
}

/** The library, the user's looks, then the project's own. */
function lookCatalogue(doc: ProjectDocument | null, user: readonly UserLook[]): LookEntry[] {
	return [
		...FACTORY_LOOKS.map(factoryEntry),
		...user.map(userEntry),
		...projectLooks(doc, user).map(projectEntry),
	];
}

async function lookById(ctx: ToolContext, doc: ProjectDocument | null, id: string): Promise<LookEntry> {
	const f = factoryLook(id);
	if (f) return factoryEntry(f);
	const own = doc ? titleLookOf(doc as never, id) : null;
	if (own) return projectEntry(own);
	if (USER_LOOK_ID.test(id)) {
		const lib: TitleLookLibraryResponse = await ctx.engine((c) => c.call('titleLooksList'));
		const user = lib.looks.find((l) => l.id === id);
		if (user) return userEntry(user);
		// Deleted from the user's library since: the project's copy is still the look that was picked.
		const copy = doc
			? Object.keys((doc as { titleLooks?: object }).titleLooks ?? {})
					.map((k) => titleLookOf(doc as never, k))
					.find((l) => l?.sourceId === id)
			: undefined;
		if (copy) return projectEntry(copy);
		throw new ToolError(
			'E_NOT_FOUND',
			`No look ${id} in the user's library`,
			'title_look_find lists looks; the user may have deleted it.',
			{ lookId: id },
		);
	}
	throw new ToolError(
		'E_NOT_FOUND',
		`No look ${id}`,
		FACTORY_LOOKS.length
			? 'title_look_find lists looks; a project look needs its projectId.'
			: 'The library of this build is empty, and a project look needs its projectId: pass recipe instead.',
		{ lookId: id },
	);
}

/** A recipe's first full validation: the schema, every layer type and param, TL-013's limits. */
function parseRecipe(raw: unknown): LookRecipe {
	const r = LookRecipeSchema.safeParse(raw);
	if (!r.success) {
		const i = r.error.issues[0]!;
		throw new ToolError(
			'E_INVALID_PARAM',
			`recipe.${i.path.join('.')}: ${i.message}`,
			'title_look_find {lookId} shows a working recipe.',
		);
	}
	const ids = createRandomIdSource();
	let a: Appearance;
	try {
		a = appearanceFromRecipe(r.data, () => ids.next('apl'));
	} catch (e) {
		throw new ToolError('E_INVALID_PARAM', `recipe: ${(e as Error).message}`, layerTypesHint());
	}
	const bad = appearanceProblem(a);
	if (bad) throw new ToolError(/stops/.test(bad) ? 'E_LIMIT' : 'E_INVALID_PARAM', `recipe: ${bad}`);
	return r.data;
}

function layerTypesHint(): string {
	return 'title_look_find {lookId} lists the layer types in layerTypes; each takes the params of its layerParams entry.';
}

/** How much a look costs to draw, from what TL-037 and docs/performance.md §7 measured: time dependence, then layers. */
function costClassOf(recipe: LookRecipe): 'light' | 'medium' | 'heavy' {
	const layers = recipe.layers.filter((l) => l.enabled !== false);
	const animated = layers.some((l) => {
		const def = titleLayerType(l.type);
		return !!def?.timeDependent?.((l.params ?? {}) as never);
	});
	if (animated || layers.length > 8) return 'heavy';
	return layers.length > 4 ? 'medium' : 'light';
}

const atFrame = (seq: Sequence) => {
	const rate = seq.settings.frameRate as Rational;
	return (frame: number): TitleCheckAt => ({
		frame,
		sec: Math.round((frame / fpsOf(rate)) * 1000) / 1000,
		timecode: sequenceTimecode(seq, frame),
	});
};

function tokens(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** A row's score for a query: words of the name and tags count most, the category next, parts of words last. */
function searchScore(e: LookEntry, words: readonly string[]): number {
	if (!words.length) return 1;
	const name = tokens(e.name);
	const tags = e.tags.flatMap(tokens);
	const category = tokens(e.category ?? '');
	let score = 0;
	for (const w of words) {
		if (name.includes(w) || tags.includes(w)) score += 4;
		else if (category.includes(w)) score += 3;
		else if ([...name, ...tags].some((t) => t.startsWith(w))) score += 2;
		else if ([...name, ...tags, ...category].some((t) => t.includes(w))) score += 1;
	}
	return score;
}

/** Applies commands to a copy of `doc`, as the engine would. */
function applyLocally(doc: ProjectDocument, seqId: string | null, commands: unknown[], revision = 0) {
	const r = applyTransaction(
		doc,
		{
			protocol: 'jasper.tx/1',
			label: 'Preview',
			origin: 'user',
			...(seqId ? { sequenceId: seqId } : {}),
			commands: commands as never,
		},
		{
			ids: createRandomIdSource(),
			now: () => new Date().toISOString(),
			revision,
			registries: defaultRegistries(),
		},
	);
	if (!r.result.ok) {
		const e = r.result.errors[0];
		throw new ToolError(e?.code ?? 'E_INVALID_PARAM', e?.message ?? 'The title does not apply', undefined, {
			errors: r.result.errors.slice(0, 5),
		});
	}
	return { document: r.document, refs: r.result.refs };
}

/** One document with one 1-frame title per row, frame n = row n, over a neutral backdrop. */
function lookSheetDocument(rows: readonly LookEntry[], sampleText: string, aspect: string) {
	const ids = createRandomIdSource();
	const fresh = createEmptyProject({ ids, name: 'Title looks' });
	const seq = Object.values(fresh.sequences)[0] as Sequence;
	const size = ASPECT_SIZES[aspect]!;
	seq.settings = makeSequenceSettings(size.width, size.height, { num: 30, den: 1 });
	const sizePx = titleSizeFor(sampleText, size);
	const commands: unknown[] = [
		{ type: 'clip.addSolid', at: 0, duration: rows.length, track: 'V1', color: LOOK_BACKDROP },
	];
	rows.forEach((row, i) => {
		const ref = `$t${i}`;
		commands.push(
			{
				type: 'clip.addText',
				at: i,
				duration: 1,
				track: 'V2',
				content: { text: sampleText, style: { sizePx, align: 'center' } },
				ref,
			},
			// A scratch document holds no project look: those travel whole.
			{
				type: 'look.apply',
				clipIds: [ref],
				...(row.source === 'project' ? { look: { name: row.name, recipe: row.recipe } } : row.apply),
				seed: 1,
			},
		);
	});
	const { document } = applyLocally(fresh, seq.id, commands);
	return { document, sequenceId: seq.id };
}

/** A size that fits the longest line in the title-safe width (0.55 em per character, an estimate), capped by the height. */
function titleSizeFor(text: string, size: { width: number; height: number }): number {
	const longest = Math.max(1, ...text.split('\n').map((l) => [...l].length));
	const byWidth = (size.width * 0.75) / (longest * 0.55);
	return Math.max(16, Math.round(Math.min(size.height * 0.16, byWidth)));
}

function cellWidthOf(sheetWidth: number, columns: number): number {
	const w = Math.floor((sheetWidth - (columns + 1) * SHEET_GAP) / columns);
	return Math.max(64, w - (w % 2));
}

/** The picture with only the title over one flat colour (difference matting: `check.ts`). */
function titleOverColor(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	color: [number, number, number, number],
): ProjectDocument {
	const copy = structuredClone(doc) as ProjectDocument;
	const s = copy.sequences[seq.id]!;
	const title = s.clips[clip.id]!;
	s.clips = { [clip.id]: title };
	s.transitions = {};
	s.links = {};
	s.groups = {};
	for (const t of s.videoTracks) {
		t.locked = false;
		t.output = true;
	}
	const v1 = s.videoTracks[0]!.id;
	if (title.trackId === v1) {
		if (s.videoTracks.length < 2) {
			const added = applyLocally(copy, seq.id, [{ type: 'track.add', kind: 'video', count: 1 }]).document;
			(added as ProjectDocument).sequences[seq.id]!.clips[clip.id]!.trackId =
				added.sequences[seq.id]!.videoTracks[1]!.id;
			return applyLocally(added, seq.id, [
				{ type: 'clip.addSolid', at: clip.start, duration: clip.duration, track: 'V1', color },
			]).document;
		}
		title.trackId = s.videoTracks[1]!.id;
	}
	return applyLocally(copy, seq.id, [
		{ type: 'clip.addSolid', at: clip.start, duration: clip.duration, track: 'V1', color },
	]).document;
}

type CheckTarget = {
	doc: ProjectDocument;
	revision: number | undefined;
	seq: Sequence;
	clip: Clip;
	/** A clip of the document (fixes can name it), not one a proposal would create. */
	real: boolean;
};

/** Builds the cells of a sheet with reuse: the same render is one cell. */
class SheetBuilder {
	readonly cells: StillSheetCell[] = [];
	private readonly index = new Map<string, number>();
	add(document: number, sequenceId: string, frame: number, tag?: string, hide?: string[]): number {
		const key = `${document}:${frame}:${hide?.join(',') ?? ''}`;
		const have = this.index.get(key);
		if (have !== undefined && !tag) return have;
		this.index.set(key, this.cells.length);
		this.cells.push({
			document,
			sequenceId,
			frame,
			...(tag ? { tag } : {}),
			...(hide ? { hide } : {}),
		});
		return this.cells.length - 1;
	}
}

/** The four renders of each frame the check measures, tagged `<kind>:<frame>`. */
function addCheckCells(b: SheetBuilder, t: CheckTarget, withDoc: number, black: number, white: number) {
	const seqId = t.seq.id;
	for (const f of titleCheckFrames(titleTiming(t.clip as never))) {
		b.add(withDoc, seqId, f, `with:${f}`);
		b.add(withDoc, seqId, f, `behind:${f}`, [t.clip.id]);
		b.add(black, seqId, f, `black:${f}`);
		b.add(white, seqId, f, `white:${f}`);
	}
}

/** The measured frames of a finished job, from its tags. */
function measuresOf(
	result: StillSheetResult,
	images: readonly { width: number; height: number; data: Uint8Array }[],
	sequenceWidth: number,
): TitleFrameMeasure[] {
	const byTag = new Map(result.cells.filter((c) => c.tag).map((c) => [c.tag!, images[c.index]!]));
	const frames = [...byTag.keys()].filter((t) => t.startsWith('with:')).map((t) => Number(t.slice(5)));
	const out: TitleFrameMeasure[] = [];
	for (const f of frames) {
		const r = {
			with: byTag.get(`with:${f}`),
			behind: byTag.get(`behind:${f}`),
			black: byTag.get(`black:${f}`),
			white: byTag.get(`white:${f}`),
		};
		if (r.with && r.behind && r.black && r.white) out.push(measureTitleFrame(f, r as never, sequenceWidth));
	}
	return out;
}

/** The rows that need no picture: the text, the font, the planner, the style lint. */
async function plainRows(ctx: ToolContext, t: CheckTarget): Promise<TitleCheckRow[]> {
	const { doc, seq, clip } = t;
	const rate = seq.settings.frameRate as Rational;
	const rows: TitleCheckRow[] = [];
	const atOf = atFrame(seq);
	const timing = titleTiming(clip as never);
	if (clip.kind === 'text') {
		const text = clip as never as Parameters<typeof titleSizePx>[0];
		rows.push(
			...titleTextRows({
				clip: text,
				timing,
				size: seq.settings,
				rate,
				atOf,
				fixes: t.real,
			}),
		);
		rows.push(await fontRow(ctx, doc, clip, atOf(clip.start)));
	}
	rows.push(await exportPathRow(ctx, t));
	return rows;
}

/** Every style lint issue of the clip's look, compared with the measured backdrops when they are in. */
function lintRows(t: CheckTarget, measures: readonly TitleFrameMeasure[]): TitleCheckRow[] {
	const { seq, clip } = t;
	const fx = clipLook(
		(clip as { effects?: { effectId: string; appearance?: unknown; id: string }[] }).effects,
	);
	if (!fx?.appearance) return [];
	const rate = seq.settings.frameRate as Rational;
	const timing = titleTiming(clip as never);
	return titleLintRows({
		appearance: fx.appearance as Appearance,
		clip,
		effectInstanceId: fx.id,
		at: atFrame(seq)(timing.hold),
		fixes: t.real,
		time: contentTimeAt(clip as never, timing.hold, rate),
		sizePx: clip.kind === 'text' ? titleSizePx(clip as never, timing.hold, rate) : null,
		frameHeight: seq.settings.height,
		backdrops: measures.flatMap((m) => (m.backdropL === null ? [] : [m.backdropL])),
	});
}

async function fontRow(
	ctx: ToolContext,
	doc: ProjectDocument,
	clip: Clip,
	at: TitleCheckAt,
): Promise<TitleCheckRow> {
	const style = (clip as { content?: { style?: { fontId?: string; weight?: number; italic?: boolean } } })
		.content?.style;
	const family = style?.fontId ? doc.fonts[style.fontId]?.family : undefined;
	const row = { id: 'font-available', kind: 'format' as const, at };
	if (!family)
		return {
			...row,
			status: 'fail',
			measured: { family: null },
			expected: 'a font the document names',
			message: 'The text names no font of the project.',
		};
	let catalog: unknown;
	try {
		catalog = await ctx.engine((c) => c.listFonts());
	} catch (e) {
		return {
			...row,
			status: 'unverified',
			measured: { family },
			expected: 'a font the engine has',
			message: `The engine's font list could not be read: ${(e as Error).message}`,
		};
	}
	const found = resolveCatalogFont(catalog as never, family, style?.weight ?? 400, style?.italic === true);
	return {
		...row,
		status: found ? 'pass' : 'fail',
		measured: { family, available: !!found },
		expected: 'a font the engine has',
		message: found
			? `${family} is available.`
			: `${family} is not installed: the title renders in the default family and exports warn FONT_FALLBACK.`,
		...(found
			? {}
			: { fix: { label: `Install ${family} (install_font), or pick a family from list_fonts` } }),
	};
}

/** The planner's answer for the sequence as it stands, and what it says about this clip. */
async function exportPathRow(ctx: ToolContext, t: CheckTarget): Promise<TitleCheckRow> {
	const base = {
		id: 'export-path',
		kind: 'format' as const,
		expected: 'a path that draws the title exactly',
		at: null,
	};
	try {
		const plan = await ctx.engine((c) =>
			c.planExport({
				envelope: toolEnvelope(t.doc, t.revision),
				sequenceId: t.seq.id,
				settings: {
					sequenceId: t.seq.id,
					range: { type: 'entire' },
					container: 'mp4',
					engine: 'auto',
					destination: { type: 'download' },
				},
			}),
		);
		const own = (plan.blockers ?? []).filter((b) => b.itemId === t.clip.id).map((b) => b.reason);
		return {
			...base,
			status: 'pass',
			measured: { path: plan.path, ...(own.length ? { nativeBlockers: own } : {}) },
			message:
				plan.path === 'remotion'
					? 'Exports through the Remotion renderer: exact, and slower than the native path.'
					: `Exports on the ${plan.path} path.`,
		};
	} catch (e) {
		if (e instanceof EngineError && e.code !== 'NETWORK')
			return {
				...base,
				status: 'fail',
				measured: { refused: e.code },
				message: `The export is refused: ${e.message}`,
			};
		return {
			...base,
			status: 'unverified',
			measured: null,
			message: `The planner could not be asked: ${(e as Error).message}`,
		};
	}
}

function renderedRowsOf(
	t: CheckTarget,
	measures: readonly TitleFrameMeasure[],
	target: DeliveryTargetId | null,
) {
	const { seq, clip } = t;
	const rate = seq.settings.frameRate as Rational;
	const timing = titleTiming(clip as never);
	const sizePx = clip.kind === 'text' ? titleSizePx(clip as never, timing.hold, rate) : null;
	const transform = (
		clip as {
			transform?: {
				position?: { value: [number, number]; keyframes: unknown[] };
				scale?: { value: number; keyframes: unknown[] };
			};
		}
	).transform;
	const pos = transform?.position;
	const scale = transform?.scale;
	const movable = t.real && pos && !pos.keyframes.length && scale && !scale.keyframes.length;
	const fx = clipLook(
		(clip as { effects?: { effectId: string; appearance?: unknown; id: string }[] }).effects,
	);
	const layers = (fx?.appearance as Appearance | undefined)?.layers;
	const face = layers?.findIndex((l) => l.type === 'face') ?? -1;
	return titleRenderedRows({
		frames: measures,
		size: seq.settings,
		sizePx,
		target,
		atOf: atFrame(seq),
		position: movable ? pos.value : null,
		moveFix: movable
			? (dx, dy, k) => [
					{
						type: 'param.set',
						target: ['clip', clip.id, 'transform', 'position'],
						value: [pos.value[0] + dx, pos.value[1] + dy],
					},
					...(k < 1
						? [
								{
									type: 'param.set',
									target: ['clip', clip.id, 'transform', 'scale'],
									value: Math.floor(scale.value * k * 100) / 100,
								},
							]
						: []),
				]
			: null,
		rimFix:
			t.real && fx && face >= 0
				? (color) => [
						{
							type: 'appearance.addLayer',
							effectInstanceId: fx.id,
							layerType: 'rim',
							index: face,
							name: 'Contrast rim',
							params: { width: 6, paint: { kind: 'color', color } },
						},
					]
				: null,
	});
}

/** The body every check shares: rows, the verdict, the revision it holds for, and what no row measures. */
function checkBody(
	rows: readonly TitleCheckRow[],
	revision: number | undefined,
	opts: { pending?: boolean; textClip?: boolean } = {},
) {
	const { counts, verified } = summarizeTitleRows(rows);
	return {
		revision: revision ?? null,
		rows,
		counts,
		verified: verified && !opts.pending,
		notChecked: [
			...TITLE_NOT_CHECKED,
			...(opts.textClip === false ? ['min-size, read-time and fonts: this clip has no text.'] : []),
			...(opts.pending ? ['The rendered rows: their job is still running.'] : []),
		],
	};
}

const CHECK_NEXT =
	'kind "format" rows: apply fix.commands with apply_commands and run title_check again. kind "judgement" rows: tell the user what was measured, with its timecode, and ask. Rows hold for this revision only. Say what notChecked lists is not checked; never say the title looks good.';

/** The sequence's platform when the brief names one. */
function briefTarget(seq: Sequence): DeliveryTargetId | null {
	const p = (seq as { brief?: { platform?: unknown } }).brief?.platform;
	return typeof p === 'string' && (DELIVERY_TARGET_IDS as readonly string[]).includes(p)
		? (p as DeliveryTargetId)
		: null;
}

/** The title of an item of a proposal, previewed on the current document. */
function proposalTarget(
	loaded: LoadedDoc,
	p: Proposal,
	itemId: string | undefined,
	alternative: number | undefined,
): CheckTarget {
	const undecided = p.items.filter((i) => i.state === 'pending' || i.state === 'stale');
	const item = itemId ? p.items.find((i) => i.id === itemId) : (undecided[0] ?? p.items[0]);
	if (!item)
		throw new ToolError(
			'E_NOT_FOUND',
			`Proposal ${p.id} has no item ${itemId ?? ''}`,
			'get_proposal lists them.',
		);
	const k = alternative ?? item.selectedAlternative ?? 0;
	if (k > (item.alternatives?.length ?? 0))
		throw new ToolError(
			'E_INVALID_PARAM',
			`Item ${item.id} has ${item.alternatives?.length ?? 0} alternatives`,
			'get_proposal lists them.',
		);
	const variant = {
		...p,
		items: p.items.map((i) => (i.id === item.id ? { ...i, selectedAlternative: k } : i)),
	};
	const preview = previewProposal(loaded.doc, variant, [item.id], {
		registries: defaultRegistries(),
		invariants: 'incremental',
		checkInvariants: false,
	});
	const failed = preview.failed[item.id]?.[0];
	if (failed)
		throw new ToolError(
			'E_PROPOSAL_STALE',
			`Item ${item.id} does not apply to the current edit: ${failed.message}`,
			'The edit changed under it: refresh_proposal, or propose again.',
		);
	const ids = preview.items[item.id]?.created ?? [];
	for (const seq of Object.values(preview.document.sequences) as Sequence[]) {
		const clips = ids.map((id) => seq.clips[id]).filter((c): c is Clip => !!c);
		const clip = clips.find((c) => c.kind === 'text') ?? clips[0];
		if (clip) return { doc: preview.document, revision: loaded.revision, seq, clip, real: false };
	}
	throw new ToolError(
		'E_INVALID_PARAM',
		`Item ${item.id} creates no clip to check`,
		'title_check checks titles; get_proposal says what the item does.',
	);
}

/** A title and its options rendered on one job: the sheet's cells first, then the check's. */
async function renderTitle(
	ctx: ToolContext,
	o: {
		options: { doc: ProjectDocument; clip: Clip; label: string }[];
		check: CheckTarget;
		revision: number | undefined;
		sheetWidth: number;
		timeoutSec: number;
	},
	extra: Extra,
) {
	const { check } = o;
	const { seq } = check;
	const timing = titleTiming(check.clip as never);
	const frames = [...new Set([timing.intro, timing.hold, timing.outro])];
	const columns = frames.length;
	const b = new SheetBuilder();
	const shown: SheetMeta['shown'] = [];
	o.options.forEach((opt, i) => {
		for (const [n, f] of frames.entries())
			shown.push({
				cell: b.add(i, seq.id, f),
				timecode: sequenceTimecode(seq, f),
				label: `${opt.label}, ${PHASES[n] ?? 'hold'}`.slice(0, 80),
			});
	});
	const black = o.options.length;
	addCheckCells(b, check, 0, black, black + 1);
	const width = Math.min(ANALYSIS_WIDTH, seq.settings.width);
	const meta: SheetMeta = { columns, cellWidth: cellWidthOf(o.sheetWidth, columns), shown };
	const documents = [
		...o.options.map((opt) => toolEnvelope(opt.doc, o.revision)),
		toolEnvelope(titleOverColor(check.doc, seq, check.clip, [0, 0, 0, 1])),
		toolEnvelope(titleOverColor(check.doc, seq, check.clip, [1, 1, 1, 1])),
	];
	const evenWidth = width - (width % 2);
	const jobId = await submitSheet(
		ctx,
		{ documents, cells: b.cells, width: evenWidth, meta: meta as never },
		extra,
	);
	return awaitSheet(ctx, jobId, o.timeoutSec, extra);
}

/** The commands of one option: the text clip, then its look. */
function titleCommands(o: {
	seq: Sequence;
	text: string;
	at: number;
	duration: number;
	sizePx: number;
	energy: Energy;
	position?: [number, number] | undefined;
	look: LookEntry;
	colorwayId?: string | undefined;
	seed: number;
}): Record<string, unknown>[] {
	return [
		{
			type: 'clip.addText',
			at: o.at,
			duration: o.duration,
			track: 'V2',
			placement: 'first-free',
			content: { text: o.text, style: { sizePx: o.sizePx, align: 'center' } },
			...(o.position ? { transform: { position: o.position } } : {}),
			textAnimation: { in: { preset: ENERGY[o.energy].in }, out: { preset: ENERGY[o.energy].out } },
			sequenceId: o.seq.id,
			ref: '$title',
		},
		{
			type: 'look.apply',
			clipIds: ['$title'],
			...o.look.apply,
			...(o.colorwayId ? { colorwayId: o.colorwayId } : {}),
			seed: o.seed,
		},
	];
}

/** The animations' frames at the sequence rate, for the default duration. */
function energyFrames(seq: Sequence, energy: Energy): number {
	const rate = seq.settings.frameRate as Rational;
	const of = (id: string) => {
		const spec = latestTextAnimationSpec(id);
		return spec ? scaleAnimationFrames(spec.defaultDurationFrames, { num: 30, den: 1 }, rate) : 0;
	};
	return of(ENERGY[energy].in) + of(ENERGY[energy].out);
}

/** Every colourway usable with a look: its own, then the library's. */
function colorwayPool(look: LookEntry): Colorway[] {
	const seen = new Set(look.colorways.map((c) => c.id));
	return [...look.colorways, ...FACTORY_COLORWAYS.filter((c) => !seen.has(c.id))];
}

/** A deterministic shuffle by `seed` (mulberry32 drives Fisher–Yates). */
function seededShuffle<T>(list: readonly T[], seed: number): T[] {
	const out = [...list];
	let s = seed >>> 0;
	const next = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

function pickColorway(pool: readonly Colorway[], arg: string): Colorway {
	const low = arg.toLowerCase();
	const c = pool.find((x) => x.id === arg) ?? pool.find((x) => x.name.toLowerCase() === low);
	if (!c)
		throw new ToolError(
			'E_NOT_FOUND',
			`No colourway ${arg}`,
			pool.length
				? `Colourways: ${pool
						.slice(0, 20)
						.map((x) => x.id)
						.join(', ')}.`
				: 'This look has no colourways and the library has none in this build: leave colorway out.',
		);
	return c;
}

const NO_EDITOR_HINT =
	'Open it first: open_project_in_editor {projectId} (project toolset, or call_tool) and ask the user to review. Or pass mode "apply": it adds the title now and, with no editor, returns revert because there is no Undo. Mode "dryRun" shows the title and changes nothing.';

/** What takes a headless apply out again: there is no History to undo it with. */
function revertOf(
	projectId: string,
	clipId: string,
	before: ProjectDocument,
	lookId: string | undefined,
	r: { revision: number; created: readonly string[] },
) {
	const newLook =
		lookId !== undefined && !(before as { titleLooks?: Record<string, unknown> }).titleLooks?.[lookId];
	const leaves = r.created.filter((id) => id !== clipId && id !== lookId);
	return {
		tool: 'apply_commands',
		arguments: {
			projectId,
			label: 'Remove title',
			commands: [
				{ type: 'clip.lift', clipIds: [clipId] },
				...(newLook ? [{ type: 'look.delete', lookId }] : []),
			],
			expectedRevision: r.revision,
		},
		...(leaves.length
			? { leaves: `Stays in the project, unused: ${leaves.join(', ')} (fonts and tracks this title added).` }
			: {}),
	};
}

/** One look as JSON (TL-104): its recipe, colourways, what each of its layer types takes and every layer type. */
async function lookRecipeBody(ctx: ToolContext, doc: ProjectDocument | null, lookId: string) {
	const look = await lookById(ctx, doc, lookId);
	const used = [...new Set(look.recipe.layers.map((l) => l.type))];
	return {
		lookId,
		name: look.name,
		tags: look.tags,
		...(look.category ? { category: look.category } : {}),
		colorways: look.colorways,
		recipe: look.recipe,
		layerParams: Object.fromEntries(
			used.map((type) => [
				type,
				(titleLayerType(type)?.params ?? []).map((p) => ({
					name: p.name,
					type: p.type,
					default: p.default,
					...('range' in p && p.range ? { range: p.range } : {}),
					...('options' in p && p.options ? { options: p.options } : {}),
				})),
			]),
		),
		layerTypes: layerCatalog(),
	};
}

export function registerTitleTools(ctx: ToolContext): void {
	ctx.server.registerResource(
		'title-look',
		new ResourceTemplate('jasper://title-looks/{id}', {
			list: async () => ({
				resources: FACTORY_LOOKS.map((l) => ({
					uri: `jasper://title-looks/${encodeURIComponent(l.libraryId)}`,
					name: l.name,
					mimeType: 'application/json',
				})),
			}),
		}),
		{
			title: 'Title look',
			description:
				'A library look as JSON: its tags, colourways and recipe (title_look_find {lookId} gives the same).',
			mimeType: 'application/json',
		},
		async (uri, { id }) => {
			const look = factoryLook(decodeURIComponent(String(id)));
			if (!look) throw new ToolError('E_NOT_FOUND', `No library look ${String(id)}`);
			const { libraryId, ...rest } = look;
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'application/json',
						text: JSON.stringify({ lookId: libraryId, ...rest }),
					},
				],
			};
		},
	);

	defineTool(
		ctx,
		'title_look_find',
		{
			title: 'Find title looks',
			description:
				'Search title looks by words and tags: rows plus one numbered sheet of real renders, 12 a page. With `lookId`: that look as JSON. Then `title_propose {lookId}`.',
			details: `Searches title looks by words and tags: the library, the user's own looks (saved in the editor, shared by every project) and, with projectId, the project's looks. Returns rows {lookId, name, tags, colorways, costClass, renderPath, source: library | user | project} with ONE numbered PNG sheet of real renders of sampleText, ${DEFAULT_SHEET_WIDTH} px wide by default. Cell n of the sheet is row n. limit is at most ${MAX_FIND_LIMIT}; cursor continues a list. costClass: light, medium or heavy, how much a look costs to draw; heavy looks move on their own and redraw every frame. renderPath comes from the planner. libraryColorways lists the colourways usable with any look, once. No schemas: lookId gives one look's JSON. An empty result says so; the library may be empty in a development build. The sheet is one engine job: past timeoutSeconds the rows come back with {jobId, timedOut, next}. lookId instead returns that one look as JSON, with no sheet: its recipe (bottom-first layers, palette, light, font), colourways, tags, what each layer type it uses takes (name, kind, default, range, no schemas) and every layer type there is; the starting point for title_propose {recipe} and title_look_save {recipe}. Library and user looks need no project; a project look needs projectId.`,
			input: {
				query: z
					.string()
					.max(200)
					.optional()
					.describe('Words to look for, e.g. "chrome trailer" (default: everything)'),
				lookId: LookIdArg.optional().describe('One look as JSON: its recipe and layer types, no sheet'),
				tags: z.array(z.string().min(1).max(64)).max(16).optional().describe('Only looks with all of these'),
				aspect: z
					.enum(['16:9', '9:16', '1:1', '4:5'])
					.optional()
					.describe('Frame of the sheet (default 16:9)'),
				sampleText: z
					.string()
					.min(1)
					.max(MAX_SAMPLE_TEXT)
					.optional()
					.describe('Text on the sheet (default "Your Title")'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_FIND_LIMIT)
					.optional()
					.describe(`Rows per page (default 6, max ${MAX_FIND_LIMIT})`),
				cursor: z
					.string()
					.regex(/^\d{1,6}$/, 'the nextCursor of an earlier call')
					.optional()
					.describe('nextCursor of the previous page'),
				projectId: ProjectIdArg.optional().describe('Also search this project’s looks'),
				width: SheetWidthArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const doc = a.projectId ? (await loadDoc(ctx, a.projectId)).doc : null;
			if (a.lookId !== undefined) return jsonResult(await lookRecipeBody(ctx, doc, a.lookId));
			const user = await userLooks(ctx);
			const words = tokens(a.query ?? '');
			const wanted = (a.tags ?? []).map((t) => t.toLowerCase());
			const hits = lookCatalogue(doc, user.looks)
				.filter((e) => wanted.every((t) => e.tags.some((x) => x.toLowerCase() === t)))
				.map((e) => ({ e, score: searchScore(e, words) }))
				.filter((x) => x.score > 0)
				.sort((x, y) => y.score - x.score || x.e.name.localeCompare(y.e.name))
				.map((x) => x.e);
			const offset = Number(a.cursor ?? 0);
			const limit = a.limit ?? 6;
			const page = hits.slice(offset, offset + limit);
			const next = offset + limit < hits.length ? String(offset + limit) : undefined;
			const library = FACTORY_COLORWAYS.map((c) => ({ id: c.id, name: c.name }));
			const base = {
				total: hits.length,
				...(next ? { nextCursor: next } : {}),
				libraryColorways: library,
				...(user.error ? { userLooksError: `The user's looks could not be read: ${user.error}` } : {}),
			};
			if (!page.length)
				return jsonResult({
					rows: [],
					...base,
					next:
						FACTORY_LOOKS.length || user.looks.length
							? 'No look matches: try other words, or fewer tags.'
							: 'The library of this build holds no looks. Write a recipe for title_propose (get_guide {"topic": "title-art"}).',
				});
			const aspect = a.aspect ?? '16:9';
			const { document, sequenceId } = lookSheetDocument(page, a.sampleText ?? DEFAULT_SAMPLE_TEXT, aspect);
			const envelope = toolEnvelope(document);
			const plan = await ctx
				.engine((c) =>
					c.planExport({
						envelope,
						sequenceId,
						settings: {
							sequenceId,
							range: { type: 'entire' },
							container: 'mp4',
							engine: 'auto',
							destination: { type: 'download' },
						},
					}),
				)
				.catch(() => null);
			const rows = page.map((e, i) => ({
				n: offset + i + 1,
				lookId: e.lookId,
				name: e.name,
				tags: e.tags,
				colorways: e.colorways.map((c) => c.id),
				costClass: costClassOf(e.recipe),
				renderPath: plan?.path ?? null,
				source: e.source,
			}));
			const columns = Math.min(4, page.length);
			const width = cellWidthOf(a.width ?? DEFAULT_SHEET_WIDTH, columns);
			const meta: SheetMeta = {
				columns,
				numbered: true,
				shown: page.map((e, cell) => ({ cell, label: e.name.slice(0, 60) })),
			};
			const jobId = await submitSheet(
				ctx,
				{
					documents: [envelope],
					cells: page.map((_, frame) => ({ document: 0, sequenceId, frame })),
					width,
					meta: meta as never,
				},
				extra,
			);
			const out = await awaitSheet(ctx, jobId, a.timeoutSeconds ?? DEFAULT_SHEET_TIMEOUT_SEC, extra);
			if (!out.done) return jsonResult({ rows, ...base, jobId, timedOut: true, next: sheetNext(jobId) });
			const { body, image } = await composeSheet(ctx, out.result);
			return jsonResult(
				{
					rows,
					...base,
					jobId,
					timedOut: false,
					sheet: body.sheet,
					next: 'Pick a row and call title_propose {lookId}. Numbers on the sheet start at 1 on each page.',
				},
				[image],
			);
		},
	);

	defineTool(
		ctx,
		'title_propose',
		{
			title: 'Propose a title',
			description:
				'Put a styled title on the footage as a proposal for review (needs an editor window), or dryRun or apply, with a sheet and `title_check` rows. Plain text: `add_text`.',
			details: `Turns a brief into a title on the real footage and checks it. text, at, lookId (title_look_find) or recipe; colorway, energy (low, medium, high: the in and out animations), alternatives (0–${MAX_ALTERNATIVES} other colourways), seed. duration defaults to the time the text needs. mode "propose" (default) stores a title-art proposal for the user's review, colourways as the item's alternatives, and needs the project open in an editor window (no window: E_NO_EDITOR, nothing stored). "dryRun" changes nothing. "apply" adds the title now: one undoable entry with an editor; on a headless engine there is no Undo, so the result carries revert, the apply_commands arguments that remove it. Returns {proposalId | clipIds, seed, check, next} and ONE PNG sheet of intro, hold and outro × alternatives, composited over the real footage, ${DEFAULT_SHEET_WIDTH} px wide by default. check holds title_check's rows; costClass and renderPath say what the look costs. All renders are one engine job: past timeoutSeconds it returns {jobId, timedOut, next} and the plain rows; the title itself is already stored or applied. Bounds: ${RECIPE_BOUNDS.layers} layers, ${RECIPE_BOUNDS.maxBytes / 1024} KB, ${RECIPE_BOUNDS.maxDepth} levels, ${RECIPE_BOUNDS.maxTypeInstances} layers of a type, ${RECIPE_BOUNDS.maxGeneratorInstances} generators in a recipe.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				text: z.string().min(1).max(500).describe('The title (line breaks allowed)'),
				at: timeArg('Start of the title'),
				duration: timeArg('Length (default: the time the text needs, with its animations)').optional(),
				lookId: LookIdArg.optional(),
				recipe: RecipeArg.optional(),
				name: z
					.string()
					.min(1)
					.max(120)
					.optional()
					.describe('Name of a recipe look (default "Custom title")'),
				colorway: z.string().min(1).max(128).optional().describe('Colourway id or name'),
				energy: z.enum(['low', 'medium', 'high']).optional().describe('Default medium'),
				alternatives: z
					.number()
					.int()
					.min(0)
					.max(MAX_ALTERNATIVES)
					.optional()
					.describe(`Other colourways to offer, 0–${MAX_ALTERNATIVES} (default 0)`),
				seed: z.number().int().min(0).max(0xffff_ffff).optional().describe('Default: random, returned'),
				mode: z.enum(['propose', 'dryRun', 'apply']).optional().describe('Default "propose"'),
				expectedRevision: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe('The revision you planned on: anything else is refused'),
				position: z
					.tuple([z.number(), z.number()])
					.optional()
					.describe('[x, y] in sequence px (default centre)'),
				sizePx: z.number().positive().max(2000).optional().describe('Text size (default: fits the frame)'),
				width: SheetWidthArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.lookId === undefined) === (a.recipe === undefined))
				throw new ToolError('E_INVALID_PARAM', 'Give lookId or recipe', 'title_look_find lists looks.');
			const mode = a.mode ?? 'propose';
			const loaded = await loadDoc(ctx, a.projectId);
			const { doc } = loaded;
			if (a.expectedRevision !== undefined && loaded.revision !== a.expectedRevision)
				throw new ToolError(
					'E_REVISION_MISMATCH',
					`The project is at revision ${loaded.revision}, not ${a.expectedRevision}`,
					'Read it again (get_project) and plan on the current revision.',
					{ revision: loaded.revision },
				);
			if (mode === 'propose' && !loaded.live)
				throw new ToolError(
					'E_NO_EDITOR',
					'No editor window has this project open, so nobody can review a proposal. Nothing was stored.',
					NO_EDITOR_HINT,
				);
			if (mode === 'apply' && agentProposalsAllowed(doc, TITLE_ART_FEATURE) === false)
				throw new ToolError(
					'E_APPROVAL_REQUIRED',
					'The user turned off "Allow agents to apply title art proposals" in this project',
					APPROVAL_REQUIRED_HINT,
				);
			const seq = pickSequence(doc, a.sequenceId);
			const look: LookEntry =
				a.lookId !== undefined
					? await lookById(ctx, doc, a.lookId)
					: (() => {
							const recipe = parseRecipe(a.recipe);
							const name = a.name ?? 'Custom title';
							return {
								lookId: null,
								name,
								tags: [],
								source: 'recipe',
								recipe,
								colorways: [],
								apply: { look: { name, recipe } },
							};
						})();
			const seed = a.seed ?? (Math.random() * 0x1_0000_0000) >>> 0;
			const energy = a.energy ?? 'medium';
			const at = frameOf(seq, a.at);
			const fps = fpsOf(seq.settings.frameRate as Rational);
			const duration =
				a.duration !== undefined
					? durationFrames(seq, a.duration)
					: Math.ceil(titleReadSeconds(a.text) * fps) + energyFrames(seq, energy);
			const sizePx = a.sizePx ?? titleSizeFor(a.text, seq.settings);
			const pool = colorwayPool(look);
			const primary = a.colorway ? pickColorway(pool, a.colorway) : undefined;
			const askedAlternatives = a.alternatives ?? 0;
			const others = seededShuffle(
				pool.filter((c) => c.id !== primary?.id),
				seed,
			).slice(0, askedAlternatives);
			const commandsOf = (c: Colorway | undefined) =>
				titleCommands({
					seq,
					text: a.text,
					at,
					duration,
					sizePx,
					energy,
					position: a.position,
					look,
					colorwayId: c?.id,
					seed,
				});
			const labelOf = (c: Colorway | undefined) => (c ? `${look.name}, ${c.name}` : look.name);
			const options = [primary, ...others].map((c) => {
				const commands = commandsOf(c);
				const { document, refs } = applyLocally(doc, seq.id, commands, loaded.revision);
				const clipId = refs.$title!;
				return {
					colorway: c,
					commands,
					label: labelOf(c),
					doc: document,
					clip: document.sequences[seq.id]!.clips[clipId]!,
				};
			});
			const costClass = costClassOf(look.recipe);
			const common = {
				seed,
				look: { lookId: look.lookId, name: look.name, source: look.source },
				costClass,
				colorway: primary ? { id: primary.id, name: primary.name } : null,
				alternatives: others.map((c) => ({ id: c.id, name: c.name })),
				...(askedAlternatives > others.length
					? {
							alternativesNote: `${askedAlternatives} asked, ${others.length} exist: this look has no more colourways in this build.`,
						}
					: {}),
			};

			let check: CheckTarget = {
				doc: options[0]!.doc,
				revision: loaded.revision,
				seq,
				clip: options[0]!.clip,
				real: false,
			};
			let stored: Record<string, unknown> = {};
			let next = '';
			if (mode === 'apply') {
				const res = await transact(
					ctx,
					a.projectId,
					{
						label: `Title "${a.text.slice(0, 30)}"`,
						commands: options[0]!.commands,
						sequenceId: seq.id,
						...(a.expectedRevision !== undefined ? { expectedRevision: a.expectedRevision } : {}),
					},
					extra,
				);
				const r = requireOk(res);
				const clipId = r.refs.$title!;
				const after = await loadDoc(ctx, a.projectId);
				const afterClip = after.doc.sequences[seq.id]?.clips[clipId];
				if (!afterClip)
					throw new ToolError('E_INTERNAL', `The title ${clipId} is not in the document after applying it`);
				const lookResult = (r.results.find((x) => typeof x === 'object' && x !== null && 'lookId' in x) ??
					{}) as { lookId?: string };
				check = { doc: after.doc, revision: after.revision, seq, clip: afterClip, real: true };
				options[0] = { ...options[0]!, doc: after.doc, clip: afterClip };
				stored = {
					...txBody(res, r),
					clipIds: [clipId],
					...(res.appliedBy === 'session'
						? {}
						: { revert: revertOf(a.projectId, clipId, doc, lookResult.lookId, r) }),
				};
				next =
					res.appliedBy === 'session'
						? 'Applied as one undo step (undo). Read check; alternatives swap with apply_commands look.setColorway.'
						: 'Applied on a headless engine: there is no History, so undo cannot reach it. revert holds the apply_commands arguments that remove it. Read check; alternatives swap with apply_commands look.setColorway.';
			} else if (mode === 'dryRun') {
				stored = { dryRun: true };
				next = 'Nothing changed. Run it with mode "propose", or "apply" when the user asked for the title.';
			}

			const target = briefTarget(seq);
			const plain = await plainRows(ctx, check);
			const out = await renderTitle(
				ctx,
				{
					options: options.map((o) => ({ doc: o.doc, clip: o.clip, label: o.label })),
					check,
					revision: check.revision,
					sheetWidth: a.width ?? DEFAULT_SHEET_WIDTH,
					timeoutSec: a.timeoutSeconds ?? DEFAULT_SHEET_TIMEOUT_SEC,
				},
				extra,
			);
			const textClip = check.clip.kind === 'text';
			let rendered: {
				rows: TitleCheckRow[];
				image: CallToolResult['content'][number];
				cells: unknown;
			} | null = null;
			if (out.done) {
				const images = await sheetImages(ctx, out.result);
				const measures = measuresOf(out.result, images, seq.settings.width);
				const rows = [...renderedRowsOf(check, measures, target), ...plain, ...lintRows(check, measures)];
				const { image, body } = await composeSheet(ctx, out.result, images);
				rendered = { rows, image, cells: body.cells };
			}
			const checked = rendered
				? checkBody(rendered.rows, check.revision, { textClip })
				: checkBody([...plain, ...lintRows(check, [])], check.revision, { pending: true, textClip });
			const renderPath = (
				checked.rows.find((x) => x.id === 'export-path')?.measured as { path?: string } | null
			)?.path;

			if (mode === 'propose') {
				// Stored after the renders, so the item carries the rows Review shows: only option 0 is measured.
				const metaOf = (o: (typeof options)[number], k: number): TitleArtMeta => ({
					group: TITLE_ART_GROUP,
					text: a.text,
					...(look.lookId ? { lookId: look.lookId } : {}),
					lookName: look.name,
					...(o.colorway ? { colorwayId: o.colorway.id, colorwayName: o.colorway.name } : {}),
					seed,
					clipRef: '$title',
					costClass,
					...(renderPath ? { renderPath } : {}),
					...(k === 0 ? { check: titleArtCheck({ ...checked, pending: !rendered }) } : {}),
				});
				const [first, ...rest] = options;
				let r: ProposalCreateResponse;
				try {
					r = await ctx.engine((c) =>
						c.createProposal(a.projectId, {
							...titleArtDraft({
								sequenceId: seq.id,
								title: `Title: ${a.text.split('\n')[0]!}`,
								summary: labelOf(first!.colorway),
								option: { label: first!.label, commands: first!.commands, meta: metaOf(first!, 0) },
								alternatives: rest.map((o, i) => ({
									label: o.label,
									commands: o.commands,
									meta: metaOf(o, i + 1),
								})),
							}),
							allOrNothing: true,
							...(a.expectedRevision !== undefined ? { expectedRevision: a.expectedRevision } : {}),
						}),
					);
				} catch (e) {
					if (e instanceof EngineError && e.code === 'PROPOSAL_INVALID')
						throw new ToolError('E_PROPOSAL_INVALID', e.message, 'Nothing was stored.', { detail: e.detail });
					throw e;
				}
				stored = { proposalId: r.proposal.id, updatedAt: r.proposal.updatedAt, revision: r.revision };
				next = `Nothing was applied. Tell the user the title is waiting in the Review panel, with ${others.length} alternative colourway(s), then wait_for_proposal {projectId, proposalId, since: updatedAt}. Read check first (the proposal keeps it for the first option): propose again rather than hand over a failing row without saying so.`;
			}

			if (!rendered)
				return jsonResult({
					...stored,
					...common,
					check: checked,
					jobId: out.jobId,
					timedOut: true,
					next: `${next} ${sheetNext(out.jobId)}`,
				});
			return jsonResult(
				{
					...stored,
					...common,
					...(renderPath ? { renderPath } : {}),
					check: checked,
					jobId: out.jobId,
					timedOut: false,
					cells: rendered.cells,
					next,
				},
				[rendered.image],
			);
		},
	);

	defineTool(
		ctx,
		'title_check',
		{
			title: 'Check a title',
			description:
				'Measure a title clip or proposal on rendered frames: safe area, contrast, size, read time, fonts, export path. Taste is not measured. An exported file: `verify_export`.',
			details: `Measures a title on rendered frames and returns verify-style rows {id, kind: "format" | "judgement", status: pass | warn | fail | unverified, measured, expected, at, message, fix?} with verified (no fail row and no unverified format row) and the revision they hold for. clipId checks a clip; proposalId (+ itemId, alternative) checks what a proposal would create, nothing applied. Rows: safe-area and off-frame (the title's real alpha bounds, by difference matting), contrast (each part of the title against the picture rendered behind it, at the frames it is at rest), min-size, read-time, font-available, export-path (the planner's answer) and every style lint issue. target (${DELIVERY_TARGET_IDS.join(', ')}; default the brief's platform) adds target-safe-area on vertical platforms: an estimate that only warns. fix.commands are ready for apply_commands; a proposal's rows carry only fix.label, because its clip has no id yet. notChecked says what no row measures: taste above all; report it as not checked. The renders are one engine job: past timeoutSeconds it returns the plain rows with {jobId, timedOut, next}; call again with the same arguments and jobId. ${CHECK_NEXT}`,
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).max(64).optional().describe('The title clip (get_timeline)'),
				proposalId: z.string().min(1).max(64).optional().describe('A proposal (title_propose)'),
				itemId: z
					.string()
					.min(1)
					.max(64)
					.optional()
					.describe('With proposalId: the item (default the first undecided)'),
				alternative: z
					.number()
					.int()
					.min(0)
					.max(16)
					.optional()
					.describe('With proposalId: the alternative (default the selected one)'),
				target: z.enum(DELIVERY_TARGET_IDS).optional().describe('Delivery platform'),
				timeoutSeconds: TimeoutArg,
				jobId: z.string().min(1).max(64).optional().describe('Pick up the renders of an earlier call'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			if ((a.clipId === undefined) === (a.proposalId === undefined))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give clipId or proposalId',
					'get_timeline lists clips; list_proposals lists proposals.',
				);
			if (a.proposalId === undefined && (a.itemId !== undefined || a.alternative !== undefined))
				throw new ToolError('E_INVALID_PARAM', 'itemId and alternative need proposalId');
			const loaded = await loadDoc(ctx, a.projectId);
			let t: CheckTarget;
			if (a.clipId !== undefined) {
				const { seq, clip } = findClip(loaded.doc, a.clipId);
				if (!(TITLE_LOOK_CLIP_KINDS as readonly string[]).includes(clip.kind))
					throw new ToolError(
						'E_INVALID_PARAM',
						`${clip.id} is a ${clip.kind} clip`,
						`title_check checks ${TITLE_LOOK_CLIP_KINDS.join(', ')} clips.`,
					);
				t = { doc: loaded.doc, revision: loaded.revision, seq, clip, real: true };
			} else {
				const proposalId = a.proposalId!;
				const r = (await ctx.engine((c) => c.getProposal(a.projectId, proposalId))) as ProposalResponse;
				t = proposalTarget(loaded, r.proposal, a.itemId, a.alternative);
			}
			const { seq, clip } = t;
			const target = a.target ?? briefTarget(seq);
			const plain = await plainRows(ctx, t);
			const textClip = clip.kind === 'text';
			const subject = a.clipId !== undefined ? { clipId: a.clipId } : { proposalId: a.proposalId };
			let out: Awaited<ReturnType<typeof awaitSheet>>;
			if (a.jobId) {
				out = await sheetOfJob(ctx, a.jobId);
				const madeAt = out.done
					? (out.result.meta as { revision?: unknown } | undefined)?.revision
					: undefined;
				if (out.done && madeAt !== (loaded.revision ?? null))
					throw new ToolError(
						'E_STALE',
						`The job measured revision ${String(madeAt)}; the project is at ${loaded.revision}`,
						'Call title_check again without jobId.',
					);
			} else {
				const b = new SheetBuilder();
				addCheckCells(b, t, 0, 1, 2);
				const width = Math.min(ANALYSIS_WIDTH, seq.settings.width);
				const jobId = await submitSheet(
					ctx,
					{
						documents: [
							toolEnvelope(t.doc, loaded.revision),
							toolEnvelope(titleOverColor(t.doc, seq, clip, [0, 0, 0, 1])),
							toolEnvelope(titleOverColor(t.doc, seq, clip, [1, 1, 1, 1])),
						],
						cells: b.cells,
						width: width - (width % 2),
						meta: { revision: loaded.revision ?? null },
					},
					extra,
				);
				out = await awaitSheet(ctx, jobId, a.timeoutSeconds ?? DEFAULT_SHEET_TIMEOUT_SEC, extra);
			}
			if (!out.done)
				return jsonResult({
					...subject,
					sequenceId: seq.id,
					...checkBody([...plain, ...lintRows(t, [])], loaded.revision, { pending: true, textClip }),
					jobId: out.jobId,
					timedOut: true,
					next: `The renders are still running as job ${out.jobId}: title_check again with the same arguments and jobId returns the rendered rows.`,
				});
			const images = await sheetImages(ctx, out.result);
			const measures = measuresOf(out.result, images, seq.settings.width);
			const rows = [...renderedRowsOf(t, measures, target), ...plain, ...lintRows(t, measures)];
			// TL-102: bound to a revision: an edit made while rendering means these rows describe nothing.
			const now = await ctx.engine((c) =>
				c.agentQuery({ projectId: a.projectId, query: 'doc.get', args: { path: ['projectId'] } }),
			);
			const stale = now.revision !== loaded.revision;
			const body = checkBody(rows, loaded.revision, { textClip });
			return jsonResult({
				...subject,
				sequenceId: seq.id,
				...body,
				verified: body.verified && !stale,
				...(stale ? { stale: true } : {}),
				jobId: out.jobId,
				timedOut: false,
				next: stale ? 'The project changed while this ran: run title_check again.' : CHECK_NEXT,
			});
		},
	);

	defineTool(
		ctx,
		'title_look_save',
		{
			title: 'Save a title look',
			description:
				"Save a clip's look or a recipe as a look of this project, for `title_propose {lookId}`. Photoshop layer styles: `import_layer_styles`.",
			details:
				'Saves a look in the project (look.create, one undo step): from a clip (clipId, its appearance at its first frame; link: true links the clip to the new look) or a recipe. name is unique in the project. The new lookId works with title_propose and title_look_find {projectId}.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).max(64).optional().describe('A clip with a look'),
				recipe: RecipeArg.optional(),
				name: z.string().trim().min(1).max(120).describe('Name of the look'),
				tags: z.array(z.string().min(1).max(64)).max(16).optional().describe('Search words'),
				category: z.string().min(1).max(64).optional().describe('Library category'),
				link: z.boolean().optional().describe('Link clipId to the new look'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.clipId === undefined) === (a.recipe === undefined))
				throw new ToolError('E_INVALID_PARAM', 'Give clipId or recipe', 'title_look_find {lookId} gives a recipe.');
			const recipe = a.recipe !== undefined ? parseRecipe(a.recipe) : undefined;
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: `Save look "${a.name.slice(0, 40)}"`,
					commands: [
						{
							type: 'look.create',
							name: a.name,
							...(a.clipId !== undefined ? { fromClipId: a.clipId } : { recipe }),
							...(a.tags ? { tags: a.tags } : {}),
							...(a.category ? { category: a.category } : {}),
							...(a.link ? { link: true } : {}),
							ref: '$look',
						},
					],
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), lookId: r.refs.$look });
		},
	);

	defineTool(
		ctx,
		'title_generator_add',
		{
			title: 'Add a title generator',
			description:
				'Add a generator (fire, particles, sunburst…) to a title\'s look, or as its own clip below the title so it never hides it. Generator ids: `list_effects {category: "Generate"}`.',
			details:
				'Adds a generator (fire, particles, sunburst…: list_effects {category: "Generate"}) in one undo step. With clipId it becomes a layer of that clip\'s look, so it follows the title\'s shape. Without it a standalone clip goes on a free track, below belowClipId when given, so it never hides the title (clip.addGenerator); give at and duration.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				generator: z
					.string()
					.min(1)
					.max(128)
					.describe('A Generate effect id, or generator:<id> for a look generator'),
				clipId: z.string().min(1).max(64).optional().describe('Add it to this clip’s look'),
				at: timeArg('Start of a standalone generator').optional(),
				duration: timeArg('Length of a standalone generator').optional(),
				belowClipId: z.string().min(1).max(64).optional().describe('Keep it below this title'),
				params: z.record(z.string(), z.unknown()).optional().describe('Generator params'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			let commands: Record<string, unknown>[];
			if (a.clipId !== undefined) {
				if (a.at !== undefined || a.duration !== undefined || a.belowClipId !== undefined)
					throw new ToolError(
						'E_INVALID_PARAM',
						'clipId adds a layer to a look: at, duration and belowClipId are for standalone generators',
					);
				const { clip } = findClip(doc, a.clipId);
				const fx = clipLook((clip as { effects?: { effectId: string; id: string }[] }).effects);
				if (!fx)
					throw new ToolError(
						'E_INVALID_PARAM',
						`Clip ${a.clipId} has no look`,
						'title_propose applies one; or leave clipId out for a standalone generator.',
					);
				const id = a.generator.replace(/^jasper\.generator\./, '');
				commands = [
					{
						type: 'appearance.addLayer',
						effectInstanceId: fx.id,
						layerType: id.startsWith(GENERATOR_LAYER_PREFIX) ? id : `${GENERATOR_LAYER_PREFIX}${id}`,
						...(a.params ? { params: a.params } : {}),
						ref: '$layer',
					},
				];
			} else {
				if (a.at === undefined || a.duration === undefined)
					throw new ToolError(
						'E_INVALID_PARAM',
						'A standalone generator needs at and duration',
						'Or pass clipId to add it to a look.',
					);
				const seq = pickSequence(doc, a.sequenceId);
				commands = [
					{
						type: 'clip.addGenerator',
						sequenceId: seq.id,
						effectId: a.generator,
						at: frameOf(seq, a.at),
						duration: durationFrames(seq, a.duration),
						...(a.belowClipId ? { belowClipId: a.belowClipId } : {}),
						...(a.params ? { params: a.params } : {}),
						ref: '$generator',
					},
				];
			}
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: `Generator ${a.generator}`.slice(0, 80),
					commands,
					...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
				},
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'title_light_set',
		{
			title: 'Set the global light',
			description:
				'Set or clear the global light of a sequence: the light of every title look that follows the sequence. 3D lights are clips: `add_light`.',
			details:
				'Sets the light of a sequence (sequence.setGlobalLight, one undo step): every look whose light source is "sequence" follows it. angle in degrees (0 = right, clockwise), altitude 0–90. clear: true removes it, and those looks use their own light again. Keyframe it with apply_commands param.set on ["globalLight", sequenceId, "angle"].',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				angle: z.number().min(-3600).max(3600).optional().describe('Degrees'),
				altitude: z.number().min(0).max(90).optional().describe('Degrees above the horizon'),
				clear: z.boolean().optional().describe('Remove the global light'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			if (!a.clear && a.angle === undefined && a.altitude === undefined)
				throw new ToolError('E_INVALID_PARAM', 'Give angle, altitude or clear');
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: 'Global light',
					commands: [
						{
							type: 'sequence.setGlobalLight',
							...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
							...(a.angle !== undefined ? { angle: a.angle } : {}),
							...(a.altitude !== undefined ? { altitude: a.altitude } : {}),
							...(a.clear ? { clear: true } : {}),
						},
					],
					...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
				},
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);
}

/** Every layer type, one line each (no schemas, TL-106). */
function layerCatalog() {
	return TITLE_LAYER_TYPES.map((t) => ({ type: t.type, label: t.label, description: t.description }));
}
