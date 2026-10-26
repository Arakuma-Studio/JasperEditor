// Clean Up settings drawer (spec 14 TC-040, TC-030): every setting with its unit, in groups; each change is an undoable
// `cleanup.configure` of the sequence (repeated edits of one field coalesce) and re-plans a review at once. Edited
// values are marked against the preset; "Reset to preset" drops the overrides. Word lists per language (fillers,
// discourse markers, emphasis repeats that are never stutters) replace the built-in ones; user presets are saved to
// and deleted from the engine's library.
import {
	builtinLists,
	type CleanupLanguage,
	readSequenceCleanup,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, Checkbox, Select, TextField, toast } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { t } from '../../../i18n/runtime.ts';
import { cleanupFor } from './controller.ts';
import {
	CHOICE_LABELS,
	GROUP_LABELS,
	parseFieldValue,
	type SettingField,
	type SettingGroup,
	SETTING_FIELDS,
	showFieldValue,
} from './settings-fields.ts';

const GROUPS: readonly SettingGroup[] = ['rules', 'edges', 'gaps', 'guards', 'joins', 'thresholds'];

export function SettingsDrawer({ session, seq }: { session: EditorSession; seq: Sequence }) {
	const c = cleanupFor(session);
	const userPresets = useStoreSelector(c.store, (s) => s.userPresets);
	const settings = c.settingsOf(seq);
	const stored = readSequenceCleanup(seq);
	const overrides = (stored.settings?.overrides ?? {}) as Record<string, Record<string, unknown> | undefined>;
	const presetId = stored.settings?.presetId ?? 'builtin.fast';
	const isUser = userPresets.some((p) => p.id === presetId);
	const [name, setName] = useState('');
	const set = (f: SettingField, value: unknown) =>
		report(
			c.configure(
				{ settings: { overrides: { [f.group]: { [f.key]: value } } }, mergeOverrides: true },
				t('Clean Up Settings'),
				`${f.group}.${f.key}`,
			),
		);
	return (
		<div
			className="max-h-[50%] shrink-0 overflow-auto border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small"
			data-testid="text.cleanup.settingsDrawer"
		>
			<div className="mb-1 flex flex-wrap items-center gap-1">
				<Button
					variant="quiet"
					disabled={!Object.keys(overrides).length}
					disabledReason={t('Nothing is edited')}
					onClick={() => report(c.configure({ settings: { presetId } }, t('Reset Clean Up Settings')))}
					data-testid="text.cleanup.settings.reset"
				>
					Reset to preset
				</Button>
				<TextField
					className="w-36"
					value={name}
					placeholder="Preset name"
					aria-label="Preset name"
					onChange={(e) => setName(e.currentTarget.value)}
					data-testid="text.cleanup.settings.presetName"
				/>
				<Button
					variant="quiet"
					disabled={!name.trim()}
					disabledReason={t('Name the preset first')}
					onClick={async () => {
						const r = await c.savePreset(name.trim());
						if (r.ok) {
							setName('');
							toast({ kind: 'success', title: t('Preset saved') });
						} else toast({ kind: 'warning', title: t('The preset was not saved'), detail: r.reason });
					}}
					data-testid="text.cleanup.settings.savePreset"
				>
					Save as Preset
				</Button>
				{isUser ? (
					<Button
						variant="quiet"
						onClick={async () => {
							if (!window.confirm(t('Delete this preset? Sequences that use it fall back to Fast.'))) return;
							const r = await c.deletePreset(presetId);
							if (!r.ok) toast({ kind: 'warning', title: t('The preset was not deleted'), detail: r.reason });
						}}
						data-testid="text.cleanup.settings.deletePreset"
					>
						Delete Preset
					</Button>
				) : null}
			</div>
			{GROUPS.map((g) => (
				<details key={g} open={g !== 'thresholds'} className="mb-1">
					<summary className="cursor-pointer font-semibold text-pr-text">{GROUP_LABELS[g]}</summary>
					<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-[2px] py-1">
						{SETTING_FIELDS.filter((f) => f.group === g).map((f) => (
							<FieldRow
								key={`${f.group}.${f.key}`}
								field={f}
								value={(settings[f.group] as Record<string, unknown>)[f.key]}
								edited={overrides[f.group]?.[f.key] !== undefined}
								onChange={(v) => set(f, v)}
							/>
						))}
					</div>
				</details>
			))}
			<ListsEditor session={session} seq={seq} />
		</div>
	);
}

function report(r: { ok: true } | { ok: false; reason: string }) {
	if (!r.ok) toast({ kind: 'warning', title: t('Clean Up Settings'), detail: r.reason });
}

