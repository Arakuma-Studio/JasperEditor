// One clip body (S02 §7: TL-320…334; S05:TLC-040/041). DOM body positioned in content px on its track's scroll
// layer, which the scroll moves (TL-153; ui-perf: `left`, not a transform per clip — hundreds of compositor transform
// nodes made every repaint pay for layerization); filmstrip and waveform drawn into ≤ 512 px canvas tiles positioned from exact
// time so they never drift from the clip edges (TL-102, TL-158). Registered `clipDecorations` add badges to
// the name strip and overlays to the body (S09:TRU-005 tracker/link glyphs, ARCHITECTURE §19.10).
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	clipEngines,
	clipMediaTimeAt,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	isMulticamClip,
	isRemapped,
	kindCapabilities,
	type MediaAsset,
	multicamBadge,
	multicamSourceOf,
	type Rational,
	type TimedClip,
} from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';
import { useSessionOrNull } from '@jasper/session/react';
import { labelColor } from '@jasper/ui';
import { memo, useCallback } from 'react';
import {
	type ClipDecorationDef,
	type ClipDecorationProps,
	clipDecorations,
	decorationsFor,
} from '../../../extensions/index.ts';
import { useClipBadge, useRegistry } from '../../../extensions/react.ts';
import { TextAnimationWedges } from '../../../text-animation/TextAnimationWedges.tsx';
import { peaksFor, reducePeaks, sheetImage, spriteFor } from '../media/media-cache.ts';
import { filmstripSlots, mappedFilmstripSlots, nearestTile, tileRect } from '../model/filmstrip.ts';
import { snapPx } from '../model/viewport.ts';
import { drawGain, waveBars } from '../model/waveform.ts';
import type { ThumbnailStyle } from '../state/prefs.ts';
import { CanvasTiles, cssVar, dpr, TILE_MAX_PX, type TileDraw } from './canvas.tsx';

const NAME_STRIP_PX = 14;
const OVERSCAN_PX = 256;

export type ClipDisplay = {
	thumbnails: ThumbnailStyle;
	videoNames: boolean;
	audioNames: boolean;
	waveforms: boolean;
	rectified: boolean;
	fxBadges: boolean;
	engineBadges: boolean;
	labelColors: boolean;
	clipMarkers: boolean;
};

type ClipViewProps = {
	clip: Clip;
	/**
	 * ui-perf: unrounded x of the clip start in content px (`start × px per frame`) and its width. The track's clip
	 * layer is moved by `scrollPx`, so a scroll changes no clip position (ClipView skips it when nothing it draws
	 * depends on the scroll, `clipViewEqual`).
	 */
	x: number;
	w: number;
	height: number;
	viewportWidth: number;
	/** Scroll offset of the clip layer (content px, snapped to device pixels) and the matching first frame. */
	scrollPx: number;
	scrollFrame: number;
	pxPerFrame: number;
	rate: Rational;
	selected: boolean;
	trackLocked: boolean;
	trackDimmed: boolean;
	linked: boolean;
	syncOffset: number | null;
	offline: boolean;
	flash: boolean;
	asset: MediaAsset | undefined;
	runtime: MediaRuntime | undefined;
	engine: EngineClient | null;
	display: ClipDisplay;
	/** Changes when sprite/peaks data arrives, to redraw tiles. */
	mediaVersion: number;
};

function nameFor(c: Clip, linked: boolean, isAudio: boolean, mcBadge = ''): string {
	let s = mcBadge ? `[${mcBadge}] ${c.name}` : c.name;
	if (linked) s += isAudio ? ' [A]' : ' [V]';
	if (isRemapped(c as TimedClip)) s += ' (time remapped)';
	else {
		if (c.speed.rate !== 1) s += ` ${Math.round(c.speed.rate * 10000) / 100}%`;
		if (c.speed.reverse) s += ' (reversed)';
	}
	return s;
}

