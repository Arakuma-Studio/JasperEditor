// Motion Templates ▸ Text Animations tab (S11:TXA-020). Owner: wp-m2-text-anim, which replaces this placeholder
// with the preset gallery (cards with PreviewThumb, category chips, search, apply / drag onto text clips).
import { TEXT_ANIMATION_SPECS } from '@jasper/project';
import { Icon } from '@jasper/ui';

export function TextAnimationsTab() {
	return (
		<div
			className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-center text-pr-ui text-pr-text"
			data-testid="text-animations-tab"
		>
			<span className="text-pr-icon">
				<Icon id="panel.motionTemplates" size={24} />
			</span>
			<p className="text-pr-small text-pr-muted">
				{TEXT_ANIMATION_SPECS.length === 0
					? 'Text animation presets are not installed yet.'
					: `${TEXT_ANIMATION_SPECS.length} text animation presets`}
			</p>
		</div>
	);
}
