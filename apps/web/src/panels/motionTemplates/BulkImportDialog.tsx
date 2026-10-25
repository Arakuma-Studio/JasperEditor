// Import Motion Graphics from Spreadsheet… (social-comments design §7.9 "Bulk import"; docs/wp-notes/social-comments.md
// "Add another & bulk import"). Paste rows copied from a spreadsheet (tab-separated, first row = column names) or
// choose a .csv / .tsv file; pick the template (or one of its presets, e.g. a social-comment variant); the preview
// shows every row as it will be inserted — values the template fills at random are marked — and the rows with
// errors, which are left out. Insert adds the valid rows one after another from the playhead, each on the first free
// video track, as one undo step.
import {
	formatTimecode,
	MG_IMPORT_TEXT,
	type MgImportMessage,
	TABLE_MAX_CHARS,
	TABLE_MAX_ROWS,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import {
	Button,
	cx,
	Dialog,
	type HostedDialogProps,
	PanelErrorBoundary,
	registerDialog,
	toast,
} from '@jasper/ui';
import { useId, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { t } from '../../i18n/runtime.ts';
import { randomSeed } from './add-another.ts';
import {
	type BulkDelimiter,
	type BulkImportModel,
	buildBulkImport,
	bulkTemplateOptions,
	insertBulkImport,
	previewValue,
} from './bulk-import.ts';
import { firstFreeFloor } from './insert.ts';

export const MG_BULK_IMPORT_DIALOG = 'mg.bulkImport';

/** Props a caller may pass (validated: dialogs are opened from menus, the palette and the gallery). */
const PropsSchema = z.object({
	template: z
		.object({
			id: z.string().min(1),
			version: z.number().int().positive(),
			preset: z.string().min(1).max(64).optional(),
		})
		.optional(),
	text: z.string().max(TABLE_MAX_CHARS).optional(),
});

/** The text of a parser / planner message in the UI language (the templates are catalogue strings). */
export function importMessageText(m: MgImportMessage): string {
	const body = m.code === 'template' ? t(m.text) : t(MG_IMPORT_TEXT[m.code] ?? m.code, ...m.values);
	return m.column ? `${m.column}: ${body}` : body;
}

const DELIMITERS: { value: BulkDelimiter; label: string }[] = [
	{ value: 'auto', label: 'Detect' },
	{ value: '\t', label: 'Tab (pasted cells)' },
	{ value: ',', label: 'Comma' },
	{ value: ';', label: 'Semicolon' },
];

/** Sample pasted rows (column names stay English: they are parameter names, not UI text). */
const SAMPLE_ROWS = [
	['User', 'Comment', 'Likes'],
	['luna.park', 'This is so good 😍', '1.2K'],
]
	.map((r) => r.join('\t'))
	.join('\n');

const SELECT =
	'h-[var(--pr-control-h)] min-w-0 rounded-pr-control border border-pr-border-strong bg-pr-field px-1 font-pr text-pr-ui text-pr-text focus:outline focus:outline-1 focus:outline-pr-focus';

type DialogProps = HostedDialogProps<{ session?: EditorSession | null; template?: unknown; text?: unknown }>;

function BulkImportDialog(props: DialogProps) {
	const session = props.session ?? null;
	const parsedProps = PropsSchema.safeParse({ template: props.template, text: props.text });
	const initial = parsedProps.success ? parsedProps.data : {};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Import Motion Graphics from Spreadsheet"
			size="large"
			data-testid="mg-bulk-import-dialog"
		>
			<PanelErrorBoundary name="Import Motion Graphics">
				{session ? (
					<BulkImportBody session={session} initial={initial} close={props.close} />
				) : (
					<p className="text-pr-muted" role="status">
						Open a project and a sequence first.
					</p>
				)}
			</PanelErrorBoundary>
		</Dialog>
	);
}

function BulkImportBody({
	session,
	initial,
	close,
}: {
	session: EditorSession;
	initial: z.infer<typeof PropsSchema>;
	close(result?: unknown): void;
}) {
	const reg = session.ctx.registries.mgTemplates;
	const options = useMemo(() => bulkTemplateOptions(reg), [reg]);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const sequenceId = useStoreSelector(session.store, (s) => s.activeSequenceId);
	const doc = useStoreSelector(session.store, (s) => s.document);
	const seq = sequenceId ? doc.sequences[sequenceId] : undefined;
	const initialKey = (() => {
		const tpl = initial.template;
		if (tpl) {
			const k = `${tpl.id}@${tpl.version}${tpl.preset ? `:${tpl.preset}` : ''}`;
			if (options.some((o) => o.key === k)) return k;
		}
		// the template of a selected motion-graphic clip, else the first template with presets, else the first one
		const sel = session.getState().selection.timeline.clips.map((id) => seq?.clips[id]);
		const mg = sel.find((c) => c?.kind === 'motion-graphic');
		if (mg?.kind === 'motion-graphic') {
			const k = `${mg.template.id}@${mg.template.version}`;
			if (options.some((o) => o.key === k)) return k;
		}
		return (options.find((o) => o.preset) ?? options[0])?.key ?? '';
	})();
	const [key, setKey] = useState(initialKey);
	const [text, setText] = useState(initial.text ?? '');
	const [delimiter, setDelimiter] = useState<BulkDelimiter>('auto');
	const [seed, setSeed] = useState(() => randomSeed());
	const [fileError, setFileError] = useState<string | null>(null);
	const [insertError, setInsertError] = useState<string | null>(null);
	const [startAt] = useState(() => Math.max(0, Math.round(session.transport.getState().frame)));
	const fileInput = useRef<HTMLInputElement | null>(null);
	const ids = { template: useId(), text: useId(), delimiter: useId() };

	const option = options.find((o) => o.key === key);
	const info = option ? reg.get(option.id, option.version) : undefined;
	const model: BulkImportModel | null = useMemo(() => {
		if (!info || !seq || !text.trim()) return null;
		return buildBulkImport({
			text,
			delimiter,
			info,
			...(option?.preset ? { preset: option.preset } : {}),
			rate: seq.settings.frameRate,
			media: doc.media,
			seed,
			startAt,
		});
	}, [info, seq, text, delimiter, option?.preset, doc.media, seed, startAt]);

	const tc = (frame: number) => (seq ? formatTimecode(frame, seq.settings.frameRate) : String(frame));
	const label = (name: string) => info?.ui?.params?.[name]?.label ?? name;
	const included = model?.ok ? model.included : 0;
	const errorRows = model?.ok ? model.rows.filter((r) => !r.included) : [];

	const chooseFile = async (file: File) => {
		setFileError(null);
		if (file.size > TABLE_MAX_CHARS) {
			setFileError(
				t('{0} is too large to import (at most {1} MB)', file.name, TABLE_MAX_CHARS / 1024 / 1024),
			);
			return;
		}
		try {
			const content = await file.text();
			setText(content);
			if (/\.tsv$/i.test(file.name)) setDelimiter('\t');
		} catch (e) {
			setFileError(t('Could not read {0}: {1}', file.name, e instanceof Error ? e.message : String(e)));
		}
	};

	const insert = () => {
		if (!model?.ok || !seq || !sequenceId) return;
		setInsertError(null);
		const view = session.getState().views[sequenceId] ?? null;
		const r = insertBulkImport(session, model, {
			seed,
			track: firstFreeFloor(seq, view),
			sequenceId,
			label: t('Import {0} Motion Graphics', included),
		});
		if (!r.ok) {
			setInsertError(r.message);
			return;
		}
		toast({
			kind: 'success',
			title: t('Added {0} motion graphics', r.clipIds.length),
			...(errorRows.length ? { detail: t('{0} rows with errors were left out', errorRows.length) } : {}),
		});
		close(r);
	};

	return (
		<div className="flex min-h-0 flex-col gap-2 text-pr-ui text-pr-text" data-testid="mg-bulk-import">
			<div className="flex flex-wrap items-end gap-2">
				<label className="flex min-w-[220px] flex-1 flex-col gap-0.5" htmlFor={ids.template}>
					<span className="text-pr-muted">Template</span>
					<select
						id={ids.template}
						className={SELECT}
						value={key}
						onChange={(e) => setKey(e.target.value)}
						data-testid="mg-bulk-template"
					>
						{options.map((o) => (
							<option key={o.key} value={o.key}>
								{o.presetName ? `${t(o.templateName)} · ${t(o.presetName)}` : t(o.templateName)}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-0.5" htmlFor={ids.delimiter}>
					<span className="text-pr-muted">Columns separated by</span>
					<select
						id={ids.delimiter}
						className={SELECT}
						value={delimiter}
						onChange={(e) => setDelimiter(e.target.value as BulkDelimiter)}
						data-testid="mg-bulk-delimiter"
					>
						{DELIMITERS.map((d) => (
							<option key={d.label} value={d.value}>
								{t(d.label)}
							</option>
						))}
					</select>
				</label>
				<Button variant="secondary" onClick={() => fileInput.current?.click()} data-testid="mg-bulk-file">
					Choose CSV File…
				</Button>
				<input
					ref={fileInput}
					type="file"
					accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
					className="hidden"
					data-testid="mg-bulk-file-input"
					onChange={(e) => {
						const f = e.target.files?.[0];
						e.target.value = '';
						if (f) void chooseFile(f);
					}}
				/>
			</div>
			<label className="flex flex-col gap-0.5" htmlFor={ids.text}>
				<span className="text-pr-muted">
					Rows (copy cells from a spreadsheet and paste them here; the first row names the columns)
				</span>
				<textarea
					id={ids.text}
					className="h-28 w-full resize-y rounded-pr-control border border-pr-border-strong bg-pr-field px-1 py-1 font-pr-mono text-pr-small text-pr-text focus:outline focus:outline-1 focus:outline-pr-focus"
					value={text}
					spellCheck={false}
					placeholder={SAMPLE_ROWS}
					onChange={(e) => setText(e.target.value)}
					data-testid="mg-bulk-text"
				/>
			</label>
			<p className="text-pr-small text-pr-dim">
				{t(
					'Columns are parameter names or labels (aliases such as User, Comment and Verified work for social comments), plus optional start and duration. Empty cells get the template default or a random value. At most {0} rows.',
					TABLE_MAX_ROWS,
				)}
			</p>
			{fileError ? (
				<p className="text-pr-danger" role="alert" data-testid="mg-bulk-file-error">
					{fileError}
				</p>
			) : null}
			{model && !model.ok ? (
				<p className="text-pr-danger" role="alert" data-testid="mg-bulk-error">
					{importMessageText(model.message)}
				</p>
			) : null}
			{model?.ok ? (
				<>
					<ul className="flex flex-wrap gap-1" aria-label="Columns" data-testid="mg-bulk-columns">
						{model.plan.columns.map((c) => (
							<li
								key={c.index}
								className={cx(
									'rounded-pr-pill border px-1.5 text-pr-small',
									c.kind === 'ignored'
										? 'border-pr-border-subtle text-pr-dim'
										: 'border-pr-border-strong text-pr-text',
								)}
								title={c.kind === 'ignored' ? importMessageText(c.reason) : undefined}
								data-column-kind={c.kind}
							>
								{c.header || '—'}
								{c.kind === 'param'
									? ` → ${t(label(c.param))}`
									: c.kind === 'start'
										? ` → ${t('Start')}`
										: c.kind === 'duration'
											? ` → ${t('Duration')}`
											: c.kind === 'alias'
												? ` → ${t('per row')}`
												: ` · ${t('ignored')}: ${importMessageText(c.reason)}`}
							</li>
						))}
					</ul>
					<div className="max-h-[320px] min-h-0 overflow-auto rounded-pr-control border border-pr-border-subtle">
						<table className="w-full border-collapse text-left text-pr-small" data-testid="mg-bulk-preview">
							<thead className="sticky top-0 bg-pr-panel-alt text-pr-muted">
								<tr>
									<th className="px-1 py-0.5 font-normal">#</th>
									<th className="px-1 py-0.5 font-normal">Start</th>
									{model.shown.map((p) => (
										<th key={p} className="px-1 py-0.5 font-normal whitespace-nowrap">
											{t(label(p))}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{model.rows.map((r) => {
									const params = r.resolved?.ok ? r.resolved.params : r.row.params;
									const filled = new Set(r.resolved?.ok ? r.resolved.filled : []);
									const errors = [
										...r.row.errors.map(importMessageText),
										...(r.resolved && !r.resolved.ok ? [r.resolved.message] : []),
									];
									return (
										<tr
											key={r.row.index}
											className={cx('align-top', !r.included && 'bg-pr-field-deep')}
											data-row={r.row.index}
											data-included={r.included}
										>
											<td className="px-1 py-0.5 text-pr-muted">{r.row.index + 1}</td>
											<td className="px-1 py-0.5 whitespace-nowrap text-pr-muted">
												{r.included && r.start !== undefined ? tc(r.start) : '—'}
											</td>
											{errors.length ? (
												<td
													colSpan={model.shown.length}
													className="px-1 py-0.5 text-pr-danger"
													data-testid="mg-bulk-row-error"
												>
													{t('Left out')}: {errors.join(' · ')}
												</td>
											) : (
												model.shown.map((p) => {
													const v = params[p];
													const isFilled = filled.has(p);
													return (
														<td
															key={p}
															className={cx(
																'max-w-[240px] truncate px-1 py-0.5',
																isFilled ? 'text-pr-dim italic' : 'text-pr-text',
															)}
															title={isFilled ? t('Random value (filled by the template)') : undefined}
															data-filled={isFilled || undefined}
														>
															{typeof v === 'boolean' ? (v ? t('Yes') : t('No')) : previewValue(v)}
														</td>
													);
												})
											)}
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					{model.rows.some((r) => r.row.warnings.length) ? (
						<ul className="text-pr-small text-pr-warning" data-testid="mg-bulk-warnings">
							{model.rows
								.filter((r) => r.row.warnings.length)
								.slice(0, 20)
								.map((r) => (
									<li key={r.row.index}>
										{t('Row {0}', r.row.index + 1)}: {r.row.warnings.map(importMessageText).join(' · ')}
									</li>
								))}
						</ul>
					) : null}
				</>
			) : null}
			{insertError ? (
				<p className="text-pr-danger" role="alert" data-testid="mg-bulk-insert-error">
					{insertError}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-2 border-t border-pr-border-subtle pt-2">
				<span className="text-pr-small text-pr-muted" data-testid="mg-bulk-summary" role="status">
					{model?.ok
						? errorRows.length
							? t(
									'{0} of {1} rows will be added from {2}; {3} with errors are left out',
									included,
									model.rows.length,
									tc(startAt),
									errorRows.length,
								)
							: t('{0} rows will be added one after another from {1}', included, tc(startAt))
						: !seq
							? t('Open a sequence to import')
							: t('Paste rows or choose a file')}
				</span>
				<Button
					variant="quiet"
					className="ml-auto"
					disabled={!model?.ok}
					title="Pick other random values for the empty cells"
					onClick={() => setSeed(randomSeed())}
					data-testid="mg-bulk-reroll"
				>
					New Random Values
				</Button>
				<Button variant="secondary" onClick={() => close()}>
					Cancel
				</Button>
				<Button
					variant="primary"
					disabled={!model?.ok || included === 0 || readOnly || !seq}
					onClick={insert}
					data-testid="mg-bulk-insert"
				>
					{t('Insert {0}', included)}
				</Button>
			</div>
		</div>
	);
}

let registered = false;
/** Registers the dialog with the dialog host (idempotent). */
export function registerBulkImportDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(
		MG_BULK_IMPORT_DIALOG,
		BulkImportDialog as (p: HostedDialogProps) => ReturnType<typeof BulkImportDialog>,
	);
}
