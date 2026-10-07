// Retimed video pictures (workstream `time`): a video layer whose frames are chosen by media time instead of linear
// playback — reverse, Time Remapping, Frame Blending / Optical Flow (speed changes, remaps, frame-rate conform) and
// variable-frame-rate media. Each composition frame computes the media time it shows (the clip's picture time through
// its remap), decodes the frame(s) around it (`FrameSource`, GOP-cached, so reverse playback is smooth) and composes
// them on the GPU (`RetimeCompositor`: sampling, blending, optical flow). The result is drawn in the layer box, or
// handed to the colour stage / fx picture like any decoded frame.
//
// Player: while a frame is not decoded yet the Player buffers (no stale picture during playback). Renders: every
// frame holds a delayRender until its picture is drawn (deterministic under random access and parallel renders).
// Originals the browser cannot decode (ProRes) are read through <OffthreadVideo> at the exact frames in renders.
import {
	activeRemap,
	analysisFactor,
	analysisSize,
	FLICKS_PER_SECOND,
	INTERP_EPS,
	type MediaHandle,
	type RenderVisualClip,
	remapSourceAt,
	type TimeInterpolation,
} from '@jasper/project';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	continueRender,
	delayRender,
	Freeze,
	getRemotionEnvironment,
	OffthreadVideo,
	useBufferState,
	useVideoConfig,
} from 'remotion';
import { mediaSrc } from '../pipeline.ts';
import type { RenderOptions } from '../types.ts';
import { RetimeCompositor } from './flow-gl.ts';
import { acquireFrameSource, type DecodedFrame, type FrameSource, releaseFrameSource } from './frames.ts';

/** Longest side of the frames decoded for the Program monitor (renders decode at full size). */
const PREVIEW_MAX = 1920;

/** Media time (seconds) a clip shows at picture time `pictureTime` (content flicks; frame holds already applied). */
export function retimeMediaSeconds(
	clip: Pick<RenderVisualClip, 'timeRemap' | 'kind'>,
	pictureTime: number,
): number {
	const remap = activeRemap(clip);
	const m = remap ? remapSourceAt(remap, pictureTime) : pictureTime;
	return Math.max(0, m / FLICKS_PER_SECOND);
}

/** Decoded size and analysis size of a retimed media (shared rule with the native export, see flow.ts). */
export function retimeSizes(
	media: Pick<MediaHandle, 'width' | 'height'>,
	isPreview: boolean,
): { decode: { w: number; h: number }; analysis: { w: number; h: number } } {
	const mw = Math.max(1, media.width ?? 1280);
	const mh = Math.max(1, media.height ?? 720);
	const k = analysisFactor(mw, mh);
	const analysis = analysisSize(mw, mh, k);
	const j = isPreview
		? Math.max(1, Math.min(k, Math.floor(PREVIEW_MAX / Math.max(analysis.w, analysis.h))))
		: k;
	return { decode: { w: analysis.w * j, h: analysis.h * j }, analysis };
}

type Picture = { a: DecodedFrame; b: DecodedFrame | null; w: number };

/** The frames that make the picture at media time t (Premiere Time Interpolation; `pickFrames` semantics). */
async function framesFor(src: FrameSource, t: number, mode: TimeInterpolation): Promise<Picture | null> {
	const a = await src.frameAt(t);
	if (!a) return null;
	if (mode === 'frame-sampling') return { a, b: null, w: 0 };
	const b = await src.nextAfter(a);
	if (!b) return { a, b: null, w: 0 };
	const w = (t - a.time) / (b.time - a.time);
	if (!(w > INTERP_EPS)) return { a, b: null, w: 0 };
	if (w >= 1 - INTERP_EPS) return { a: b, b: null, w: 0 };
	return { a, b, w };
}

