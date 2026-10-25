// spec 13 AS-040 / AS-022: Create Subtitles — source, output, template, the rules in two columns (generic default vs
// the template's default; an empty field keeps the template's), text transforms, cut awareness, language, nesting,
// a live preview (counts + the first subtitle rendered by the Program monitor's pipeline, from the same command on a
// copy of the document) and Create: one `captions.generate` transaction, one History entry.
import {
	type CutAwareInput,
	type Sequence,
	type SubtitleRulesInput,
	type SubtitleTemplate,
	type SubtitleTextInput,
	sequenceWords,
	templateNeedsFont,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider, useStoreSelector } from '@jasper/session/react';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	PanelErrorBoundary,
	Select,
	TextField,
	toast,
} from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';
import { useFonts } from '../fonts/hooks.ts';
import { installFontFiles, isFontAvailable, pickFontFiles } from '../fonts/store.ts';
import { t } from '../i18n/runtime.ts';
import { FrameView } from '../panels/program/FrameView.tsx';
import { textPanelRequests } from '../panels/text/state.ts';
import {
	availableTemplates,
	type CreateSubtitlesOptions,
	effectiveCutAware,
	type GenerationPreview,
	generateCommand,
	loadCreateOptions,
	parseWordList,
	previewGeneration,
	ruleColumns,
	type SubtitleSourceChoice,
	saveCreateOptions,
} from './model.ts';
import { useSubtitleLibrary } from './store.ts';
import { templateName } from './templates.ts';

export type CreateSubtitlesProps = {
	session: EditorSession;
	sequenceId: string;
	source?: SubtitleSourceChoice;
};

type RuleKey = keyof Required<SubtitleRulesInput>;
const NUMERIC_RULES: Array<{
	key: RuleKey;
	label: string;
	min: number;
	max: number;
	int?: boolean;
	nullable?: boolean;
	unit?: string;
}> = [
	{ key: 'maxChars', label: 'Characters per line', min: 7, max: 72, int: true },
	{ key: 'lines', label: 'Lines', min: 1, max: 3, int: true },
	{ key: 'maxWords', label: 'Words per subtitle', min: 1, max: 20, int: true, nullable: true },
	{ key: 'minSeconds', label: 'Minimum duration', min: 0.1, max: 10, unit: 's' },
	{ key: 'maxSeconds', label: 'Maximum duration', min: 0.5, max: 60, unit: 's' },
	{ key: 'gapFrames', label: 'Gap between subtitles', min: 0, max: 30, int: true, unit: 'frames' },
	{ key: 'breakPauseSeconds', label: 'Break at a pause of', min: 0.05, max: 10, unit: 's' },
	{ key: 'holdSeconds', label: 'Hold until the next one', min: 0, max: 10, nullable: true, unit: 's' },
];

const PUNCTUATION_LABELS: Record<string, string> = {
	never: 'Never',
	half: 'When half full',
	always: 'Always',
};
const CASE_LABELS: Record<string, string> = {
	'as-spoken': 'As spoken',
	upper: 'UPPER CASE',
	lower: 'lower case',
	sentence: 'Sentence case',
};

/** A rule value shown in a column ("off" for null). */
function shown(v: number | string | null | undefined, unit?: string): string {
	if (v === null) return t('off');
	if (v === undefined) return '';
	return unit ? `${v} ${unit === 's' ? 's' : t('frames')}` : String(v);
}

/** Parses a typed rule value: '' = template default, "off" = null (nullable rules), a number in range. */
export function parseRule(
	raw: string,
	spec: { min: number; max: number; int?: boolean; nullable?: boolean },
): { ok: true; value: number | null | undefined } | { ok: false } {
	const s = raw.trim().toLowerCase();
	if (!s) return { ok: true, value: undefined };
	if (spec.nullable && (s === 'off' || s === t('off').toLowerCase())) return { ok: true, value: null };
	const n = Number(s.replace(',', '.'));
	if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.int && !Number.isInteger(n)))
		return { ok: false };
	return { ok: true, value: n };
}

function Row(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid min-h-[28px] grid-cols-[150px_minmax(0,1fr)] items-center gap-3">
			<span className="text-pr-muted">{props.label}</span>
			<div className="flex min-w-0 items-center gap-2">{props.children}</div>
		</div>
	);
}

