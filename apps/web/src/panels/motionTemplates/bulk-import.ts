// Bulk import of motion graphics from a spreadsheet (social-comments design §7.9 "Bulk import"; docs/wp-notes/
// social-comments.md "Add another & bulk import"): pasted rows (TSV) or a CSV file → a preview where every row is
// resolved exactly as `clip.addMotionGraphic` will store it (`resolveMgTemplateParams`: fill from the row's seed,
// defaults, schema, media) → one transaction (one undo step) placing the valid rows one after another from the
// playhead, each on the first free video track. Rows with errors are left out and listed. Parsing and column
// mapping are the shared pure code of @jasper/project (also used by MCP `import_motion_graphics_csv`).
import {
	type Command,
	type MediaAsset,
	type MgImportMessage,
	type MgImportPlan,
	type MgImportRow,
	type MgParamsResolution,
	type MgTemplateInfo,
	type MgTemplateRegistry,
	mgImportCommand,
	mgImportTemplateOf,
	mgItemSeed,
	parseTable,
	planMgImport,
	type Rational,
	resolveMgTemplateParams,
	scheduleMgImport,
	type TableDelimiter,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';

/** A template (and optionally one of its presets) the dialog can import as. Key: `id@version` or `id@version:preset`. */
export type BulkTemplateOption = {
	key: string;
	id: string;
	version: number;
	preset?: string;
	templateName: string;
	presetName?: string;
};

/** Every installed template, and one entry per preset after it (the gallery's cards). */
export function bulkTemplateOptions(reg: MgTemplateRegistry): BulkTemplateOption[] {
	return reg
		.list()
		.slice()
		.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
		.flatMap((t) => [
			{ key: `${t.id}@${t.version}`, id: t.id, version: t.version, templateName: t.name },
			...(t.presets ?? []).map((p) => ({
				key: `${t.id}@${t.version}:${p.id}`,
				id: t.id,
				version: t.version,
				preset: p.id,
				templateName: t.name,
				presetName: p.name,
			})),
		]);
}

export type BulkDelimiter = 'auto' | TableDelimiter;

export type BulkRowView = {
	row: MgImportRow;
	/** The params the clip will store (null when the row already has errors). */
	resolved: MgParamsResolution | null;
	included: boolean;
	start?: number;
	duration?: number;
};

export type BulkImportModel =
	| { ok: false; message: MgImportMessage }
	| {
			ok: true;
			plan: MgImportPlan;
			rows: BulkRowView[];
			/** Params shown in the preview, in the template's order: the imported ones and the filled ones. */
			shown: string[];
			included: number;
	  };

type Media = Readonly<Record<string, Pick<MediaAsset, 'kind'> | undefined>>;

/** Parses, maps and resolves `text` for a preview; never throws. */
export function buildBulkImport(args: {
	text: string;
	delimiter: BulkDelimiter;
	info: MgTemplateInfo;
	preset?: string;
	rate: Rational;
	media: Media;
	seed: number;
	startAt: number;
}): BulkImportModel {
	const parsed = parseTable(args.text, { delimiter: args.delimiter });
	if (!parsed.ok) return { ok: false, message: parsed.message };
	const template = mgImportTemplateOf(args.info);
	if (!template) return { ok: false, message: { code: 'column-unknown', values: [args.info.name] } };
	const planned = planMgImport(parsed.table, template, {
		rate: args.rate,
		...(args.preset ? { preset: args.preset } : {}),
	});
	if (!planned.ok) return { ok: false, message: planned.message };
	const plan = planned.plan;
	const rows: BulkRowView[] = plan.rows.map((row) => {
		if (row.errors.length > 0) return { row, resolved: null, included: false };
		const resolved = resolveMgTemplateParams(
			args.info,
			{ ...plan.presetParams, ...row.params },
			{ seed: mgItemSeed(args.seed, row.index), media: args.media },
		);
		return { row, resolved, included: resolved.ok };
	});
	const placements = scheduleMgImport(
		rows.filter((r) => r.included).map((r) => r.row),
		{ startAt: args.startAt, defaultDuration: plan.defaultDuration },
	);
	const byRow = new Map(placements.map((p) => [p.row, p]));
	for (const r of rows) {
		const p = byRow.get(r.row.index);
		if (p) {
			r.start = p.start;
			r.duration = p.duration;
		}
	}
	const wanted = new Set<string>();
	for (const c of plan.columns) if (c.kind === 'param') wanted.add(c.param);
	for (const r of rows) {
		for (const k of Object.keys(r.row.params)) wanted.add(k);
		if (r.resolved?.ok) for (const k of r.resolved.filled) wanted.add(k);
	}
	const order = Object.keys(args.info.defaults);
	const shown = [...wanted].sort((a, b) => rank(order, a) - rank(order, b));
	return { ok: true, plan, rows, shown, included: placements.length };
}

const rank = (order: string[], k: string) => {
	const i = order.indexOf(k);
	return i < 0 ? order.length : i;
};

/** The commands of the included rows (first-free from `track`), in row order. */
export function bulkImportCommands(
	model: Extract<BulkImportModel, { ok: true }>,
	opts: { seed: number; track: string; sequenceId: string },
): Command[] {
	return model.rows
		.filter((r) => r.included && r.start !== undefined && r.duration !== undefined)
		.map((r) =>
			mgImportCommand(
				model.plan,
				r.row,
				{ start: r.start!, duration: r.duration! },
				{
					seed: opts.seed,
					track: opts.track,
					sequenceId: opts.sequenceId,
				},
			),
		);
}

/** Inserts the included rows as one transaction and selects the new clips. */
export function insertBulkImport(
	session: EditorSession,
	model: Extract<BulkImportModel, { ok: true }>,
	opts: { seed: number; track: string; sequenceId: string; label: string },
): { ok: true; clipIds: string[] } | { ok: false; message: string } {
	if (session.getState().readOnly) return { ok: false, message: 'The project is read-only' };
	const commands = bulkImportCommands(model, opts);
	if (commands.length === 0) return { ok: false, message: 'There are no rows to import' };
	const result = session.apply({
		label: opts.label,
		origin: 'user',
		sequenceId: opts.sequenceId,
		commands,
	});
	if (!result.ok)
		return { ok: false, message: result.errors.map((e) => e.message).join('; ') || 'Import failed' };
	const clipIds = (result.results as { clipId?: string }[])
		.map((r) => r.clipId)
		.filter((id): id is string => !!id);
	if (clipIds.length) session.select('timeline', clipIds, 'replace');
	return { ok: true, clipIds };
}

/** A resolved value as preview text (long text cut, objects as JSON). */
export function previewValue(v: unknown): string {
	if (v === null || v === undefined) return '—';
	if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 79)}…` : v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	try {
		const s = JSON.stringify(v);
		return s.length > 60 ? `${s.slice(0, 59)}…` : s;
	} catch {
		return String(v);
	}
}
