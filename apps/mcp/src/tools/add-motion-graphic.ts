// add_motion_graphic (social-comments design §7.10, docs/wp-notes/social-comments.md "Placement & agent API"):
// one item or `items[]` in ONE transaction (one undo step), first-free placement unless a track is given, omitted
// params filled by the template's fill hook from a seed, fully resolved params in the result, and `dryRun` (with
// `preview` stills) without touching the document. Every path goes through `clip.addMotionGraphic`, the command
// the editor, HTTP (`/api/agent/tx`) and the CLI (`jasper call add_motion_graphic`) use too.
import { randomInt } from 'node:crypto';
import type { MgTemplateCatalogEntry, MgTemplatePresetEntry, MgTemplatesResponse } from '@jasper/api';
import { type ProjectDocument, type Sequence, sequenceTimecode, TrackRefSchema } from '@jasper/project';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import { defineTool, EDIT, type Extra, loadDoc, type ToolContext, transact, txBody } from '../context.ts';
import { jsonResult, ToolError, TX_ERROR_HINTS } from '../errors.ts';
import { resolveTemplateRef, templatePreview } from './templates.ts';

/** Most items one call adds (zod-validated). */
export const MAX_MG_ITEMS = 200;
/** Most items one dry run renders preview stills for (each is a render job). */
export const MAX_MG_PREVIEWS = 10;
/** Lowest track first-free placement starts from when an item names none (V1 usually holds the footage). */
export const DEFAULT_MG_FLOOR = 'V2';

const TemplateRefArg = z
	.string()
	.min(1)
	.describe(
		'Template id, optionally with version and preset: "lower-third", "lower-third@1", "counter:percentage" or "counter@1:percentage" (list_motion_templates lists ids and presets)',
	);
const ParamsArg = z
	.record(z.string(), z.unknown())
	.describe(
		'Template params (list_motion_templates shows each one); they win over everything. Omitted params come from the preset ("<id>:<preset>"), then the template’s fill hook when it has one (believable values from the seed), then the template defaults',
	);
const TrackArg = TrackRefSchema.describe(
	'A video track label ("V3") or id. Given: the clip goes on exactly that track and overwrites what is there in its time range (the behaviour before first-free placement), unless placement is "first-free" (then it is the lowest track tried). Omitted: first-free from V2 up',
);
const PlacementArg = z
	.enum(['first-free', 'overwrite'])
	.describe(
		'"first-free" (default without track): the lowest unlocked video track at or above the track (default V2) that is empty for the clip’s range; a new top track when none is — never overwrites. "overwrite" (default with track): on the track, clearing its range',
	);
const SeedArg = z.number().int().min(0).max(0xffff_ffff);

const ItemSchema = z.object({
	template: TemplateRefArg,
	params: ParamsArg.optional(),
	at: timeArg('Start time'),
	duration: timeArg('Length (default: the template default, else 5 s)').optional(),
	track: TrackArg.optional(),
	placement: PlacementArg.optional(),
	seed: SeedArg.optional().describe(
		'Seed of this item’s fill (default: derived from the call’s seed and index)',
	),
});
type Item = z.infer<typeof ItemSchema>;

/** One item with its catalogue entry and preset (the one template-ref parser: `resolveTemplateRef`, templates.ts). */
type Resolved = { item: Item; template: MgTemplateCatalogEntry; preset: MgTemplatePresetEntry | null };

/** Item `i`'s fill seed: its own, else the call seed for item 0 and a golden-ratio step from it for the others. */
export function itemSeed(base: number, index: number, own?: number): number {
	return own ?? (base + Math.imul(index, 0x9e37_79b9)) >>> 0;
}

