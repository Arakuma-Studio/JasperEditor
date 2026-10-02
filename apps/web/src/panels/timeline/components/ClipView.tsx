// One clip body (S02 §7: TL-320…334; S05:TLC-040/041). DOM body positioned with translateX in viewport
// coordinates (TL-153); filmstrip and waveform drawn into ≤ 512 px canvas tiles positioned from exact
// time so they never drift from the clip edges (TL-102, TL-158). Registered `clipDecorations` add badges to
// the name strip and overlays to the body (S09:TRU-005 tracker/link glyphs, ARCHITECTURE §19.10).
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	clipEngines,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	kindCapabilities,
	type MediaAsset,
	type Rational,
} from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';
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
import { filmstripSlots, nearestTile, tileRect } from '../model/filmstrip.ts';
import { snapPx } from '../model/viewport.ts';
import { drawGain, waveBars } from '../model/waveform.ts';
import type { ThumbnailStyle } from '../state/prefs.ts';
import { CanvasTiles, cssVar, dpr, type TileDraw } from './canvas.tsx';

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
	/** Unrounded clip-area x of the clip start and its width (viewport px). */
	x: number;
	w: number;
	height: number;
	viewportWidth: number;
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

function nameFor(c: Clip, linked: boolean, isAudio: boolean): string {
	let s = c.name;
	if (linked) s += isAudio ? ' [A]' : ' [V]';
	if (c.speed.rate !== 1) s += ` ${Math.round(c.speed.rate * 10000) / 100}%`;
	if (c.speed.reverse) s += ' (reversed)';
	return s;
}

function ClipViewImpl(p: ClipViewProps) {
	const c = p.clip;
	const caps = kindCapabilities(c.kind);
	// M2 (wp-m2-mg): engine badge state from the extension providers (e.g. Remotion master cached → ✓).
	const extBadge = useClipBadge(c);
	const decorations = decorationsFor(useRegistry(clipDecorations), c);
	const isAudio = caps ? !caps.visual && caps.audio : false;
	const dprv = dpr();
	const xr = snapPx(p.x, dprv);
	const wr = Math.max(1 / dprv, snapPx(p.x + p.w, dprv) - xr);

	// Visible part of the clip (plus overscan) in clip-area px.
	const vis0 = Math.max(p.x, -OVERSCAN_PX);
	const vis1 = Math.min(p.x + p.w, p.viewportWidth + OVERSCAN_PX);
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
			const slots =
				c.kind === 'still'
					? [{ x: p.x, w: contentH * aspect, timeSec: 0 }]
					: filmstripSlots({
							start: c.start,
							duration: c.duration,
							sourceIn: c.sourceIn,
							rate: c.speed.rate,
							reverse: c.speed.reverse,
							scrollFrame: p.scrollFrame,
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
				Math.max(p.x, tile.x0),
				contentTop,
				Math.min(p.x + p.w, tile.x0 + tile.width) - Math.max(p.x, tile.x0),
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
		[sprite, c, p.x, p.w, p.scrollFrame, p.pxPerFrame, p.rate, contentH, p.display.thumbnails],
	);

	const drawWave = useCallback<TileDraw>(
		(ctx, tile) => {
			if (!peaks) return;
			const F = flicksPerFrame(p.rate);
			const secPerPx = (F * c.speed.rate) / FLICKS_PER_SECOND / p.pxPerFrame;
			const x0 = Math.max(tile.x0, p.x);
			const x1 = Math.min(tile.x0 + tile.width, p.x + p.w);
			const columns = Math.max(0, Math.ceil(x1 - x0));
			if (columns === 0) return;
			const frameAt = (x: number) => p.scrollFrame + x / p.pxPerFrame - c.start;
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
		[peaks, c, p.x, p.w, p.scrollFrame, p.pxPerFrame, p.rate, contentH, p.display.rectified],
	);

	// Level of detail (TL-154).
	if (p.w < 2) {
		return (
			<div
				className="pointer-events-none absolute top-0 left-0"
				data-clip-id={c.id}
				style={{
					transform: `translateX(${xr}px)`,
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
				x: p.x,
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
	const nameOffset = Math.max(0, -p.x);
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
				transform: `translateX(${xr}px)`,
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
					x0={vis0}
					x1={vis1}
					height={p.height}
					originX={p.x}
					draw={drawThumbs}
					version={p.mediaVersion}
				/>
			) : null}
			{showWave && peaks ? (
				<CanvasTiles
					x0={vis0}
					x1={vis1}
					height={p.height}
					originX={p.x}
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
							{p.offline ? `Media Offline · ${c.name}` : nameFor(c, p.linked, isAudio)}
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

export const ClipView = memo(ClipViewImpl);
