// Remotion entry of the TemplateImage render test (template-image.e2e.test.ts): one picture per composition,
// drawn by `TemplateImage` from the `src` input prop, over a black background.
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { TemplateImage } from '../../src/templates/image.tsx';

type Props = { src: string };

function Picture({ src }: Props) {
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
