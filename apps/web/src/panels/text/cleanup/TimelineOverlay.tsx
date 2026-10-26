// Timeline colours during a Clean Up review (spec 14 TC-041): what the plan cuts (across every track), the pauses it
// keeps inside pieces and the padding it leaves at their edges (on the speech clips' tracks). Drawn over the track
// area, never intercepting the pointer; only while reviewing the sequence shown and the review is current.
import type { Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { useMemo } from 'react';
import { t } from '../../../i18n/runtime.ts';
import { rowOf, type TrackAreaLayout } from '../../timeline/model/layout.ts';
import { frameToX, type Viewport } from '../../timeline/model/viewport.ts';
import { cleanupFor } from './controller.ts';
import { type OverlayBand, overlayBands } from './model.ts';

export const OVERLAY_COLORS = {
	cut: 'color-mix(in srgb, var(--pr-danger) 30%, transparent)',
	pause: 'color-mix(in srgb, var(--pr-warning) 40%, transparent)',
	padding: 'color-mix(in srgb, var(--pr-success) 35%, transparent)',
} as const;

export function CleanupTimelineOverlay(p: {
	session: EditorSession;
	seq: Sequence;
	layout: TrackAreaLayout;
	viewport: Viewport;
}) {
	const c = cleanupFor(p.session);
	const st = useStoreSelector(
		c.store,
		(s) => ({ analysis: s.analysis, mode: s.mode, seqId: s.sequenceId, stale: s.stale, phase: s.phase }),
		(a, b) =>
			a.analysis === b.analysis &&
			a.mode === b.mode &&
			a.seqId === b.seqId &&
			a.stale === b.stale &&
			a.phase === b.phase,
	);
	const active =
		st.phase === 'review' && st.mode === 'cleanup' && !st.stale && st.seqId === p.seq.id && !!st.analysis;
	const bands = useMemo(
		() => (active && st.analysis ? overlayBands(p.seq, st.analysis, (m, s) => c.voiceOf(m, s)) : null),
		[active, st.analysis, p.seq, c],
	);
	if (!bands) return null;
	const v = p.viewport;
	const L = p.layout;
	const top = L.video.top;
	const bottom = L.audio.top + L.audio.height;
	const rect = (b: OverlayBand, color: string, key: string) => {
		const x = frameToX(v, b.start);
		const w = Math.max(1, (b.end - b.start) * v.pxPerFrame);
		if (x + w < 0 || x > v.width) return null;
		let y = top;
		let h = bottom - top;
		if (b.trackId) {
			const row = rowOf(L, b.trackId);
			if (!row) return null;
			y = row.y;
			h = row.height;
		}
		return (
			<div
				key={key}
				className="absolute"
				style={{ left: x, top: y, width: w, height: h, background: color }}
			/>
		);
	};
	return (
		<div
			className="pointer-events-none absolute inset-0 overflow-hidden"
			aria-label={t('Clean Up review: cuts, kept pauses and padding')}
			role="img"
			data-testid="timeline.cleanupOverlay"
			data-cuts={bands.cuts.length}
		>
			{bands.cuts.map((b, i) => rect(b, OVERLAY_COLORS.cut, `c${i}`))}
			{bands.pauses.map((b, i) => rect(b, OVERLAY_COLORS.pause, `p${i}`))}
			{bands.padding.map((b, i) => rect(b, OVERLAY_COLORS.padding, `d${i}`))}
		</div>
	);
}
