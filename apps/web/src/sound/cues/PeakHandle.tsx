// The peak handle of an SFX clip (spec 12 §2.7): a 1 px `--pr-accent` line at the sound's peak and a 7 px diamond at
// the top of the clip body (hidden below 24 px of width or 32 px of height). Dragging the diamond moves the clip (and
// the clips grouped with it) so that its peak snaps — the peak only, not the clip's edges — to the timeline's targets
// (cues, markers, the playhead…). Shift-dragging moves the peak inside the clip instead: a peak override written with
// `soundDesign.setPeak` (one undo step). Tooltip "Peak <tc> · <s> into <name>".
import {
	type AudioClip,
	type Clip,
	type Command,
	formatTimecode,
	type MediaAsset,
	type Rational,
	type Sequence,
} from '@jasper/project';
import type { Gesture } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react';
import type { ClipDecorationProps } from '../../extensions/index.ts';
import { t } from '../../i18n/runtime.ts';
import { activeTimeline, useTimelineEnv } from '../../panels/timeline/env.tsx';
import { collectSnapTargets, findSnap, thresholdFrames } from '../../panels/timeline/model/snapping.ts';
import { deltaFramesFromPx } from '../../panels/timeline/model/viewport.ts';
import {
	clipPeakFlicks,
	contentFlicksAt,
	PEAK_DIAMOND_PX,
	peakFrameOf,
	peakHandleGeom,
	peakSecondsIntoSound,
} from './model.ts';

type Drag = {
	pointerId: number;
	mode: 'move' | 'peak';
	x0: number;
	moved: boolean;
	delta: number;
	gesture: Gesture | null;
	ids: string[];
	peak0: number;
	targets: ReturnType<typeof collectSnapTargets>;
	/** Removes the drag's Esc listener. */
	offKeys: () => void;
};

function sequenceOf(clips: Record<string, Sequence>, clipId: string): Sequence | null {
	for (const s of Object.values(clips)) if (s.clips[clipId]) return s;
	return null;
}

const fmt = (sec: number) => (sec < 10 ? sec.toFixed(3) : sec.toFixed(2));

