// "Add another" and spreadsheet bulk import for agents (social-comments design §7.9–7.10,
// docs/wp-notes/social-comments.md "Add another & bulk import"):
// - duplicate_motion_graphic: `clip.duplicateMotionGraphic` (the command the editor's Add Another runs), `count`
//   copies chained one after another through `$ref`s in ONE transaction (each after the last consecutive copy of the
//   chain, so repeated calls on the same source continue the sequence);
// - import_motion_graphics_csv: the @jasper/project table parser and import planner (the ones the editor's bulk
//   import dialog uses) → one `clip.addMotionGraphic` per row in ONE transaction.
import { randomInt } from 'node:crypto';
import {
	type MgImportColumn,
	type MgImportRow,
	type MgImportTemplate,
	mgImportCommand,
	mgImportText,
	mgItemSeed,
	type ProjectDocument,
	parseTable,
	planMgImport,
	type Sequence,
	scheduleMgImport,
	sequenceTimecode,
	TABLE_MAX_CHARS,
	TABLE_MAX_ROWS,
	TrackRefSchema,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import { defineTool, EDIT, frameOf, loadDoc, type ToolContext, transact, txBody } from '../context.ts';
import { jsonResult, ToolError, TX_ERROR_HINTS } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { DEFAULT_MG_FLOOR } from './add-motion-graphic.ts';
import { resolveTemplateRef } from './templates.ts';

/** Most copies one duplicate_motion_graphic call makes. */
export const MAX_DUPLICATES = 50;

const SeedArg = z.number().int().min(0).max(0xffff_ffff);

/** What `clip.duplicateMotionGraphic` returns (packages/project handlers/mg-another.ts). */
type DupResult = {
	clipId: string;
	sourceClipId: string;
	sequenceId: string;
	trackId: string;
	track: string;
	createdTrack?: boolean;
	start: number;
	duration: number;
	params: Record<string, unknown>;
	rerolled: string[];
	seed: number;
};

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

type TxErrors = { commandIndex: number; code: string; message: string; path?: string[] }[];

const timing = (seq: Sequence | undefined, start: number, duration: number) => {
	const end = start + duration;
	return {
		start,
		end,
		duration,
		...(seq ? { startTimecode: sequenceTimecode(seq, start), endTimecode: sequenceTimecode(seq, end) } : {}),
	};
};

/** A refused transaction → an MCP error naming the item (`what(i)`) it failed on. */
function refused(
	errors: TxErrors,
	count: number,
	what: (i: number) => { label: string; details: Record<string, unknown> },
	extra: { appliedBy: string; revision: number },
	tail: string,
): ToolError {
	const first = errors[0];
	const code = first?.code ?? 'E_INTERNAL';
	const inRange = (e: TxErrors[number]) => e.commandIndex >= 0 && e.commandIndex < count;
	const where = first && inRange(first) ? `${what(first.commandIndex).label}: ` : '';
	return new ToolError(
		code,
		`${where}${first?.message ?? 'The transaction was rejected'}. ${tail}`,
		TX_ERROR_HINTS[code],
		{
			...extra,
			items: errors.filter(inRange).map((e) => ({
				...what(e.commandIndex).details,
				code: e.code,
				message: e.message,
				...(e.path ? { path: e.path } : {}),
			})),
			...(errors.some((e) => !inRange(e))
				? { errors: errors.filter((e) => !inRange(e)).map((e) => ({ code: e.code, message: e.message })) }
				: {}),
		},
	);
}

const DELIMITERS = { auto: 'auto', comma: ',', tab: '\t', semicolon: ';' } as const;

/** One column of the import as reported to the agent. */
function columnBody(c: MgImportColumn): Record<string, unknown> {
	switch (c.kind) {
		case 'param':
			return { column: c.header, param: c.param };
		case 'alias':
			return {
				column: c.header,
				param:
					typeof c.target === 'string'
						? c.target
						: `by ${c.target.byParam}: ${Object.entries(c.target.map)
								.map(([k, v]) => `${k} → ${v}`)
								.join(', ')}; otherwise ${c.target.otherwise}`,
			};
		case 'start':
		case 'duration':
			return { column: c.header, timing: c.kind };
		default:
			return { column: c.header, ignored: mgImportText(c.reason) };
	}
}

const rowErrors = (r: MgImportRow) => ({
	row: r.index + 1,
	line: r.line,
	errors: r.errors.map(mgImportText),
});

/** A row with its problems, as reported (`details.rows`, `skipped`). */
type BadRow = { row: number; line: number; errors: string[] };

/**
 * A refusal that belongs to its row — the template's params schema, its fill hook or a template media check
 * (`resolveMgTemplateParams`, what the editor's import dialog checks each row with) — rather than to the import as a
 * whole (a locked track, a stale revision, a missing sequence…).
 */
function rowRefusal(e: TxErrors[number], count: number): boolean {
	if (e.commandIndex < 0 || e.commandIndex >= count) return false;
	if (e.code === 'E_INVALID_PARAM') return true;
	return (e.code === 'E_NOT_FOUND' || e.code === 'E_SCHEMA') && e.path?.[0] === 'params';
}

export function registerBulkMotionGraphics(ctx: ToolContext): void {
	defineTool(
		ctx,
		'duplicate_motion_graphic',
		{
			title: 'Add another motion graphic',
			description: `"Add another" (clip.duplicateMotionGraphic, the editor's Add Another): copies a motion-graphic clip after itself — after the last consecutive copy of its chain (from the source's end, past every graphic of the same template that starts exactly where the previous one ends, on its track or above), so calling it again on the same clip continues the sequence instead of stacking copies; at overrides the start; same duration — with its transform, effects, keyframes, name and label, on the first free unlocked video track from the source's track (or track) up — it never overwrites. The params the template lists for re-randomizing (list_motion_templates: ui.addAnother.reroll; social-comment: the identity — displayName, handle, avatar — and the stats — time, likes, replies, reposts, views) get fresh values from the template's fill hook, deterministic for seed; every other param is copied (social-comment keeps variant, theme, emoji style, text, toggles and animation). params win over both (applied to every copy). count: N makes N copies one after another (each after the previous; the same as N calls with count 1) — all in ONE transaction, one undo step. Returns per copy the clip id, track, start/end (frames and timecode), the resolved params and which were re-randomized.`,
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('The motion-graphic clip to copy (get_timeline lists clip ids)'),
				count: z
					.number()
					.int()
					.min(1)
					.max(MAX_DUPLICATES)
					.optional()
					.describe(`How many copies, one after another (default 1, at most ${MAX_DUPLICATES})`),
				seed: SeedArg.optional().describe(
					'Seed of the re-randomized params: copy 0 uses it, copy i a value derived from it. Default: random, returned in the result',
				),
				at: timeArg(
					'Start of the first copy (default: the end of the source clip, or of the last consecutive copy after it)',
				).optional(),
				track: TrackRefSchema.optional().describe(
					'Lowest video track tried, e.g. "V3" (default: the track of the clip each copy follows)',
				),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Params set on every copy (validated by the template); they are not re-randomized'),
				dryRun: z
					.boolean()
					.optional()
					.describe('Resolve placement and params without changing the project (clip ids are not kept)'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const count = a.count ?? 1;
			const seed = a.seed ?? randomInt(0, 2 ** 32);
			const commands = Array.from({ length: count }, (_, i) => ({
				type: 'clip.duplicateMotionGraphic',
				clipId: i === 0 ? a.clipId : `$another${i - 1}`,
				seed: mgItemSeed(seed, i),
				...(i === 0 && a.at !== undefined ? { at: a.at } : {}),
				...(a.track !== undefined ? { track: a.track } : {}),
				...(a.params !== undefined ? { params: a.params } : {}),
				...(i < count - 1 ? { ref: `$another${i}` } : {}),
			}));
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: count === 1 ? 'Add Another' : `Add ${count} More`,
					commands,
					sequenceId: a.sequenceId,
					...(a.dryRun ? { dryRun: true } : {}),
				},
				extra,
			);
			const r = res.result;
			if (!r.ok)
				throw refused(
					r.errors,
					count,
					(i) => ({ label: count > 1 ? `copy ${i + 1}` : 'Add another', details: { index: i } }),
					{ appliedBy: res.appliedBy, revision: r.revision },
					'Nothing was added.',
				);
			const results = r.results as DupResult[];
			const { doc } = await loadDoc(ctx, a.projectId);
			const { results: _results, ...body } = txBody(res, r, a.dryRun === true);
			return jsonResult({
				...body,
				...(a.dryRun ? { note: 'Dry run: nothing was added; clip ids are placeholders.' } : {}),
				seed,
				items: results.map((x, index) => ({
					index,
					clipId: x.clipId,
					sourceClipId: x.sourceClipId,
					sequenceId: x.sequenceId,
					track: x.track,
					trackId: x.trackId,
					...(x.createdTrack ? { createdTrack: true } : {}),
					...timing(doc.sequences[x.sequenceId], x.start, x.duration),
					params: x.params,
					rerolled: x.rerolled,
					seed: x.seed,
				})),
			});
		},
	);

	defineTool(
		ctx,
		'import_motion_graphics_csv',
		{
			title: 'Import motion graphics from CSV',
			description: `Bulk import (the editor's spreadsheet import): one motion-graphic clip per row of CSV text or rows copied from a spreadsheet (TSV; semicolon CSV too), at most ${TABLE_MAX_ROWS} rows and ${TABLE_MAX_CHARS / 1024 / 1024} MB. The first row names the columns: param names or Properties labels (any case, spaces / "_" / "-" ignored), the template's aliases (social-comment: User → the name the variant shows, Username → the handle, Comment → text, Verified yes/true/1; "@" before a handle is dropped; an age in one Time / Age / Ago / Posted cell — "3h", "2 weeks", "10mo", "1y", "5 min", "3 hours ago", "just now" — sets timeValue and timeUnit, a bare number there is the count alone), plus optional start and duration (3, 1.5s, 0:03, 90f or timecode). Other columns are ignored and reported (social-comment: Image URL — remote images are not imported). Cells are read by the param type: "1,234", "1.2K", "3.5M"; yes/no; enum values ignoring case and punctuation; JSON for object params. An empty cell is not given: the preset, then the template's fill hook (deterministic for seed), then the defaults decide. Rows go one after another from startAt (default 0), each at the previous row's end (default length: the template's), on the first free video track from track (default V2) up — never overwriting — all in ONE transaction (one undo step). Rows with errors — cells that do not fit their param, and rows the template refuses (its params checks and fill, or a media param such as avatar {mediaId} naming a medium the project does not have) — refuse the whole call (details.rows lists every bad row's errors) unless skipInvalid: true skips them (listed in skipped). Returns the column mapping and per row the clip id, track, start/end, the resolved params and which were filled.`,
			input: {
				projectId: ProjectIdArg,
				csv: z
					.string()
					.min(1)
					.max(TABLE_MAX_CHARS)
					.describe(
						'The table: a header row of column names, then one row per graphic (CSV, TSV or semicolon CSV)',
					),
				template: z
					.string()
					.min(1)
					.describe(
						'Template id, optionally with version and preset: "social-comment:tiktok-comment", "counter:percentage", "lower-third-anim" (list_motion_templates). A preset’s params are every row’s starting point',
					),
				delimiter: z
					.enum(['auto', 'comma', 'tab', 'semicolon'])
					.optional()
					.describe(
						'Cell separator (default auto: tab when the header has one, else ";" when it has more than ",")',
					),
				startAt: timeArg('Start of the first row (default 0)').optional(),
				track: TrackRefSchema.optional().describe('Lowest video track tried (default V2)'),
				seed: SeedArg.optional().describe(
					'Seed of the fill: row i uses a value derived from it. Default: random, returned in the result',
				),
				skipInvalid: z
					.boolean()
					.optional()
					.describe('Skip rows with errors (they are reported) instead of refusing the call'),
				dryRun: z
					.boolean()
					.optional()
					.describe('Resolve the rows, placement and params without changing the project'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc as ProjectDocument, a.sequenceId);
			const startAt = a.startAt === undefined ? 0 : frameOf(seq, a.startAt);
			if (startAt < 0) throw new ToolError('E_INVALID_PARAM', 'startAt must not be before 0');
			const cat = await ctx.engine((c) => c.mgTemplates());
			const { template, preset } = resolveTemplateRef(cat, a.template, ' (list_motion_templates)');
			const table = parseTable(a.csv, { delimiter: DELIMITERS[a.delimiter ?? 'auto'] });
			if (!table.ok)
				throw new ToolError(
					'E_INVALID_PARAM',
					mgImportText(table.message),
					`Send at most ${TABLE_MAX_ROWS} rows (${TABLE_MAX_CHARS / 1024 / 1024} MB) per call, with a header row first.`,
				);
			const planned = planMgImport(table.table, template as MgImportTemplate, {
				rate: seq.settings.frameRate,
				...(preset ? { preset: preset.id } : {}),
			});
			if (!planned.ok)
				throw new ToolError(
					'E_INVALID_PARAM',
					mgImportText(planned.message),
					'list_motion_templates shows the param names a header row may use.',
				);
			const plan = planned.plan;
			const columns = plan.columns.map(columnBody);
			const bad = plan.rows.filter((r) => r.errors.length > 0);
			const valid = plan.rows.filter((r) => r.errors.length === 0);
			const seed = a.seed ?? randomInt(0, 2 ** 32);
			const track = a.track ?? DEFAULT_MG_FLOOR;
			const commandsOf = (rows: readonly MgImportRow[]) => {
				const places = scheduleMgImport(rows, { startAt, defaultDuration: plan.defaultDuration });
				return rows.map((r, i) => mgImportCommand(plan, r, places[i]!, { seed, track, sequenceId: seq.id }));
			};
			const run = (rows: readonly MgImportRow[], dryRun: boolean) =>
				transact(
					ctx,
					a.projectId,
					{
						label: `Import ${rows.length} motion graphic${rows.length === 1 ? '' : 's'}`,
						commands: commandsOf(rows),
						sequenceId: seq.id,
						...(dryRun ? { dryRun: true } : {}),
					},
					extra,
				);
			const refusedTx = (rows: readonly MgImportRow[], res: Awaited<ReturnType<typeof run>>) => {
				const r = res.result as Extract<typeof res.result, { ok: false }>;
				return refused(
					r.errors,
					rows.length,
					(i) => ({
						label: `row ${rows[i]!.index + 1} (line ${rows[i]!.line})`,
						details: { row: rows[i]!.index + 1, line: rows[i]!.line },
					}),
					{ appliedBy: res.appliedBy, revision: r.revision },
					'Nothing was imported.',
				);
			};
			// Rows that pass the JSON-Schema coercion can still be refused by the command — zod refinements, the fill hook,
			// media that is not in the project: what the editor's dialog checks each row with (`resolveMgTemplateParams`).
			// Those are row errors like the coercion ones. The happy path is one transaction; after a refusal, dry runs of
			// the rows after it find the next one (k refused rows: k + 1 runs, each shorter than the one before).
			// With coercion errors and no skipInvalid nothing is imported, so the rows are only dry-run (to report every
			// bad row together).
			const refuseAll = bad.length > 0 && !a.skipInvalid;
			let rows = valid;
			let res = rows.length > 0 ? await run(rows, refuseAll || a.dryRun === true) : null;
			const refusedRows = new Map<number, BadRow>();
			if (res && !res.result.ok) {
				let pending = rows;
				let probe = res;
				while (!probe.result.ok) {
					const e = probe.result.errors[0];
					if (!e || !rowRefusal(e, pending.length)) throw refusedTx(pending, probe);
					const row = pending[e.commandIndex]!;
					refusedRows.set(row.index, { row: row.index + 1, line: row.line, errors: [e.message] });
					pending = pending.slice(e.commandIndex + 1);
					if (pending.length === 0) break;
					probe = await run(pending, true);
				}
				rows = valid.filter((r) => !refusedRows.has(r.index));
			}
			const skipped = [...bad.map(rowErrors), ...refusedRows.values()].sort((x, y) => x.row - y.row);
			if (skipped.length > 0 && !a.skipInvalid)
				throw new ToolError(
					'E_INVALID_PARAM',
					`${skipped.length} of ${plan.rows.length} rows have errors (first: row ${skipped[0]!.row}, ${skipped[0]!.errors[0]}). Nothing was imported.`,
					'Fix the cells listed in details.rows, or pass skipInvalid: true to import the other rows.',
					{ rows: skipped, columns },
				);
			if (rows.length === 0 || !res)
				throw new ToolError(
					'E_INVALID_PARAM',
					'No row can be imported',
					'Every row has errors (details.rows).',
					{
						rows: skipped,
						columns,
					},
				);
			if (refusedRows.size > 0) {
				res = await run(rows, a.dryRun === true);
				if (!res.result.ok) throw refusedTx(rows, res);
			}
			const r = res.result;
			if (!r.ok) throw refusedTx(rows, res);
			const results = r.results as AddResult[];
			const { results: _results, ...body } = txBody(res, r, a.dryRun === true);
			return jsonResult({
				...body,
				...(a.dryRun ? { note: 'Dry run: nothing was added; clip ids are placeholders.' } : {}),
				template: `${template.id}@${template.version}${preset ? `:${preset.id}` : ''}`,
				delimiter: { ',': 'comma', '\t': 'tab', ';': 'semicolon' }[plan.delimiter],
				seed,
				columns,
				rows: results.map((x, i) => {
					const row = rows[i]!;
					return {
						row: row.index + 1,
						line: row.line,
						clipId: x.clipId,
						track: x.track,
						trackId: x.trackId,
						...(x.createdTrack ? { createdTrack: true } : {}),
						...timing(seq, x.start, x.duration),
						params: x.params,
						filled: x.filled ?? [],
						seed: x.seed,
						...(row.warnings.length ? { warnings: row.warnings.map(mgImportText) } : {}),
					};
				}),
				...(skipped.length ? { skipped } : {}),
			});
		},
	);
}
