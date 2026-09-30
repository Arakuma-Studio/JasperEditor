// Effects panel (S05:EFX-001…003, R-PUI §12): search, "Real-time" / "Native" badge filters, a tree of
// bins (Video Effects by category, Audio Effects), drag an effect onto a timeline clip or the Effect
// Controls panel, or double-click to apply it to the selected clips (one undo step for N clips).
import { type EffectSpec, effectBadges } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { cx } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { CaretGlyph, FxGlyph } from '../properties/controls/glyphs.tsx';
import type { PanelProps } from '../types.ts';
import { applyEffectToClips, clipsAccepting, effectTree, writeEffectDragPayload } from './drag.ts';

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
	const [closed, setClosed] = useState<Record<string, boolean>>({});
	const [status, setStatus] = useState<string | null>(null);
	const [focused, setFocused] = useState<string | null>(null);
	const selected = useSessionState((s) => s.selection.timeline.clips);
	const registry = session.ctx.registries.effects;
	const tree = useMemo(
		() => effectTree(registry, { query, realtime, native }),
		[registry, query, realtime, native],
	);

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
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto" role="tree" aria-label="Effects">
				{tree.length === 0 ? (
					<p className="px-2 py-1 text-pr-small text-pr-muted">No effects match.</p>
				) : null}
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
			</div>
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
