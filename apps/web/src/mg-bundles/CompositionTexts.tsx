// Properties ▸ Composition ▸ Text (M3, wp-m3-mgtext, S08:MGU-006): one editor per text the composition exposes
// (S08:MGC-036) — a multi-line field that previews live while typing (one gesture → one History step "Edit Text
// «label»" on Enter / Ctrl+Enter / leaving the field; Esc reverts), the props that style it (font, weight, size,
// colour, alignment, italic, line height, tracking) when the composition exposes them, a character counter,
// static warnings (length, lines) and layout warnings measured in the bundle's own page (off frame, cut off,
// outside the safe area, wrapped lines; S08:MGC-037), plus "Edit on canvas" (S08:MGU-005).
import {
	type Command,
	type CompositionClip,
	type CompositionTextLayer,
	checkCompositionText,
	compositionSequenceFrames,
	getPropAt,
	type MgCompositionInfo,
	type MgTextMeasurement,
	measuredTextIssues,
	type PropertySpec,
	type Rational,
	type StyleLink,
	type TextIssue,
	type TextStyleRole,
	textLayerValue,
	textLength,
	unsetPropOverride,
	validateTextEdit,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import {
	AlignCenter,
	AlignJustify,
	AlignLeft,
	AlignRight,
	Info,
	PencilLine,
	TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { mediaKeyOf } from '../import/assets.ts';
import { CheckboxField, MiniButton, SelectField } from '../panels/properties/controls/fields.tsx';
import { ResetGlyph } from '../panels/properties/controls/glyphs.tsx';
import { createScrub } from '../panels/properties/lib/ops.ts';
import { bundleFontFamilies } from './bundle-fonts.ts';
import { PropEditor } from './CompositionSection.tsx';
import { onTextFieldFocusRequest, startCanvasTextEdit } from './text-edit.ts';
import { textMeasurer } from './text-measure.ts';

const MEASURE_DEBOUNCE_MS = 250;

type Measured = {
	state: 'idle' | 'measuring' | 'done' | 'failed';
	byId: Map<string, MgTextMeasurement>;
	fonts: string[];
};

/** Layout of the clip's texts in the bundle page (re-measured when props, size or frame rate change). */
function useTextMeasurements(
	clip: CompositionClip,
	info: MgCompositionInfo,
	bundleKey: string | null,
	effective: Record<string, unknown>,
	layers: readonly CompositionTextLayer[],
	seq: { width: number; height: number; rate: Rational } | null,
): Measured {
	const [state, setState] = useState<Measured>({ state: 'idle', byId: new Map(), fonts: [] });
	const canvas =
		clip.canvas === 'sequence' || !clip.canvas
			? { width: seq?.width ?? info.width, height: seq?.height ?? info.height }
			: clip.canvas;
	const key = JSON.stringify([bundleKey, info.id, effective, canvas, seq?.rate, layers.map((l) => l.key)]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` captures every input
	useEffect(() => {
		if (!bundleKey || !seq || layers.length === 0 || typeof document === 'undefined') return;
		let cancelled = false;
		const fps = seq.rate.num / seq.rate.den;
		const total = compositionSequenceFrames(info, seq.rate);
		const timer = setTimeout(() => {
			setState((s) => ({ ...s, state: 'measuring' }));
			// One page render per measuring frame.
			const groups = new Map<number, CompositionTextLayer[]>();
			for (const l of layers) {
				const f = Math.max(0, Math.min(total - 1, l.frame ?? Math.floor(total / 2)));
				groups.set(f, [...(groups.get(f) ?? []), l]);
			}
			void (async () => {
				const byId = new Map<string, MgTextMeasurement>();
				let fonts: string[] = [];
				try {
					for (const [frame, ls] of groups) {
						const r = await textMeasurer().measure({
							bundleKey,
							compositionId: info.id,
							props: effective,
							width: canvas.width,
							height: canvas.height,
							fps,
							durationInFrames: total,
							frame,
							items: ls.map((l) => ({ id: l.path.join('.'), text: textLayerValue(effective, l) })),
						});
						for (const m of r.measurements) byId.set(m.id, m);
						fonts = bundleFontFamilies(r.fonts);
					}
					if (!cancelled) setState({ state: 'done', byId, fonts });
				} catch {
					if (!cancelled) setState((s) => ({ ...s, state: 'failed' }));
				}
			})();
		}, MEASURE_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [key]);
	return state;
}

export function CompositionTexts(props: {
	session: EditorSession;
	clip: CompositionClip;
	info: MgCompositionInfo;
	layers: readonly CompositionTextLayer[];
	effective: Record<string, unknown>;
	seq: { width: number; height: number; rate: Rational } | null;
	disabled: boolean;
	onMessage(m: { kind: 'info' | 'error'; text: string } | null): void;
}) {
	const { session, clip, info, layers, effective } = props;
	const doc = session.getState().document;
	const bundleKey = mediaKeyOf(clip.composition.mediaId ? doc.media[clip.composition.mediaId] : null);
	const measured = useTextMeasurements(clip, info, bundleKey, effective, layers, props.seq);
	const canvas =
		clip.canvas === 'sequence' || !clip.canvas
			? { width: props.seq?.width ?? info.width, height: props.seq?.height ?? info.height }
			: clip.canvas;
	return (
		<div className="flex flex-col gap-2 pt-1" data-testid="composition-texts" data-measure={measured.state}>
			{layers.map((l) => (
				<TextLayerEditor
					key={l.key}
					session={session}
					clip={clip}
					info={info}
					layer={l}
					value={textLayerValue(effective, l)}
					effective={effective}
					measurement={measured.byId.get(l.path.join('.')) ?? null}
					canvas={canvas}
					fonts={measured.fonts}
					disabled={props.disabled}
					onMessage={props.onMessage}
				/>
			))}
		</div>
	);
}

function TextLayerEditor(props: {
	session: EditorSession;
	clip: CompositionClip;
	info: MgCompositionInfo;
	layer: CompositionTextLayer;
	value: string;
	effective: Record<string, unknown>;
	measurement: MgTextMeasurement | null;
	canvas: { width: number; height: number };
	fonts: readonly string[];
	disabled: boolean;
	onMessage(m: { kind: 'info' | 'error'; text: string } | null): void;
}) {
	const { session, clip, info, layer, value, disabled } = props;
	const [text, setText] = useState(value);
	const [focused, setFocused] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
	const scrub = useMemo(() => createScrub(session), [session]);
	const live = useRef<{ started: boolean; pending: string | null; raf: number | null; skipBlur: boolean }>({
		started: false,
		pending: null,
		raf: null,
		skipBlur: false,
	});
	const label = `Edit Text «${layer.label}»`;
	const testId = `text-${layer.path.join('.')}`;
	const cmd = (v: string) =>
		({ type: 'param.set', target: ['clip', clip.id, 'props', ...layer.path], value: v }) as Command;

	useEffect(() => {
		if (!focused) setText(value);
	}, [value, focused]);
	useEffect(
		() =>
			onTextFieldFocusRequest((r) => {
				if (r.clipId !== clip.id || r.path.join('.') !== layer.path.join('.')) return;
				ref.current?.scrollIntoView({ block: 'nearest' });
				ref.current?.focus();
			}),
		[clip.id, layer.path],
	);

	/** Problems with a value as typed: schema (errors) + the composition's soft limits. */
	const problems = (v: string): { errors: string[]; issues: TextIssue[] } => {
		const issues = checkCompositionText(layer, v);
		const schema = validateTextEdit(info, clip.props, [{ path: layer.path, value: v }]);
		const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
		if (!errors.length && schema.length) errors.push(`Not valid for this composition: ${schema[0]}`);
		return { errors, issues };
	};

	// Live preview while typing: the edit runs as a gesture (transient document → Program monitor), committed as
	// one History step when the field is left or applied.
	const flush = () => {
		const l = live.current;
		if (l.raf !== null) cancelAnimationFrame(l.raf);
		l.raf = null;
		if (l.pending === null) return;
		const v = l.pending;
		l.pending = null;
		if (!l.started) l.started = scrub.start(label);
		if (l.started) {
			const r = scrub.update([cmd(v)]);
			if (r && !r.ok) setError(r.errors.map((e) => e.message).join('; '));
		}
	};
	const onType = (v: string) => {
		setText(v);
		const { errors } = problems(v);
		setError(errors[0] ?? null);
		if (errors.length) return; // keep the last valid preview
		live.current.pending = v;
		if (live.current.raf === null) live.current.raf = requestAnimationFrame(flush);
	};
	const end = (apply: boolean) => {
		const l = live.current;
		if (l.raf !== null) cancelAnimationFrame(l.raf);
		l.raf = null;
		const started = l.started;
		l.started = false;
		l.pending = null;
		if (!apply) {
			if (started) scrub.end(true);
			setText(value);
			setError(null);
			return;
		}
		const { errors } = problems(text);
		if (errors.length) {
			if (started) scrub.end(true);
			setText(value);
			setError(null);
			props.onMessage({ kind: 'error', text: `Not applied — ${errors[0]}` });
			return;
		}
		if (started) {
			// Bring the gesture to the final text, then commit it as one step.
			scrub.update([cmd(text)]);
			const r = scrub.end(false);
			if (r && !r.ok) props.onMessage({ kind: 'error', text: r.errors.map((e) => e.message).join('; ') });
			else props.onMessage(null);
		} else if (text !== value) {
			const r = session.apply({ label, origin: 'user', commands: [cmd(text)] });
			if (!r.ok) props.onMessage({ kind: 'error', text: r.errors.map((e) => e.message).join('; ') });
			else props.onMessage(null);
		}
	};

	const n = textLength(text);
	// The design limit when the composition declares one (soft), else the schema's hard limit.
	const max = layer.maxChars ?? layer.maxLength;
	const overridden = getPropAt(clip.props, layer.path) !== undefined;
	const statics = checkCompositionText(layer, text).filter((i) => i.severity !== 'error');
	const measured =
		props.measurement && !focused ? measuredTextIssues(layer, props.measurement, props.canvas) : [];
	const issues = [...statics, ...measured.filter((i) => !statics.some((s) => s.code === i.code))];
	const cls =
		'w-full min-w-0 rounded-pr-control border bg-pr-field px-1 font-pr text-pr-ui text-pr-text hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus';
	const fieldProps = {
		ref,
		'aria-label': layer.label,
		disabled,
		spellCheck: true,
		value: text,
		onFocus: () => setFocused(true),
		onBlur: () => {
			setFocused(false);
			if (live.current.skipBlur) live.current.skipBlur = false;
			else end(true);
		},
		onChange: (e: { target: { value: string } }) => onType(e.target.value),
		'data-testid': testId,
		'data-text-path': layer.path.join('.'),
	};
	const rows = Math.min(8, Math.max(2, text.split('\n').length));
	return (
		<div className="flex flex-col gap-1 px-2" data-text-layer={layer.path.join('.')}>
			<div className="flex min-h-[18px] items-center gap-1">
				<span
					className={cx('min-w-0 flex-1 truncate text-pr-ui', overridden ? 'text-pr-text' : 'text-pr-muted')}
					title={layer.description ?? layer.key}
				>
					{layer.label}
				</span>
				<span
					className={cx(
						'pr-tabular text-pr-small',
						layer.maxLength !== undefined && n > layer.maxLength
							? 'text-pr-danger'
							: layer.maxChars !== undefined && n > layer.maxChars
								? 'text-pr-warning'
								: 'text-pr-dim',
					)}
					data-testid={`${testId}-count`}
					title={[
						layer.maxChars !== undefined ? `Designed for ${layer.maxChars} characters` : null,
						layer.maxLength !== undefined ? `at most ${layer.maxLength}` : null,
					]
						.filter(Boolean)
						.join(', ')}
				>
					{max !== undefined ? `${n}/${max}` : n}
				</span>
				<MiniButton
					label={`Edit ${layer.label} on canvas`}
					disabled={disabled}
					onClick={() => startCanvasTextEdit(session, clip.id, { path: layer.path })}
					data-testid={`${testId}-canvas`}
				>
					<PencilLine size={12} />
				</MiniButton>
				<MiniButton
					label={`Reset ${layer.label}`}
					disabled={disabled || !overridden}
					onClick={() => {
						const r = session.apply({
							label: `Reset ${layer.label}`,
							origin: 'user',
							commands: [
								{
									type: 'clip.update',
									clipId: clip.id,
									patch: { props: unsetPropOverride(clip.props, layer.path) },
								} as Command,
							],
						});
						if (!r.ok) props.onMessage({ kind: 'error', text: r.errors.map((e) => e.message).join('; ') });
					}}
					data-testid={`${testId}-reset`}
				>
					<ResetGlyph size={12} />
				</MiniButton>
			</div>
			{layer.multiline ? (
				<textarea
					{...fieldProps}
					rows={rows}
					className={cx(cls, 'resize-y py-1 leading-snug', error ? 'border-pr-danger' : 'border-transparent')}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							(e.target as HTMLTextAreaElement).blur();
						} else if (e.key === 'Escape') {
							e.preventDefault();
							end(false);
							live.current.skipBlur = true;
							(e.target as HTMLTextAreaElement).blur();
						}
					}}
				/>
			) : (
				<input
					{...fieldProps}
					className={cx(cls, 'h-[22px]', error ? 'border-pr-danger' : 'border-transparent')}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							(e.target as HTMLInputElement).blur();
						} else if (e.key === 'Escape') {
							e.preventDefault();
							end(false);
							live.current.skipBlur = true;
							(e.target as HTMLInputElement).blur();
						}
					}}
				/>
			)}
			{error ? (
				<p className="text-pr-small text-pr-danger" role="alert" data-testid={`${testId}-error`}>
					{error}
				</p>
			) : null}
			<StyleControls {...props} />
			{issues.length ? (
				<ul className="m-0 flex list-none flex-col gap-[2px] p-0" data-testid={`${testId}-issues`}>
					{issues.map((i) => (
						<li
							key={i.code + i.message}
							className={cx(
								'flex items-start gap-1 text-pr-small',
								i.severity === 'info' ? 'text-pr-muted' : 'text-pr-warning',
							)}
							data-code={i.code}
						>
							{i.severity === 'info' ? (
								<Info size={12} className="mt-[2px] shrink-0" />
							) : (
								<TriangleAlert size={12} className="mt-[2px] shrink-0" />
							)}
							<span>{i.message}</span>
						</li>
					))}
				</ul>
			) : null}
			{layer.hint ? <p className="text-pr-small text-pr-dim">{layer.hint}</p> : null}
		</div>
	);
}

// ---------------------------------------------------------------- style props of a text

const ROLE_LABEL: Record<TextStyleRole, string> = {
	fontFamily: 'Font',
	fontWeight: 'Weight',
	fontSize: 'Size',
	italic: 'Italic',
	color: 'Colour',
	align: 'Align',
	lineHeight: 'Leading',
	letterSpacing: 'Tracking',
};

const ALIGN_ICONS: Record<string, ReactNode> = {
	left: <AlignLeft size={13} />,
	start: <AlignLeft size={13} />,
	center: <AlignCenter size={13} />,
	centre: <AlignCenter size={13} />,
	middle: <AlignCenter size={13} />,
	right: <AlignRight size={13} />,
	end: <AlignRight size={13} />,
	justify: <AlignJustify size={13} />,
};

function StyleControls(props: {
	session: EditorSession;
	clip: CompositionClip;
	layer: CompositionTextLayer;
	effective: Record<string, unknown>;
	fonts: readonly string[];
	disabled: boolean;
	onMessage(m: { kind: 'info' | 'error'; text: string } | null): void;
}) {
	const { session, clip, layer, disabled } = props;
	const roles = (Object.keys(layer.style) as TextStyleRole[]).filter((r) => layer.style[r]);
	if (roles.length === 0) return null;
	const set = (link: StyleLink, v: unknown) => {
		const r = session.apply({
			label: `${layer.label} ${ROLE_LABEL[roleOf(layer, link)]}`,
			origin: 'user',
			commands: [
				{ type: 'param.set', target: ['clip', clip.id, 'props', ...link.path], value: v } as Command,
			],
		});
		props.onMessage(r.ok ? null : { kind: 'error', text: r.errors.map((e) => e.message).join('; ') });
	};
	return (
		<div
			className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-[3px]"
			data-testid={`text-${layer.path.join('.')}-style`}
		>
			{roles.map((role) => {
				const link = layer.style[role]!;
				const value = getPropAt(props.effective, link.path);
				return (
					<StyleRow key={role} label={ROLE_LABEL[role]} prop={link.key}>
						<StyleEditor
							session={session}
							clip={clip}
							role={role}
							spec={link.spec}
							value={value}
							fonts={props.fonts}
							disabled={disabled}
							onSet={(v) => set(link, v)}
						/>
					</StyleRow>
				);
			})}
		</div>
	);
}

function roleOf(layer: CompositionTextLayer, link: StyleLink): TextStyleRole {
	return (Object.keys(layer.style) as TextStyleRole[]).find((r) => layer.style[r] === link) ?? 'color';
}

function StyleRow(props: { label: string; prop: string; children: ReactNode }) {
	return (
		<>
			<span className="text-pr-small text-pr-muted" title={props.prop}>
				{props.label}
			</span>
			<div className="flex min-w-0 items-center gap-1" data-prop={props.prop}>
				{props.children}
			</div>
		</>
	);
}

function StyleEditor(props: {
	session: EditorSession;
	clip: CompositionClip;
	role: TextStyleRole;
	spec: PropertySpec;
	value: unknown;
	fonts: readonly string[];
	disabled: boolean;
	onSet(v: unknown): void;
}) {
	const { role, spec, value, disabled } = props;
	const testId = `prop-${spec.key}`;
	if (role === 'align') {
		const options = spec.options ?? ['left', 'center', 'right'];
		return (
			<div className="flex items-center gap-[2px]" role="radiogroup" aria-label={spec.label}>
				{options.map((o) => (
					<MiniButton
						key={o}
						label={`Align ${o}`}
						active={value === o}
						disabled={disabled}
						onClick={() => props.onSet(o)}
						data-testid={`${testId}-${o}`}
					>
						{ALIGN_ICONS[o.toLowerCase()] ?? <span className="text-pr-small">{o}</span>}
					</MiniButton>
				))}
			</div>
		);
	}
	if (role === 'fontFamily' && spec.kind !== 'enum' && props.fonts.length > 0) {
		// The bundle's own fonts render identically in every export; the current value stays selectable.
		const current = typeof value === 'string' ? value : '';
		const options = [...new Set([...(current ? [current] : []), ...props.fonts])];
		return (
			<SelectField
				value={current || null}
				options={options}
				label={spec.label}
				disabled={disabled}
				onChange={props.onSet}
				className="flex-1"
				data-testid={testId}
			/>
		);
	}
	if (role === 'fontWeight' && spec.kind === 'number') {
		const lo = spec.range?.min ?? 100;
		const hi = spec.range?.max ?? 900;
		const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900].filter((w) => w >= lo && w <= hi);
		if (weights.length > 1)
			return (
				<SelectField
					value={typeof value === 'number' ? value : null}
					options={[...new Set([...(typeof value === 'number' ? [value] : []), ...weights])].sort(
						(a, b) => a - b,
					)}
					label={spec.label}
					disabled={disabled}
					onChange={props.onSet}
					data-testid={testId}
				/>
			);
	}
	if (role === 'italic')
		return (
			<CheckboxField
				value={typeof value === 'boolean' ? value : null}
				label={spec.label}
				disabled={disabled}
				onChange={props.onSet}
			/>
		);
	return (
		<PropEditor
			session={props.session}
			clip={props.clip}
			spec={spec}
			value={value}
			disabled={disabled}
			onSet={props.onSet}
		/>
	);
}