function FieldRow(p: { field: SettingField; value: unknown; edited: boolean; onChange(v: unknown): void }) {
	const f = p.field;
	const id = `cleanup-setting-${f.group}-${f.key}`;
	const label = (
		<label htmlFor={id} className={`truncate ${p.edited ? 'text-pr-text' : 'text-pr-muted'}`} title={f.label}>
			{p.edited ? <span className="mr-1 text-pr-accent" title={t('Edited')}>•</span> : null}
			{f.label}
		</label>
	);
	if (f.type === 'choice')
		return (
			<>
				{label}
				<span data-testid={`text.cleanup.setting.${f.group}.${f.key}`}>
					<Select
						id={id}
						label={f.label}
						className="w-32"
						value={String(p.value)}
						onValueChange={(v) => p.onChange(v)}
						options={f.options.map((o) => ({ value: o, label: CHOICE_LABELS[o] ?? o }))}
					/>
				</span>
			</>
		);
	if (f.type === 'bool')
		return (
			<>
				{label}
				<Checkbox
					id={id}
					checked={p.value === true}
					onCheckedChange={(v) => p.onChange(v)}
					aria-label={f.label}
				/>
			</>
		);
	return (
		<>
			{label}
			<NumberCell field={f} id={id} value={typeof p.value === 'number' ? p.value : 0} onChange={p.onChange} />
		</>
	);
}

function NumberCell(p: {
	field: Extract<SettingField, { type: 'number' }>;
	id: string;
	value: number;
	onChange(v: number): void;
}) {
	const shown = showFieldValue(p.field, p.value);
	const [text, setText] = useState(shown);
	useEffect(() => setText(shown), [shown]);
	const parsed = parseFieldValue(p.field, text);
	const commit = () => {
		if (parsed === null) {
			setText(shown);
			toast({
				kind: 'info',
				title: t('{0}: between {1} and {2} {3}', p.field.label, p.field.min, p.field.max, p.field.unit),
			});
			return;
		}
		if (parsed !== p.value) p.onChange(parsed);
	};
	return (
		<span className="flex items-center gap-1">
			<TextField
				id={p.id}
				type="number"
				className="w-20"
				min={p.field.min}
				max={p.field.max}
				step={p.field.step}
				value={text}
				invalid={parsed === null}
				onChange={(e) => setText(e.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commit();
					} else if (e.key === 'Escape') setText(shown);
				}}
				data-testid={`text.cleanup.setting.${p.field.group}.${p.field.key}`}
			/>
			<span className="w-8 text-pr-muted">{p.field.unit}</span>
		</span>
	);
}

/** Per-language word lists (TC-011, TC-030): empty = the built-in list. */
function ListsEditor({ session, seq }: { session: EditorSession; seq: Sequence }) {
	const c = cleanupFor(session);
	const [lang, setLang] = useState<CleanupLanguage>('es');
	const stored = readSequenceCleanup(seq).lists?.[lang];
	const builtin = builtinLists(lang);
	const field = (key: 'fillers' | 'markers' | 'allow', label: string, help: string) => (
		<ListField
			key={`${lang}.${key}`}
			label={label}
			help={help}
			value={stored?.[key]}
			builtin={builtin[key]}
			testId={`text.cleanup.lists.${key}`}
			onChange={(list) => {
				const next = { ...(stored ?? {}) } as Record<string, string[] | undefined>;
				if (list) next[key] = list;
				else delete next[key];
				report(
					c.configure(
						{ lists: { [lang]: Object.keys(next).length ? next : null } },
						t('Clean Up Word Lists'),
						`lists.${lang}.${key}`,
					),
				);
			}}
		/>
	);
	return (
		<details className="mb-1">
			<summary className="cursor-pointer font-semibold text-pr-text">Word lists</summary>
			<div className="flex flex-col gap-1 py-1">
				<Select
					label="Language"
					className="w-32"
					value={lang}
					onValueChange={(v) => setLang(v as CleanupLanguage)}
					options={[
						{ value: 'es', label: 'Spanish' },
						{ value: 'en', label: 'English' },
					]}
				/>
				{field('fillers', t('Fillers'), t('Always cut when the rule removes fillers (single words)'))}
				{field('markers', t('Discourse markers'), t('Cut only when a phrase between pauses is made of them'))}
				{field('allow', t('Emphasis repeats'), t('Repeated on purpose, never a stutter (single words)'))}
			</div>
		</details>
	);
}

function ListField(p: {
	label: string;
	help: string;
	value: readonly string[] | undefined;
	builtin: readonly string[];
	testId: string;
	onChange(list: string[] | null): void;
}) {
	const shown = (p.value ?? p.builtin).join(', ');
	const [text, setText] = useState(shown);
	useEffect(() => setText(shown), [shown]);
	const commit = () => {
		const list = text
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.slice(0, 500)
			.map((s) => s.slice(0, 100));
		const same = list.join('\u0000') === p.builtin.join('\u0000');
		const was = (p.value ?? p.builtin).join('\u0000');
		if (list.join('\u0000') === was) return;
		p.onChange(same ? null : list);
	};
	return (
		<label className="flex flex-col gap-[2px]">
			<span className="text-pr-text">
				{p.label}
				{p.value ? <span className="ml-1 text-pr-accent">{t('(edited)')}</span> : null}
			</span>
			<TextField
				value={text}
				onChange={(e) => setText(e.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commit();
					}
				}}
				data-testid={p.testId}
			/>
			<span className="text-pr-muted">{p.help}</span>
			{p.value ? (
				<button
					type="button"
					className="self-start text-pr-muted underline hover:text-pr-text"
					onClick={() => p.onChange(null)}
				>
					Use the built-in list
				</button>
			) : null}
		</label>
	);
}

