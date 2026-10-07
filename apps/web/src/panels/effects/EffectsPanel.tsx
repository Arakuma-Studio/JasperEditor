// Effects panel (S05:EFX-001…003, R-PUI §12): search, "Real-time" / "Native" / "GPU" badge filters, a tree of
// bins (Presets, Video Effects by category or by an effect's `bin` — fx catalogue packs such as "Sapphire Glows" —,
// Audio Effects), drag an effect onto a timeline clip or the Effect Controls panel, or double-click to apply it to
// the selected clips (one undo step for N clips). "GPU" = a shader effect (Premiere's Accelerated Effects badge).
// M3 (wp-m3-presets, S03:FX-030): the Presets bin (built-in and user effect presets) is presets/PresetsBin.tsx.
import {
	type EffectSpec,
	effectBadges,
	effectIsGpu,
	TRANSITION_SPECS,
	type TransitionSpec,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState, useStoreSelector } from '@jasper/session/react';
import { cx } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { CaretGlyph, FxGlyph } from '../properties/controls/glyphs.tsx';
import { ContextMenu } from '../timeline/components/Chrome.tsx';
import type { ContextMenuItem } from '../timeline/state/ui-store.ts';
import type { PanelProps } from '../types.ts';
import {
	applyEffectToClips,
	clipsAccepting,
	effectTree,
	endTransitionDrag,
	writeEffectDragPayload,
	writeTransitionDragPayload,
} from './drag.ts';
import { usePresetLibrary } from './presets/hooks.ts';
import { PresetsBin, presetTree } from './presets/PresetsBin.tsx';
import { setDefaultTransition, transitionDefaults } from './transition-prefs.ts';
import { applyTransitionToClips, transitionTree } from './transitions.ts';

export function EffectsPanel(props: PanelProps) {
	const session = useSessionOrNull();
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel font-pr text-pr-ui text-pr-text"
			data-panel-kind="effects"
			data-instance-id={props.instanceId}
			data-testid="effects-panel"
		>
			{session ? (
				<EffectsBody session={session} />
			) : (
				<p className="p-3 text-pr-small text-pr-muted">No project open.</p>
			)}
		</div>
	);
}

function Badge(props: { on: boolean; label: string; short: string; onClick(): void }) {
	return (
		<button
			type="button"
			aria-pressed={props.on}
			title={`Show only ${props.label} effects`}
			onClick={props.onClick}
			className={cx(
				'h-[20px] rounded-pr-control border px-1 text-pr-small',
				props.on
					? 'border-pr-accent text-pr-accent'
					: 'border-pr-border-strong text-pr-muted hover:text-pr-text',
			)}
		>
			{props.short}
		</button>
	);
}

