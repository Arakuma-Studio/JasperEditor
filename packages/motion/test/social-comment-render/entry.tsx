// Remotion entry of the social-comment render tests (social-comment-render.e2e.test.ts): the template alone on a
// transparent canvas of each design size, its fonts loaded from the bundle's public dir before the first frame
// (`delayRender`, like the layer's font gate), emoji and avatar pictures passed as public-dir files.
import { socialComment, animeTemplateTiming } from '@jasper/mg-templates';
import { useState } from 'react';
import { Composition, continueRender, delayRender, registerRoot, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { SocialComment } from '../../src/templates/social-comment/index.tsx';
import type { CardProps } from './types.ts';

const FPS = 30;
const FRAMES = 150;

function useFonts(fonts: CardProps['fonts']): boolean {
	const [state] = useState(() => {
		const handle = delayRender('Loading social-comment fonts');
		const s = { ready: false };
		Promise.all(
			fonts.map(async (f) => {
				const face = new FontFace(f.family, `url(${staticFile(f.file)})`, { weight: String(f.weight) });
				await face.load();
				document.fonts.add(face);
			}),
		)
			.then(() => {
				s.ready = true;
				continueRender(handle);
			})
			.catch((e: unknown) => {
				throw e instanceof Error ? e : new Error(String(e));
			});
		return s;
	});
	return state.ready || fonts.length === 0;
}

function Card(props: CardProps) {
	const frame = useCurrentFrame();
	const { width, height, durationInFrames } = useVideoConfig();
	useFonts(props.fonts);
	const t = animeTemplateTiming(socialComment, { fps: FPS, localFrame: frame, durationFrames: durationInFrames });
	const urls = (m: Record<string, string>) =>
		Object.fromEntries(Object.entries(m).map(([k, v]) => [k, staticFile(v)]));
	const extra = { mediaUrls: urls(props.mediaFiles), emojiUrls: urls(props.emojiFiles) };
	return (
		<div style={{ position: 'absolute', inset: 0, background: props.background ?? 'transparent' }}>
			<SocialComment
				params={props.params}
				timeMs={t.timeMs}
				totalMs={t.totalMs}
				introMs={t.introMs}
				outroMs={t.outroMs}
				fps={FPS}
				canvas={{ width, height }}
				seed={7}
				isPreview={false}
				{...extra}
			/>
		</div>
	);
}

const DEFAULT: CardProps = { params: {}, fonts: [], mediaFiles: {}, emojiFiles: {} };

function Root() {
	return (
		<>
			{[
				[1080, 1920],
				[1920, 1080],
				[1080, 1080],
			].map(([w, h]) => (
				<Composition
					key={`${w}x${h}`}
					id={`Card-${w}x${h}`}
					component={Card}
					width={w!}
					height={h!}
					fps={FPS}
					durationInFrames={FRAMES}
					defaultProps={DEFAULT}
				/>
			))}
		</>
	);
}

registerRoot(Root);
