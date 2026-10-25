// Implementation of the test-only `hold-test@1` template (packages/mg-templates/test/fixtures/hold-test-template.ts):
// prints the seek time it is drawn at.
import type { AnimeTemplateProps } from '@jasper/motion/templates';

export function HoldTest(p: AnimeTemplateProps) {
	return (
		<div data-hold-test="" data-time={p.timeMs.toFixed(3)}>
			{String(p.params.text)}
		</div>
	);
}
