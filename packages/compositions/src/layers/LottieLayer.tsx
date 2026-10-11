// Lottie animations (docs/wp-notes/imports.md): an `animated-image` clip whose media is a Lottie
// document is drawn by the Lottie player (lottie-web, SVG renderer, MIT) — frame-exact: every composition frame seeks
// the player to the Lottie frame of the clip's media time (Frame Sampling, `lottieFrameAt`), through Interpret Footage
// (assumed frame rate, loop) and the clip's own loop. The same component draws the Program monitor, the Remotion
// renders and the layer bakes of the native export, so every path shows the same pixels. Renders hold a delayRender
// until the document and its images are loaded and the frame is drawn.
import { FLICKS_PER_SECOND, fileTimeOf, lottieFrameAt, lottieImageAssets } from '@jasper/project';
import type { AnimationItem } from 'lottie-web';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment } from 'remotion';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';
import { lottieDocument, lottiePlayer } from './lottie.ts';

/**
 * The Lottie frame shown at a layer's picture time: media time → file time (Interpret Footage), wrapped by the clip's
 * loop, then Frame Sampling on the Lottie's own frame grid.
 */
export function lottieFrameForLayer(
	layer: Pick<LayerProps, 'clip' | 'contentTime' | 'pictureTime' | 'media'>,
): number | null {
	const info = layer.media?.lottie;
	if (!info) return null;
	let t = fileTimeOf(layer.clip.mediaTime, layer.pictureTime ?? layer.contentTime) / FLICKS_PER_SECOND;
	const pass = (info.outFrame - info.inFrame) / info.fps;
	if (layer.clip.loop && pass > 0) {
		t %= pass;
		if (t < 0) t += pass;
	}
	return lottieFrameAt(info, t);
}

export function LottieLayer(layer: LayerProps) {
	const { media } = layer;
	const host = useRef<HTMLDivElement | null>(null);
	const anim = useRef<AnimationItem | null>(null);
	const [ready, setReady] = useState(false);
	const rendering = getRemotionEnvironment().isRendering;
	const url = media?.loaderUrl ?? null;
	const frame = lottieFrameForLayer(layer);
	const [loading] = useState(() => (rendering && url ? delayRender(`Lottie animation ${url}`) : null));

	useEffect(() => {
		if (!url || !host.current) return;
		let alive = true;
		let a: AnimationItem | null = null;
		void Promise.all([lottiePlayer(), lottieDocument(url)])
			.then(([lottie, doc]) => {
				if (!alive || !host.current) return;
				a = lottie.loadAnimation({
					container: host.current,
					renderer: 'svg',
					loop: false,
					autoplay: false,
					animationData: JSON.parse(JSON.stringify(doc)),
					rendererSettings: { preserveAspectRatio: 'none', progressiveLoad: false, hideOnTransparent: true },
				});
				anim.current = a;
				// Ready once the SVG tree exists (`DOMLoaded`) and every embedded image is decoded (renders must not capture
				// an image element before its picture).
				const images = Promise.all(
					lottieImageAssets(doc)
						.map((asset) => asset.file)
						.filter((file) => file.startsWith('data:image/'))
						.map((src) => {
							const img = new Image();
							img.src = src;
							return img.decode().catch(() => undefined);
						}),
				);
				const dom = new Promise<void>((res) => {
					if (a?.isLoaded) res();
					a?.addEventListener('DOMLoaded', () => res());
				});
				a.addEventListener('data_failed', () => {
					if (rendering) cancelRender(new Error(`The Lottie animation ${url} failed to load`));
				});
				void Promise.all([dom, images]).then(() => {
					if (alive) setReady(true);
				});
			})
			.catch((e: unknown) => {
				if (rendering) cancelRender(e instanceof Error ? e : new Error(String(e)));
			});
		return () => {
			alive = false;
			a?.destroy();
			anim.current = null;
			setReady(false);
		};
	}, [url, rendering]);

	// Seek before paint (renders capture the DOM once every delayRender is released).
	useLayoutEffect(() => {
		if (!ready || frame === null || !anim.current || !media?.lottie) return;
		anim.current.goToAndStop(frame - media.lottie.inFrame, true);
	}, [ready, frame, media?.lottie]);

	const released = useRef(false);
	useEffect(() => {
		if (ready && loading !== null && !released.current) {
			released.current = true;
			continueRender(loading);
		}
	}, [ready, loading]);
	useEffect(
		() => () => {
			if (loading !== null && !released.current) {
				released.current = true;
				continueRender(loading);
			}
		},
		[loading],
	);

	if (!media) return null;
	return (
		<LayerBox layer={layer}>
			<div
				ref={host}
				data-lottie=""
				style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
			/>
		</LayerBox>
	);
}