/** The `clip.addMotionGraphic` command of one resolved item. */
function itemCommand(r: Resolved, seed: number, sequenceId: string | undefined): Record<string, unknown> {
	const { item, template: t } = r;
	const placement = item.placement ?? (item.track ? 'overwrite' : 'first-free');
	// Layering (the command merges defaults under and runs the fill hook): defaults → preset → fill → item params.
	// The preset's params travel as given params, so the fill only fills what both leave out.
	const params = { ...(r.preset?.params ?? {}), ...(item.params ?? {}) };
	return {
		type: 'clip.addMotionGraphic',
		at: item.at,
		duration: item.duration ?? { seconds: t.defaultDurationSeconds ?? 5 },
		track: item.track ?? DEFAULT_MG_FLOOR,
		...(placement === 'first-free' ? { placement } : {}),
		template: { id: t.id, version: t.version },
		...(Object.keys(params).length ? { params } : {}),
		fill: { seed },
		...(sequenceId ? { sequenceId } : {}),
	};
}

/** What `clip.addMotionGraphic` returns (packages/project clip-core). */
type AddResult = {
	clipId: string;
	sequenceId: string;
	trackId: string;
	track: string;
	createdTrack?: boolean;
	start: number;
	duration: number;
	params: Record<string, unknown>;
	filled?: string[];
	seed?: number;
};

/** Even, ≥ 64, fitting a 960×960 box with the sequence's aspect (the preview tool's default scale). */
function previewSize(seq: Sequence | undefined): { width: number; height: number } {
	const w = Math.max(1, seq?.settings.width ?? 1920);
	const h = Math.max(1, seq?.settings.height ?? 1080);
	const k = Math.min(1, 960 / Math.max(w, h));
	const even = (n: number) => Math.max(64, Math.round(n / 2) * 2);
	return { width: even(w * k), height: even(h * k) };
}

/** Sequence rate as a whole fps for the preview document (1…60). */
function previewFps(seq: Sequence | undefined): number {
	const r = seq?.settings.frameRate;
	const fps = r && r.den > 0 ? r.num / r.den : 30;
	return Number.isFinite(fps) ? Math.min(60, Math.max(1, Math.round(fps))) : 30;
}

/** The items of a call: `items`, or the single item given by the top-level fields (never both). */
function itemsOf(a: Record<string, unknown> & { items?: Item[] }): { items: Item[]; single: boolean } {
	const singleKeys = ['template', 'params', 'at', 'duration', 'track', 'placement'].filter(
		(k) => a[k] !== undefined,
	);
	if (a.items) {
		if (singleKeys.length)
			throw new ToolError(
				'E_INVALID_PARAM',
				`Give either items or a single item, not both (also given: ${singleKeys.join(', ')})`,
				'Move template / params / at / duration / track / placement into the entries of items.',
			);
		return { items: a.items, single: false };
	}
	if (a.template === undefined || a.at === undefined)
		throw new ToolError(
			'E_INVALID_PARAM',
			`A single item needs template and at${a.template === undefined ? '' : ' (at is missing)'}`,
			'Pass template and at (plus params, duration, track), or items: [{template, at, …}, …].',
		);
	// already validated (and friendly times converted) by the tool's input schema
	return { items: [Object.fromEntries(singleKeys.map((k) => [k, a[k]])) as Item], single: true };
}

/** A refused transaction → an MCP error naming the item(s) it failed on. */
function itemsTxError(
	errors: { commandIndex: number; code: string; message: string; path?: string[] }[],
	items: readonly Item[],
	extra: { appliedBy: string; revision: number },
): ToolError {
	const first = errors[0];
	const code = first?.code ?? 'E_INTERNAL';
	const perItem = errors
		.filter((e) => e.commandIndex >= 0 && e.commandIndex < items.length)
		.map((e) => ({
			index: e.commandIndex,
			template: items[e.commandIndex]!.template,
			code: e.code,
			message: e.message,
			...(e.path ? { path: e.path } : {}),
		}));
	const where =
		first && first.commandIndex >= 0 && first.commandIndex < items.length && items.length > 1
			? `items[${first.commandIndex}] (${items[first.commandIndex]!.template}): `
			: '';
	const transactionLevel = errors.filter((e) => e.commandIndex < 0 || e.commandIndex >= items.length);
	return new ToolError(
		code,
		`${where}${first?.message ?? 'The transaction was rejected'}. Nothing was added.`,
		TX_ERROR_HINTS[code],
		{
			...extra,
			items: perItem,
			...(transactionLevel.length
				? { errors: transactionLevel.map((e) => ({ code: e.code, message: e.message })) }
				: {}),
		},
	);
}