function compose(
	c: RetimeCompositor,
	p: Picture,
	mode: TimeInterpolation,
	size: ReturnType<typeof retimeSizes>,
) {
	const { w: W, h: H } = size.decode;
	if (!p.b) return c.blend(p.a.canvas, null, 0, W, H);
	if (mode === 'optical-flow')
		return c.flow(p.a.canvas, p.b.canvas, p.w, W, H, size.analysis, `${p.a.time}|${p.b.time}`);
	return c.blend(p.a.canvas, p.b.canvas, p.w, W, H);
}

export type RetimedFeedProps = {
	clip: RenderVisualClip;
	media: MediaHandle;
	options: RenderOptions;
	/** Picture time (content flicks) of the frame to show. */
	pictureTime: number;
	/** Receives each composed picture (a canvas that is reused: draw it synchronously). */
	onPicture(picture: CanvasImageSource, width: number, height: number): void;
	/** Shown inside the layer box (plain layers); otherwise the picture only goes to `onPicture`. */
	visible?: boolean;
};

/** Decodes and composes the retimed picture of a clip at one picture time. */
export function RetimedFeed(props: RetimedFeedProps): ReactNode {
	const { clip, media, options } = props;
	const rendering = getRemotionEnvironment().isRendering;
	const mode: TimeInterpolation = clip.retime?.interpolation ?? 'frame-sampling';
	const size = useMemo(() => retimeSizes(media, options.isPreview), [media, options.isPreview]);
	if (media.browserDecodable === false && !options.isPreview)
		return <OffthreadRetimed {...props} mode={mode} size={size} />;
	return <DecodedRetimed {...props} mode={mode} size={size} rendering={rendering} />;
}

function DecodedRetimed(
	props: RetimedFeedProps & {
		mode: TimeInterpolation;
		size: ReturnType<typeof retimeSizes>;
		rendering: boolean;
	},
) {
	const { media, options, mode, size, rendering } = props;
	const src = mediaSrc(media, options);
	const host = useRef<HTMLDivElement | null>(null);
	const [comp, setComp] = useState<RetimeCompositor | null>(null);
	const [source, setSource] = useState<FrameSource | null>(null);
	const buffer = useBufferState();
	const onPicture = useRef(props.onPicture);
	onPicture.current = props.onPicture;
	// Renders: the decoder and compositor are created in effects, after the first paint. Hold the frame from the
	// first render until its picture is drawn, or a tab's first frame of this layer is captured empty.
	const [mountHold] = useState(() => (rendering ? delayRender(`Retimed layer ${src}`) : null));
	const mountReleased = useRef(false);
	const releaseMount = useRef(() => {
		if (mountReleased.current || mountHold === null) return;
		mountReleased.current = true;
		continueRender(mountHold);
	});
	useEffect(() => releaseMount.current, []);
	useEffect(() => {
		const s = acquireFrameSource(src, size.decode.w, size.decode.h, media.alpha === true);
		setSource(s);
		return () => releaseFrameSource(s);
	}, [src, size.decode.w, size.decode.h, media.alpha]);
	useEffect(() => {
		const c = new RetimeCompositor();
		const el = c.canvas as HTMLCanvasElement;
		el.style.width = '100%';
		el.style.height = '100%';
		el.style.display = 'block';
		el.dataset.retimed = '';
		setComp(c);
		return () => c.dispose();
	}, []);
	useLayoutEffect(() => {
		const el = comp?.canvas as HTMLCanvasElement | undefined;
		if (!el || !host.current || !props.visible) return;
		host.current.appendChild(el);
		return () => el.remove();
	}, [comp, props.visible]);
	const t = retimeMediaSeconds(props.clip, props.pictureTime);
	const seq = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: redraw when the media time, mode or decoder changes
	useLayoutEffect(() => {
		if (!comp || !source) return;
		const id = ++seq.current;
		const hold = rendering ? delayRender(`Retimed frame ${t.toFixed(4)}s of ${src}`) : null;
		const cached = source.peek(t);
		const wait = !rendering && !cached ? buffer.delayPlayback() : null;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			wait?.unblock();
			if (hold !== null) continueRender(hold);
		};
		void framesFor(source, t, mode)
			.then((p) => {
				if (id !== seq.current) return;
				if (!p) {
					// Past the media: nothing to draw.
					releaseMount.current();
					return;
				}
				const out = compose(comp, p, mode, size);
				onPicture.current(out, size.decode.w, size.decode.h);
				releaseMount.current();
			})
			.catch((e: unknown) => {
				if (rendering) throw e;
			})
			.finally(finish);
		return finish;
	}, [comp, source, t, mode, size]);
	return props.visible ? <div ref={host} style={{ position: 'absolute', inset: 0 }} /> : null;
}

