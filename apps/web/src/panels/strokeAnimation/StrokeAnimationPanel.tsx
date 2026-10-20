// Stroke Animation panel (docs/wp-notes/shapes.md § "Stroke Animation panel"): one-click Trim Paths animations for
// the selected shape clips — Draw (In, Out, In & Out), Middle (Grow, Shrink), Divide (In, Out) — the path
// utilities (Reverse Path Direction, Add Horizontal / Vertical Line) and tracers (a marker following the moving tip).
// Every button runs a UI command (the same as Graphics ▸ Stroke Animation and the palette); Alt-click reverses,
// Shift-click animates the offset, Alt+Shift both — the Reverse / Animate offset checkboxes are the persistent
// version. Settings (duration, offset, copies, lag, start, curve, visible buttons) are per-user preferences.
import type { EngineClient } from '@jasper/engine-client';
import { type CubicEase, easeCurveSegments, formatTimecode } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState, useTransportFrame } from '@jasper/session/react';
import {
	Checkbox,
	cx,
	EmptyState,
	Icon,
	ScrubbyNumber,
	Select,
	TextField,
	TimecodeText,
	Tooltip,
	toast,
} from '@jasper/ui';
import {
	type MouseEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createCommandContext } from '../../commands/context.ts';
import { runCommand } from '../../commands/registry.ts';
import { useVectorUi } from '../../shapes/vector.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import {
	animationStart,
	effectiveFlags,
	formatCubic,
	lineTarget,
	parseCubic,
	STROKE_ACTIONS,
	STROKE_BUTTON_LABELS,
	STROKE_DESCRIPTIONS,
	STROKE_GROUP_TITLES,
	STROKE_GROUPS,
	STROKE_HINTS,
	STROKE_MENU_LABELS,
	type StrokeAction,
	shapeTargets,
	tracerTarget,
} from '../../stroke-animation/model.ts';
import {
	STROKE_BUTTON_IDS,
	STROKE_LIMITS,
	type StrokePrefs,
	strokePrefs,
	useStrokePrefs,
} from '../../stroke-animation/prefs.ts';
import type { PanelProps } from '../types.ts';

/** A named cubic curve offered by the curve picker. */
export type StrokeCurvePreset = { id: string; name: string; curve: CubicEase };

/** Below this width the buttons show their glyph only (the tooltip keeps the name). */
const NARROW_PX = 240;

const START_LABELS: Record<StrokePrefs['startAt'], string> = {
	playhead: 'Playhead (inside the clip)',
	clipStart: 'Clip start',
};
const TIP_LABELS: Record<StrokePrefs['tracerTip'], string> = {
	auto: 'Moving tip',
	start: 'Start',
	end: 'End',
};
const CURVE_DEFAULT = '__default';
const CURVE_CUSTOM = '__custom';

export function StrokeAnimationPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	if (!session)
		return <EmptyState icon="panel.strokeAnimation" message="Open a project to animate strokes" />;
	return <StrokeAnimationBody session={session} curvePresets={[]} />;
}

/** Alt / Shift held right now (they preview the click's Reverse / Animate offset). */
function useModifiers(): { alt: boolean; shift: boolean } {
	const [mods, setMods] = useState({ alt: false, shift: false });
	useEffect(() => {
		const update = (e: KeyboardEvent) =>
			setMods((m) =>
				m.alt === e.altKey && m.shift === e.shiftKey ? m : { alt: e.altKey, shift: e.shiftKey },
			);
		const reset = () => setMods({ alt: false, shift: false });
		window.addEventListener('keydown', update);
		window.addEventListener('keyup', update);
		window.addEventListener('blur', reset);
		return () => {
			window.removeEventListener('keydown', update);
			window.removeEventListener('keyup', update);
			window.removeEventListener('blur', reset);
		};
	}, []);
	return mods;
}

function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
	const [narrow, setNarrow] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			const w = el.getBoundingClientRect().width;
			setNarrow(w > 0 && w < NARROW_PX);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return narrow;
}

