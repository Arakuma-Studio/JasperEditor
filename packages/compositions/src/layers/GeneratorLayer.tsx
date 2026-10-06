// Synthetic generator layer (edit-structure): Bars and Tone's HD colour bars and the Universal Counting Leader, drawn
// on a canvas from the pure rasterizers of @jasper/project (`renderBars`, `renderCountingLeader`), the same pixels the
// native export writes into its intermediates. Then the clip's pipeline like a picture: GPU shader effects through
// `FxPicture`, colour runs through the colour stage, CSS effects, Motion, opacity and blend.
import {
	FLICKS_PER_SECOND,
	type RenderVisualClip,
	renderBars,
	renderCountingLeader,
} from '@jasper/project';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { ColorCanvas } from '../color/ColorCanvas.tsx';
import { useColorStage } from '../color/chain.ts';
import { FxPicture, useFxFeed } from '../fx/FxPicture.tsx';
import { FxMediaInputs } from '../fx/sources.tsx';
import { useLayerFx } from '../fx/stage.ts';
import type { LayerProps } from '../types.ts';
import { GradeChip, LayerBox } from './LayerBox.tsx';

type Generator = Extract<RenderVisualClip['source'], { generator: unknown }>['generator'];

const FILL = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block' } as const;
const barsCache = new Map<string, HTMLCanvasElement>();

/** The generator's picture at content time `t` (flicks) as a canvas of `w × h`. */
export function generatorCanvas(g: Generator, w: number, h: number, t: number, fps: number): HTMLCanvasElement {
	const key = `${w}x${h}`;
	if (g.kind === 'bars') {
		const hit = barsCache.get(key);
		if (hit) return hit;
	}
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const px =
		g.kind === 'bars' ? renderBars(w, h) : renderCountingLeader(w, h, t / FLICKS_PER_SECOND, g.style, 1 / fps);
	const ctx = c.getContext('2d');
	if (ctx) ctx.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
	if (g.kind === 'bars') barsCache.set(key, c);
	return c;
}

function FxCanvasFeed({ canvas }: { canvas: HTMLCanvasElement }) {
	const fx = useFxFeed();
	useLayoutEffect(() => {
		fx.feed('source', canvas);
	}, [canvas, fx]);
	return null;
}

/** A canvas showing `source` (drawn in a layout effect: before the frame is captured). */
function PlainCanvas({ source }: { source: HTMLCanvasElement }) {
	const ref = useRef<HTMLCanvasElement | null>(null);
	useLayoutEffect(() => {
		const c = ref.current;
		if (!c) return;
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, c.width, c.height);
		ctx.drawImage(source, 0, 0);
	}, [source]);
	return <canvas ref={ref} width={source.width} height={source.height} style={FILL} data-generator="" />;
}

export function GeneratorLayer(layer: LayerProps) {
	const { clip, props } = layer;
	const src = clip.source;
	const g = 'generator' in src ? src.generator : null;
	const w = Math.max(1, Math.round(props.box.width));
	const h = Math.max(1, Math.round(props.box.height));
	const t = layer.pictureTime ?? layer.contentTime;
	// The leader changes every frame; the bars never (one cached picture per size).
	const frameKey = g?.kind === 'counting-leader' ? Math.round((t * layer.fps) / FLICKS_PER_SECOND) : 0;
	const styleKey = g?.kind === 'counting-leader' ? JSON.stringify(g.style) : '';
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the generator, size and frame
	const canvas = useMemo(
		() => (g ? generatorCanvas(g, w, h, (frameKey * FLICKS_PER_SECOND) / layer.fps, layer.fps) : null),
		[g?.kind, styleKey, w, h, frameKey, layer.fps],
	);
	const color = useColorStage(clip.clipId, props.effects);
	const fx = useLayerFx(layer);
	if (!canvas) return null;
	if (fx.mode === 'active')
		return (
			<LayerBox
				layer={layer}
				effects={fx.cssEffects}
				overlay={fx.chip ? <GradeChip layer={layer} text={fx.chip} /> : null}
			>
				<FxPicture stage={fx.stage}>
					<FxCanvasFeed canvas={canvas} />
					<FxMediaInputs stage={fx.stage} frame={layer.localFrame} />
				</FxPicture>
			</LayerBox>
		);
	return (
		<LayerBox
			layer={layer}
			effects={color.cssEffects}
			overlay={
				fx.mode === 'bypass' ? (
					<GradeChip layer={layer} text={fx.chip} />
				) : color.unavailable ? (
					<GradeChip layer={layer} />
				) : null
			}
		>
			{color.effects.length > 0 ? (
				<ColorCanvas effects={color.effects} width={w} height={h} source={canvas} style={FILL} />
			) : (
				<PlainCanvas source={canvas} />
			)}
		</LayerBox>
	);
}
