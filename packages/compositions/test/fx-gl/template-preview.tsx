// App QA N7/N8: the card fills a gallery poster and its missing-asset warning stays on the visible card.
import { Thumbnail } from '@remotion/player';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MgTemplatePreview } from '../../src/index.ts';

export async function templatePreviewGeometry() {
	const host = document.createElement('div');
	host.style.cssText = 'position:relative;width:640px;height:360px';
	document.body.append(host);
	const root = createRoot(host);
	try {
		flushSync(() =>
			root.render(
				<Thumbnail
					component={MgTemplatePreview}
					inputProps={{
						templateId: 'social-comment',
						version: 1,
						params: { variant: 'x-post', text: 'A visible card' },
					}}
					compositionWidth={640}
					compositionHeight={360}
					durationInFrames={150}
					fps={30}
					frameToDisplay={75}
					style={{ width: 640, height: 360 }}
				/>,
			),
		);
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		const rect = (element: Element | null) => {
			if (!element) throw new Error('template card or missing-asset warning was not rendered');
			const { left, top, right, bottom, width } = element.getBoundingClientRect();
			return { left, top, right, bottom, width };
		};
		return {
			poster: rect(host),
			card: rect(host.querySelector('[data-social-variant="x-post"]')),
			warning: rect(host.querySelector('[data-missing-asset="font"]')),
		};
	} finally {
		root.unmount();
		host.remove();
	}
}