function ClipViewImpl(p: ClipViewProps) {
	const c = p.clip;
	const caps = kindCapabilities(c.kind);
	// M2 (wp-m2-mg): engine badge state from the extension providers (e.g. Remotion master cached → ✓).
	const extBadge = useClipBadge(c);
	const decorations = decorationsFor(useRegistry(clipDecorations), c);
	const isAudio = caps ? !caps.visual && caps.audio : false;
	// wp-multicam: Premiere labels multi-camera clips "[MC<camera>] name".
	const session = useSessionOrNull();
	const mcBadge =
		session && isMulticamClip(c)
			? multicamBadge(multicamSourceOf(session.getCommitted().sequences[c.sequenceId]), c)
			: '';
	const dprv = dpr();
	const xr = snapPx(p.x, dprv);
	const wr = Math.max(1 / dprv, snapPx(p.x + p.w, dprv) - xr);
	/** The clip start in viewport px (what decorations and the sticky name work with). */
	const vx = p.x - p.scrollPx;
	// Canvas tiles in clip-local px, aligned to the tile size, covering the visible part (plus overscan): scrolling
	// moves them with the clip and redraws only tiles that come into view (ui-perf).
	const [tile0, tile1] = visibleTiles(p);
	const contentTop = NAME_STRIP_PX;
	const contentH = Math.max(0, p.height - NAME_STRIP_PX - 1);
	const hasMedia = !!(c as { mediaId?: string }).mediaId;
	const showThumbs =
		!isAudio &&
		hasMedia &&
		p.display.thumbnails !== 'off' &&
		p.height >= 40 &&
		p.w >= 40 &&
		(c.kind === 'video' || c.kind === 'still' || c.kind === 'animated-image');
	const showWave = isAudio && hasMedia && p.display.waveforms && p.height >= 32 && p.w >= 12;
	const sprite = showThumbs ? spriteFor(p.engine, p.asset, p.runtime) : null;
	const peaks = showWave
		? peaksFor(
				p.engine,
				p.asset,
				p.runtime,
				(c as { channels?: { streamIndex: number } }).channels?.streamIndex ?? 0,
			)
		: null;

	const drawThumbs = useCallback<TileDraw>(
		(ctx, tile) => {
			if (!sprite) return;
			const aspect = sprite.index.tileWidth / sprite.index.tileHeight;
			// Clip-local px: the viewport of the slot functions starts at the clip start.
			const slots =
				c.kind === 'still'
					? [{ x: 0, w: contentH * aspect, timeSec: 0 }]
					: isRemapped(c as TimedClip)
						? mappedFilmstripSlots({
								start: c.start,
								duration: c.duration,
								scrollFrame: c.start,
								pxPerFrame: p.pxPerFrame,
								visibleX0: tile.x0,
								visibleX1: tile.x0 + tile.width,
								slotWidth: contentH * aspect,
								mediaSecondsAt: (f) => clipMediaTimeAt(c as TimedClip, f, p.rate) / FLICKS_PER_SECOND,
							})
						: filmstripSlots({
								start: c.start,
								duration: c.duration,
								sourceIn: c.sourceIn,
								rate: c.speed.rate,
								reverse: c.speed.reverse,
								scrollFrame: c.start,
								pxPerFrame: p.pxPerFrame,
								visibleX0: tile.x0,
								visibleX1: tile.x0 + tile.width,
								slotWidth: contentH * aspect,
								fps: p.rate,
								style: p.display.thumbnails === 'off' ? 'continuous' : p.display.thumbnails,
							});
			ctx.save();
			ctx.beginPath();
			ctx.rect(
				Math.max(0, tile.x0),
				contentTop,
				Math.min(p.w, tile.x0 + tile.width) - Math.max(0, tile.x0),
				contentH,
			);
			ctx.clip();
			ctx.globalAlpha = 0.7;
			for (const s of slots) {
				const t = nearestTile(sprite.index, s.timeSec);
				if (!t) continue;
				const img = sheetImage(sprite.sheetUrl(t.sheet));
				if (!img) continue;
				const r = tileRect(sprite.index, t);
				ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, s.x, contentTop, s.w, contentH);
			}
			ctx.restore();
		},
		[sprite, c, p.w, p.pxPerFrame, p.rate, contentH, p.display.thumbnails],
	);

	const drawWave = useCallback<TileDraw>(
		(ctx, tile) => {
			if (!peaks) return;
			const F = flicksPerFrame(p.rate);
			const secPerPx = (F * c.speed.rate) / FLICKS_PER_SECOND / p.pxPerFrame;
			const x0 = Math.max(tile.x0, 0);
			const x1 = Math.min(tile.x0 + tile.width, p.w);
			const columns = Math.max(0, Math.ceil(x1 - x0));
			if (columns === 0) return;
			// Clip-local px.
			const frameAt = (x: number) => x / p.pxPerFrame;
			const startSec = c.speed.reverse
				? (c.sourceIn + (c.duration - frameAt(x0)) * F * c.speed.rate) / FLICKS_PER_SECOND
				: (c.sourceIn + frameAt(x0) * F * c.speed.rate) / FLICKS_PER_SECOND;
			const req = {
				startSec,
				secPerColumn: c.speed.reverse ? -secPerPx : secPerPx,
				columns,
				peaksPerSecond: peaks.header.peaksPerSecond,
			};
			const stereo = peaks.channels.length > 1 && contentH >= 64 - NAME_STRIP_PX;
			const token = `${Math.random()}`;
			ctx.canvas.dataset.token = token;
			const a = c as { gainDb?: number; volumeDb?: { value: number } };
			const gain = drawGain(a.gainDb ?? 0, a.volumeDb?.value ?? 0);
			const fill = labelTintVar(ctx.canvas, c.label);
			const danger = cssVar(ctx.canvas, '--pr-danger');
			const style = p.display.rectified ? 'rectified' : 'centered';
			void Promise.all(
				peaks.channels.length > 1
					? [reducePeaks(peaks, 0, req), reducePeaks(peaks, 1, req)]
					: [reducePeaks(peaks, 0, req)],
			).then((cols) => {
				if (ctx.canvas.dataset.token !== token) return;
				const lanes = stereo
					? [
							{ cols: cols[0]!, top: contentTop, height: contentH / 2 },
							{ cols: cols[1]!, top: contentTop + contentH / 2, height: contentH / 2 },
						]
					: [
							{
								cols: cols.length > 1 ? maxOf(cols[0]!, cols[1]!) : cols[0]!,
								top: contentTop,
								height: contentH,
							},
						];
				for (const lane of lanes) {
					for (const b of waveBars(
						lane.cols,
						{ x: x0, top: lane.top, height: lane.height },
						gain,
						style,
						'log',
					)) {
						ctx.fillStyle = fill;
						ctx.fillRect(b.x, b.top, 1, b.height);
						if (b.clipped && danger) {
							ctx.fillStyle = danger;
							ctx.fillRect(b.x, b.top, 1, Math.min(2, b.height));
						}
					}
				}
			});
		},
		[peaks, c, p.w, p.pxPerFrame, p.rate, contentH, p.display.rectified],
	);

	// Level of detail (TL-154).
	if (p.w < 2) {
		return (
			<div
				className="pointer-events-none absolute top-0 left-0"
				data-clip-id={c.id}
				style={{
					left: xr,
					width: 1,
					height: p.height,
					background: p.display.labelColors ? labelColor(c.label) : 'var(--pr-border-strong)',
				}}
			/>
		);
	}
	const showName = p.w >= 12 && (isAudio ? p.display.audioNames : p.display.videoNames);
	const showBadges = p.w >= 40;
	const decoBadges = showBadges ? decorations.filter((d) => d.badge) : [];
	const decoOverlays = decorations.filter((d) => d.overlay);
	const decoProps: ClipDecorationProps | null = decorations.length
		? {
				clip: c,
				x: vx,
				w: p.w,
				height: p.height,
				viewportWidth: p.viewportWidth,
				scrollFrame: p.scrollFrame,
				pxPerFrame: p.pxPerFrame,
				rate: p.rate,
				selected: p.selected,
				trackLocked: p.trackLocked,
			}
		: null;
	// M2 (S11:ATP-002): per clip, so anime templates show R.
	const badge = clipEngines(c)?.badge ?? null;
	const hasFx = ((c as { effects?: unknown[] }).effects?.length ?? 0) > 0;
	const nameOffset = nameShift(p);
	const body = p.offline
		? 'var(--pr-offline-clip)'
		: p.display.labelColors
			? labelColor(c.label)
			: 'var(--pr-bg-panel-raised)';
	const F = flicksPerFrame(p.rate);
	return (
		<div
			className="absolute top-0 left-0 overflow-hidden rounded-pr-clip"
			data-clip-id={c.id}
			data-selected={p.selected || undefined}
			style={{
				left: xr,
				width: wr,
				height: p.height - 1,
				background: body,
				opacity: !c.enabled ? 'var(--pr-disabled-clip-opacity)' : p.trackDimmed ? 0.55 : 1,
				boxShadow: p.selected
					? 'inset 0 0 0 2px var(--pr-text-strong)'
					: p.flash
						? 'inset 0 0 0 2px var(--pr-agent)'
						: `inset 0 0 0 1px color-mix(in srgb, ${body} 80%, var(--pr-bg-app))`,
				filter: p.selected ? 'brightness(1.12)' : undefined,
			}}
		>
			{showThumbs && sprite ? (
				<CanvasTiles
					x0={tile0}
					x1={tile1}
					height={p.height}
					originX={0}
					draw={drawThumbs}
					version={p.mediaVersion}
				/>
			) : null}
			{showWave && peaks ? (
				<CanvasTiles
					x0={tile0}
					x1={tile1}
					height={p.height}
					originX={0}
					draw={drawWave}
					version={p.mediaVersion}
				/>
			) : null}
			{showName || decoBadges.length ? (
				<div
					className="pointer-events-none absolute top-0 right-0 flex h-[14px] items-center gap-1 pr-1 text-[11px] leading-[14px] text-pr-strong"
					style={{ left: nameOffset, paddingLeft: 4 }}
				>
					{showName ? (
						<span className="min-w-0 flex-1 truncate">
							{p.offline ? `Media Offline · ${c.name}` : nameFor(c, p.linked, isAudio, mcBadge)}
						</span>
					) : (
						<span className="flex-1" />
					)}
					{decoProps ? decoBadges.map((d) => <DecorationBadge key={d.id} def={d} props={decoProps} />) : null}
					{showName && showBadges && p.syncOffset ? (
						<span
							className="shrink-0 rounded-[2px] px-[3px] text-[10px] leading-[12px] text-pr-strong"
							style={{ background: 'var(--pr-danger)' }}
							title="Out of sync (frames)"
						>
							{p.syncOffset > 0 ? `+${p.syncOffset}` : p.syncOffset}
						</span>
					) : null}
					{showName && showBadges && p.display.fxBadges && hasFx ? (
						<span className="shrink-0 text-[10px] text-pr-strong opacity-80" title="Effects applied">
							fx
						</span>
					) : null}
					{showName && showBadges && p.display.engineBadges && badge ? (
						<span
							className="shrink-0 text-[10px] font-semibold text-pr-strong opacity-70"
							title={extBadge?.title ?? (badge === 'R' ? 'Rendered by Remotion' : 'Rendered by fframes')}
							data-engine-badge={badge}
							data-engine-badge-state={extBadge?.tone}
						>
							{extBadge?.text ?? badge}
						</span>
					) : null}
				</div>
			) : null}
			{p.display.clipMarkers && showBadges
				? c.markers.map((m) => {
						const rel = c.speed.reverse
							? c.duration - (m.flicks - c.sourceIn) / (F * c.speed.rate)
							: (m.flicks - c.sourceIn) / (F * c.speed.rate);
						if (rel < 0 || rel > c.duration) return null;
						return (
							<div
								key={m.id}
								className="pointer-events-none absolute top-[14px] w-[2px]"
								style={{
									left: rel * p.pxPerFrame,
									height: 6,
									background: `var(--pr-marker-${markerVar(m.color)})`,
								}}
								title={m.name}
							/>
						);
					})
				: null}
			{/* M2 (wp-m2-text-anim, S11:TXA-023): In/Out wedges of animated text clips. */}
			<TextAnimationWedges clip={c} pxPerFrame={p.pxPerFrame} height={p.height} />
			{decoProps ? decoOverlays.map((d) => <DecorationOverlay key={d.id} def={d} props={decoProps} />) : null}
			{p.trackLocked ? (
				<div
					className="pointer-events-none absolute inset-0"
					style={{ background: 'var(--pr-locked-hatch)' }}
				/>
			) : null}
		</div>
	);
}

