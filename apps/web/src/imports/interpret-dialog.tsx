// Interpret Footage (imports workstream, docs/wp-notes/imports.md): Premiere's Modify ▸ Interpret Footage with After
// Effects' loop and matte colour — Frame Rate, Pixel Aspect Ratio, Field Order, Alpha Channel and Loop. The dialog is
// made of sections registered in `INTERPRET_SECTIONS` (`registerInterpretSection`): each section edits its own part of
// a shared draft and contributes commands on OK, so another workstream adds a section (Colour) without touching this
// file. The built-in sections all write one `media.interpret` patch (one undo step for the whole dialog).
import {
	type CommandInput,
	fileFieldOrder,
	fileFrameRate,
	filePixelAspect,
	type InterpretationPatch,
	isPictureMedia,
	isTimedMedia,
	type MediaAsset,
	type MediaInterpretation,
	mediaDurationFlicks,
	type Rational,
	rationalFromFps,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Checkbox,
	ColorSwatch,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
} from '@jasper/ui';
import { type ReactNode, useMemo, useRef, useState } from 'react';

export const INTERPRET_FOOTAGE_DIALOG = 'imports.interpretFootage';

/** The dialog's working state: the `media.interpret` patch plus any section's own data (keyed by section id). */
export type InterpretDraft = { patch: InterpretationPatch; sections: Record<string, unknown> };

export type InterpretSectionProps = {
	assets: MediaAsset[];
	/** color-mgmt (additive): the editor session (a section may read the project's other items and the sequence). */
	session?: EditorSession;
	draft: InterpretDraft;
	setDraft(update: (d: InterpretDraft) => InterpretDraft): void;
};

export type InterpretSection = {
	id: string;
	title: string;
	/** Sort order (built-ins: 10 Frame Rate, 20 Pixel Aspect Ratio, 30 Field Order, 40 Alpha Channel, 50 Loop). */
	order: number;
	/** Whether the section applies to the selected media (hidden otherwise). */
	applies(assets: readonly MediaAsset[]): boolean;
	component(props: InterpretSectionProps): ReactNode;
	/** Commands of this section on OK (the built-ins return none: they write `draft.patch`). */
	commands?(assets: readonly MediaAsset[], draft: InterpretDraft): CommandInput[];
};

const SECTIONS: InterpretSection[] = [];

/** Adds a section to Interpret Footage (replaces one with the same id). Returns an unregister function. */
export function registerInterpretSection(section: InterpretSection): () => void {
	const i = SECTIONS.findIndex((s) => s.id === section.id);
	if (i >= 0) SECTIONS.splice(i, 1, section);
	else SECTIONS.push(section);
	SECTIONS.sort((a, b) => a.order - b.order);
	return () => {
		const j = SECTIONS.indexOf(section);
		if (j >= 0) SECTIONS.splice(j, 1);
	};
}

export function interpretSections(): readonly InterpretSection[] {
	return SECTIONS;
}

/** The common value of `f` over the assets, or `null` when they differ. */
function common<T>(assets: readonly MediaAsset[], f: (a: MediaAsset) => T): T | null {
	const vals = assets.map((a) => JSON.stringify(f(a)));
	return vals.every((v) => v === vals[0]) ? (f(assets[0]!) as T) : null;
}

const fpsText = (r: Rational | null) => (r ? `${(r.num / r.den).toFixed(r.den === 1 ? 0 : 3)} fps` : '—');

/** A frame rate typed by the user → a rational (NTSC rates as 1001 fractions). */
export function parseFps(text: string): Rational | null {
	return rationalFromFps(Number(text.replace(',', '.')));
}

/** Premiere's pixel aspect ratio menu. */
export const PIXEL_ASPECT_PRESETS: readonly { label: string; value: Rational }[] = [
	{ label: 'Square Pixels (1.0)', value: { num: 1, den: 1 } },
	{ label: 'D1/DV NTSC (0.9091)', value: { num: 10, den: 11 } },
	{ label: 'D1/DV NTSC Widescreen 16:9 (1.2121)', value: { num: 40, den: 33 } },
	{ label: 'D1/DV PAL (1.0940)', value: { num: 59, den: 54 } },
	{ label: 'D1/DV PAL Widescreen 16:9 (1.4587)', value: { num: 118, den: 81 } },
	{ label: 'Anamorphic 2:1 (2.0)', value: { num: 2, den: 1 } },
	{ label: 'HD Anamorphic 1080 (1.333)', value: { num: 4, den: 3 } },
	{ label: 'DVCPRO HD (1.5)', value: { num: 3, den: 2 } },
];
const parLabel = (r: Rational) =>
	PIXEL_ASPECT_PRESETS.find((p) => p.value.num * r.den === r.num * p.value.den)?.label ??
	`${(r.num / r.den).toFixed(4)}`;

