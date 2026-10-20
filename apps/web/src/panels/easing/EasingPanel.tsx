// Easing panel (keyframe assistant): shape an ease curve and apply it to the selected keyframes, keep curves in a
// library, copy / paste eases and values between keys. The toolbar runs the easing UI commands (commands/easing.ts —
// the same ones as the palette, Clip ▸ Keyframe Easing, the Effect Controls key menu and F9 shortcuts), so every
// disabled control says why. The curve editor shows the selection's curve (two keys or one segment: cubic; three or
// more keys of a numeric property: multi-point; several properties: a switcher), else the last edited one. Edits
// have their own undo history; with Auto-apply each committed edit is applied as one undo step (a drag is one live
// gesture). Curve, library and settings are per-user preferences (library.ts).
import {
	type CubicEase,
	EASE_SECTIONS,
	type EaseCurve,
	type EasePreset,
	type MultiEase,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { Button, cx, PanelErrorBoundary } from '@jasper/ui';
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { t } from '../../i18n/runtime.ts';
import { createScrub } from '../properties/lib/ops.ts';
import { ContextMenu } from '../timeline/components/Chrome.tsx';
import type { ContextMenuItem } from '../timeline/state/ui-store.ts';
import type { PanelProps } from '../types.ts';
import { type CurveChange, CurveEditor } from './CurveEditor.tsx';
import { CurvePreview } from './CurvePreview.tsx';
import { BUILTIN_CATALOG, type EaseCatalog } from './catalog.ts';
import { useEaseClipboard } from './clipboard.ts';
import {
	type CubicField,
	curvesEqual,
	formatCubicBezier,
	historyInit,
	historyPush,
	historyRedo,
	historyUndo,
	LINEAR_EASE_CURVE,
	mirrorCurve,
	type PointField,
	parseCubicBezier,
	setCubicField,
	setPointField,
} from './curve-edit.ts';
import { type EaseDispatch, useEaseDispatch } from './dispatch.tsx';
import { applyEaseCommand } from './doc-commands.ts';
import { curveSummary } from './geometry.ts';
import { Library } from './Library.tsx';
import { DEFAULT_GROUP_ID, type EasingView, easeLibrary, savePreset, useEaseLibrary } from './library.ts';
import { type EaseSelection, noEaseSelection, readEaseSelection } from './selection.ts';
import {
	describeTargets,
	resolveSections,
	type SectionMods,
	sectionMods,
	toggleSection,
} from './targeting.ts';

export function EasingPanel(props: PanelProps & { catalog?: EaseCatalog }) {
	const session = useSessionOrNull();
	// Without a project the editor and library still work; nothing can be applied.
	const none = useMemo(noEaseSelection, []);
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel font-pr text-pr-ui text-pr-text outline-none"
			data-panel-kind="easing"
			data-instance-id={props.instanceId}
			data-testid="easing-panel"
		>
			{session ? (
				<WithSession session={session} visible={props.visible} catalog={props.catalog ?? BUILTIN_CATALOG} />
			) : (
				<EasingBody
					session={null}
					selection={none}
					visible={props.visible}
					catalog={props.catalog ?? BUILTIN_CATALOG}
				/>
			)}
		</div>
	);
}

function WithSession(props: { session: EditorSession; visible: boolean; catalog: EaseCatalog }) {
	const { session } = props;
	const doc = useSessionState((s) => s.document);
	const seqId = useSessionState((s) => s.activeSequenceId);
	const keySel = useSessionState((s) => s.selection.keyframes);
	const readOnly = useSessionState((s) => s.readOnly);
	const selection = useMemo(() => {
		try {
			return readEaseSelection(doc, seqId ? (doc.sequences[seqId] ?? null) : null, keySel, {
				frame: 0,
				registries: session.ctx.registries,
				readOnly,
			});
		} catch (error) {
			return {
				...noEaseSelection(),
				blocked: t(
					'The selection could not be read: {0}',
					error instanceof Error ? error.message : String(error),
				),
			};
		}
	}, [doc, seqId, keySel, readOnly, session]);
	return (
		<EasingBody session={session} selection={selection} visible={props.visible} catalog={props.catalog} />
	);
}