function DecorationBadge({ def, props }: { def: ClipDecorationDef; props: ClipDecorationProps }) {
	const Badge = def.badge!;
	return <Badge {...props} />;
}

function DecorationOverlay({ def, props }: { def: ClipDecorationDef; props: ClipDecorationProps }) {
	const Overlay = def.overlay!;
	return <Overlay {...props} />;
}

function maxOf(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(Math.max(a.length, b.length));
	for (let i = 0; i < out.length; i++) out[i] = Math.max(a[i] ?? 0, b[i] ?? 0);
	return out;
}

function labelTintVar(el: Element, label: Clip['label']): string {
	return cssVar(el, `--pr-label-${label}-tint`) || cssVar(el, '--pr-text-primary');
}

/** Maps label colors to the 8 marker token colors (TL-790 uses 8 marker colors). */
export function markerVar(color: string): string {
	const map: Record<string, string> = {
		green: 'green',
		forest: 'green',
		caribbean: 'green',
		rose: 'red',
		magenta: 'red',
		purple: 'purple',
		violet: 'purple',
		lavender: 'purple',
		mango: 'orange',
		brown: 'orange',
		tan: 'orange',
		yellow: 'yellow',
		blue: 'blue',
		iris: 'blue',
		cerulean: 'cyan',
		teal: 'cyan',
	};
	return map[color] ?? 'green';
}

