// Remotion entry of the social-comment render tests (social-comment-render.e2e.test.ts): the template alone on a
// transparent canvas of each design size, its fonts loaded from the bundle's public dir before the first frame
// (`delayRender`, like the layer's font gate), emoji and avatar pictures passed as public-dir files.
import { animeTemplateTiming, socialComment } from '@jasper/mg-templates';
import { useEffect, useState } from 'react';
import {
	Composition,
	cancelRender,
	continueRender,
	delayRender,
	registerRoot,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion';
import { SocialComment } from '../../src/templates/social-comment/index.tsx';
import type { CardProps } from './types.ts';

const FPS = 30;
const FRAMES = 150;

/**
 * Loads the faces before the card is drawn (like the layer, which renders templates only once their fonts are
 * loaded): the card's fit is measured once per layout, so a card laid out in a fallback font and measured before the
 * real face arrives would keep the wrong zoom — a frame would then depend on load timing (renderStill ≠ renderFrames).
 * The render is held from the first render until the card has been drawn with the faces.
 */
function useFonts(fonts: CardProps['fonts']): boolean {
	const [ready, setReady] = useState(fonts.length === 0);
	const [handle] = useState(() => (fonts.length > 0 ? delayRender('Loading social-comment fonts') : null));
	// biome-ignore lint/correctness/useExhaustiveDependencies: the faces of one composition never change
	useEffect(() => {
		if (handle === null) return;
		let live = true;
		Promise.all(
			fonts.map(async (f) => {
				const face = new FontFace(f.family, `url(${staticFile(f.file)})`, { weight: String(f.weight) });
				await face.load();
				document.fonts.add(face);
			}),
		).then(
			() => {
				if (live) setReady(true);
			},
			(e: unknown) => cancelRender(e instanceof Error ? e : new Error(String(e))),
		);
		return () => {
			live = false;
		};
	}, []);
	// after the commit that drew the card with its faces (and the fit's synchronous re-render)
	useEffect(() => {
		if (ready && handle !== null) continueRender(handle);
	}, [ready, handle]);
	return ready;
}

function Card(props: CardProps) {
	const frame = useCurrentFrame();
	const { width, height, durationInFrames } = useVideoConfig();
	const fontsReady = useFonts(props.fonts);
	const t = animeTemplateTiming(socialComment, {
		fps: FPS,
		localFrame: frame,
		durationFrames: durationInFrames,
	});
	const urls = (m: Record<string, string>) =>
		Object.fromEntries(Object.entries(m).map(([k, v]) => [k, staticFile(v)]));
	const extra = {
		mediaUrls: urls(props.mediaFiles),
		emojiUrls: urls(props.emojiFiles),
		imageUrls: urls(props.imageFiles ?? {}),
	};
	return (
		<div style={{ position: 'absolute', inset: 0, background: props.background ?? 'transparent' }}>
			{fontsReady ? (
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
			) : null}
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
