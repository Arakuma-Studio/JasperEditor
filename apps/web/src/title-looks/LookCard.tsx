// One look in the grid (TL-086): a poster from the engine (TL-087) and colourway dots. Hovering previews on the selection
// (TL-088); the poster follows the dot under the pointer. No hover state is needed to discover anything: the status line
// of the browser says what a click does.
import type { Colorway, RGBA } from '@jasper/project';
import { ContextMenu, cx, type ResolvedMenuItem } from '@jasper/ui';
import { memo, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { writeLookDrag } from './drag.ts';
import type { LookEntry } from './library.ts';
import {
	DEFAULT_SAMPLE_TEXT,
	type PosterSample,
	type PosterStore,
	posterRequest,
	usePoster,
} from './posters.ts';

const MAX_DOTS = 7;

const css = (c: RGBA | undefined) =>
	c
		? `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})` // tokens-allow: document color
		: 'var(--pr-field)';

/** A colourway as a dot: its face, split with its accent or keyline. */
export function colorwayFill(c: Pick<Colorway, 'palette'>): string {
	const a = css(c.palette.face);
	const b = css(c.palette.accent1 ?? c.palette.keyline ?? c.palette.base ?? c.palette.face);
	return `linear-gradient(135deg, ${a} 0 50%, ${b} 50% 100%)`;
}

type CardProps = {
	entry: LookEntry;
	index: number;
	/** Roving focus: the one card in the tab order. */
	active: boolean;
	width: number;
	height: number;
	x: number;
	y: number;
	posterPx: number;
	/** The selected title's words; null = the look's own sample. */
	sample: PosterSample | null;
	store: PosterStore | null;
	/** Colourway of the selected clip when it has this look. */
	currentColorway?: string;
	onUse(entry: LookEntry, colorway?: Colorway): void;
	onHover(entry: LookEntry | null, colorway?: Colorway): void;
	onFocusCard(index: number): void;
	menu(entry: LookEntry): ResolvedMenuItem[];
};

function LookCardBody(p: CardProps) {
	const { entry } = p;
	const [dot, setDot] = useState<Colorway | null>(null);
	const sample = p.sample ?? { text: entry.sampleText ?? DEFAULT_SAMPLE_TEXT };
	const poster = usePoster(p.store, posterRequest(entry.recipe, dot, sample, p.posterPx));
	const shown = entry.cardColorways.slice(0, MAX_DOTS);
	const more = entry.cardColorways.length - shown.length;
	return (
		<ContextMenu items={() => p.menu(entry)}>
			<li
				// biome-ignore lint/a11y/noNoninteractiveTabindex: grid cells are focusable (Enter uses the look)
				tabIndex={p.active ? 0 : -1}
				draggable
				data-look={entry.lookId}
				data-look-index={p.index}
				data-testid="look-card"
				aria-label={t('{0} ({1})', entry.name, entry.category)}
				className={cx(
					'absolute flex cursor-pointer flex-col gap-1 overflow-hidden rounded-pr-control border bg-pr-panel-alt p-1 outline-none',
					'border-pr-border-subtle hover:border-pr-border-strong focus-visible:border-pr-focus',
				)}
				style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
				onClick={() => p.onUse(entry)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						p.onUse(entry);
					}
				}}
				onFocus={() => {
					p.onFocusCard(p.index);
					p.onHover(entry);
				}}
				onBlur={() => p.onHover(null)}
				onPointerEnter={() => p.onHover(entry)}
				onPointerLeave={() => {
					setDot(null);
					p.onHover(null);
				}}
				onDragStart={(e) => {
					p.onHover(null);
					writeLookDrag(e.dataTransfer, entry.lookId);
				}}
			>
				<div
					className="relative aspect-video w-full shrink-0 overflow-hidden rounded-pr-control bg-pr-field-deep"
					data-poster={poster.state}
				>
					{poster.state === 'ready' ? (
						<img src={poster.url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
					) : poster.state === 'error' ? (
						<span
							className="absolute inset-0 flex items-center justify-center p-1 text-center text-pr-small text-pr-muted"
							title={poster.message}
							data-testid="look-poster-error"
						>
							No preview: {poster.message}
						</span>
					) : (
						<span className="absolute inset-0 flex items-center justify-center text-pr-small text-pr-dim">
							Rendering…
						</span>
					)}
				</div>
				<div className="flex min-w-0 items-center gap-1 px-0.5">
					<span className="min-w-0 flex-1 truncate text-pr-ui text-pr-text">{entry.name}</span>
					{entry.source === 'project' ? (
						<span className="shrink-0 text-pr-small text-pr-muted" title="Saved in this project">
							Project
						</span>
					) : null}
				</div>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: stops a dot's click from also using the card */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: the dots are buttons of their own */}
				<div
					className="flex h-[14px] items-center gap-[3px] px-0.5"
					onClick={(e) => e.stopPropagation()}
					data-testid="look-colorways"
				>
					{shown.map((c) => (
						<button
							key={c.id}
							type="button"
							tabIndex={-1}
							aria-label={t('{0} in {1}', entry.name, c.name)}
							title={c.name}
							data-colorway={c.id}
							aria-pressed={p.currentColorway === c.id}
							className={cx(
								'size-[12px] shrink-0 rounded-pr-pill border',
								p.currentColorway === c.id ? 'border-pr-focus' : 'border-pr-border-strong',
							)}
							style={{ background: colorwayFill(c) }}
							onPointerEnter={() => {
								setDot(c);
								p.onHover(entry, c);
							}}
							onPointerLeave={() => {
								setDot(null);
								p.onHover(entry);
							}}
							onClick={() => p.onUse(entry, c)}
						/>
					))}
					{more > 0 ? <span className="text-pr-small text-pr-muted">+{more}</span> : null}
				</div>
			</li>
		</ContextMenu>
	);
}

export const LookCard = memo(LookCardBody);