/**
 * Renders of originals the browser cannot decode: the frames come from <OffthreadVideo> (the render's FFmpeg) frozen
 * at the exact media times of frame a (and b), composed like decoded frames. Constant-rate media only (the frame
 * grid is the probed rate).
 */
function OffthreadRetimed(
	props: RetimedFeedProps & { mode: TimeInterpolation; size: ReturnType<typeof retimeSizes> },
) {
	const { clip, media, mode, size } = props;
	const rate = clip.retime?.mediaRate ?? { num: 30, den: 1 };
	const fps = rate.num / rate.den;
	const t = retimeMediaSeconds(clip, props.pictureTime);
	const dur = (media.durationFlicks ?? Number.POSITIVE_INFINITY) / FLICKS_PER_SECOND;
	const last = Math.max(0, Math.floor(dur * fps - 1e-3) - 1);
	const ia = Math.min(last, Math.floor(t * fps + 1e-6));
	let w = mode === 'frame-sampling' || ia >= last ? 0 : t * fps - ia;
	if (!(w > INTERP_EPS)) w = 0;
	const useB = w > 0 && w < 1 - INTERP_EPS;
	const a = w >= 1 - INTERP_EPS ? ia + 1 : ia;
	const comps = useVideoConfig().fps;
	const pics = useRef<{ key: number; a: CanvasImageSource | null; b: CanvasImageSource | null }>({
		key: -1,
		a: null,
		b: null,
	});
	if (pics.current.key !== a) pics.current = { key: a, a: null, b: null };
	const [comp] = useState(() => new RetimeCompositor());
	useEffect(() => () => comp.dispose(), [comp]);
	const emit = () => {
		const pa = pics.current.a;
		if (!pa) return;
		const W = size.decode.w;
		const H = size.decode.h;
		let out: CanvasImageSource;
		if (useB && pics.current.b) {
			out =
				mode === 'optical-flow'
					? comp.flow(
							pa as TexImageSource,
							pics.current.b as TexImageSource,
							w,
							W,
							H,
							size.analysis,
							`${a}|${a + 1}`,
						)
					: comp.blend(pa as TexImageSource, pics.current.b as TexImageSource, w, W, H);
		} else out = comp.blend(pa as TexImageSource, null, 0, W, H);
		props.onPicture(out, W, H);
	};
	const hidden = { position: 'absolute', inset: 0, opacity: 0 } as const;
	// Frame n of the media starts at n / fps seconds: a 1×-speed <OffthreadVideo> frozen at its frame 0 with
	// `trimBefore` (composition frames of media time, fractional allowed) = n / fps · composition fps shows it.
	return (
		<>
			<Freeze frame={0} key={`a${a}`}>
				<OffthreadVideo
					src={media.url}
					trimBefore={(a / fps) * comps}
					muted
					transparent={media.alpha === true}
					style={hidden}
					showInTimeline={false}
					onVideoFrame={(img) => {
						pics.current.a = img;
						if (!useB) emit();
						else if (pics.current.b) emit();
					}}
				/>
			</Freeze>
			{useB ? (
				<Freeze frame={0} key={`b${a}`}>
					<OffthreadVideo
						src={media.url}
						trimBefore={((a + 1) / fps) * comps}
						muted
						transparent={media.alpha === true}
						style={hidden}
						showInTimeline={false}
						onVideoFrame={(img) => {
							pics.current.b = img;
							if (pics.current.a) emit();
						}}
					/>
				</Freeze>
			) : null}
		</>
	);
}