/** Shift / Alt / Ctrl (Cmd) held right now, for the info line. */
function useHeldMods(platform: EaseDispatch['platform']): SectionMods {
	const [mods, setMods] = useState<SectionMods>({ shift: false, alt: false, primary: false });
	useEffect(() => {
		const on = (e: KeyboardEvent) =>
			setMods((m) => {
				const n = sectionMods(e, platform);
				return n.shift === m.shift && n.alt === m.alt && n.primary === m.primary ? m : n;
			});
		const clear = () => setMods({ shift: false, alt: false, primary: false });
		window.addEventListener('keydown', on);
		window.addEventListener('keyup', on);
		window.addEventListener('blur', clear);
		return () => {
			window.removeEventListener('keydown', on);
			window.removeEventListener('keyup', on);
			window.removeEventListener('blur', clear);
		};
	}, [platform]);
	return mods;
}

function useWideLayout(): { ref: (el: HTMLDivElement | null) => void; wide: boolean } {
	const [wide, setWide] = useState(false);
	const ro = useRef<ResizeObserver | null>(null);
	const ref = useCallback((el: HTMLDivElement | null) => {
		ro.current?.disconnect();
		if (!el || typeof ResizeObserver === 'undefined') return;
		ro.current = new ResizeObserver(([e]) => {
			const r = e?.contentRect;
			if (r) setWide(r.width >= 560 && r.width >= r.height * 1.3);
		});
		ro.current.observe(el);
	}, []);
	return { ref, wide };
}

const keyIdsOf = (sel: EaseSelection) => sel.properties.flatMap((p) => p.keys.map((k) => k.id));

