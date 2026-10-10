// Motion Templates ▸ Text Animations tab (S11:TXA-020): 16:9 cards of the presets (poster of the "Aa Title"
// sample, hover preview), side chips (In / Out: which side the previews show and double-click applies) and
// category chips, search. Double-click / Enter applies the preset to the selected text clips; the card menu
// offers Apply as In / Apply as Out; dragging a card onto a text clip in the Timeline, Program or Effect
// Controls applies it (drop position picks the side).
import { LATEST_TEXT_ANIMATION_SPECS, type TextAnimationSide, type TextAnimationSpec } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { cx, DropdownMenu, Icon, IconButton } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { applyMessage, applyTextAnimation, selectedTextClips, writeTextAnimationDrag } from './actions.ts';
import { PresetPreview } from './PresetPreview.tsx';

type NullableStore = {
	getState(): SessionState | null;
	subscribe(l: (s: SessionState | null, p: SessionState | null) => void): () => void;
};
const NO_SESSION_STORE: NullableStore = { getState: () => null, subscribe: () => () => {} };

/** Presets matching the search and category (pure; tests). */
function filterPresets(
	specs: readonly TextAnimationSpec[],
	f: { query: string; category: string | null; side: TextAnimationSide },
): TextAnimationSpec[] {
	const q = f.query.trim().toLowerCase();
	return specs.filter(
		(s) =>
			s.phases.includes(f.side) &&
			(!f.category || s.category === f.category) &&
			(!q || `${s.label} ${s.category} ${s.description} ${s.id}`.toLowerCase().includes(q)),
	);
}

export function TextAnimationsTab() {
	const session = useSessionOrNull();
	const selected = useStoreSelector(
		(session?.store as NullableStore | undefined) ?? NO_SESSION_STORE,
		(s) => {
			const seq = s?.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
			return seq ? s!.selection.timeline.clips.filter((id) => seq.clips[id]?.kind === 'text').length : 0;
		},
	);
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<string | null>(null);
	const [side, setSide] = useState<TextAnimationSide>('in');
	const [message, setMessage] = useState<{ kind: 'info' | 'warning' | 'error'; text: string } | null>(null);
	const categories = useMemo(() => [...new Set(LATEST_TEXT_ANIMATION_SPECS.map((s) => s.category))], []);
	const visible = filterPresets(LATEST_TEXT_ANIMATION_SPECS, { query, category, side });

	const apply = (spec: TextAnimationSpec, as: TextAnimationSide) => {
		if (!session) return;
		const ids = selectedTextClips(session);
		const r = applyTextAnimation(session, ids, { side: as, preset: spec.id, version: spec.version });
		const m = applyMessage(r);
		setMessage(
			m ?? {
				kind: 'info',
				text: `${spec.label} applied as ${as === 'in' ? 'In' : 'Out'} to ${ids.length} clip${ids.length > 1 ? 's' : ''}`,
			},
		);
	};

	const chip = (on: boolean) =>
		cx(
			'rounded-pr-pill border px-1.5 text-pr-small',
			on
				? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
				: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
		);
	return (
		<div
			className="flex h-full min-h-0 flex-col gap-1 p-1 text-pr-ui text-pr-text"
			data-testid="text-animations-tab"
		>
			<label className="flex items-center gap-1 rounded-pr-control bg-pr-field px-1">
				<Icon id="app.search" size={14} />
				<input
					type="search"
					aria-label="Search text animations"
					placeholder="Search text animations"
					className="min-w-0 flex-1 bg-transparent py-0.5 text-pr-ui text-pr-text outline-none placeholder:text-pr-dim"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</label>
			<div className="flex flex-wrap gap-1" role="toolbar" aria-label="Text animation filters">
				{(['in', 'out'] as const).map((s) => (
					<button
						key={s}
						type="button"
						aria-pressed={side === s}
						className={chip(side === s)}
						onClick={() => setSide(s)}
						data-side-chip={s}
					>
						{s === 'in' ? 'In' : 'Out'}
					</button>
				))}
				<span className="mx-0.5 w-px self-stretch bg-pr-border-subtle" />
				{[null, ...categories].map((c) => (
					<button
						key={c ?? 'all'}
						type="button"
						aria-pressed={category === c}
						className={chip(category === c)}
						onClick={() => setCategory(c)}
					>
						{c ?? 'All'}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{visible.length === 0 ? (
					<p className="p-2 text-center text-pr-small text-pr-muted">No text animations match.</p>
				) : (
					<ul
						className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1"
						aria-label="Text animations"
					>
						{visible.map((s) => (
							<li
								key={s.id}
								// biome-ignore lint/a11y/noNoninteractiveTabindex: grid cells are focusable (Enter applies)
								tabIndex={0}
								draggable
								data-text-animation={`${s.id}@${s.version}`}
								aria-label={`${s.label} (${s.category})`}
								title={`${s.label} — ${s.description}\nDouble-click to apply to the selected text clips, or drag onto a text clip`}
								className={cx(
									'group flex cursor-pointer flex-col gap-1 rounded-pr-control border border-pr-border-subtle bg-pr-panel-alt p-1 outline-none',
									'hover:border-pr-border-strong focus-visible:border-pr-focus',
								)}
								onDoubleClick={() => apply(s, side)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										apply(s, side);
									}
								}}
								onDragStart={(e) =>
									writeTextAnimationDrag(e.dataTransfer, { preset: s.id, version: s.version })
								}
							>
								<div className="w-full overflow-hidden rounded-pr-control bg-pr-field-deep">
									<PresetPreview spec={s} side={side} />
								</div>
								<div className="flex items-center gap-1 px-0.5">
									<span className="min-w-0 flex-1 truncate text-pr-ui text-pr-text">{s.label}</span>
									<DropdownMenu
										align="end"
										trigger={
											<IconButton
												icon="app.more"
												label={`${s.label} options`}
												size="small"
												data-testid={`text-anim-menu-${s.id}`}
											/>
										}
										items={[
											{
												type: 'item',
												id: 'in',
												label: 'Apply as In',
												disabled: selected === 0,
												onSelect: () => apply(s, 'in'),
											},
											{
												type: 'item',
												id: 'out',
												label: 'Apply as Out',
												disabled: selected === 0,
												onSelect: () => apply(s, 'out'),
											},
										]}
									/>
								</div>
								<div className="flex gap-1 px-0.5 text-pr-small text-pr-muted">
									<span className="truncate">{s.category}</span>
									<span className="ml-auto shrink-0">{(s.defaultDurationFrames / 30).toFixed(2)} s</span>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
			<footer
				className="flex items-center gap-1 text-pr-small text-pr-dim"
				data-testid="text-animations-status"
			>
				<span className="truncate">
					{message ? (
						<span
							className={
								message.kind === 'error'
									? 'text-pr-danger'
									: message.kind === 'warning'
										? 'text-pr-warning'
										: 'text-pr-muted'
							}
						>
							{message.text}
						</span>
					) : selected === 0 ? (
						'Select text clips, then double-click a preset — or drag it onto a text clip'
					) : selected > 1 ? (
						`${selected} text clips selected · double-click to apply as ${side === 'in' ? 'In' : 'Out'}`
					) : (
						`1 text clip selected · double-click to apply as ${side === 'in' ? 'In' : 'Out'}`
					)}
				</span>
			</footer>
		</div>
	);
}