function EffectsBody({ session }: { session: EditorSession }) {
	const [query, setQuery] = useState('');
	const [realtime, setRealtime] = useState(false);
	const [native, setNative] = useState(false);
	const [gpu, setGpu] = useState(false);
	const [closed, setClosed] = useState<Record<string, boolean>>({});
	const [status, setStatus] = useState<string | null>(null);
	const [focused, setFocused] = useState<string | null>(null);
	const selected = useSessionState((s) => s.selection.timeline.clips);
	const registry = session.ctx.registries.effects;
	const tree = useMemo(
		() => effectTree(registry, { query, realtime, native, gpu }),
		[registry, query, realtime, native, gpu],
	);
	// S10:TUI-020: transition bins. The built-ins are native-capable and real-time; GPU transitions (transition
	// framework) carry the GPU badge — the N / GPU filters apply to them like to effects.
	const transitionBins = useMemo(
		() =>
			transitionTree(
				query,
				TRANSITION_SPECS.filter((s) => (!gpu || !!s.gpu) && (!native || !s.gpu)),
			),
		[query, gpu, native],
	);
	const presetLib = usePresetLibrary();
	const presetFilter = useMemo(() => ({ query, realtime, native }), [query, realtime, native]);
	const presets = useMemo(
		() => presetTree(presetLib, registry, presetFilter),
		[presetLib, registry, presetFilter],
	);
	const defaults = useStoreSelector(transitionDefaults(), (s) => s);
	const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
	const applyTransition = (t: TransitionSpec) => {
		const r = applyTransitionToClips(session, t.id, selected);
		setStatus(
			r === null
				? selected.length
					? `${t.label} cannot be applied to the selected clips.`
					: 'Select clips in the Timeline first.'
				: r.ok
					? `Applied ${t.label} to ${r.count} edit point${r.count === 1 ? '' : 's'}.`
					: r.message,
		);
	};
	const transitionMenu = (t: TransitionSpec): ContextMenuItem[] => [
		{
			kind: 'item',
			label: 'Set Selected as Default Transition',
			checked: defaults[t.appliesTo] === t.id,
			run: () => {
				setDefaultTransition(t.id);
				setStatus(`${t.label} is the default ${t.appliesTo} transition.`);
			},
		},
		{ kind: 'item', label: 'Apply to Selected Clips', run: () => applyTransition(t) },
	];

	const apply = (e: EffectSpec) => {
		const targets = clipsAccepting(session, e.id, selected);
		if (!targets.length) {
			setStatus(
				selected.length
					? `${e.label} cannot be applied to the selected clips.`
					: 'Select clips in the Timeline first.',
			);
			return;
		}
		const r = applyEffectToClips(session, e.id, targets);
		setStatus(
			r?.ok
				? `Applied ${e.label} to ${targets.length} clip${targets.length > 1 ? 's' : ''}.`
				: `Could not apply ${e.label}.`,
		);
	};
	const toggle = (id: string) => setClosed({ ...closed, [id]: !closed[id] });
	/** One transition row (S10:TUI-020): drag onto an edit point, double-click applies to the selection. */
	const transitionItem = (t: TransitionSpec, depth: number) => {
		const isDefault = defaults[t.appliesTo] === t.id;
		const gpuBadge = !!t.gpu;
		return (
			<div
				key={t.id}
				role="treeitem"
				tabIndex={0}
				aria-selected={focused === t.id}
				draggable
				title={`${t.description}\nDrag onto an edit point or clip edge in the Timeline.${isDefault ? `\nDefault ${t.appliesTo} transition.` : ''}`}
				className={cx(
					'flex h-[var(--pr-row-h)] cursor-grab items-center gap-1 pr-2 text-pr-ui',
					focused === t.id ? 'bg-pr-selected' : 'hover:bg-pr-hover',
				)}
				style={{ paddingLeft: 6 + depth * 16 }}
				onClick={() => setFocused(t.id)}
				onDoubleClick={() => applyTransition(t)}
				onKeyDown={(ev) => ev.key === 'Enter' && applyTransition(t)}
				onContextMenu={(ev) => {
					ev.preventDefault();
					setFocused(t.id);
					setMenu({ x: ev.clientX, y: ev.clientY, items: transitionMenu(t) });
				}}
				onDragStart={(ev) => writeTransitionDragPayload(ev.dataTransfer, t.id)}
				onDragEnd={endTransitionDrag}
				data-transition-effect-id={t.id}
				data-default={isDefault || undefined}
			>
				<TransitionGlyph audio={t.appliesTo === 'audio'} isDefault={isDefault} />
				<span className="min-w-0 flex-1 truncate">{t.label}</span>
				{gpuBadge ? (
					<span
						className="text-[10px] text-pr-accent"
						title="GPU-accelerated transition (exports through Remotion)"
						data-badge="gpu"
					>
						GPU
					</span>
				) : (
					<span className="text-[10px] text-pr-engine-native" title="Renders on the native (ffmpeg) path">
						N
					</span>
				)}
			</div>
		);
	};

	return (
		<>
			<div className="flex shrink-0 items-center gap-1 p-1">
				<input
					type="search"
					aria-label="Search effects"
					placeholder="Search"
					className="h-[22px] min-w-0 flex-1 rounded-pr-control bg-pr-field-deep px-2 text-pr-ui text-pr-text placeholder:text-pr-dim"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							if (query) setQuery('');
							else e.currentTarget.blur();
						}
					}}
					data-testid="effects-search"
				/>
				<Badge on={realtime} label="real-time" short="RT" onClick={() => setRealtime(!realtime)} />
				<Badge on={native} label="native (ffmpeg)" short="N" onClick={() => setNative(!native)} />
				<Badge on={gpu} label="GPU-accelerated" short="GPU" onClick={() => setGpu(!gpu)} />
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto" role="tree" aria-label="Effects">
				{tree.length === 0 && transitionBins.length === 0 && presets.matches === 0 ? (
					<p className="px-2 py-1 text-pr-small text-pr-muted">No effects match.</p>
				) : null}
				<PresetsBin
					session={session}
					lib={presetLib}
					tree={presets}
					filter={presetFilter}
					closed={closed}
					onToggle={toggle}
					focused={focused}
					onFocus={setFocused}
					onStatus={setStatus}
					onMenu={(x, y, items) => setMenu({ x, y, items })}
					selectedClips={selected}
				/>
				{tree.map((bin) => (
					<div key={bin.medium}>
						<TreeFolder
							label={bin.medium}
							open={!closed[bin.medium] || !!query}
							depth={0}
							onToggle={() => toggle(bin.medium)}
						/>
						{!closed[bin.medium] || query
							? bin.categories.map((cat) => {
									const id = `${bin.medium}/${cat.category}`;
									const open = !closed[id] || !!query;
									return (
										<div key={id}>
											<TreeFolder label={cat.category} open={open} depth={1} onToggle={() => toggle(id)} />
											{open
												? cat.effects.map((e) => {
														const badges = effectBadges(e);
														return (
															<div
																key={e.id}
																role="treeitem"
																tabIndex={0}
																aria-selected={focused === e.id}
																draggable
																title={`${e.description ?? e.label}\nDrag onto a clip or double-click to apply to the selection.`}
																className={cx(
																	'flex h-[var(--pr-row-h)] cursor-grab items-center gap-1 pr-2 pl-[38px] text-pr-ui',
																	focused === e.id ? 'bg-pr-selected' : 'hover:bg-pr-hover',
																)}
																onClick={() => setFocused(e.id)}
																onDoubleClick={() => apply(e)}
																onKeyDown={(ev) => ev.key === 'Enter' && apply(e)}
																onDragStart={(ev) => writeEffectDragPayload(ev.dataTransfer, e.id)}
																data-effect-id={e.id}
															>
																<span className="text-pr-icon">
																	<FxGlyph size={13} />
																</span>
																<span className="min-w-0 flex-1 truncate">{e.label}</span>
																{badges.realtime ? (
																	<span className="text-[10px] text-pr-muted" title="Real-time preview">
																		RT
																	</span>
																) : null}
																{effectIsGpu(e) ? (
																	<span
																		className="text-[10px] text-pr-accent"
																		title="GPU-accelerated shader effect (exports through Remotion unless native)"
																		data-badge="gpu"
																	>
																		GPU
																	</span>
																) : null}
																{badges.native ? (
																	<span
																		className="text-[10px] text-pr-engine-native"
																		title="Renders on the native (ffmpeg) path"
																	>
																		N
																	</span>
																) : null}
															</div>
														);
													})
												: null}
										</div>
									);
								})
							: null}
					</div>
				))}
				{transitionBins.map((bin) => (
					<div key={bin.medium} data-testid={`effects-bin-${bin.appliesTo}-transitions`}>
						<TreeFolder
							label={bin.medium}
							open={!closed[bin.medium] || !!query}
							depth={0}
							onToggle={() => toggle(bin.medium)}
						/>
						{!closed[bin.medium] || query
							? bin.categories.map((cat) => {
									const id = `${bin.medium}/${cat.category}`;
									const open = !closed[id] || !!query;
									return (
										<div key={id} data-transition-bin={cat.category}>
											<TreeFolder label={cat.category} open={open} depth={1} onToggle={() => toggle(id)} />
											{open
												? [
														...cat.transitions.map((t) => transitionItem(t, 2)),
														...cat.groups.map((g) => {
															const gid = `${id}/${g.group}`;
															const gopen = !closed[gid] || !!query;
															return (
																<div key={gid} data-transition-bin={`${cat.category}/${g.group}`}>
																	<TreeFolder
																		label={g.group}
																		open={gopen}
																		depth={2}
																		onToggle={() => toggle(gid)}
																	/>
																	{gopen ? g.transitions.map((t) => transitionItem(t, 3)) : null}
																</div>
															);
														}),
													]
												: null}
										</div>
									);
								})
							: null}
					</div>
				))}
			</div>
			{menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
			{status ? (
				<p
					className="shrink-0 border-t border-pr-border-subtle px-2 py-1 text-pr-small text-pr-muted"
					role="status"
					data-testid="effects-status"
				>
					{status}
				</p>
			) : null}
		</>
	);
}

