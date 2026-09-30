// Effect Controls editor for `jasper.corner-pin` (S09:TRU-003/004), shown above the generic param rows (which
// stay): the Program-monitor handles toggle, "Driven by tracker <name> on <clip>" with Re-apply / Unlink when
// the clip's `trackedBy` points at this effect, and a warning when the pinned quad is non-convex (the layer then
// draws unpinned, TRK-030).
import {
	type Clip,
	clipContentTime,
	evaluate,
	findTracker,
	intrinsicBoxOf,
	type Rational,
} from '@jasper/project';
import { useSessionState } from '@jasper/session/react';
import { Move, RefreshCw, TriangleAlert, Unlink } from 'lucide-react';
import { useState } from 'react';
import type { EffectEditorProps } from '../extensions/index.ts';
import { reapplyTracking, unlinkTracking } from './actions.ts';
import { SmallButton, ToolButton } from './controls.tsx';
import { CORNER_PIN_DEFAULTS, pinIsConvex, type Quad } from './geometry.ts';
import { trackingStore, useTracking } from './store.ts';

type TrackedBy = {
	clipId: string;
	trackerId: string;
	mode: 'corner-pin' | 'transform';
	effectInstanceId?: string;
};

const PARAMS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;

/** Corner-pin params of an effect instance evaluated at a sequence frame (normalised). */
export function pinAt(clip: Clip, fx: EffectEditorProps['fx'], frame: number, fps: Rational): Quad {
	const inClip = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
	const t = clipContentTime(clip, inClip, fps);
	return PARAMS.map((k, i) => {
		const a = fx.params[k];
		const v = a ? (evaluate(a as never, t) as unknown) : null;
		return Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : CORNER_PIN_DEFAULTS[i]!;
	}) as Quad;
}

export function CornerPinEditor(props: EffectEditorProps) {
	const { session, clip, fx, frame, sequenceId } = props;
	const pinTool = useTracking((s) => s.cornerPinTool);
	const readOnly = useSessionState((s) => s.readOnly);
	const doc = useSessionState((s) => s.document);
	const [error, setError] = useState<string | null>(null);
	const seq = doc.sequences[sequenceId];
	const tb = (clip as { trackedBy?: TrackedBy }).trackedBy;
	const driven =
		tb && tb.mode === 'corner-pin' && (!tb.effectInstanceId || tb.effectInstanceId === fx.id) ? tb : null;
	const loc = driven ? findTracker(doc, driven.trackerId) : null;
	const box = seq ? intrinsicBoxOf({ clip, doc, seq } as never) : { width: 1920, height: 1080 };
	const convex = seq ? pinIsConvex(pinAt(clip, fx, frame, seq.settings.frameRate), box) : true;
	const act = (fn: () => void) => {
		try {
			setError(null);
			fn();
		} catch (e) {
			setError((e as Error).message);
		}
	};
	return (
		<div className="flex flex-col gap-[2px] py-1 pr-1 pl-6" data-testid="corner-pin-editor">
			<div className="flex items-center gap-1">
				<ToolButton
					icon={Move}
					label={
						pinTool
							? 'Hide Corner Pin handles on the Program monitor'
							: 'Show Corner Pin handles on the Program monitor'
					}
					active={pinTool}
					onClick={() => trackingStore.setState({ cornerPinTool: !pinTool })}
					data-testid="corner-pin-handles-toggle"
				/>
				<span className="text-pr-small text-pr-muted">Drag the corners on the Program monitor</span>
			</div>
			{driven ? (
				<div className="flex flex-wrap items-center gap-1" data-testid="corner-pin-driven">
					<span className="min-w-0 flex-1 truncate text-pr-small text-pr-text">
						Driven by tracker <span className="text-pr-strong">{loc?.tracker.name ?? '(removed)'}</span> on{' '}
						<span className="text-pr-strong">{loc?.clip.name || 'clip'}</span>
					</span>
					<SmallButton
						icon={RefreshCw}
						disabled={readOnly || !loc}
						onClick={() => act(() => reapplyTracking(session, clip.id))}
						title="Re-bake the tracker over the overlap (replaces the corner keyframes there)"
						data-testid="corner-pin-reapply"
					>
						Re-apply
					</SmallButton>
					<SmallButton
						icon={Unlink}
						disabled={readOnly}
						onClick={() => act(() => unlinkTracking(session, clip.id))}
						title="Stop following the tracker; the keyframes stay"
						data-testid="corner-pin-unlink"
					>
						Unlink
					</SmallButton>
				</div>
			) : null}
			{!convex ? (
				<p
					className="flex items-center gap-1 text-pr-small text-pr-warning"
					role="status"
					data-testid="corner-pin-nonconvex"
				>
					<TriangleAlert size={12} aria-hidden />
					The corners cross (non-convex): the layer is drawn unpinned.
				</p>
			) : null}
			{error ? (
				<p className="text-pr-small text-pr-danger" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
