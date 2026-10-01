// The GL colour stage as a standalone component (ARCHITECTURE §19.2 "GL colour stage API"): any layer that has a
// picture as a CanvasImageSource (an <OffthreadVideo> frame, a composition clip's pre-rendered frame, a canvas)
// feeds it here and gets the graded result on a canvas. Uses the same canvas effect chain (Remotion
// `runEffectChain`) and the same passes (`useColorStage(...).effects`) as `<Video effects>` / `<Img effects>`.
// Renders hold a delayRender from `draw()` until the chain wrote the canvas.
import {
	type CSSProperties,
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
} from 'react';
import {
	continueRender,
	delayRender,
	type EffectDefinitionAndStack,
	type EffectDescriptor,
	getRemotionEnvironment,
	Internals,
} from 'remotion';

export type ColorCanvasHandle = {
	/** Draws a source picture through the chain (resolves false when superseded by a newer draw). */
	draw(source: CanvasImageSource): Promise<boolean>;
};

export type ColorCanvasProps = {
	effects: readonly EffectDescriptor[];
	/** Drawing-buffer size (the layer's intrinsic box). */
	width: number;
	height: number;
	/** Optional declarative source: drawn whenever it (or the effects) change. */
	source?: CanvasImageSource | null;
	style?: CSSProperties;
	'data-color-output'?: string;
};

export const ColorCanvas = forwardRef<ColorCanvasHandle, ColorCanvasProps>(function ColorCanvas(
	{ effects, width, height, source, style, ...rest },
	ref,
) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const chain = Internals.useEffectChainState();
	const lastSource = useRef<CanvasImageSource | null>(null);
	const memoized = useMemo(
		() => effects.map((e) => ({ ...e, memoized: true }) as EffectDefinitionAndStack<unknown>),
		[effects],
	);
	const rendering = getRemotionEnvironment().isRendering;

	const draw = useCallback(
		async (src: CanvasImageSource): Promise<boolean> => {
			lastSource.current = src;
			const canvas = canvasRef.current;
			if (!canvas) return false;
			if (canvas.width !== width) canvas.width = width;
			if (canvas.height !== height) canvas.height = height;
			const handle = rendering ? delayRender('Colour stage') : null;
			try {
				if (memoized.length === 0) {
					const ctx = canvas.getContext('2d');
					ctx?.clearRect(0, 0, width, height);
					ctx?.drawImage(src, 0, 0, width, height);
					return true;
				}
				const state = chain.get(width, height);
				if (!state) return false;
				return await Internals.runEffectChain({
					state,
					source: src,
					effects: memoized,
					output: canvas,
					width,
					height,
				});
			} finally {
				if (handle !== null) continueRender(handle);
			}
		},
		[chain, memoized, width, height, rendering],
	);

	useImperativeHandle(ref, () => ({ draw }), [draw]);

	// Declarative source, and redraw of the last source when the passes change (paused preview edits).
	useEffect(() => {
		const src = source ?? lastSource.current;
		if (src) void draw(src);
	}, [source, draw]);

	return <canvas ref={canvasRef} width={width} height={height} style={style} {...rest} />;
});