export function StrokeAnimationBody({
	session,
	curvePresets,
}: {
	session: EditorSession;
	curvePresets: readonly StrokeCurvePreset[];
}) {
	const prefs = useStrokePrefs();
	const runtime = useShellRuntimeOrNull();
	const mods = useModifiers();
	const rootRef = useRef<HTMLDivElement>(null);
	const narrow = useNarrow(rootRef);
	const selectedItem = useVectorUi((s) => s.selected);
	const { frame } = useTransportFrame();
	const shape = useSessionState((s) => {
		const t = shapeTargets(s);
		return t.ok ? { reason: null, count: t.clips.length, first: t.clips[0] ?? null } : { reason: t.reason };
	}, sameTargets);
	const lineReason = useSessionState((s) => lineTarget(s));
	const tracer = useSessionState((s) => {
		const t = tracerTarget(s, selectedItem);
		return t.ok ? null : t.reason;
	});
	const seqSettings = useSessionState((s) => {
		const id = s.activeSequenceId;
		return id ? ((s.transient ?? s.document).sequences[id]?.settings ?? null) : null;
	});

	const fallbackCtx = useMemo(
		() =>
			createCommandContext({
				// The Stroke Animation commands use the session and notifications only.
				engine: {} as EngineClient,
				session,
				toast: (r) => toast({ kind: r.kind, title: r.message, detail: r.detail }),
			}),
		[session],
	);
	const run = (command: string, args?: unknown) => {
		if (runtime) void runtime.run(command, args);
		else void runCommand(command, fallbackCtx, args);
	};

	const reasonOf = (a: StrokeAction): string | null => {
		if (a.style || a.id === 'reversePath') return shape.reason ?? null;
		if (a.id === 'addHorizontalLine' || a.id === 'addVerticalLine') return lineReason;
		if (a.id === 'addTracer') return tracer;
		return null;
	};

	const onAction = (a: StrokeAction, e: MouseEvent) => {
		if (reasonOf(a)) return;
		if (a.style) run(a.command, effectiveFlags(prefs, { alt: e.altKey, shift: e.shiftKey }));
		else run(a.command);
	};

	const preview = effectiveFlags(prefs, mods);
	const visible = STROKE_ACTIONS.filter((a) => !prefs.hidden.includes(a.id));
	const startInfo =
		shape.reason === null && shape.first
			? animationStart(shape.first, frame, prefs.startAt) !== undefined
				? STROKE_HINTS.startPlayhead
				: STROKE_HINTS.startClip
			: null;

	return (
		<div
			ref={rootRef}
			className="flex h-full min-h-0 flex-col overflow-y-auto px-2 py-2 text-pr-small text-pr-text"
			data-testid="stroke-animation-panel"
		>
			{STROKE_GROUPS.map((g) => {
				const actions = visible.filter((a) => a.group === g);
				if (!actions.length) return null;
				return (
					<section key={g} className="mb-2" aria-label={STROKE_GROUP_TITLES[g]}>
						<h3 className="mb-1 font-semibold text-pr-muted">{STROKE_GROUP_TITLES[g]}</h3>
						<div
							className="grid gap-1"
							style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 32 : 88}px, 1fr))` }}
						>
							{actions.map((a) => (
								<ActionButton
									key={a.id}
									action={a}
									narrow={narrow}
									reason={reasonOf(a)}
									pressed={a.id === 'tracerNext' ? prefs.addTracer : undefined}
									onClick={(e) => onAction(a, e)}
								/>
							))}
						</div>
					</section>
				);
			})}

			<div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
				<Checkbox
					checked={preview.reverse}
					onCheckedChange={(c) => strokePrefs.set({ reverse: mods.alt ? !c : c })}
					label={mods.alt ? 'Reverse (Alt)' : 'Reverse'}
				/>
				<Checkbox
					checked={preview.animateOffset}
					onCheckedChange={(c) => strokePrefs.set({ animateOffset: mods.shift ? !c : c })}
					label={mods.shift ? 'Animate offset (Shift)' : 'Animate offset'}
				/>
			</div>
			<p className="mt-1 text-pr-dim" data-testid="stroke-info">
				{shape.reason ??
					(shape.count === 1
						? `1 shape clip selected · ${startInfo ?? ''}`
						: `${shape.count} shape clips selected · ${startInfo ?? ''}`)}
			</p>
			<p className="text-pr-dim">{STROKE_HINTS.modifiers}</p>

			<Settings
				prefs={prefs}
				curvePresets={curvePresets}
				durationTimecode={
					seqSettings
						? formatTimecode(prefs.durationFrames, seqSettings.frameRate, {
								dropFrame: seqSettings.dropFrame,
							})
						: null
				}
			/>
		</div>
	);
}

function sameTargets(
	a: { reason: string | null; count?: number; first?: unknown },
	b: { reason: string | null; count?: number; first?: unknown },
): boolean {
	return a.reason === b.reason && a.count === b.count && a.first === b.first;
}

function ActionButton({
	action,
	narrow,
	reason,
	pressed,
	onClick,
}: {
	action: StrokeAction;
	narrow: boolean;
	reason: string | null;
	pressed: boolean | undefined;
	onClick(e: MouseEvent): void;
}) {
	const label = STROKE_BUTTON_LABELS[action.id];
	const detail = reason
		? reason
		: action.style
			? `${STROKE_DESCRIPTIONS[action.id]} ${STROKE_HINTS.modifiers}.`
			: STROKE_DESCRIPTIONS[action.id];
	return (
		<Tooltip content={STROKE_MENU_LABELS[action.id]} detail={detail}>
			<button
				type="button"
				aria-label={STROKE_MENU_LABELS[action.id]}
				aria-disabled={reason ? true : undefined}
				aria-pressed={pressed}
				data-testid={`stroke-btn-${action.id}`}
				className={cx(
					'flex min-w-0 items-center justify-center gap-1 rounded-pr-control border border-pr-border-subtle text-pr-text',
					narrow ? 'h-8 px-0' : 'h-12 flex-col px-1',
					pressed ? 'bg-pr-selected' : 'bg-pr-field hover:bg-pr-hover',
					reason ? 'cursor-default opacity-40 hover:bg-pr-field' : undefined,
				)}
				onClick={(e) => {
					if (reason) {
						e.preventDefault();
						return;
					}
					onClick(e);
				}}
			>
				<Icon id={action.icon} size={20} className="shrink-0" />
				{narrow ? null : <span className="max-w-full truncate text-pr-small">{label}</span>}
			</button>
		</Tooltip>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-h-[var(--pr-row-h)] items-center gap-2">
			<span className="w-[92px] shrink-0 text-pr-muted">{label}</span>
			<div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
		</div>
	);
}

function Settings({
	prefs,
	curvePresets,
	durationTimecode,
}: {
	prefs: StrokePrefs;
	curvePresets: readonly StrokeCurvePreset[];
	durationTimecode: string | null;
}) {
	const open = prefs.settingsOpen;
	return (
		<section className="mt-2 border-t border-pr-border-subtle pt-1" data-testid="stroke-settings">
			<button
				type="button"
				className="flex h-6 w-full items-center gap-1 font-semibold text-pr-muted hover:text-pr-text"
				aria-expanded={open}
				onClick={() => strokePrefs.set({ settingsOpen: !open })}
			>
				<Icon id={open ? 'app.chevronDown' : 'app.chevronRight'} size={12} />
				Settings
			</button>
			{open ? (
				<div className="flex flex-col gap-0.5 pl-1">
					<Field label="Duration">
						<ScrubbyNumber
							label="Duration"
							value={prefs.durationFrames}
							min={STROKE_LIMITS.durationFrames.min}
							max={STROKE_LIMITS.durationFrames.max}
							unit="fr"
							onScrub={(v) => strokePrefs.set({ durationFrames: v })}
							onScrubEnd={(v) => strokePrefs.set({ durationFrames: v })}
							onCommit={(v) => strokePrefs.set({ durationFrames: v })}
						/>
						{durationTimecode ? (
							<TimecodeText value={durationTimecode} tone="muted" data-testid="stroke-duration-tc" />
						) : null}
					</Field>
					<Field label="Offset">
						<ScrubbyNumber
							label="Offset"
							value={prefs.offsetDegrees}
							min={STROKE_LIMITS.offsetDegrees.min}
							max={STROKE_LIMITS.offsetDegrees.max}
							unit="°"
							onScrub={(v) => strokePrefs.set({ offsetDegrees: v })}
							onScrubEnd={(v) => strokePrefs.set({ offsetDegrees: v })}
							onCommit={(v) => strokePrefs.set({ offsetDegrees: v })}
						/>
						<span className="text-pr-dim">with Animate offset</span>
					</Field>
					<Field label="Copies">
						<ScrubbyNumber
							label="Copies"
							value={prefs.copies}
							min={STROKE_LIMITS.copies.min}
							max={STROKE_LIMITS.copies.max}
							onScrub={(v) => strokePrefs.set({ copies: v })}
							onScrubEnd={(v) => strokePrefs.set({ copies: v })}
							onCommit={(v) => strokePrefs.set({ copies: v })}
						/>
						<span className="text-pr-dim">Divide</span>
					</Field>
					<Field label="In-out lag">
						<ScrubbyNumber
							label="In-out lag"
							value={Math.round(prefs.inOutLag * 100)}
							min={0}
							max={100}
							unit="%"
							onScrub={(v) => strokePrefs.set({ inOutLag: v / 100 })}
							onScrubEnd={(v) => strokePrefs.set({ inOutLag: v / 100 })}
							onCommit={(v) => strokePrefs.set({ inOutLag: v / 100 })}
						/>
						<span className="text-pr-dim">In &amp; Out</span>
					</Field>
					<Field label="Start at">
						<Select
							label="Start at"
							value={prefs.startAt}
							onValueChange={(v) => strokePrefs.set({ startAt: v as StrokePrefs['startAt'] })}
							options={START_OPTIONS()}
							className="min-w-0 flex-1"
						/>
					</Field>
					<CurveField prefs={prefs} presets={curvePresets} />
					<Field label="Tracer">
						<Select
							label="Tracer follows"
							value={prefs.tracerTip}
							onValueChange={(v) => strokePrefs.set({ tracerTip: v as StrokePrefs['tracerTip'] })}
							options={TIP_OPTIONS()}
							className="min-w-0 flex-1"
						/>
					</Field>
					<div className="pl-[100px]">
						<Checkbox
							checked={prefs.tracerOrient}
							onCheckedChange={(c) => strokePrefs.set({ tracerOrient: c })}
							label="Follower turns with the path"
						/>
					</div>
					<div className="mt-1 text-pr-muted">Buttons</div>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-2 gap-y-0.5 pl-1">
						{STROKE_BUTTON_IDS.map((id) => (
							<Checkbox
								key={id}
								checked={!prefs.hidden.includes(id)}
								onCheckedChange={(c) =>
									strokePrefs.set({
										hidden: c ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id],
									})
								}
								label={STROKE_MENU_LABELS[id]}
							/>
						))}
					</div>
				</div>
			) : null}
		</section>
	);
}

const START_OPTIONS = () =>
	(['playhead', 'clipStart'] as const).map((v) => ({ value: v, label: START_LABELS[v] }));
const TIP_OPTIONS = () =>
	(['auto', 'start', 'end'] as const).map((v) => ({ value: v, label: TIP_LABELS[v] }));

function CurveField({ prefs, presets }: { prefs: StrokePrefs; presets: readonly StrokeCurvePreset[] }) {
	const preset = prefs.curvePresetId ? presets.find((p) => p.id === prefs.curvePresetId) : undefined;
	const choice = !prefs.curve ? CURVE_DEFAULT : preset ? preset.id : CURVE_CUSTOM;
	const [text, setText] = useState(prefs.curve ? formatCubic(prefs.curve) : '');
	const [invalid, setInvalid] = useState(false);
	useEffect(() => {
		setText(prefs.curve ? formatCubic(prefs.curve) : '');
		setInvalid(false);
	}, [prefs.curve]);
	const options = useMemo(
		() => [
			{ value: CURVE_DEFAULT, label: CURVE_LABELS.default },
			...presets.map((p) => ({ value: p.id, label: p.name })),
			{ value: CURVE_CUSTOM, label: CURVE_LABELS.custom },
		],
		[presets],
	);
	const commitText = () => {
		const c = parseCubic(text);
		if (!c) {
			setInvalid(text.trim() !== '');
			if (text.trim() === '') strokePrefs.set({ curve: null, curvePresetId: null });
			return;
		}
		setInvalid(false);
		strokePrefs.set({ curve: c, curvePresetId: null });
	};
	return (
		<>
			<Field label="Curve">
				<Select
					label="Curve"
					value={choice}
					onValueChange={(v) => {
						if (v === CURVE_DEFAULT) strokePrefs.set({ curve: null, curvePresetId: null });
						else if (v === CURVE_CUSTOM)
							strokePrefs.set({
								curve: prefs.curve ?? { kind: 'cubic', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
								curvePresetId: null,
							});
						else {
							const p = presets.find((x) => x.id === v);
							if (p) strokePrefs.set({ curve: p.curve, curvePresetId: p.id });
						}
					}}
					options={options}
					className="min-w-0 flex-1"
				/>
				{prefs.curve ? <CurvePreview curve={prefs.curve} /> : null}
			</Field>
			{prefs.curve ? (
				<Field label="">
					<TextField
						value={text}
						invalid={invalid}
						aria-label="Cubic curve (x1, y1, x2, y2)"
						placeholder="x1, y1, x2, y2"
						data-testid="stroke-curve-text"
						className="min-w-0 flex-1"
						onChange={(e) => setText(e.target.value)}
						onBlur={commitText}
						onKeyDown={(e) => {
							if (e.key === 'Enter') commitText();
						}}
					/>
				</Field>
			) : null}
			{invalid ? (
				<p className="pl-[100px] text-pr-danger" role="alert">
					Enter four numbers: x1 and x2 from 0 to 1, y1 and y2 from −10 to 10
				</p>
			) : null}
		</>
	);
}

const CURVE_LABELS = { default: 'Default', custom: 'Custom cubic' };

/** The curve on a small graph: time to the right, progress up. */
function CurvePreview({ curve }: { curve: CubicEase }) {
	const seg = easeCurveSegments(curve)[0];
	if (!seg) return null;
	const ys = seg.map((p) => p[1]);
	const lo = Math.min(0, ...ys);
	const hi = Math.max(1, ...ys);
	const span = hi - lo || 1;
	const X = (x: number) => 2 + x * 36;
	const Y = (y: number) => 22 - ((y - lo) / span) * 20;
	const d = `M${X(seg[0][0])} ${Y(seg[0][1])}C${X(seg[1][0])} ${Y(seg[1][1])} ${X(seg[2][0])} ${Y(seg[2][1])} ${X(seg[3][0])} ${Y(seg[3][1])}`;
	return (
		<svg width={40} height={24} viewBox="0 0 40 24" aria-hidden className="shrink-0 text-pr-accent">
			<path d={`M2 ${Y(0)}H38M2 ${Y(1)}H38`} stroke="currentColor" strokeOpacity={0.25} fill="none" />
			<path d={d} stroke="currentColor" strokeWidth={1.5} fill="none" />
		</svg>
	);
}