function EasingBody(props: {
	session: EditorSession | null;
	selection: EaseSelection;
	visible: boolean;
	catalog: EaseCatalog;
}) {
	const { selection, catalog, session } = props;
	const lib = useEaseLibrary();
	const settings = lib.settings;
	const dispatch = useEaseDispatch();
	const clip = useEaseClipboard();
	const mods = useHeldMods(dispatch.platform);
	const layout = useWideLayout();
	const [propIndex, setPropIndex] = useState(0);
	const prop =
		selection.properties[Math.min(propIndex, Math.max(0, selection.properties.length - 1))] ?? null;
	const [history, setHistory] = useState(() =>
		historyInit(prop?.curve ?? settings.curve ?? { ...LINEAR_EASE_CURVE }),
	);
	const [preview, setPreview] = useState<EaseCurve | null>(null);
	const [hover, setHover] = useState<EasePreset | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
	const scrub = useMemo(() => (session ? createScrub(session) : null), [session]);
	const gesture = useRef(false);
	const curve = preview ?? history.present;

	// The selection's curve comes into the editor when the selection (or its curve) changes.
	const selCurve = prop?.curve ?? null;
	const selKey = `${selection.keyframeIds.join(',')}|${prop?.id ?? ''}|${selCurve ? JSON.stringify(selCurve) : ''}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the selection, not on the curve object
	useEffect(() => {
		if (selCurve && !gesture.current) setHistory((h) => historyPush(h, selCurve));
	}, [selKey]);
	// The edited curve is remembered (palette Apply, the next session).
	useEffect(() => {
		if (!curvesEqual(easeLibrary.get().settings.curve, history.present))
			easeLibrary.settings({ curve: history.present });
	}, [history.present]);

	// The toolbar's reasons, read once per selection / clipboard / library change (not on every drag frame).
	const reasons = useMemo(() => {
		void selection;
		void clip;
		void lib.settings.curve;
		const out = new Map<string, string | undefined>();
		for (const id of ['ease.apply', 'ease.copy', 'ease.paste', 'ease.pasteValues'])
			out.set(id, dispatch.reason(id));
		return out;
	}, [dispatch, selection, clip, lib.settings.curve]);
	const applyReason = reasons.get('ease.apply');
	const ids = keyIdsOf(selection);

	const applyNow = (c: EaseCurve, e: ReactMouseEvent | null, name?: string) => {
		const sections = resolveSections(settings.sections, e ? sectionMods(e, dispatch.platform) : null);
		if (!curvesEqual(easeLibrary.get().settings.curve, c)) easeLibrary.settings({ curve: c });
		void dispatch.run('ease.apply', {
			curve: c,
			...(sections ? { sections } : {}),
			...(name ? { name } : {}),
		});
	};

	const onCurve = (c: EaseCurve, phase: CurveChange) => {
		setError(null);
		if (phase === 'start') {
			gesture.current = false;
			if (settings.autoApply && !dispatch.reason('ease.apply') && scrub)
				gesture.current = scrub.start(t('Apply Ease'));
			return;
		}
		const live = () => {
			const r = scrub?.update([applyEaseCommand(ids, c, settings.sections)]);
			if (r && !r.ok) {
				scrub?.end(true);
				gesture.current = false;
				dispatch.toast({
					kind: 'warning',
					message: t('Apply Ease: not possible'),
					detail: r.errors[0]?.message,
				});
			}
		};
		if (phase === 'move') {
			setPreview(c);
			if (gesture.current) live();
			return;
		}
		setPreview(null);
		if (phase === 'cancel') {
			if (gesture.current) scrub?.end(true);
			gesture.current = false;
			return;
		}
		setHistory((h) => historyPush(h, c));
		if (gesture.current) {
			live();
			if (gesture.current) {
				const r = scrub?.end(false);
				if (r?.ok) easeLibrary.settings({ curve: c });
			}
			gesture.current = false;
		} else if (settings.autoApply && !applyReason) applyNow(c, null);
	};
	const commit = (c: EaseCurve) => onCurve(c, 'commit');

	const sections = resolveSections(settings.sections, mods);
	const info = hover
		? `${t(hover.name)} · ${curveSummary(hover.curve)}`
		: describeTargets(selection, sections, curve);
	// Matching samples every preset: once per curve / library change, not on every render.
	const matched = useMemo(
		() => catalog.match(curve, [...catalog.presets, ...lib.presets]),
		[catalog, curve, lib.presets],
	);
	const view = settings.view;

	const action = (
		id: string,
		label: string,
		run: (e: ReactMouseEvent) => void,
		testId: string,
		icon?: ReactNode,
	) => {
		const reason = reasons.has(id) ? reasons.get(id) : dispatch.reason(id);
		return (
			<Button
				variant="quiet"
				className="h-[22px] px-[6px]"
				disabled={!!reason}
				disabledReason={reason}
				onClick={(e) => run(e)}
				data-testid={testId}
				title={reason ? undefined : label}
			>
				{icon}
				{label}
			</Button>
		);
	};

	const openMore = (e: ReactMouseEvent) => {
		const item = (id: string, label: string): ContextMenuItem => {
			const reason = dispatch.reason(id);
			return {
				kind: 'item',
				label: reason ? `${label} — ${reason}` : label,
				disabled: !!reason,
				run: () => void dispatch.run(id),
			};
		};
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		setMenu({
			x: r.left,
			y: r.bottom,
			items: [
				item('ease.drivePath', t('Drive Along Path')),
				item('ease.cleanupPath', t('Clean Up Motion Path')),
				{ kind: 'submenu', label: t('Spatial'), items: [item('ease.spatialLinear', t('Linear'))] },
				{ kind: 'submenu', label: t('Temporal'), items: [item('ease.temporalContinuous', t('Continuous'))] },
				{ kind: 'separator' },
				item('ease.duplicateAtPlayhead', t('Duplicate Keys at Playhead')),
				item('ease.mirrorAtPlayhead', t('Mirror Keys at Playhead')),
				{ kind: 'separator' },
				item('ease.addOvershoot', t('Add Overshoot Expression')),
				item('ease.addBounce', t('Add Bounce Expression')),
				{ kind: 'separator' },
				item('ease.easyEase', t('Easy Ease')),
				item('ease.easyEaseIn', t('Easy Ease In')),
				item('ease.easyEaseOut', t('Easy Ease Out')),
			],
		});
	};

	const pick = (p: EasePreset, e: ReactMouseEvent | null) => {
		setHistory((h) => historyPush(h, p.curve));
		if (!applyReason) applyNow(p.curve, e, p.name);
		else easeLibrary.settings({ curve: p.curve });
	};

	const curveSection = (
		<PanelErrorBoundary name={t('Easing curve editor')}>
			<section
				// Never squeezed below its controls: a short panel scrolls instead (the body below).
				className="flex min-h-[300px] min-w-0 flex-1 flex-col gap-1 p-1"
				aria-label="Curve"
				data-testid="ease-curve-section"
			>
				{selection.properties.length > 1 ? (
					<label className="flex items-center gap-1 text-pr-small text-pr-muted">
						Property
						<select
							className="h-[20px] min-w-0 flex-1 rounded-pr-control bg-pr-field px-1 text-pr-ui text-pr-text"
							value={prop?.id ?? ''}
							onChange={(e) =>
								setPropIndex(
									Math.max(
										0,
										selection.properties.findIndex((p) => p.id === e.target.value),
									),
								)
							}
							data-testid="ease-property"
						>
							{selection.properties.map((p) => (
								<option key={p.id} value={p.id}>
									{t(p.label)}
								</option>
							))}
						</select>
					</label>
				) : prop ? (
					<div className="truncate text-pr-small text-pr-muted" data-testid="ease-property-label">
						{t('{0} · {1} keys selected', t(prop.label), prop.keys.length)}
					</div>
				) : null}
				<CurveEditor
					className="flex-1"
					curve={curve}
					onChange={onCurve}
					onUndo={() => setHistory(historyUndo)}
					onRedo={() => setHistory(historyRedo)}
					platform={dispatch.platform}
				/>
				<CurvePreview curve={hover?.curve ?? curve} playing={props.visible} />
				<CurveFields curve={curve} onCommit={commit} />
				<CubicText curve={curve} onCommit={commit} onError={setError} />
				{error ? (
					<p role="alert" className="text-pr-small text-pr-warning" data-testid="ease-error">
						{error}
					</p>
				) : null}
				<div className="flex flex-wrap items-center gap-1">
					<Button
						variant="quiet"
						className="h-[22px] px-[6px]"
						disabled={history.past.length === 0}
						disabledReason={t('Nothing to undo in the editor')}
						onClick={() => setHistory(historyUndo)}
						data-testid="ease-undo"
					>
						Undo
					</Button>
					<Button
						variant="quiet"
						className="h-[22px] px-[6px]"
						disabled={history.future.length === 0}
						disabledReason={t('Nothing to redo in the editor')}
						onClick={() => setHistory(historyRedo)}
						data-testid="ease-redo"
					>
						Redo
					</Button>
					<Button
						variant="quiet"
						className="h-[22px] px-[6px]"
						title={t('Make the curve symmetric: the second half mirrors the first')}
						onClick={() => commit(mirrorCurve(curve))}
						data-testid="ease-mirror"
					>
						Mirror
					</Button>
					<Button
						variant="quiet"
						className="h-[22px] px-[6px]"
						onClick={() => commit({ ...LINEAR_EASE_CURVE })}
						data-testid="ease-reset"
					>
						Reset
					</Button>
					<label
						className="flex items-center gap-1 px-1 text-pr-small text-pr-text"
						title={t('Apply every committed edit to the selected keys (one undo step each)')}
					>
						<input
							type="checkbox"
							checked={settings.autoApply}
							onChange={(e) => easeLibrary.settings({ autoApply: e.target.checked })}
							data-testid="ease-auto-apply"
						/>
						Auto-apply
					</label>
					<span className="ml-auto" />
					{saving ? (
						<span className="w-[140px]">
							<SaveName
								onDone={(name) => {
									setSaving(false);
									if (name === null) return;
									const active = lib.groups.some((g) => g.id === settings.group)
										? settings.group
										: DEFAULT_GROUP_ID;
									const err = easeLibrary.run((s) => savePreset(s, { name, curve, group: active }));
									setError(err);
									if (!err && settings.view === 'curve') easeLibrary.settings({ group: active });
								}}
							/>
						</span>
					) : (
						<Button
							variant="quiet"
							className="h-[22px] px-[6px]"
							onClick={() => setSaving(true)}
							data-testid="ease-save"
						>
							Save to Library…
						</Button>
					)}
					<Button
						variant="primary"
						className="h-[22px] px-[8px]"
						disabled={!!applyReason}
						disabledReason={applyReason}
						title={applyReason ? undefined : t('Apply (Shift: in, Alt: out, Ctrl/Cmd: middle)')}
						onClick={(e) => applyNow(curve, e)}
						data-testid="ease-apply"
					>
						Apply
					</Button>
				</div>
			</section>
		</PanelErrorBoundary>
	);

	const librarySection = (
		<PanelErrorBoundary name={t('Easing library')}>
			<Library
				catalog={catalog}
				lib={lib}
				matchedId={matched?.id ?? null}
				onHover={setHover}
				onPick={pick}
				onLoad={(p) => setHistory((h) => historyPush(h, p.curve))}
			/>
		</PanelErrorBoundary>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-[28px] shrink-0 items-center gap-1 overflow-hidden border-pr-border-subtle border-b px-1">
				{action('ease.copy', t('Copy'), () => void dispatch.run('ease.copy'), 'ease-copy')}
				{action(
					'ease.paste',
					t('Paste Ease'),
					(e) => {
						const s = resolveSections(settings.sections, sectionMods(e, dispatch.platform));
						void dispatch.run('ease.paste', s ? { sections: s } : undefined);
					},
					'ease-paste',
				)}
				{action(
					'ease.pasteValues',
					t('Paste Values'),
					() => void dispatch.run('ease.pasteValues'),
					'ease-paste-values',
				)}
				<Button
					variant="quiet"
					className="h-[22px] px-[6px]"
					aria-label="More easing actions"
					aria-haspopup="menu"
					onClick={openMore}
					data-testid="ease-more"
				>
					⋯
				</Button>
				<span className="ml-auto" />
				<fieldset
					className="flex shrink-0 overflow-hidden rounded-pr-control border border-pr-border-subtle"
					aria-label="View"
				>
					{(['curve', 'library', 'both'] as const satisfies readonly EasingView[]).map((v) => (
						<button
							key={v}
							type="button"
							aria-pressed={view === v}
							className={cx(
								'h-[20px] px-2 text-pr-small',
								view === v ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:bg-pr-hover',
							)}
							onClick={() => easeLibrary.settings({ view: v })}
							data-testid={`ease-view-${v}`}
						>
							{v === 'curve' ? t('Curve') : v === 'library' ? t('Library') : t('Both')}
						</button>
					))}
				</fieldset>
			</header>
			{clip ? (
				<div className="shrink-0 truncate px-2 pt-1 text-pr-small text-pr-dim" data-testid="ease-clipboard">
					{t(
						'Copied: {0} ({1})',
						t(clip.label),
						clip.ease.kind === 'key' ? t('one key') : t('{0} segments', clip.ease.segments.length),
					)}
				</div>
			) : null}
			<div
				ref={layout.ref}
				className={cx(
					'flex min-h-0 flex-1 overflow-y-auto',
					view === 'both' && layout.wide ? 'flex-row' : 'flex-col',
				)}
			>
				{view !== 'library' ? curveSection : null}
				{view === 'both' ? (
					<div
						className={
							layout.wide ? 'w-px shrink-0 bg-pr-border-subtle' : 'h-px shrink-0 bg-pr-border-subtle'
						}
					/>
				) : null}
				{view !== 'curve' ? (
					<div
						className={cx(
							'flex min-w-0 flex-1 flex-col',
							view === 'both' && !layout.wide ? 'min-h-[240px]' : 'min-h-0',
						)}
					>
						{librarySection}
					</div>
				) : null}
			</div>
			<footer className="flex shrink-0 flex-wrap items-center gap-2 border-pr-border-subtle border-t px-2 py-1">
				<fieldset
					className="flex overflow-hidden rounded-pr-control border border-pr-border-subtle"
					aria-label="Segments to ease"
				>
					{EASE_SECTIONS.map((s) => (
						<button
							key={s}
							type="button"
							aria-pressed={settings.sections.includes(s)}
							className={cx(
								'h-[20px] px-2 text-pr-small',
								settings.sections.includes(s)
									? 'bg-pr-accent-fill text-pr-on-accent'
									: 'text-pr-muted hover:bg-pr-hover',
							)}
							title={t('Choose the segments yourself; none chosen = automatic')}
							onClick={() => easeLibrary.settings({ sections: toggleSection(settings.sections, s) })}
							data-testid={`ease-section-${s}`}
						>
							{s === 'in' ? t('In') : s === 'middle' ? t('Middle') : t('Out')}
						</button>
					))}
				</fieldset>
				<span
					className="min-w-0 flex-1 truncate text-pr-small text-pr-muted"
					data-testid="ease-info"
					title={info}
				>
					{info}
				</span>
			</footer>
			{menu ? (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					items={menu.items}
					onClose={() => setMenu(null)}
					testId="ease-more-menu"
				/>
			) : null}
		</div>
	);
}

function SaveName(props: { onDone(name: string | null): void }) {
	const [v, setV] = useState('');
	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: shown because the user chose Save to Library
			autoFocus
			aria-label="Name of the new library curve"
			placeholder="Curve name"
			className="h-[20px] w-full rounded-pr-control border border-pr-focus bg-pr-field px-1 text-pr-ui text-pr-text outline-none"
			value={v}
			maxLength={200}
			onChange={(e) => setV(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') props.onDone(v.trim() || null);
				if (e.key === 'Escape') props.onDone(null);
			}}
			onBlur={() => props.onDone(v.trim() || null)}
			data-testid="ease-save-name"
		/>
	);
}

/** One number that commits on Enter / blur; text that is not a number is refused (red, original value kept). */
function NumberCell(props: { label: string; value: number; onCommit(v: number): void; testId: string }) {
	const shown = Number(props.value.toFixed(3)).toString();
	const [text, setText] = useState(shown);
	const [bad, setBad] = useState(false);
	useEffect(() => {
		setText(shown);
		setBad(false);
	}, [shown]);
	const commit = () => {
		const s = text.trim().replace(',', '.');
		const v = s === '' ? Number.NaN : Number(s);
		if (!Number.isFinite(v)) {
			setBad(true);
			return;
		}
		setBad(false);
		if (v !== props.value) props.onCommit(v);
		else setText(shown);
	};
	return (
		<label className="flex min-w-0 items-center gap-[2px] text-pr-small text-pr-muted">
			{props.label}
			<input
				className={cx(
					'pr-tabular h-[20px] w-[52px] min-w-0 rounded-pr-control border bg-pr-field px-1 text-pr-ui text-pr-text outline-none focus:border-pr-focus',
					bad ? 'border-pr-danger' : 'border-transparent',
				)}
				aria-invalid={bad || undefined}
				aria-label={props.label}
				value={text}
				inputMode="decimal"
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') commit();
					if (e.key === 'Escape') {
						setText(shown);
						setBad(false);
					}
				}}
				data-testid={props.testId}
			/>
		</label>
	);
}

const CUBIC_FIELDS: readonly CubicField[] = ['x1', 'y1', 'x2', 'y2'];

function CurveFields(props: { curve: EaseCurve; onCommit(c: EaseCurve): void }) {
	const { curve } = props;
	const [point, setPoint] = useState(1);
	if (curve.kind === 'cubic') {
		const c: CubicEase = curve;
		return (
			<div className="flex flex-wrap items-center gap-2" data-testid="ease-fields">
				{CUBIC_FIELDS.map((f) => (
					<NumberCell
						key={f}
						label={f}
						value={c[f]}
						onCommit={(v) => props.onCommit(setCubicField(c, f, v))}
						testId={`ease-field-${f}`}
					/>
				))}
			</div>
		);
	}
	const m: MultiEase = curve;
	const i = Math.min(Math.max(0, point), m.points.length - 1);
	const p = m.points[i]!;
	const inn = p.in ?? (i > 0 ? defaultHandleOf(m, i, 'in') : null);
	const out = p.out ?? (i < m.points.length - 1 ? defaultHandleOf(m, i, 'out') : null);
	const cell = (field: PointField, label: string, value: number | null) =>
		value === null ? null : (
			<NumberCell
				key={field}
				label={label}
				value={value}
				onCommit={(v) => props.onCommit(setPointField(m, i, field, v))}
				testId={`ease-point-${field}`}
			/>
		);
	const end = i === 0 || i === m.points.length - 1;
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid="ease-fields">
			<select
				aria-label="Point"
				className="h-[20px] rounded-pr-control bg-pr-field px-1 text-pr-ui text-pr-text"
				value={i}
				onChange={(e) => setPoint(Number(e.target.value))}
				data-testid="ease-point-select"
			>
				{m.points.map((_, k) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: points are addressed by index
					<option key={k} value={k}>
						{t('Point {0}', k + 1)}
					</option>
				))}
			</select>
			{end ? null : cell('x', 'x', p.x)}
			{end ? null : cell('y', 'y', p.y)}
			{cell('inX', t('in x'), inn?.[0] ?? null)}
			{cell('inY', t('in y'), inn?.[1] ?? null)}
			{cell('outX', t('out x'), out?.[0] ?? null)}
			{cell('outY', t('out y'), out?.[1] ?? null)}
		</div>
	);
}

function defaultHandleOf(m: MultiEase, i: number, side: 'in' | 'out'): [number, number] | null {
	const p = m.points[i];
	const q = m.points[side === 'in' ? i - 1 : i + 1];
	if (!p || !q) return null;
	return [p.x + (q.x - p.x) / 3, p.y + (q.y - p.y) / 3];
}

/** The curve as `cubic-bezier(…)` text: type or paste one to set the curve. */
function CubicText(props: {
	curve: EaseCurve;
	onCommit(c: EaseCurve): void;
	onError(m: string | null): void;
}) {
	const shown = props.curve.kind === 'cubic' ? formatCubicBezier(props.curve) : '';
	const [text, setText] = useState(shown);
	const [bad, setBad] = useState(false);
	useEffect(() => {
		setText(shown);
		setBad(false);
	}, [shown]);
	const commit = (value: string) => {
		if (value.trim() === shown || (value.trim() === '' && props.curve.kind === 'multi')) {
			setBad(false);
			return;
		}
		const r = parseCubicBezier(value);
		if (!r.ok) {
			setBad(true);
			props.onError(r.error);
			return;
		}
		setBad(false);
		props.onError(null);
		props.onCommit(r.curve);
	};
	return (
		<input
			className={cx(
				'pr-tabular h-[20px] w-full min-w-0 rounded-pr-control border bg-pr-field px-1 font-pr text-pr-ui text-pr-text outline-none focus:border-pr-focus',
				bad ? 'border-pr-danger' : 'border-transparent',
			)}
			aria-label="cubic-bezier value"
			aria-invalid={bad || undefined}
			spellCheck={false}
			placeholder={
				props.curve.kind === 'multi'
					? t('Multi-point curve: paste cubic-bezier(…) to replace it')
					: 'cubic-bezier(x1, y1, x2, y2)'
			}
			value={text}
			onChange={(e) => setText(e.target.value)}
			onPaste={(e) => {
				const pasted = e.clipboardData.getData('text');
				if (!pasted) return;
				e.preventDefault();
				setText(pasted);
				commit(pasted);
			}}
			onBlur={() => commit(text)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') commit(text);
				if (e.key === 'Escape') {
					setText(shown);
					setBad(false);
					props.onError(null);
				}
			}}
			data-testid="ease-cubic-text"
		/>
	);
}
