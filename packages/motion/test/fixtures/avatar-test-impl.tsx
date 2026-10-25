// Implementation of the test-only `avatar-test@1` template (packages/mg-templates/test/fixtures/avatar-test-template.ts):
// the avatar picture through `mediaUrls` and `TemplateImage`, initials when there is none.
import { TemplateImage } from '../../src/templates/image.tsx';
import type { AnimeTemplateProps } from '../../src/templates/types.ts';

export function AvatarTest(p: AnimeTemplateProps) {
	const ref = p.params.avatar as { mediaId: string } | null;
	const size = Math.round(p.canvas.height / 4);
	return (
		<div style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }} data-avatar-test="">
			<TemplateImage
				src={ref ? p.mediaUrls[ref.mediaId] : null}
				alt={String(p.params.name)}
				style={{ width: size, height: size, borderRadius: size / 2, objectFit: 'cover' }}
				fallback={<span data-avatar-initials="">{String(p.params.name).slice(0, 1)}</span>}
				data-testid="avatar"
			/>
		</div>
	);
}
