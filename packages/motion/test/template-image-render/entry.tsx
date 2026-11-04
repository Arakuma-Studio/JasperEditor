// Remotion entry of the TemplateImage render test (template-image.e2e.test.ts): one picture per composition,
// drawn by `TemplateImage` from the `src` input prop, over a black background.
import { useEffect } from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { TemplateImage } from '../../src/templates/image.tsx';

type Props = { src: string };

function Picture({ src }: Props) {
	useEffect(() => {
		if (!src.endsWith('/slow.png')) return;
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => {
				console.info(
					`template-image-ready:${(window as Window & { remotion_renderReady?: boolean }).remotion_renderReady}`,
				);
			});
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
		};
	}, [src]);
	return (
		<AbsoluteFill style={{ background: 'black' }}>
			<TemplateImage src={src} style={{ position: 'absolute', left: 0, top: 0, width: 64, height: 64 }} />
		</AbsoluteFill>
	);
}

function Root() {
	return (
		<Composition
			id="TemplateImage"
			component={Picture}
			width={64}
			height={64}
			fps={30}
			durationInFrames={1}
			defaultProps={{ src: '' }}
		/>
	);
}

registerRoot(Root);