/** Transition item icon; the default transition gets the blue outline badge (Premiere convention). */
function TransitionGlyph(props: { audio: boolean; isDefault: boolean }) {
	return (
		<span
			className="inline-flex size-[15px] shrink-0 items-center justify-center rounded-[2px] text-pr-icon"
			style={
				props.isDefault ? { boxShadow: 'inset 0 0 0 1px var(--pr-transition-default-badge)' } : undefined
			}
			title={props.isDefault ? 'Default transition' : undefined}
			data-default-badge={props.isDefault || undefined}
		>
			<svg width={11} height={11} viewBox="0 0 11 11" aria-hidden="true">
				<path
					d={props.audio ? 'M1 9 Q5 1 10 2 M1 2 Q6 1 10 9' : 'M1 10 L10 1 M1 1 L10 10'}
					fill="none"
					stroke="currentColor"
					strokeWidth={1.2}
				/>
			</svg>
		</span>
	);
}

function TreeFolder(props: { label: string; open: boolean; depth: number; onToggle(): void }) {
	return (
		<button
			type="button"
			aria-expanded={props.open}
			onClick={props.onToggle}
			className="flex h-[var(--pr-row-h)] w-full items-center gap-1 pr-2 text-left text-pr-ui text-pr-text hover:bg-pr-hover"
			style={{ paddingLeft: 4 + props.depth * 16 }}
		>
			<span className="text-pr-icon">
				<CaretGlyph open={props.open} size={11} />
			</span>
			{props.label}
		</button>
	);
}