/** One item of the result: placement in frames and timecode, the fully resolved params and the fill report. */
function itemBody(doc: ProjectDocument, r: Resolved, x: AddResult, index: number) {
	const seq = doc.sequences[x.sequenceId];
	const end = x.start + x.duration;
	return {
		index,
		clipId: x.clipId,
		template: `${r.template.id}@${r.template.version}`,
		...(r.preset ? { preset: r.preset.id } : {}),
		sequenceId: x.sequenceId,
		track: x.track,
		trackId: x.trackId,
		...(x.createdTrack ? { createdTrack: true } : {}),
		start: x.start,
		end,
		duration: x.duration,
		...(seq
			? { startTimecode: sequenceTimecode(seq, x.start), endTimecode: sequenceTimecode(seq, end) }
			: {}),
		params: x.params,
		filled: x.filled ?? [],
		seed: x.seed,
	};
}

/** Preview stills of dry-run items (at the middle of each item's hold); a failed one is reported on its item. */
async function previews(
	ctx: ToolContext,
	cat: MgTemplatesResponse,
	doc: ProjectDocument,
	resolved: readonly Resolved[],
	results: readonly AddResult[],
	extra: Extra,
): Promise<{ info: Record<string, unknown>[]; images: CallToolResult['content'] }> {
	const info: Record<string, unknown>[] = [];
	const images: CallToolResult['content'] = [];
	for (const [i, x] of results.entries()) {
		const seq = doc.sequences[x.sequenceId];
		const fps = previewFps(seq);
		const r = seq?.settings.frameRate;
		const seconds = r && r.num > 0 ? (x.duration * r.den) / r.num : x.duration / fps;
		try {
			const out = await templatePreview(
				ctx,
				cat,
				resolved[i]!.template,
				{ params: x.params, ...previewSize(seq), durationSeconds: seconds, fps, frames: 1 },
				extra,
			);
			const text = out.content.find((c) => c.type === 'text');
			const meta = text && text.type === 'text' ? (JSON.parse(text.text) as Record<string, unknown>) : {};
			const own = out.content.filter((c) => c.type === 'image');
			info.push({
				...meta,
				...(own.length ? { image: images.length } : { image: null, note: 'The renderer returned no still' }),
			});
			images.push(...own);
		} catch (e) {
			const err =
				e instanceof ToolError ? e : new ToolError('RENDER_FAILED', (e as Error)?.message ?? String(e));
			info.push({ error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } });
		}
	}
	return { info, images };
}

