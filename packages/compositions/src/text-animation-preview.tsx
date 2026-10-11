// Preview composition of one text animation preset (S11:TXA-020/021): an "Aa Title" text clip animated by the
// preset, rendered by the real SequenceComposition (same layer, same value engine) so gallery cards and the
// preset picker show exactly what the timeline will.
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	getTextAnimationSpec,
} from '@jasper/project';
import { useMemo } from 'react';
import { SequenceComposition } from './SequenceComposition.tsx';
import { DEFAULT_RENDER_OPTIONS, type RenderDoc } from './types.ts';

export type TextAnimationPreviewSide = 'in' | 'out' | 'both';

export type TextAnimationPreviewProps = {
	preset: string;
	version: number;
	side: TextAnimationPreviewSide;
	/** Params over the preset's defaults. */
	params?: Record<string, unknown>;
	text?: string;
};

/** Canvas of the preview (1080p at 30 fps; cards scale it down). */
export const TEXT_ANIMATION_PREVIEW = { width: 1920, height: 1080, fps: 30 } as const;
/** Frames the text holds at rest between the windows, and blank frames after an Out. */
const HOLD = 24;
const TAIL = 8;

/** Length of the looping preview and the poster frame (mid-motion of the shown side). */
export function textAnimationPreviewTiming(
	windowFrames: number,
	side: TextAnimationPreviewSide,
): { durationInFrames: number; posterFrame: number; clipFrames: number } {
	const w = Math.max(1, Math.round(windowFrames));
	if (side === 'in')
		return { durationInFrames: w + HOLD, posterFrame: Math.floor(w / 2), clipFrames: w + HOLD };
	if (side === 'out')
		return { durationInFrames: HOLD + w + TAIL, posterFrame: HOLD + Math.floor(w / 2), clipFrames: HOLD + w };
	return { durationInFrames: 2 * w + HOLD + TAIL, posterFrame: Math.floor(w / 2), clipFrames: 2 * w + HOLD };
}

/** The render document of a preview (pure; cached per preset/side/params). */
function textAnimationPreviewDoc(p: TextAnimationPreviewProps): RenderDoc | null {
	const spec = getTextAnimationSpec(p.preset, p.version);
	if (!spec) return null;
	const timing = textAnimationPreviewTiming(spec.defaultDurationFrames, p.side);
	const animator = { preset: spec.id, version: spec.version, params: p.params ?? {} };
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'Preview', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'preview',
			origin: 'system',
			commands: [
				{
					type: 'clip.addText',
					at: 0,
					duration: timing.clipFrames,
					track: 'V1',
					content: {
						text: p.text ?? 'Aa Title',
						style: { sizePx: 220, weight: 700, align: 'center', fill: [1, 1, 1, 1] },
					},
					box: { autoSize: 'none', width: 1600, height: 300 },
					transform: { position: [960, 540] },
					textAnimation: {
						...(p.side !== 'out' ? { in: animator } : {}),
						...(p.side !== 'in' ? { out: animator } : {}),
					},
				},
			],
		},
		{ ids, now: () => '', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) return null;
	const snap = buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	return {
		...snap,
		durationFrames: timing.durationInFrames,
		range: { start: 0, end: timing.durationInFrames },
	};
}

export function TextAnimationPreview(props: TextAnimationPreviewProps) {
	const { preset, version, side, params, text } = props;
	const key = JSON.stringify([preset, version, side, params ?? null, text ?? null]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the serialised props
	const doc = useMemo(() => textAnimationPreviewDoc({ preset, version, side, params, text }), [key]);
	if (!doc) return null;
	return <SequenceComposition doc={doc} options={DEFAULT_RENDER_OPTIONS} />;
}