function CreateSubtitlesDialog(props: HostedDialogProps<CreateSubtitlesProps>) {
	const { session, sequenceId } = props;
	const doc = useStoreSelector(session.store, (s) => s.document);
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	const selection = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const library = useSubtitleLibrary();
	const fonts = useFonts();
	const [opts, setOpts] = useState<CreateSubtitlesOptions>(() => loadCreateOptions());
	const [raw, setRaw] = useState<Record<string, string>>({});
	const [profanity, setProfanity] = useState('');
	const [source, setSource] = useState<SubtitleSourceChoice>(() => props.source ?? { kind: 'sequence' });
	const [preview, setPreview] = useState<GenerationPreview | null>(null);
	const [busy, setBusy] = useState(false);

	const templates = useMemo(() => availableTemplates(doc, library.templates), [doc, library.templates]);
	const template: SubtitleTemplate | null =
		templates.find((x) => x.template.id === opts.templateId)?.template ?? templates[0]?.template ?? null;
	const cols = ruleColumns(template);
	const cut = effectiveCutAware(template, opts.cutAware);
	const output = opts.output === 'template' ? (template?.output ?? 'text-clips') : opts.output;

	// sources: the sequence transcript, a transcribed media of the sequence, or the selected clips
	const words = useMemo(() => (seq ? sequenceWords(doc, seq) : []), [doc, seq]);
	const media = useMemo(() => {
		const ids = [...new Set(words.map((w) => w.mediaId))];
		return ids.map(
			(id) => [id, (doc.media[id] as { originalName?: string } | undefined)?.originalName ?? id] as const,
		);
	}, [words, doc.media]);
	const selected = selection.filter((id) => seq?.clips[id]);
	const range =
		seq && seq.inPoint !== null && seq.outPoint !== null ? { start: seq.inPoint, end: seq.outPoint } : null;

	// invalid typed rules block Create (and are shown red)
	const invalid = new Set<string>();
	const rules: SubtitleRulesInput = {};
	for (const r of NUMERIC_RULES) {
		const p = parseRule(raw[r.key] ?? '', r);
		if (!p.ok) invalid.add(r.key);
		else if (p.value !== undefined) (rules as Record<string, unknown>)[r.key] = p.value;
	}
	if (opts.rules.punctuation) rules.punctuation = opts.rules.punctuation;
	const cutInput: CutAwareInput = { ...opts.cutAware };
	for (const [key, min, max] of [
		['lookBackSeconds', 0, 2],
		['lookAheadSeconds', 0, 0.5],
	] as const) {
		const p = parseRule(raw[key] ?? '', { min, max });
		if (!p.ok) invalid.add(key);
		else if (p.value !== undefined && p.value !== null) cutInput[key] = p.value;
	}
	const cov = parseRule(raw.overlayCoverage ?? '', { min: 1, max: 100 });
	if (!cov.ok) invalid.add('overlayCoverage');
	else if (typeof cov.value === 'number') cutInput.overlayCoverage = cov.value / 100;
	const text: SubtitleTextInput = { ...opts.text };
	const list = parseWordList(profanity);
	if (list.length) text.profanity = { words: list, mask: text.profanity?.mask ?? 'asterisks' };
	else delete text.profanity;
	const effective: CreateSubtitlesOptions = { ...opts, rules, text, cutAware: cutInput };
	const command = seq ? generateCommand(effective, { sequenceId, source, range, template }) : null;
	const key = command ? JSON.stringify(command) : '';

	// live preview (debounced): the command applied to a copy of the document
	// biome-ignore lint/correctness/useExhaustiveDependencies: the serialised command (`key`) is the dependency
	useEffect(() => {
		if (!command || invalid.size) return;
		const id = setTimeout(() => setPreview(previewGeneration(session.getCommitted(), command)), 250);
		return () => clearTimeout(id);
	}, [key, session, invalid.size]);

	const needsFont =
		!!template && templateNeedsFont(template) && !isFontAvailable(fonts.catalog, template.fontFamily);
	const setRule = (k: string, v: string) => setRaw((r) => ({ ...r, [k]: v }));

	if (!seq)
		return (
			<Dialog open onOpenChange={(o) => !o && props.close()} title="Create Subtitles" size="small">
				<p className="text-pr-muted">The sequence is gone.</p>
			</Dialog>
		);

	const create = () => {
		if (!command) return false;
		saveCreateOptions(opts);
		setBusy(true);
		try {
			const r = session.apply({ label: 'Create Subtitles', origin: 'user', sequenceId, commands: [command] });
			if (!r.ok) {
				toast({ kind: 'warning', title: t('Subtitles not created'), detail: r.errors[0]?.message });
				return false;
			}
			for (const w of r.warnings.slice(0, 3))
				toast({ kind: 'info', title: t('Create Subtitles'), detail: w.message });
			textPanelRequests.open('subtitles');
			return true;
		} finally {
			setBusy(false);
		}
	};

	const stats = preview?.ok ? preview.stats : null;
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Create Subtitles"
			size="large"
			primaryLabel="Create"
			primaryDisabled={busy || invalid.size > 0 || !preview?.ok}
			onPrimary={() => {
				if (create()) props.close(true);
				return false;
			}}
			data-testid="subtitles-dialog"
		>
			<div className="grid grid-cols-[minmax(0,1fr)_280px] gap-4">
				<div className="flex min-w-0 flex-col gap-2">
					<Row label={t('Source')}>
						<Select
							label="Source"
							className="w-72"
							value={source.kind === 'media' ? `media:${source.mediaId}` : source.kind}
							onValueChange={(v) =>
								setSource(
									v === 'sequence'
										? { kind: 'sequence' }
										: v === 'clips'
											? { kind: 'clips', clipIds: selected }
											: { kind: 'media', mediaId: v.slice(6) },
								)
							}
							options={[
								{ value: 'sequence', label: t('Sequence transcript') },
								...media.map(([id, name]) => ({ value: `media:${id}`, label: name })),
								{
									value: 'clips',
									label: t('Selected clips ({0})', selected.length),
									disabled: !selected.length,
								},
							]}
						/>
						{range ? (
							<Checkbox
								checked={opts.inOutOnly}
								onCheckedChange={(v) => setOpts({ ...opts, inOutOnly: v === true })}
								label="Only from In to Out"
							/>
						) : null}
					</Row>
					<Row label={t('Template')}>
						<Select
							label="Template"
							className="w-72"
							value={template?.id ?? ''}
							onValueChange={(v) => {
								setOpts({ ...opts, templateId: v, rules: {}, text: {}, cutAware: {} });
								setRaw({});
							}}
							options={templates.map((x) => ({
								value: x.template.id,
								label:
									x.origin === 'built-in'
										? templateName(x.template)
										: `${x.template.name} · ${x.origin === 'project' ? t('project') : t('library')}`,
							}))}
						/>
					</Row>
					{needsFont ? (
						<div
							className="flex items-center gap-2 rounded-pr-control border border-pr-warning px-2 py-1 text-pr-small text-pr-text"
							role="alert"
							data-testid="subtitles-font-notice"
						>
							<span className="min-w-0 flex-1">
								{t(
									'This template uses the font "{0}", which is not installed: the subtitles show in the default font until you install it.',
									template!.fontFamily,
								)}
							</span>
							<Button
								onClick={async () => {
									const files = await pickFontFiles();
									if (!files.length) return;
									const r = await installFontFiles(files);
									for (const e of r.errors) toast({ kind: 'warning', title: e.file, detail: e.message });
								}}
								data-testid="subtitles-install-font"
							>
								Install Font…
							</Button>
						</div>
					) : null}
					<Row label={t('Output')}>
						<Select
							label="Output"
							className="w-72"
							value={opts.output}
							onValueChange={(v) => setOpts({ ...opts, output: v as CreateSubtitlesOptions['output'] })}
							options={[
								{
									value: 'template',
									label: t(
										'As the template ({0})',
										template?.output === 'caption-track' ? t('caption track') : t('text clips'),
									),
								},
								{ value: 'text-clips', label: t('Text clips (effects, animation)') },
								{ value: 'caption-track', label: t('Caption track (subtitle files)') },
							]}
						/>
					</Row>
					<Row label={t('Language')}>
						<TextField
							className="w-24"
							value={opts.language}
							placeholder={t('from transcript')}
							onChange={(e) => setOpts({ ...opts, language: e.currentTarget.value.trim().slice(0, 35) })}
							aria-label="Language"
						/>
					</Row>

					<h3 className="mt-2 text-pr-small text-pr-muted">RULES</h3>
					<div className="grid grid-cols-[150px_70px_70px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-pr-small">
						<span />
						<span className="text-pr-muted">Generic</span>
						<span className="text-pr-muted">Template</span>
						<span className="text-pr-muted">Value</span>
						{NUMERIC_RULES.map((r) => (
							<RuleRow
								key={r.key}
								label={r.label}
								generic={shown(cols.generic[r.key] as number | null, r.unit)}
								tmpl={shown(cols.template[r.key] as number | null, r.unit)}
							>
								<TextField
									className="w-20"
									value={raw[r.key] ?? ''}
									placeholder={shown(cols.template[r.key] as number | null)}
									invalid={invalid.has(r.key)}
									onChange={(e) => setRule(r.key, e.currentTarget.value)}
									aria-label={r.label}
									data-testid={`subtitles-rule-${r.key}`}
								/>
							</RuleRow>
						))}
						<RuleRow
							label={t('Break at punctuation')}
							generic={t(PUNCTUATION_LABELS[cols.generic.punctuation]!)}
							tmpl={t(PUNCTUATION_LABELS[cols.template.punctuation]!)}
						>
							<Select
								label="Break at punctuation"
								className="w-40"
								value={opts.rules.punctuation ?? cols.template.punctuation}
								onValueChange={(v) => setOpts({ ...opts, rules: { ...opts.rules, punctuation: v as never } })}
								options={Object.entries(PUNCTUATION_LABELS).map(([value, label]) => ({ value, label }))}
							/>
						</RuleRow>
						<RuleRow
							label={t('Case')}
							generic={t(CASE_LABELS[cols.genericText.case]!)}
							tmpl={t(CASE_LABELS[cols.templateText.case]!)}
						>
							<Select
								label="Case"
								className="w-40"
								value={opts.text.case ?? cols.templateText.case}
								onValueChange={(v) => setOpts({ ...opts, text: { ...opts.text, case: v as never } })}
								options={Object.entries(CASE_LABELS).map(([value, label]) => ({ value, label }))}
							/>
						</RuleRow>
						<RuleRow
							label={t('Strip trailing punctuation')}
							generic={cols.genericText.stripTrailingPunctuation ? t('on') : t('off')}
							tmpl={cols.templateText.stripTrailingPunctuation ? t('on') : t('off')}
						>
							<Checkbox
								checked={opts.text.stripTrailingPunctuation ?? cols.templateText.stripTrailingPunctuation}
								onCheckedChange={(v) =>
									setOpts({ ...opts, text: { ...opts.text, stripTrailingPunctuation: v === true } })
								}
								aria-label="Strip trailing punctuation"
							/>
						</RuleRow>
						<RuleRow
							label={t('Replace missing glyphs')}
							generic={cols.genericText.replaceGlyphs ? t('on') : t('off')}
							tmpl={cols.templateText.replaceGlyphs ? t('on') : t('off')}
						>
							<Checkbox
								checked={opts.text.replaceGlyphs ?? cols.templateText.replaceGlyphs}
								onCheckedChange={(v) =>
									setOpts({ ...opts, text: { ...opts.text, replaceGlyphs: v === true } })
								}
								label="Use plain dots and quotes (… “ ”)"
							/>
						</RuleRow>
						<RuleRow
							label={t('Mask words')}
							generic={t('off')}
							tmpl={cols.templateText.profanity ? t('on') : t('off')}
						>
							<TextField
								className="w-full"
								value={profanity}
								placeholder={t('comma-separated words')}
								onChange={(e) => setProfanity(e.currentTarget.value)}
								aria-label="Words to mask"
								data-testid="subtitles-profanity"
							/>
						</RuleRow>
					</div>

					<h3 className="mt-2 text-pr-small text-pr-muted">CUTS</h3>
					<div className="flex flex-col gap-1 text-pr-small">
						<span data-testid="subtitles-cut-aware">
							<Checkbox
								checked={cut.enabled}
								onCheckedChange={(v) => setOpts({ ...opts, cutAware: { ...opts.cutAware, enabled: v } })}
								label="Cut-aware timing: never run a subtitle across a cut, start subtitles on cuts"
							/>
						</span>
						{cut.enabled ? (
							<div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 pl-6">
								<span className="text-pr-muted">Start on a cut up to</span>
								<span className="flex items-center gap-1">
									<TextField
										className="w-16"
										value={raw.lookBackSeconds ?? ''}
										placeholder={String(cut.lookBackSeconds)}
										invalid={invalid.has('lookBackSeconds')}
										onChange={(e) => setRule('lookBackSeconds', e.currentTarget.value)}
										aria-label="Look back"
									/>
									{t('s before the first word, or')}
									<TextField
										className="w-16"
										value={raw.lookAheadSeconds ?? ''}
										placeholder={String(cut.lookAheadSeconds)}
										invalid={invalid.has('lookAheadSeconds')}
										onChange={(e) => setRule('lookAheadSeconds', e.currentTarget.value)}
										aria-label="Look ahead"
									/>
									{t('s after it')}
								</span>
								<span className="text-pr-muted">Overlays covering</span>
								<span className="flex items-center gap-1">
									<TextField
										className="w-16"
										value={raw.overlayCoverage ?? ''}
										placeholder={String(Math.round(cut.overlayCoverage * 100))}
										invalid={invalid.has('overlayCoverage')}
										onChange={(e) => setRule('overlayCoverage', e.currentTarget.value)}
										aria-label="Overlay coverage"
									/>
									{t('% of the frame or more are cuts')}
								</span>
								<span className="text-pr-muted">At transitions</span>
								<Select
									label="At transitions"
									className="w-56"
									value={cut.transitions}
									onValueChange={(v) =>
										setOpts({ ...opts, cutAware: { ...opts.cutAware, transitions: v as 'snap' | 'avoid' } })
									}
									options={[
										{ value: 'snap', label: t('Change on the edit point') },
										{ value: 'avoid', label: t('Change outside the transition') },
									]}
								/>
							</div>
						) : null}
						{output === 'text-clips' ? (
							<Checkbox
								checked={opts.nest}
								onCheckedChange={(v) => setOpts({ ...opts, nest: v === true })}
								label="Nest the subtitles (they will not follow later ripple edits of this sequence)"
							/>
						) : null}
					</div>
				</div>

				<div className="flex min-w-0 flex-col gap-2" data-testid="subtitles-preview">
					<div className="aspect-video w-full overflow-hidden rounded-pr-control bg-pr-field-deep">
						{preview?.ok && preview.first ? (
							// hosted dialogs render outside the editor's SessionProvider; a preview failure stays in the box
							<SessionProvider session={session}>
								<PanelErrorBoundary name="Subtitle preview">
									<FrameView
								doc={preview.doc}
								sequenceId={preview.sequenceId}
								frame={preview.first.frame}
								label={t('First subtitle')}
								testId="subtitles-preview-frame"
							/>
								</PanelErrorBoundary>
							</SessionProvider>
						) : null}
					</div>
					{preview?.ok && preview.first ? (
						<p className="truncate text-pr-small text-pr-text" data-testid="subtitles-preview-text">
							{preview.first.text}
						</p>
					) : null}
					{stats ? (
						<dl
							className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 text-pr-small"
							data-testid="subtitles-counts"
						>
							<dt className="text-pr-muted">Subtitles</dt>
							<dd data-testid="subtitles-count">{stats.count}</dd>
							<dt className="text-pr-muted">Started on a cut</dt>
							<dd>{stats.snappedToCuts}</dd>
							<dt className="text-pr-muted">Split at a cut</dt>
							<dd>{stats.splitAtCuts}</dd>
							<dt className="text-pr-muted">Below the minimum</dt>
							<dd>{stats.belowMinimum}</dd>
							<dt className="text-pr-muted">Cuts merged (montage)</dt>
							<dd>{stats.merged}</dd>
						</dl>
					) : null}
					{preview && !preview.ok ? (
						<p className="text-pr-small text-pr-danger" role="alert" data-testid="subtitles-preview-error">
							{preview.message}
						</p>
					) : null}
					{stats?.warnings.length ? (
						<ul className="list-disc pl-4 text-pr-small text-pr-muted">
							{stats.warnings.slice(0, 4).map((w) => (
								<li key={w}>{w}</li>
							))}
						</ul>
					) : null}
				</div>
			</div>
		</Dialog>
	);
}

function RuleRow(props: { label: string; generic: string; tmpl: string; children: React.ReactNode }) {
	return (
		<>
			<span className="text-pr-muted">{props.label}</span>
			<span className="text-pr-muted">{props.generic}</span>
			<span className="text-pr-text">{props.tmpl}</span>
			<span className="flex min-w-0 items-center">{props.children}</span>
		</>
	);
}

export { CreateSubtitlesDialog };