/**
 * How far the name strip is pushed right so the name stays in view when the clip starts left of the viewport, at most
 * the clip's width (past that the strip has no width either way, and a scroll does not change it).
 */
function nameShift(p: Pick<ClipViewProps, 'x' | 'w' | 'scrollPx'>): number {
	return Math.min(p.w, Math.max(0, p.scrollPx - p.x));
}

/**
 * The clip-local range of canvas tiles to draw: the visible part of the clip plus the overscan, widened to whole tiles
 * (so it changes only when a tile boundary scrolls into view).
 */
function visibleTiles(p: Pick<ClipViewProps, 'x' | 'w' | 'scrollPx' | 'viewportWidth'>): [number, number] {
	const lo = Math.max(0, p.scrollPx - OVERSCAN_PX - p.x);
	const hi = Math.min(p.w, p.scrollPx + p.viewportWidth + OVERSCAN_PX - p.x);
	if (hi <= lo) return [0, 0];
	return [
		Math.floor(lo / TILE_MAX_PX) * TILE_MAX_PX,
		Math.min(p.w, Math.ceil(hi / TILE_MAX_PX) * TILE_MAX_PX),
	];
}

/**
 * ui-perf: a scroll changes only `scrollPx` / `scrollFrame`; the clip re-renders for it only when something it draws
 * depends on the scroll: the sticky name of a clip crossing the left edge, the canvas tiles in view, decorations
 * (they work in viewport px).
 */
function clipViewEqual(a: ClipViewProps, b: ClipViewProps): boolean {
	for (const k of Object.keys(a) as (keyof ClipViewProps)[]) {
		if (k === 'scrollPx' || k === 'scrollFrame') continue;
		if (a[k] !== b[k]) return false;
	}
	if (a.scrollPx === b.scrollPx && a.scrollFrame === b.scrollFrame) return true;
	if (nameShift(a) !== nameShift(b)) return false;
	// Only clips of media draw canvas tiles (thumbnails, waveforms).
	if ((b.clip as { mediaId?: string }).mediaId) {
		const ta = visibleTiles(a);
		const tb = visibleTiles(b);
		if (ta[0] !== tb[0] || ta[1] !== tb[1]) return false;
	}
	return decorationsFor(clipDecorations.list(), b.clip).length === 0;
}

export const ClipView = memo(ClipViewImpl, clipViewEqual);
