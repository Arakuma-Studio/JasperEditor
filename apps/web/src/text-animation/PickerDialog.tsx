// Graphics ▸ Text Animation ▸ Apply In… / Apply Out… (S11:TXA-024): picks a preset for the selected text clips.
import type { TextAnimationSide } from '@jasper/project';
import { Dialog, type HostedDialogProps } from '@jasper/ui';
import { PresetGrid } from './PresetPreview.tsx';

export const TEXT_ANIMATION_PICKER_DIALOG = 'textAnimation.pick';

/** Resolves `close(presetId | null)` (null = None); undefined on cancel. */
export function TextAnimationPickerDialog(
	props: HostedDialogProps<{ side: TextAnimationSide; count: number; current: string | null }>,
) {
	const side = props.side === 'in' ? 'In' : 'Out';
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.close(undefined);
			}}
			title={`Apply ${side} Animation`}
			description={`Text animation for the ${side.toLowerCase()} of ${props.count} selected text clip${props.count > 1 ? 's' : ''}`}
			size="large"
		>
			<div data-testid="text-anim-dialog" className="max-h-[60vh] overflow-y-auto p-1">
				<PresetGrid side={props.side} value={props.current} onPick={(p) => props.close(p)} />
			</div>
		</Dialog>
	);
}
