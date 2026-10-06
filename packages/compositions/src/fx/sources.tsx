// Feeders of the fx framework (wave 1): components that deliver a layer's pictures into `<FxPicture>` slots.
// - video: `@remotion/media` `<Video headless onVideoFrame>` (Player and renders; the element draws nothing itself,
//   Remotion's scheduling and delayRender stay in charge) or `<OffthreadVideo onVideoFrame>` (renders of originals a
//   browser cannot decode; kept mounted, invisible);
// - time samples: the same feeders inside `<Freeze frame={…}>` (the source at other frames: deterministic under random
//   seek and parallel renders because every sample is decoded for its own frame, never taken from earlier draws);
// - stills: the decoded image; solids: a canvas of the matte colour;
// - media params (depth/displacement maps, textures): images, or videos at the layer's clip-local time.
import { Video } from '@remotion/media';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { continueRender, delayRender, Freeze, getRemotionEnvironment, OffthreadVideo } from 'remotion';
import type { LayerProps } from '../types.ts';
import { loadFxImage, useFxFeed } from './FxPicture.tsx';
import type { FxStage } from './stage.ts';

const HIDDEN = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', opacity: 0 } as const;

/** A video into a slot. `frame` = the clip-local frame it shows (renders invalidate the slot when it changes). */
export function FxVideoFeed(props: {
	slot: string;
	src: string;
	trimBefore: number;
	playbackRate: number;
	frame: number;
	offthread?: { transparent: boolean };
	loop?: boolean;
}) {
	const fx = useFxFeed();
	const rendering = getRemotionEnvironment().isRendering;
	const { slot } = props;
	const onFrame = useCallback((img: CanvasImageSource) => fx.feed(slot, img), [fx, slot]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the frame shown changes the picture
	useLayoutEffect(() => {
		if (rendering) fx.invalidate(slot);
	}, [props.frame, slot, fx, rendering]);
	if (props.offthread)
		return (
			<OffthreadVideo
				src={props.src}
				trimBefore={props.trimBefore}
				playbackRate={props.playbackRate}
				muted
				transparent={props.offthread.transparent}
				style={HIDDEN}
				showInTimeline={false}
				onVideoFrame={onFrame}
			/>
		);
	return (
		<Video
			src={props.src}
			headless
			trimBefore={props.trimBefore}
			playbackRate={props.playbackRate}
			loop={props.loop}
			muted
			showInTimeline={false}
			onVideoFrame={onFrame}
		/>
	);
}

/** A still image into a slot (renders hold a delayRender from the first render until it is fed). */
export function FxImageFeed({ slot, src }: { slot: string; src: string }) {
	const fx = useFxFeed();
	const rendering = getRemotionEnvironment().isRendering;
	const [handle] = useState(() => (rendering ? delayRender(`Loading fx still ${src}`) : null));
	const released = useRef(false);
	useLayoutEffect(() => {
		let alive = true;
		void loadFxImage(src).then((img) => {
			if (alive && img) fx.feed(slot, img);
			if (handle !== null && !released.current) {
				released.current = true;
				continueRender(handle);
			}
		});
		return () => {
			alive = false;
		};
	}, [src, slot, fx, handle]);
	return null;
}

/** A uniform colour (solid / colour matte) into a slot, at the layer box size. */
export function FxSolidFeed({
	slot,
	rgba,
	width,
	height,
}: {
	slot: string;
	rgba: readonly number[];
	width: number;
	height: number;
}) {
	const fx = useFxFeed();
	const key = rgba.join(',');
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the colour and size
	useLayoutEffect(() => {
		const c = document.createElement('canvas');
		c.width = Math.max(1, Math.ceil(width));
		c.height = Math.max(1, Math.ceil(height));
		const ctx = c.getContext('2d')!;
		const [r, g, b, a] = rgba;
		ctx.fillStyle = `rgba(${Math.round(r! * 255)}, ${Math.round(g! * 255)}, ${Math.round(b! * 255)}, ${a ?? 1})`;
		ctx.fillRect(0, 0, c.width, c.height);
		fx.feed(slot, c);
	}, [key, width, height, slot, fx]);
	return null;
}

/**
 * The source of a video layer, its time samples and the stage's media inputs. `frame` = the clip-local frame of the
 * source (remapped when a time effect remaps it; the remap's `<Freeze>` sits above, see `withFxTime`).
 */
export function FxVideoSources(props: {
	layer: LayerProps;
	stage: FxStage;
	src: string;
	trimBefore: number;
	/** Media rate (default: the clip speed). */
	playbackRate?: number;
	/**
	 * When the feeders sit inside an extra `<Sequence from={k}>` (composition masters/previews), `freezeBase = −k`
	 * keeps the time samples' `<Freeze>` frames aligned with the clip.
	 */
	freezeBase?: number;
	offthread?: { transparent: boolean };
}) {
	const { layer, stage } = props;
	const head = layer.clip.headHandle ?? 0;
	const tail = layer.clip.tailHandle ?? 0;
	const f = layer.localFrame;
	// (time samples are absolute frames, `f` is the layer's own source frame)
	const rate = props.playbackRate ?? layer.clip.speed.rate;
	const base = props.freezeBase ?? 0;
	return (
		<>
			<FxVideoFeed
				slot="source"
				src={props.src}
				trimBefore={props.trimBefore}
				playbackRate={rate}
				frame={f}
				offthread={props.offthread}
			/>
			{stage.samples.map((at) => {
				// Absolute source frames (fxStackTime: composed with the stack's remaps, inside the drawn span).
				if (at < -head || at > layer.clip.duration + tail - 1) return null;
				return (
					<Freeze key={at} frame={at + head + base}>
						<FxVideoFeed
							slot={`sample@${at}`}
							src={props.src}
							trimBefore={props.trimBefore}
							playbackRate={rate}
							frame={at}
							offthread={props.offthread}
						/>
					</Freeze>
				);
			})}
			<FxMediaInputs stage={stage} frame={f} />
		</>
	);
}

/** Time samples of a still are the still itself; of a solid, the colour: only the main slot exists. */
export function FxMediaInputs({ stage, frame }: { stage: FxStage; frame: number }) {
	return (
		<>
			{stage.media
				.filter((m) => m.kind === 'video')
				.map((m) => (
					<FxVideoFeed
						key={m.mediaId}
						slot={`media:${m.mediaId}`}
						src={m.url}
						trimBefore={0}
						playbackRate={1}
						frame={frame}
					/>
				))}
		</>
	);
}