const FIELD_LABELS: Record<'progressive' | 'upper' | 'lower', string> = {
	progressive: 'No Fields (Progressive Scan)',
	upper: 'Upper Field First',
	lower: 'Lower Field First',
};

function Radio(props: {
	name: string;
	checked: boolean;
	onChange(): void;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<label className="flex items-center gap-2 text-pr-ui text-pr-text">
			<input
				type="radio"
				name={props.name}
				checked={props.checked}
				onChange={props.onChange}
				data-testid={props.testId}
				className="accent-[var(--pr-accent)]"
			/>
			{props.children}
		</label>
	);
}

/** Effective value of a patch field: the patch's when set (null = file), else the asset's current interpretation. */
function current<K extends keyof MediaInterpretation>(
	assets: readonly MediaAsset[],
	draft: InterpretDraft,
	key: K,
): MediaInterpretation[K] | null | undefined {
	const p = (draft.patch as Record<string, unknown>)[key];
	if (p !== undefined) return p as MediaInterpretation[K] | null;
	return common(assets, (a) => a.interpretation?.[key] ?? null) as MediaInterpretation[K] | null | undefined;
}

const setPatch =
	(setDraft: InterpretSectionProps['setDraft']) => (key: keyof InterpretationPatch, value: unknown) =>
		setDraft((d) => ({ ...d, patch: { ...d.patch, [key]: value } }));

function FrameRateSection({ assets, draft, setDraft }: InterpretSectionProps) {
	const set = setPatch(setDraft);
	const own = common(assets, (a) => fileFrameRate(a));
	const assumed = current(assets, draft, 'frameRate') as Rational | null | undefined;
	const [text, setText] = useState(() =>
		assumed
			? String(+(assumed.num / assumed.den).toFixed(3))
			: own
				? String(+(own.num / own.den).toFixed(3))
				: '30',
	);
	const invalid = !!assumed && !parseFps(text);
	const duration =
		assets.length === 1
			? mediaDurationFlicks({
					...assets[0]!,
					interpretation: { ...assets[0]!.interpretation, frameRate: assumed ?? undefined },
				})
			: null;
	return (
		<div className="flex flex-col gap-1.5" data-testid="interpret-frame-rate">
			<Radio name="fr" checked={!assumed} onChange={() => set('frameRate', null)} testId="interpret-fr-file">
				Use Frame Rate from File: {own ? fpsText(own) : 'mixed'}
			</Radio>
			<div className="flex items-center gap-2">
				<Radio
					name="fr"
					checked={!!assumed}
					onChange={() => set('frameRate', parseFps(text) ?? own ?? { num: 30, den: 1 })}
					testId="interpret-fr-assume"
				>
					Assume this frame rate:
				</Radio>
				<TextField
					className="w-[90px]"
					value={text}
					invalid={invalid}
					disabled={!assumed}
					aria-label="Assumed frame rate"
					data-testid="interpret-fr-value"
					onChange={(e) => {
						setText(e.target.value);
						const r = parseFps(e.target.value);
						if (r) set('frameRate', r);
					}}
				/>
				<span className="text-pr-muted">fps</span>
			</div>
			{duration !== null ? (
				<span className="text-pr-small text-pr-muted">Duration: {(duration / 705_600_000).toFixed(3)} s</span>
			) : null}
		</div>
	);
}

function PixelAspectSection({ assets, draft, setDraft }: InterpretSectionProps) {
	const set = setPatch(setDraft);
	const own = common(assets, (a) => filePixelAspect(a));
	const conform = current(assets, draft, 'pixelAspect') as Rational | null | undefined;
	const options = PIXEL_ASPECT_PRESETS.map((p, i) => ({ value: String(i), label: p.label }));
	const idx = conform
		? PIXEL_ASPECT_PRESETS.findIndex((p) => p.value.num * conform.den === conform.num * p.value.den)
		: 0;
	return (
		<div className="flex flex-col gap-1.5" data-testid="interpret-pixel-aspect">
			<Radio
				name="par"
				checked={!conform}
				onChange={() => set('pixelAspect', null)}
				testId="interpret-par-file"
			>
				Use Pixel Aspect Ratio from File: {own ? parLabel(own) : 'mixed'}
			</Radio>
			<div className="flex items-center gap-2">
				<Radio
					name="par"
					checked={!!conform}
					onChange={() => set('pixelAspect', PIXEL_ASPECT_PRESETS[0]!.value)}
					testId="interpret-par-conform"
				>
					Conform to:
				</Radio>
				<Select
					value={String(Math.max(0, idx))}
					onValueChange={(v) => set('pixelAspect', PIXEL_ASPECT_PRESETS[Number(v)]!.value)}
					options={options}
					disabled={!conform}
					label="Pixel aspect ratio"
					className="w-[260px]"
				/>
			</div>
		</div>
	);
}