export function PeakHandle(p: ClipDecorationProps) {
	const session = useSessionOrNull();
	const media = useSessionState((s) => {
		const id = (p.clip as { mediaId?: string }).mediaId;
		return id ? ((s.transient ?? s.document).media[id] as MediaAsset | undefined) : undefined;
	});
	const drag = useRef<Drag | null>(null);
	const env = useTimelineEnv();
	// The handle unmounts when its clip is culled or hidden (dragged out of view, the Timeline closed): the drag's
	// gesture is cancelled with it, never left holding the session (Undo, agents' edits, autosave).
	useEffect(
		() => () => {
			const d = drag.current;
			drag.current = null;
			d?.offKeys();
			d?.gesture?.cancel();
		},
		[],
	);
	const clip = p.clip as Clip;
	const pk = clipPeakFlicks(clip as never, media);
	if (!pk || !session) return null;
	const peakFrame = peakFrameOf(clip as never, pk.flicks, p.rate);
	const geom = peakHandleGeom(clip as never, peakFrame, {
		w: p.w,
		height: p.height,
		pxPerFrame: p.pxPerFrame,
	});
	if (!geom?.visible || peakFrame === null) return null;
	const seq = sequenceOf(session.getCommitted().sequences as Record<string, Sequence>, clip.id);
	const tc = seq
		? formatTimecode(Math.floor(peakFrame), p.rate as Rational, {
				dropFrame: seq.settings.dropFrame,
				startFrames: seq.settings.startTimecodeFrames,
			})
		: '';
	const name = (media as { library?: { title?: string } } | undefined)?.library?.title || clip.name;
	const tip = t('Peak {0} · {1} s into {2}', tc, fmt(peakSecondsIntoSound(pk.flicks, media)), name);
	const hint = t('Drag to move the clip by its peak; Shift-drag to set the peak');
	const readOnly = session.getState().readOnly || p.trackLocked;

	const ui = () => activeTimeline()?.ui ?? null;
	const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		if (readOnly || !seq) return;
		const group = clip.groupId ? (seq.groups[clip.groupId]?.members ?? []) : [];
		const ids = [...new Set([clip.id, ...group])].filter((id) => !!seq.clips[id]);
		e.currentTarget.setPointerCapture?.(e.pointerId);
		// Esc cancels the drag, as every timeline drag (S02:TL-903)
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape' || !drag.current) return;
			ev.preventDefault();
			ev.stopPropagation();
			onUp(false);
		};
		window.addEventListener('keydown', onKey, true);
		drag.current = {
			offKeys: () => window.removeEventListener('keydown', onKey, true),
			pointerId: e.pointerId,
			mode: e.shiftKey ? 'peak' : 'move',
			x0: e.clientX,
			moved: false,
			delta: 0,
			gesture: null,
			ids,
			peak0: peakFrame,
			targets: collectSnapTargets(seq, {
				exclude: new Set(ids),
				playhead: session.transport.getState().frame,
			}),
		};
	};
	const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d || d.pointerId !== e.pointerId || !seq) return;
		const dx = e.clientX - d.x0;
		if (!d.moved && Math.abs(dx) < 3) return;
		d.moved = true;
		let commands: Command[];
		let lines: string[];
		let snapFrame: number | null = null;
		if (d.mode === 'move') {
			const raw = deltaFramesFromPx(dx, p.pxPerFrame);
			let delta = raw;
			if (session.getState().toggles.snapping) {
				const s = findSnap(d.targets, [Math.floor(d.peak0) + raw], thresholdFrames(p.pxPerFrame));
				if (s) {
					delta = raw + s.offset;
					snapFrame = s.target.frame;
				}
			}
			const minStart = Math.min(...d.ids.map((id) => seq.clips[id]!.start));
			if (minStart + delta < 0) {
				delta = -minStart;
				snapFrame = null;
			}
			if (delta === d.delta && d.gesture) return;
			d.delta = delta;
			commands = delta ? [{ type: 'clip.move', clipIds: d.ids, deltaFrames: delta, mode: 'overwrite' }] : [];
			lines = [
				t(
					'Peak → {0}',
					formatTimecode(Math.floor(d.peak0) + delta, p.rate, { dropFrame: seq.settings.dropFrame }),
				),
			];
		} else {
			const frame = Math.min(clip.start + clip.duration, Math.max(clip.start, d.peak0 + dx / p.pxPerFrame));
			const flicks = contentFlicksAt(clip as never, frame, p.rate);
			commands = [{ type: 'soundDesign.setPeak', clipId: clip.id, peakFlicks: flicks } as Command];
			lines = [t('Set peak: {0} s into {1}', fmt(peakSecondsIntoSound(flicks, media)), name)];
		}
		ui()?.setState({ snapFrame, tooltip: null });
		if (!d.gesture) {
			try {
				d.gesture = session.beginGesture(d.mode === 'move' ? t('Move Clip by Peak') : t('Set Peak'));
			} catch {
				drag.current = null;
				d.offKeys();
				return;
			}
		}
		const r = d.gesture.update(commands);
		if (!r.ok) lines = [r.errors[0]?.message ?? ''];
		e.currentTarget.title = lines.join('\n');
	};
	const onUp = (commit: boolean) => {
		const d = drag.current;
		drag.current = null;
		ui()?.setState({ snapFrame: null });
		d?.offKeys();
		if (!d?.gesture) return;
		if (!commit || (d.mode === 'move' && d.delta === 0)) {
			d.gesture.cancel();
			return;
		}
		const r = d.gesture.commit();
		if (r && !r.ok) env.toast({ kind: 'warning', message: r.errors[0]?.message ?? t('Edit failed') });
	};

	const x = geom.x;
	const half = PEAK_DIAMOND_PX / 2;
	return (
		<>
			<div
				className="pointer-events-none absolute top-0 bottom-0"
				style={{ left: x - 0.5, width: 1, background: 'var(--pr-accent)' }}
				data-peak-line={(clip as AudioClip).id}
				aria-hidden="true"
			/>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer handle; the same edits are commands (Align Peak to Playhead, soundDesign.setPeak) */}
			<div
				className="absolute"
				style={{
					left: x - half - 2,
					top: 0,
					width: PEAK_DIAMOND_PX + 4,
					height: PEAK_DIAMOND_PX + 2,
					cursor: readOnly ? 'default' : 'ew-resize',
					pointerEvents: 'auto',
				}}
				title={`${tip}\n${hint}`}
				onPointerDown={onDown}
				onPointerMove={onMove}
				onPointerUp={() => onUp(true)}
				onPointerCancel={() => onUp(false)}
				onDoubleClick={(e) => e.stopPropagation()}
				data-peak-handle={clip.id}
				data-peak-override={pk.override || undefined}
			>
				<svg
					width={PEAK_DIAMOND_PX + 4}
					height={PEAK_DIAMOND_PX + 2}
					viewBox={`${-half - 2} 0 ${PEAK_DIAMOND_PX + 4} ${PEAK_DIAMOND_PX + 2}`}
					aria-hidden="true"
				>
					<polygon
						points={`0,0 ${half},${half} 0,${PEAK_DIAMOND_PX} ${-half},${half}`}
						fill="var(--pr-accent)"
						stroke="var(--pr-text-strong)"
						strokeWidth={0.75}
					/>
				</svg>
			</div>
		</>
	);
}