export function registerAddMotionGraphic(ctx: ToolContext): void {
	defineTool(
		ctx,
		'add_motion_graphic',
		{
			title: 'Add motion graphic(s)',
			description: `Adds motion-graphic template clips (clip.addMotionGraphic), e.g. lower thirds, title cards or social comments: one item (template, params, at, duration, track) or items: [...] (up to ${MAX_MG_ITEMS}), all in ONE transaction (one undo step; all or nothing). Placement never overwrites by default: each clip goes on the first free unlocked video track from V2 up for its time range (a new top track when none is free), and the items of one call never collide. An explicit track keeps the old behaviour (overwrite on exactly that track) unless placement: "first-free". Omitted params are filled by the template's fill hook (deterministic for seed; a random seed is picked and returned when none is given), else take the defaults. Returns per item the clip id, track, start/end (frames and timecode) and the fully resolved params. dryRun: true returns the same without changing the project; with preview: true also a still per item (middle of its hold, up to ${MAX_MG_PREVIEWS} items) through render_motion_graphic_preview's path. Errors name the failing item (details.items).`,
			input: {
				projectId: ProjectIdArg,
				template: TemplateRefArg.optional(),
				params: ParamsArg.optional(),
				at: timeArg('Start time (single item)').optional(),
				duration: timeArg('Length (default: the template default, else 5 s)').optional(),
				track: TrackArg.optional(),
				placement: PlacementArg.optional(),
				items: z
					.array(ItemSchema)
					.min(1)
					.max(MAX_MG_ITEMS)
					.optional()
					.describe(
						`Several graphics in one transaction, each {template, params?, at, duration?, track?, placement?, seed?} (instead of the single-item fields; at most ${MAX_MG_ITEMS})`,
					),
				seed: SeedArg.optional().describe(
					'Seed of the params fill: item 0 uses it, item i a value derived from it (or its own seed). Default: random, returned in the result so the call can be repeated exactly',
				),
				dryRun: z
					.boolean()
					.optional()
					.describe('Resolve placement and params without changing the project (clip ids are not kept)'),
				preview: z
					.boolean()
					.optional()
					.describe(`With dryRun: also return a preview still per item (at most ${MAX_MG_PREVIEWS} items)`),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { items, single } = itemsOf(a as Record<string, unknown> & { items?: Item[] });
			if (a.preview && !a.dryRun)
				throw new ToolError(
					'E_INVALID_PARAM',
					'preview needs dryRun: true',
					'Call with dryRun: true and preview: true to see the graphics before adding them; render_frame shows added ones.',
				);
			if (a.preview && items.length > MAX_MG_PREVIEWS)
				throw new ToolError(
					'E_INVALID_PARAM',
					`preview renders at most ${MAX_MG_PREVIEWS} items (got ${items.length})`,
					`Dry-run the whole batch without preview, and preview up to ${MAX_MG_PREVIEWS} items per call.`,
				);
			const cat = await ctx.engine((c) => c.mgTemplates());
			const resolved: Resolved[] = [];
			const bad: { index: number; template: string; code: string; message: string; hint?: string }[] = [];
			for (const [index, item] of items.entries()) {
				try {
					resolved.push({ item, ...resolveTemplateRef(cat, item.template, ' (list_motion_templates)') });
				} catch (e) {
					if (!(e instanceof ToolError)) throw e;
					bad.push({
						index,
						template: item.template,
						code: e.code,
						message: e.message,
						...(e.hint ? { hint: e.hint } : {}),
					});
				}
			}
			if (bad.length)
				throw new ToolError(
					bad[0]!.code,
					single
						? bad[0]!.message
						: `Bad template reference in ${bad.map((u) => `items[${u.index}] ("${u.template}")`).join(', ')}. Nothing was added.`,
					bad[0]!.hint,
					{ items: bad },
				);
			const seed = a.seed ?? randomInt(0, 2 ** 32);
			const commands = resolved.map((r, i) => itemCommand(r, itemSeed(seed, i, r.item.seed), a.sequenceId));
			const first = resolved[0]!;
			const label = single
				? first.preset
					? `${first.template.name} (${first.preset.name})`
					: first.template.name
				: `${resolved.length} motion graphics`;
			const res = await transact(
				ctx,
				a.projectId,
				{ label, commands, sequenceId: a.sequenceId, ...(a.dryRun ? { dryRun: true } : {}) },
				extra,
			);
			const r = res.result;
			if (!r.ok) throw itemsTxError(r.errors, items, { appliedBy: res.appliedBy, revision: r.revision });
			const results = r.results as AddResult[];
			const { doc } = await loadDoc(ctx, a.projectId);
			const out: Record<string, unknown>[] = results.map((x, i) => itemBody(doc, resolved[i]!, x, i));
			let images: CallToolResult['content'] = [];
			if (a.dryRun && a.preview) {
				const p = await previews(ctx, cat, doc, resolved, results, extra);
				for (const [i, info] of p.info.entries()) out[i]!.preview = info;
				images = p.images;
			}
			const { results: _results, ...body } = txBody(res, r, a.dryRun === true);
			return jsonResult(
				{
					...body,
					...(a.dryRun ? { note: 'Dry run: nothing was added; clip ids are placeholders.' } : {}),
					seed,
					items: out,
				},
				images,
			);
		},
	);
}
