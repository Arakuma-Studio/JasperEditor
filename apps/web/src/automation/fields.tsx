// Shared fields of the automation dialogs (spec 15 EA-040): labelled rows, share sliders, number rows, track pickers
// and the SFX source choice, used by AutomationDialog.tsx and OverlayFields.tsx.
import { type Sequence, trackLabel } from '@jasper/project';
import { Checkbox, ScrubbyNumber, Slider } from '@jasper/ui';
import type { ReactNode } from 'react';
import { t } from '../i18n/runtime.ts';

const SOURCE_LABELS: Record<string, string> = {
	starter: 'Starter kit',
	pack: 'Sound packs',
	folder: 'Your folders',
	synth: 'Jasper Synth',
};
const SOURCES = ['starter', 'pack', 'folder', 'synth'] as const;

export type Params = Record<string, unknown>;

export const pct = (x: number) => `${Math.round(x * 100)} %`;

export function Row(p: { label: string; children: ReactNode; testId?: string }) {
	return (
		<div className="flex items-center gap-2" data-testid={p.testId}>
			<span className="w-[132px] shrink-0 text-pr-muted">{p.label}</span>
			<div className="flex min-w-0 flex-1 items-center gap-2">{p.children}</div>
		</div>
	);
}

export function ShareSlider(p: {
	label: string;
	value: number;
	defaultValue: number;
	onChange(v: number): void;
	testId?: string;
	max?: number;
}) {
	return (
		<Row label={p.label} testId={p.testId}>
			<Slider
				className="min-w-0 flex-1"
				label={p.label}
				valueText={pct(p.value)}
				value={Math.round(p.value * 100)}
				min={0}
				max={(p.max ?? 1) * 100}
				step={1}
				defaultValue={Math.round(p.defaultValue * 100)}
				onChange={(v) => p.onChange(v / 100)}
			/>
			<span className="w-[48px] shrink-0 text-right text-pr-small pr-tabular">{pct(p.value)}</span>
		</Row>
	);
}

export function NumberRow(p: {
	label: string;
	value: number;
	min: number;
	max: number;
	precision?: number;
	unit?: string;
	onCommit(v: number): void;
	testId?: string;
}) {
	return (
		<Row label={p.label} testId={p.testId}>
			<ScrubbyNumber
				label={p.label}
				value={p.value}
				min={p.min}
				max={p.max}
				precision={p.precision ?? 0}
				{...(p.unit ? { unit: p.unit } : {})}
				onCommit={p.onCommit}
				onScrubEnd={(v) => p.onCommit(v)}
			/>
		</Row>
	);
}

export function trackOptions(seq: Sequence, automatic: string) {
	return [
		{ value: 'auto', label: automatic },
		...seq.videoTracks.map((tr) => {
			const lb = trackLabel(seq, tr.id) ?? tr.id;
			return { value: lb, label: tr.name ? `${lb} · ${tr.name}` : lb };
		}),
	];
}

export const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
export const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

/** The sound fields shared by Decorate Cuts and punch-ins. */
export function SfxFields(p: { value: Params | undefined; label: string; onChange(v: Params): void }) {
	const v = p.value ?? {};
	const on = bool(v.enabled, true);
	const sources = new Set<string>(Array.isArray(v.sources) ? (v.sources as string[]) : SOURCES);
	return (
		<fieldset className="flex flex-col gap-1" data-testid="automation-sfx">
			<legend className="mb-1 text-pr-muted">{t('Sound')}</legend>
			<Checkbox checked={on} onCheckedChange={(c) => p.onChange({ ...v, enabled: c })} label={p.label} />
			<div className="flex flex-wrap items-center gap-3 pl-6">
				{SOURCES.map((s) => (
					<Checkbox
						key={s}
						disabled={!on}
						checked={sources.has(s)}
						onCheckedChange={(c) => {
							const next = new Set(sources);
							if (c) next.add(s);
							else next.delete(s);
							const list = SOURCES.filter((x) => next.has(x));
							const { sources: _drop, ...rest } = v;
							p.onChange(list.length === SOURCES.length || !list.length ? rest : { ...rest, sources: list });
						}}
						label={SOURCE_LABELS[s]}
					/>
				))}
			</div>
		</fieldset>
	);
}