function FieldOrderSection({ assets, draft, setDraft }: InterpretSectionProps) {
	const set = setPatch(setDraft);
	const own = common(assets, (a) => fileFieldOrder(a));
	const conform = current(assets, draft, 'fieldOrder') as
		| 'progressive'
		| 'upper'
		| 'lower'
		| null
		| undefined;
	return (
		<div className="flex flex-col gap-1.5" data-testid="interpret-field-order">
			<Radio name="fo" checked={!conform} onChange={() => set('fieldOrder', null)} testId="interpret-fo-file">
				Use Field Order from File: {own ? FIELD_LABELS[own] : 'mixed'}
			</Radio>
			<div className="flex items-center gap-2">
				<Radio
					name="fo"
					checked={!!conform}
					onChange={() => set('fieldOrder', 'progressive')}
					testId="interpret-fo-conform"
				>
					Conform to:
				</Radio>
				<Select
					value={conform ?? 'progressive'}
					onValueChange={(v) => set('fieldOrder', v)}
					options={(['progressive', 'upper', 'lower'] as const).map((v) => ({
						value: v,
						label: FIELD_LABELS[v],
					}))}
					disabled={!conform}
					label="Field order"
					className="w-[260px]"
				/>
			</div>
			<span className="text-pr-small text-pr-muted">
				Interlaced pictures are deinterlaced in the progressive sequence.
			</span>
		</div>
	);
}

function AlphaSection({ assets, draft, setDraft }: InterpretSectionProps) {
	const set = setPatch(setDraft);
	const alpha = current(assets, draft, 'alpha') as MediaInterpretation['alpha'] | null | undefined;
	const mode = alpha?.mode ?? 'straight';
	const invert = !!alpha?.invert;
	const matte = alpha?.matte ?? [0, 0, 0, 1];
	const write = (next: {
		mode?: 'straight' | 'premultiplied' | 'ignore';
		invert?: boolean;
		matte?: [number, number, number, number];
	}) => {
		const m = next.mode ?? mode;
		const inv = next.invert ?? invert;
		const mt = next.matte ?? (matte as [number, number, number, number]);
		set(
			'alpha',
			m === 'straight' && !inv
				? null
				: { mode: m, invert: inv, ...(m === 'premultiplied' ? { matte: mt } : {}) },
		);
	};
	return (
		<div className="flex flex-col gap-1.5" data-testid="interpret-alpha">
			<Checkbox
				checked={mode === 'premultiplied'}
				onCheckedChange={(c) => write({ mode: c ? 'premultiplied' : 'straight' })}
				label="Premultiply Alpha"
				disabled={mode === 'ignore'}
			/>
			{mode === 'premultiplied' ? (
				<div className="flex items-center gap-2 pl-6">
					<span className="text-pr-muted">Matted with color</span>
					<ColorSwatch
						value={matte as [number, number, number, number]}
						alpha={false}
						onChange={(c) => write({ matte: [c[0], c[1], c[2], 1] })}
						label="Matte color"
					/>
				</div>
			) : null}
			<Checkbox
				checked={mode === 'ignore'}
				onCheckedChange={(c) => write({ mode: c ? 'ignore' : 'straight' })}
				label="Ignore Alpha Channel"
			/>
			<Checkbox checked={invert} onCheckedChange={(c) => write({ invert: c })} label="Invert Alpha Channel" />
		</div>
	);
}

