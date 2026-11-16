// The Pitch Shifter's engine warning: an instance set to Rubber Band R3 plays with Signalsmith Stretch where the
// preview could not load or start the Rubber Band module (`previewRubberBand`); exports say so in their plan warnings.
import { previewRubberBand } from '@jasper/compositions';
import type { EffectInstance } from '@jasper/project';
import { useSyncExternalStore } from 'react';
import type { EffectEditorProps } from '../extensions/index.ts';

const wantsRubberBand = (fx: Pick<EffectInstance, 'effectId' | 'params'>) =>
	fx.effectId === 'jasper.audio.pitch-shifter' && fx.params.engine?.value === 'rubberband-r3';

/** The preview's Rubber Band warning for `fx` (null when it plays the engine it is set to). */
export function usePitchEngineWarning(fx: Pick<EffectInstance, 'effectId' | 'params'>): string | null {
	const warning = useSyncExternalStore(previewRubberBand.subscribe, previewRubberBand.warning, () => null);
	return wantsRubberBand(fx) ? warning : null;
}

export function PitchEngineNotice(props: EffectEditorProps) {
	const warning = usePitchEngineWarning(props.fx);
	if (!warning) return null;
	return (
		<div
			className="py-1 text-pr-small text-pr-warning"
			role="status"
			data-testid={`pitch-engine-warning-${props.fx.id}`}
		>
			{`Rubber Band R3 is not available in the preview (${warning}): playing with Signalsmith Stretch.`}
		</div>
	);
}

/** A compact marker for an insert row (Audio Track Mixer) whose Pitch Shifter falls back in the preview. */
export function PitchEngineMark({ fx }: { fx: Pick<EffectInstance, 'effectId' | 'params'> }) {
	const warning = usePitchEngineWarning(fx);
	if (!warning) return null;
	return (
		<span
			className="text-pr-warning"
			role="img"
			aria-label="Rubber Band R3 unavailable"
			title={`Rubber Band R3 is not available in the preview (${warning}): playing with Signalsmith Stretch.`}
		>
			!
		</span>
	);
}
