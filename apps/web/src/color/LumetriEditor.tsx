// The Lumetri editor (S06:CGU-001/002; color-grade completion): Basic Correction (Auto, Reset), Creative (look LUT or
// built-in look, Looks browser, adjustments, shadow/highlight tint), Curves (RGB and hue/saturation curves with
// eyedroppers), Color Wheels & Match (Comparison View, Face Detection, Apply Match), HSL Secondary (key with
// Set/Add/Remove Color, refine, 1-way/3-way correction) and Vignette, each section with Premiere's on/off checkbox.
// Edits one clip's first `jasper.lumetri` instance. Hosted by the Lumetri Color panel (every section; the instance is
// created by the first edit, one undo step) and by Effect Controls (only the graphical controls — curves, wheels,
// tints, correction wheels: the scalar params keep their generic rows and keyframe lanes there, `hideParams` =
// LUMETRI_EDITOR_PARAMS).
import {
	addColorToKey,
	type Clip,
	DEFAULT_SECONDARY_KEY,
	type EffectInstance,
	type EffectSpec,
	hueCurveEyedropper,
	keyFromColor,
	LUMETRI_EFFECT,
	LUMETRI_GROUPS,
	linearCurveEyedropper,
	luma709,
	type ProjectDocument,
	removeColorFromKey,
	rgbToHsl,
	type SecondaryKey,
	type Sequence,
	sequenceColorInfo,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { cx } from '@jasper/ui';
import { type ReactNode, useState } from 'react';
import { isHdrWorking } from '../color-mgmt/model.ts';
import { monitorExtras, setComparison } from '../panels/program/monitor-view.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { ResetGlyph } from '../panels/properties/controls/glyphs.tsx';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { Section } from '../panels/properties/controls/Section.tsx';
import { planReset, type Row } from '../panels/properties/lib/model.ts';
import type { InspectorOps } from '../panels/properties/lib/ops.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { browseForLut } from './actions.ts';
import { type CurveChannel, CurveField, type CurveKind } from './controls/CurveField.tsx';
import { LutPicker } from './controls/LutPicker.tsx';
import { SliderEditor } from './controls/SliderEditor.tsx';
import { WheelField } from './controls/WheelField.tsx';
import {
	applyLumetriValues,
	faceDetectionPref,
	runApplyMatch,
	runAutoTone,
	setFaceDetectionPref,
} from './grade/actions.ts';
import { eyedropper, useEyedropper } from './grade/eyedropper.ts';
import { LooksBrowser } from './grade/LooksBrowser.tsx';
import {
	curvePoints,
	curveValue,
	isIdentityPoints,
	isNeutralPoints,
	lumetriRow,
	NEUTRAL_POINTS,
} from './model.ts';
import { type RowWriteContext, useRowWriter } from './rowEdit.ts';

type LumetriEditorProps = {
	session: EditorSession;
	doc: ProjectDocument;
	seq: Sequence;
	clip: Clip;
	/** The edited instance; null = none yet (the first edit adds it). */
	fx: EffectInstance | null;
	effect?: EffectSpec;
	frame: number;
	ops: InspectorOps;
	host: 'effectControls' | 'properties' | 'panel';
	hint(message: string): void;
	confirmStopwatchOff(label: string, onConfirm: () => void): void;
};

const CURVES: { channel: CurveChannel; param: string; label: string }[] = [
	{ channel: 'master', param: 'curveMaster', label: 'Master' },
	{ channel: 'red', param: 'curveRed', label: 'Red' },
	{ channel: 'green', param: 'curveGreen', label: 'Green' },
	{ channel: 'blue', param: 'curveBlue', label: 'Blue' },
];

/** Hue / saturation curves: x axis, background, what the eyedropper reads. */
const HUE_CURVES: {
	param: string;
	label: string;
	kind: CurveKind;
	background: string;
	pick: 'hue' | 'luma' | 'sat';
}[] = [
	{ param: 'hueVsSat', label: 'Hue vs Sat', kind: 'hue', background: 'var(--pr-curve-hue)', pick: 'hue' },
	{ param: 'hueVsHue', label: 'Hue vs Hue', kind: 'hue', background: 'var(--pr-curve-hue)', pick: 'hue' },
	{ param: 'hueVsLuma', label: 'Hue vs Luma', kind: 'hue', background: 'var(--pr-curve-hue)', pick: 'hue' },
	{
		param: 'lumaVsSat',
		label: 'Luma vs Sat',
		kind: 'offset',
		background: 'var(--pr-curve-luma)',
		pick: 'luma',
	},
	{ param: 'satVsSat', label: 'Sat vs Sat', kind: 'offset', background: 'var(--pr-curve-sat)', pick: 'sat' },
];

const WHEELS = [
	{ wheel: 'shadowsWheel', level: 'shadowsLevel', title: 'Shadows' },
	{ wheel: 'midtonesWheel', level: 'midtonesLevel', title: 'Midtones' },
	{ wheel: 'highlightsWheel', level: 'highlightsLevel', title: 'Highlights' },
] as const;

const SEC_WHEELS = [
	{ wheel: 'secShadowsWheel', level: 'secShadowsLevel', title: 'Shadows' },
	{ wheel: 'secMidtonesWheel', level: 'secMidtonesLevel', title: 'Midtones' },
	{ wheel: 'secHighlightsWheel', level: 'secHighlightsLevel', title: 'Highlights' },
] as const;

/** Gradient tracks (design tokens) of sliders. */
const TRACKS: Record<string, string> = {
	temperature: 'var(--pr-slider-temperature)',
	tint: 'var(--pr-slider-tint)',
	saturation: 'var(--pr-slider-saturation)',
	creativeSaturation: 'var(--pr-slider-saturation)',
	secTemperature: 'var(--pr-slider-temperature)',
	secTint: 'var(--pr-slider-tint)',
	secSaturation: 'var(--pr-slider-saturation)',
	secHueCenter: 'var(--pr-slider-hue)',
	secLumaLow: 'var(--pr-slider-luma)',
	secLumaHigh: 'var(--pr-slider-luma)',
};

const BASIC = [
	'inputLut',
	'temperature',
	'tint',
	'exposure',
	'contrast',
	'highlights',
	'shadows',
	'whites',
	'blacks',
	'saturation',
];
const CREATIVE = [
	'look',
	'creativeLook',
	'lookIntensity',
	'fadedFilm',
	'sharpen',
	'vibrance',
	'creativeSaturation',
	'shadowTint',
	'highlightTint',
	'tintBalance',
];
const SECONDARY_KEY = Object.keys(DEFAULT_SECONDARY_KEY);
const SECONDARY = [
	...SECONDARY_KEY,
	'secShowMask',
	'secMaskStyle',
	'secInvert',
	'secDenoise',
	'secBlur',
	'secWheelMode',
	'secWheel',
	'secWheelLevel',
	...SEC_WHEELS.flatMap((w) => [w.wheel, w.level]),
	'secTemperature',
	'secTint',
	'secContrast',
	'secSharpen',
	'secSaturation',
];
const VIGNETTE = ['vignetteAmount', 'vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather'];

const sub = (text: string) => (
	<div className="px-2 pt-2 pb-[2px] text-pr-small font-semibold text-pr-muted uppercase">{text}</div>
);

export function LumetriEditor(props: LumetriEditorProps) {
	const { session, doc, seq, clip, fx, frame, ops } = props;
	const effect = props.effect ?? LUMETRI_EFFECT;
	const live = () => session.transport.getState().frame;
	const writeCtx: RowWriteContext = { ops, live, hint: props.hint };
	const rowCtx: RowContext = {
		doc,
		seq,
		frame,
		ops,
		transport: session.transport,
		mode: 'effectControls',
		hint: props.hint,
		confirmStopwatchOff: props.confirmStopwatchOff,
	};
	const row = (name: string) => lumetriRow(doc, seq, clip, fx, name, frame, effect);
	const value = (name: string) => row(name).bindings[0]?.resolved.value;
	const panel = props.host !== 'effectControls';
	const engine = useEngineOrNull()?.client ?? null;
	const readOnly = session.getState().readOnly;
	const [busy, setBusy] = useState<string | null>(null);

	const resetAction = (title: string, names: readonly string[]) => {
		const rows = names.map(row);
		return fx ? (
			<MiniButton
				label={`Reset ${title}`}
				onClick={() =>
					ops.apply(
						`Reset ${title}`,
						rows.flatMap((r) => planReset(r, doc, seq, live()).commands),
					)
				}
				data-testid={`lumetri-reset-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
			>
				<ResetGlyph size={12} />
			</MiniButton>
		) : null;
	};

	/** Premiere's on/off checkbox of a section (its params act as defaults when off), drawn before the caret. */
	const sectionToggle = (group: string, title: string): ReactNode => {
		const g = LUMETRI_GROUPS.find((x) => x.group === group);
		if (!g || !panel) return null;
		const on = value(g.toggle) !== false;
		return (
			<input
				type="checkbox"
				aria-label={`${title} on`}
				title={`${title} on/off`}
				checked={on}
				disabled={readOnly}
				onChange={(e) => {
					const err = applyLumetriValues(
						session,
						`${e.target.checked ? 'Enable' : 'Disable'} ${title}`,
						clip,
						fx,
						{ [g.toggle]: e.target.checked },
					);
					if (err) props.hint(err);
				}}
				className="size-[12px] accent-[var(--pr-text-primary)]"
				data-testid={`lumetri-section-${group}`}
			/>
		);
	};
	const sectionTitle = (group: string, title: string): ReactNode => {
		const g = LUMETRI_GROUPS.find((x) => x.group === group);
		const off = !!g && panel && value(g.toggle) === false;
		return off ? <span className="text-pr-muted">{title}</span> : title;
	};

	const sliderRow = (name: string) => {
		const r = row(name);
		return (
			<div key={name} data-lumetri-param={name}>
				<PropertyRow
					row={r}
					ctx={rowCtx}
					editor={
						<SliderEditor
							row={r}
							ctx={writeCtx}
							trackBackground={TRACKS[name]}
							data-testid={`lumetri-${name}`}
						/>
					}
				/>
			</div>
		);
	};
	/** A row with the generic editor (checkboxes, popups). */
	const plainRow = (name: string) => (
		<div key={name} data-lumetri-param={name} data-testid={`lumetri-${name}`}>
			<PropertyRow row={row(name)} ctx={rowCtx} />
		</div>
	);
	const lutRow = (name: string) => {
		const r = row(name);
		return (
			<div key={name} data-lumetri-param={name}>
				<PropertyRow row={r} ctx={rowCtx} editor={<LutRowPicker row={r} ctx={writeCtx} props={props} />} />
			</div>
		);
	};
	const wheel = (name: string, title: string, level?: string) => (
		<div key={name} className="min-w-[84px] flex-1" data-lumetri-param={name}>
			<WheelField
				row={row(name)}
				levelRow={level && panel ? row(level) : undefined}
				ctx={writeCtx}
				title={title}
				data-testid={`lumetri-${name}`}
			/>
		</div>
	);

	const run = async (
		what: string,
		fn: () => Promise<string | null | { error: string | null; note?: string }>,
	) => {
		setBusy(what);
		try {
			const r = await fn();
			const err = typeof r === 'string' ? r : r && 'error' in r ? r.error : null;
			if (err) props.hint(err);
			else if (r && typeof r === 'object' && 'note' in r && r.note) props.hint(r.note);
		} catch (e) {
			props.hint(`${what} failed: ${(e as Error).message}`);
		} finally {
			setBusy(null);
		}
	};

	const pickKey = (mode: 'set' | 'add' | 'remove') => {
		const id = `secondary-${mode}`;
		const label = mode === 'set' ? 'Set Color' : mode === 'add' ? 'Add Color' : 'Remove Color';
		eyedropper.toggle({
			id,
			label: `Click a colour in the Program monitor (${label})`,
			clipId: clip.id,
			onPick: (rgb) => {
				const cur = Object.fromEntries(SECONDARY_KEY.map((k) => [k, value(k)])) as SecondaryKey;
				const next =
					mode === 'set'
						? keyFromColor(rgb)
						: mode === 'add'
							? addColorToKey(cur, rgb)
							: removeColorFromKey(cur, rgb);
				const changed = Object.fromEntries(
					Object.entries(next).filter(
						([k, v]) => JSON.stringify(v) !== JSON.stringify(cur[k as keyof SecondaryKey]),
					),
				);
				if (!Object.keys(changed).length) return;
				const err = applyLumetriValues(session, `HSL Secondary: ${label}`, clip, fx, changed);
				if (err) props.hint(err);
			},
		});
	};
	// color-mgmt: HDR White / HDR Specular show in HDR working spaces (Premiere shows them for HDR sequences).
	const hdr = isHdrWorking(sequenceColorInfo(seq?.settings));
	const basicNames = hdr ? [BASIC[0]!, 'hdrWhite', 'hdrSpecular', ...BASIC.slice(1)] : BASIC;

	return (
		<div className="flex min-w-0 flex-col" data-testid={`lumetri-editor-${props.host}`}>
			{panel ? (
				<>
					<Section
						id="lumetri.basic"
						title={sectionTitle('basic', 'Basic Correction')}
						lead={sectionToggle('basic', 'Basic Correction')}
						actions={
							<>
								<button
									type="button"
									className="h-[18px] rounded-pr-control border border-pr-border px-2 text-pr-small text-pr-text hover:bg-pr-hover disabled:text-pr-dim"
									disabled={readOnly || !engine || busy !== null}
									title={engine ? 'Set the tone sliders from the clip (Auto)' : 'Auto needs the engine'}
									onClick={() => {
										if (engine) void run('Auto', () => runAutoTone(session, engine, clip, fx));
									}}
									data-testid="lumetri-auto"
								>
									{busy === 'Auto' ? 'Auto…' : 'Auto'}
								</button>
								{resetAction('Basic Correction', basicNames)}
							</>
						}
					>
						{lutRow('inputLut')}
						{hdr ? sliderRow('hdrWhite') : null}
						{sub('White Balance')}
						{sliderRow('temperature')}
						{sliderRow('tint')}
						{sub('Tone')}
						{sliderRow('exposure')}
						{sliderRow('contrast')}
						{sliderRow('highlights')}
						{sliderRow('shadows')}
						{sliderRow('whites')}
						{sliderRow('blacks')}
						{hdr ? sliderRow('hdrSpecular') : null}
						<div className="h-1" />
						{sliderRow('saturation')}
					</Section>
					<Section
						id="lumetri.creative"
						title={sectionTitle('creative', 'Creative')}
						lead={sectionToggle('creative', 'Creative')}
						actions={resetAction('Creative', CREATIVE)}
					>
						{lutRow('look')}
						{plainRow('creativeLook')}
						<LooksBrowser
							session={session}
							clip={clip}
							fx={fx}
							current={String(value('creativeLook') ?? 'none')}
							intensity={Number(value('lookIntensity') ?? 100)}
							disabled={readOnly}
							hint={props.hint}
						/>
						{sliderRow('lookIntensity')}
						{sub('Adjustments')}
						{sliderRow('fadedFilm')}
						{sliderRow('sharpen')}
						{sliderRow('vibrance')}
						{sliderRow('creativeSaturation')}
						<div className="flex flex-wrap justify-center gap-2 px-2 py-1">
							{wheel('shadowTint', 'Shadow Tint')}
							{wheel('highlightTint', 'Highlight Tint')}
						</div>
						{sliderRow('tintBalance')}
					</Section>
				</>
			) : (
				<Section id="lumetri.ec.tints" title="Shadow / Highlight Tint" variant="group">
					<div className="flex flex-wrap justify-center gap-2 px-2 py-1">
						{wheel('shadowTint', 'Shadow Tint')}
						{wheel('highlightTint', 'Highlight Tint')}
					</div>
				</Section>
			)}
			<Section
				id={panel ? 'lumetri.curves' : 'lumetri.ec.curves'}
				title={sectionTitle('curves', 'Curves')}
				lead={sectionToggle('curves', 'Curves')}
				variant={panel ? 'section' : 'group'}
				actions={resetAction('Curves', [...CURVES.map((c) => c.param), ...HUE_CURVES.map((c) => c.param)])}
			>
				{sub('RGB Curves')}
				<CurvesEditor row={row} ctx={writeCtx} />
				{sub('Hue Saturation Curves')}
				<HueCurvesEditor row={row} ctx={writeCtx} clipId={clip.id} />
			</Section>
			<Section
				id={panel ? 'lumetri.wheels' : 'lumetri.ec.wheels'}
				title={sectionTitle('wheels', panel ? 'Color Wheels & Match' : 'Color Wheels')}
				lead={sectionToggle('wheels', panel ? 'Color Wheels & Match' : 'Color Wheels')}
				variant={panel ? 'section' : 'group'}
				actions={resetAction(
					'Color Wheels',
					WHEELS.flatMap((w) => (panel ? [w.wheel, w.level] : [w.wheel])),
				)}
			>
				{panel ? (
					<MatchControls
						session={session}
						clip={clip}
						fx={fx}
						seq={seq}
						disabled={readOnly || !engine}
						busy={busy}
						onMatch={(reference, faces) => {
							if (engine)
								void run('Apply Match', () => runApplyMatch(session, engine, clip, fx, reference, faces));
						}}
					/>
				) : null}
				<div className="flex flex-wrap justify-center gap-2 px-2 py-1">
					{WHEELS.map((w) => wheel(w.wheel, w.title, w.level))}
				</div>
			</Section>
			{panel ? (
				<Section
					id="lumetri.secondary"
					title={sectionTitle('secondary', 'HSL Secondary')}
					lead={sectionToggle('secondary', 'HSL Secondary')}
					actions={resetAction('HSL Secondary', SECONDARY)}
					defaultOpen={false}
				>
					{sub('Key')}
					<SecondaryEyedroppers onPick={pickKey} disabled={readOnly} />
					{plainRow('secHueOn')}
					{sliderRow('secHueCenter')}
					{sliderRow('secHueRange')}
					{sliderRow('secHueSoft')}
					{plainRow('secSatOn')}
					{sliderRow('secSatLow')}
					{sliderRow('secSatHigh')}
					{sliderRow('secSatSoft')}
					{plainRow('secLumaOn')}
					{sliderRow('secLumaLow')}
					{sliderRow('secLumaHigh')}
					{sliderRow('secLumaSoft')}
					{plainRow('secShowMask')}
					{plainRow('secMaskStyle')}
					{plainRow('secInvert')}
					{sub('Refine')}
					{sliderRow('secDenoise')}
					{sliderRow('secBlur')}
					{sub('Correction')}
					{plainRow('secWheelMode')}
					<div className="flex flex-wrap justify-center gap-2 px-2 py-1">
						{value('secWheelMode') === 'three'
							? SEC_WHEELS.map((w) => wheel(w.wheel, w.title, w.level))
							: wheel('secWheel', 'Correction', 'secWheelLevel')}
					</div>
					{sliderRow('secTemperature')}
					{sliderRow('secTint')}
					{sliderRow('secContrast')}
					{sliderRow('secSharpen')}
					{sliderRow('secSaturation')}
				</Section>
			) : (
				<Section
					id="lumetri.ec.secondary"
					title="HSL Secondary Correction"
					variant="group"
					defaultOpen={false}
				>
					<div className="flex flex-wrap justify-center gap-2 px-2 py-1">
						{wheel('secWheel', '1-way')}
						{SEC_WHEELS.map((w) => wheel(w.wheel, w.title))}
					</div>
				</Section>
			)}
			{panel ? (
				<Section
					id="lumetri.vignette"
					title={sectionTitle('vignette', 'Vignette')}
					lead={sectionToggle('vignette', 'Vignette')}
					actions={resetAction('Vignette', VIGNETTE)}
					defaultOpen={false}
				>
					{VIGNETTE.map(sliderRow)}
				</Section>
			) : null}
		</div>
	);
}

function LutRowPicker({ row, ctx, props }: { row: Row; ctx: RowWriteContext; props: LumetriEditorProps }) {
	const writer = useRowWriter(row, ctx);
	return (
		<LutPicker
			doc={props.doc}
			value={row.bindings[0]?.resolved.value}
			label={row.label}
			onChange={(mediaId) => writer.commit({ mediaId })}
			onBrowse={() => browseForLut(props.session)}
			data-testid={`lumetri-${row.spec.key.split('.').pop()}`}
		/>
	);
}

const tabClass = (on: boolean) =>
	cx(
		'flex h-[20px] items-center gap-1 rounded-pr-control px-2 text-pr-small',
		on ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:bg-pr-hover',
	);

/** Master/R/G/B tabs over one curve editor; the other channels are drawn faintly behind. */
function CurvesEditor({ row, ctx }: { row: (name: string) => Row; ctx: RowWriteContext }) {
	const [tab, setTab] = useState<CurveChannel>('master');
	const current = CURVES.find((c) => c.channel === tab)!;
	const r = row(current.param);
	const writer = useRowWriter(r, ctx);
	const pts = curvePoints(r.bindings[0]?.resolved.value);
	const tabButton = (c: (typeof CURVES)[number]): ReactNode => {
		const edited = !isIdentityPoints(curvePoints(row(c.param).bindings[0]?.resolved.value));
		return (
			<button
				key={c.channel}
				type="button"
				role="tab"
				aria-selected={tab === c.channel}
				className={tabClass(tab === c.channel)}
				onClick={() => setTab(c.channel)}
				data-testid={`lumetri-curve-tab-${c.channel}`}
			>
				<span
					className="inline-block size-[8px] rounded-full"
					style={{ background: `var(--pr-curve-${c.channel})` }}
				/>
				{c.label}
				{edited ? <span className="text-pr-accent">•</span> : null}
			</button>
		);
	};
	return (
		<div className="flex flex-col items-center gap-1 px-2 py-1" data-lumetri-param={current.param}>
			<div className="flex w-full flex-wrap items-center gap-1" role="tablist" aria-label="Curve channel">
				{CURVES.map(tabButton)}
				<span className="flex-1" />
				<MiniButton
					label={`Reset ${current.label} curve`}
					disabled={isIdentityPoints(pts)}
					onClick={() =>
						writer.commit(
							curveValue([
								[0, 0],
								[1, 1],
							]),
						)
					}
					data-testid="lumetri-curve-reset"
				>
					<ResetGlyph size={12} />
				</MiniButton>
			</div>
			<CurveField
				row={r}
				ctx={ctx}
				channel={tab}
				ghosts={CURVES.filter((c) => c.channel !== tab).map((c) => ({
					channel: c.channel,
					value: row(c.param).bindings[0]?.resolved.value,
				}))}
				data-testid="lumetri-curve"
			/>
		</div>
	);
}

/** Hue vs Sat / Hue vs Hue / Hue vs Luma / Luma vs Sat / Sat vs Sat tabs, with an eyedropper and a reset. */
function HueCurvesEditor({
	row,
	ctx,
	clipId,
}: {
	row: (name: string) => Row;
	ctx: RowWriteContext;
	clipId: string;
}) {
	const [tab, setTab] = useState(HUE_CURVES[0]!.param);
	const armed = useEyedropper();
	const current = HUE_CURVES.find((c) => c.param === tab)!;
	const r = row(current.param);
	const writer = useRowWriter(r, ctx);
	const pts = curvePoints(r.bindings[0]?.resolved.value, NEUTRAL_POINTS);
	const pickId = `curve-${current.param}`;
	const pick = () =>
		eyedropper.toggle({
			id: pickId,
			label: `Click a colour for ${current.label}`,
			clipId,
			onPick: (rgb) => {
				const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2], [0, 0, 0]);
				const x =
					current.pick === 'hue'
						? hsl[0]
						: current.pick === 'luma'
							? luma709(rgb[0], rgb[1], rgb[2])
							: Math.max(...rgb) - Math.min(...rgb);
				const next = current.kind === 'hue' ? hueCurveEyedropper(pts, x) : linearCurveEyedropper(pts, x);
				writer.commit(curveValue(next.points));
			},
		});
	return (
		<div className="flex flex-col items-center gap-1 px-2 py-1" data-lumetri-param={current.param}>
			<div
				className="flex w-full flex-wrap items-center gap-1"
				role="tablist"
				aria-label="Hue saturation curve"
			>
				{HUE_CURVES.map((c) => {
					const edited = !isNeutralPoints(
						curvePoints(row(c.param).bindings[0]?.resolved.value, NEUTRAL_POINTS),
					);
					return (
						<button
							key={c.param}
							type="button"
							role="tab"
							aria-selected={tab === c.param}
							className={tabClass(tab === c.param)}
							onClick={() => setTab(c.param)}
							data-testid={`lumetri-hue-curve-tab-${c.param}`}
						>
							{c.label}
							{edited ? <span className="text-pr-accent">•</span> : null}
						</button>
					);
				})}
				<span className="flex-1" />
				<MiniButton
					label={`Eyedropper: add three points around a picked colour on ${current.label}`}
					active={armed?.id === pickId}
					onClick={pick}
					data-testid="lumetri-hue-curve-eyedropper"
				>
					<EyedropperGlyph />
				</MiniButton>
				<MiniButton
					label={`Reset ${current.label}`}
					disabled={isNeutralPoints(pts)}
					onClick={() => writer.commit(curveValue(NEUTRAL_POINTS))}
					data-testid="lumetri-hue-curve-reset"
				>
					<ResetGlyph size={12} />
				</MiniButton>
			</div>
			<CurveField
				row={r}
				ctx={ctx}
				kind={current.kind}
				background={current.background}
				data-testid="lumetri-hue-curve"
			/>
		</div>
	);
}

/** HSL Secondary ▸ Key eyedroppers: Set Color, Add Color (+), Remove Color (−). */
function SecondaryEyedroppers({
	onPick,
	disabled,
}: {
	onPick(mode: 'set' | 'add' | 'remove'): void;
	disabled: boolean;
}) {
	const armed = useEyedropper();
	const btn = (mode: 'set' | 'add' | 'remove', label: string, text: string) => (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={armed?.id === `secondary-${mode}`}
			disabled={disabled}
			className={cx(
				'inline-flex h-[20px] items-center gap-1 rounded-pr-control border px-2 text-pr-small',
				armed?.id === `secondary-${mode}`
					? 'border-pr-accent text-pr-accent'
					: 'border-pr-border text-pr-text hover:bg-pr-hover',
				'disabled:text-pr-dim',
			)}
			onClick={() => onPick(mode)}
			data-testid={`lumetri-secondary-${mode}`}
		>
			<EyedropperGlyph />
			{text}
		</button>
	);
	return (
		<div className="flex items-center gap-1 px-2 py-1">
			{btn('set', 'Set color: click the colour to select in the Program monitor', 'Set color')}
			{btn('add', 'Add color: widen the key to another colour', '+')}
			{btn('remove', 'Remove color: take a colour out of the key', '−')}
		</div>
	);
}

/** Color Wheels & Match: Comparison View, Face Detection, Apply Match (the reference is the comparison's). */
function MatchControls(props: {
	session: EditorSession;
	clip: Clip;
	fx: EffectInstance | null;
	seq: Sequence;
	disabled: boolean;
	busy: string | null;
	onMatch(reference: { sequenceId: string; frame: number }, faceDetection: boolean): void;
}) {
	const [faces, setFaces] = useState(faceDetectionPref);
	const comparison = useStoreSelector(monitorExtras, (s) => s.comparison);
	const reference = comparison.enabled ? comparison.reference : null;
	const canMatch = !props.disabled && !!reference && props.busy === null;
	return (
		<div className="flex flex-wrap items-center gap-2 px-2 py-1">
			<button
				type="button"
				aria-pressed={comparison.enabled}
				className={cx(
					'h-[20px] rounded-pr-control border px-2 text-pr-small',
					comparison.enabled
						? 'border-pr-accent text-pr-accent'
						: 'border-pr-border text-pr-text hover:bg-pr-hover',
				)}
				onClick={() =>
					setComparison(
						comparison.enabled
							? { enabled: false }
							: {
									enabled: true,
									reference: comparison.reference ?? {
										kind: 'sequence-frame',
										sequenceId: props.seq.id,
										frame: Math.max(0, props.clip.start - 1),
									},
								},
					)
				}
				data-testid="lumetri-comparison-view"
			>
				Comparison View
			</button>
			<label className="inline-flex cursor-pointer items-center gap-1 text-pr-small text-pr-text">
				<input
					type="checkbox"
					aria-label="Face Detection"
					checked={faces}
					onChange={(e) => {
						setFaces(e.target.checked);
						setFaceDetectionPref(e.target.checked);
					}}
					className="size-[12px] accent-[var(--pr-text-primary)]"
					data-testid="lumetri-face-detection"
				/>
				Face Detection
			</label>
			<span className="flex-1" />
			<button
				type="button"
				className="h-[20px] rounded-pr-control border border-pr-border px-2 text-pr-small text-pr-text hover:bg-pr-hover disabled:text-pr-dim"
				disabled={!canMatch}
				title={
					reference
						? `Match this clip to ${reference.sequenceId === props.seq.id ? '' : 'another sequence, '}frame ${reference.frame}`
						: 'Open the Comparison View and choose the reference frame'
				}
				onClick={() =>
					reference && props.onMatch({ sequenceId: reference.sequenceId, frame: reference.frame }, faces)
				}
				data-testid="lumetri-apply-match"
			>
				{props.busy === 'Apply Match' ? 'Matching…' : 'Apply Match'}
			</button>
		</div>
	);
}

function EyedropperGlyph() {
	return (
		<svg width={12} height={12} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
			<path
				d="M10.5 2.5l3 3-1.5 1.5-3-3z M9 4l3 3-6.5 6.5H2.5v-3z"
				strokeWidth={1.3}
				strokeLinejoin="round"
			/>
		</svg>
	);
}