function LoopSection({ assets, draft, setDraft }: InterpretSectionProps) {
	const set = setPatch(setDraft);
	const loop = (current(assets, draft, 'loop') as number | null | undefined) ?? 1;
	const [text, setText] = useState(String(loop));
	const n = Number(text);
	const invalid = !Number.isInteger(n) || n < 1 || n > 1000;
	return (
		<div className="flex items-center gap-2" data-testid="interpret-loop">
			<span className="text-pr-text">Loop</span>
			<TextField
				className="w-[70px]"
				value={text}
				invalid={invalid}
				aria-label="Loop count"
				data-testid="interpret-loop-value"
				onChange={(e) => {
					setText(e.target.value);
					const v = Number(e.target.value);
					if (Number.isInteger(v) && v >= 1 && v <= 1000) set('loop', v === 1 ? null : v);
				}}
			/>
			<span className="text-pr-muted">times</span>
		</div>
	);
}

registerInterpretSection({
	id: 'frameRate',
	title: 'Frame Rate',
	order: 10,
	applies: (a) => a.length > 0 && a.every((x) => isTimedMedia(x)),
	component: FrameRateSection,
});
registerInterpretSection({
	id: 'pixelAspect',
	title: 'Pixel Aspect Ratio',
	order: 20,
	applies: (a) => a.length > 0 && a.every((x) => isPictureMedia(x)),
	component: PixelAspectSection,
});
registerInterpretSection({
	id: 'fieldOrder',
	title: 'Field Order',
	order: 30,
	applies: (a) => a.length > 0 && a.every((x) => isTimedMedia(x)),
	component: FieldOrderSection,
});
registerInterpretSection({
	id: 'alpha',
	title: 'Alpha Channel',
	order: 40,
	applies: (a) => a.length > 0 && a.every((x) => isPictureMedia(x) && !x.vector && !x.lottie),
	component: AlphaSection,
});
registerInterpretSection({
	id: 'loop',
	title: 'Loop',
	order: 50,
	applies: (a) => a.length > 0 && a.every((x) => isTimedMedia(x) && (x.probe.durationFlicks ?? 0) > 0),
	component: LoopSection,
});

export type InterpretFootageProps = { session: EditorSession; mediaIds: string[] };

/** The commands OK applies: the built-in sections' `media.interpret` patch, then each section's own commands. */
export function interpretCommands(assets: readonly MediaAsset[], draft: InterpretDraft): CommandInput[] {
	const out: CommandInput[] = [];
	if (Object.keys(draft.patch).length)
		out.push({
			type: 'media.interpret',
			mediaIds: assets.map((a) => a.id),
			interpretation: draft.patch,
		} satisfies CommandInput);
	for (const s of SECTIONS) if (s.applies(assets) && s.commands) out.push(...s.commands(assets, draft));
	return out;
}

export function InterpretFootageDialog(props: HostedDialogProps<InterpretFootageProps>) {
	const { session, mediaIds } = props;
	const [open, setOpen] = useState(true);
	const assets = useMemo(
		() => mediaIds.map((id) => session.getCommitted().media[id]).filter((a): a is MediaAsset => !!a),
		[session, mediaIds],
	);
	const [draft, setDraft] = useState<InterpretDraft>({ patch: {}, sections: {} });
	const [error, setError] = useState<string | null>(null);
	const shown = SECTIONS.filter((s) => s.applies(assets));
	// One-shot: the Dialog also reports its closing after OK ran.
	const closed = useRef(false);
	const close = (r?: unknown) => {
		if (closed.current) return;
		closed.current = true;
		setOpen(false);
		props.close(r);
	};
	const name = assets.length === 1 ? assets[0]!.originalName : `${assets.length} items`;
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && close()}
			title={`Interpret Footage: ${name}`}
			size="medium"
			primaryLabel="OK"
			primaryDisabled={!assets.length}
			onPrimary={() => {
				const commands = interpretCommands(assets, draft);
				if (!commands.length) {
					close();
					return;
				}
				const r = session.apply({ label: 'Interpret Footage', origin: 'user', commands });
				if (!r.ok) {
					setError(r.errors[0]?.message ?? 'The interpretation was refused');
					return false;
				}
				close(r);
			}}
			data-testid="interpret-footage-dialog"
		>
			<div className="flex flex-col gap-4 text-pr-ui">
				{shown.length === 0 ? (
					<p className="text-pr-muted">There is nothing to interpret on this media.</p>
				) : null}
				{shown.map((s) => (
					<section key={s.id} className="flex flex-col gap-2" data-section={s.id}>
						<h3 className="font-semibold text-pr-strong">{s.title}</h3>
						<s.component assets={assets} session={session} draft={draft} setDraft={setDraft} />
					</section>
				))}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerInterpretDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(INTERPRET_FOOTAGE_DIALOG, InterpretFootageDialog);
}
