// Typeset text: the renderer of text clips with AE-style animators, Path Options or
// the extended typography. The browser lays the text out (measure.ts); every character is then drawn as its own
// element at its measured place, moved by the animators (`charTransforms` → `placeGlyphs`, the EffectCraft port in
// @jasper/project): position / anchor / scale / skew / rotation (per-character 3D with the comp camera's
// perspective), opacity, fill and stroke colour (RGB, hue, saturation, brightness, opacity), stroke width,
// tracking, line anchor, line spacing, character offset / value, blur and variable font axes; More Options
// (anchor point grouping, fill & stroke order, inter-character blending); Path Options on a mask path.
// The same component draws the Program preview and every export (layer bake in headless Chrome), so both match.
import {
	buildPresetAnimators,
	charTransforms,
	clipLayerId,
	cssMatrix3d,
	evaluate,
	FLICKS_PER_SECOND,
	invertMatrix,
	type Keyframe,
	type LaidGlyph,
	type Mask,
	maskPathInPixels,
	PathMeasure,
	type PlacedGlyph,
	placeGlyphs,
	presetForLegacy,
	type RenderTextAnimation,
	type RGBA,
	resolveMask,
	sourceTextContentAt,
	substituteCharacter,
	type TextAnimatorGroup,
	type TextContent,
	type TextMoreOptions,
	type TextPathOptions,
	type TextSelectorExpressionHost,
	type TextStyle,
} from '@jasper/project';
import { type CSSProperties, type ReactNode, useContext, useId, useMemo } from 'react';
import { useVideoConfig } from 'remotion';
import { FALLBACK_FONT_STACK, fontFaceFor } from '../../fonts.ts';
import { rgbaCss } from '../../metadata.ts';
import type { LayerProps } from '../../types.ts';
import { TextExpressionContext } from './expression-context.ts';
import { drawnBaseline, measureAdvance, measureTypeset, type TypesetLayout } from './measure.ts';
import { charFlowCss, FAUX_ITALIC_SLANT, fauxBoldWidth, glyphSize, variationSettings } from './typography.ts';

type Fonts = LayerProps['fonts'];

export type TypesetSourceProps = {
	text: TextContent;
	box: { width: number; height: number; autoSize: 'none' | 'width' | 'height' };
	animators?: TextAnimatorGroup[];
	pathOptions?: TextPathOptions;
	moreOptions?: TextMoreOptions;
	perCharacter3d?: boolean;
	sourceTextKeyframes?: Keyframe<TextContent>[];
	animation?: RenderTextAnimation;
};

export function fontFamilyFor(s: Pick<TextStyle, 'fontId' | 'weight' | 'italic'>, fonts: Fonts): string {
	const face = fontFaceFor(fonts, s.fontId, s.weight, s.italic);
	return face ? `"${face.family.replace(/"/g, '')}", ${FALLBACK_FONT_STACK}` : FALLBACK_FONT_STACK;
}

/** AE's default comp camera (50 mm preset): zoom = 2666.67 px for a 1920 px wide comp. */
export function cameraZoom(compWidth: number): number {
	return (compWidth * 2666.67) / 1920;
}

const JOINING = /[؀-ۿݐ-ݿࢠ-ࣿ܀-ݏ߀-߿᠀-᢯ﭐ-﷿ﹰ-﻿]/u;

/** Text drawn for a grapheme: joining scripts keep their contextual forms with ZWJ on joined sides. */
function drawnText(glyphs: TypesetLayout['glyphs'], i: number, text: string): string {
	if (!JOINING.test(text)) return text;
	const prev = glyphs[i - 1];
	const next = glyphs[i + 1];
	const joins = (g: (typeof glyphs)[number] | undefined) =>
		!!g && !g.isSpace && g.lineIndex === glyphs[i]!.lineIndex && JOINING.test(g.text);
	return `${joins(prev) ? '\u200d' : ''}${text}${joins(next) ? '\u200d' : ''}`;
}

/**
 * Legacy In/Out text animations on a typeset clip are drawn in their animator form (the same conversion as the
 * `textAnimator.convertLegacy` command), windows anchored like the presets (In at the clip start, Out at its end).
 */
export function legacyAnimators(
	clip: { clipId: string; duration: number; sourceIn: number; speed: { rate: number; reverse: boolean } },
	animation: RenderTextAnimation | undefined,
	fps: number,
): TextAnimatorGroup[] {
	if (!animation) return [];
	const out: TextAnimatorGroup[] = [];
	let n = 0;
	const F = FLICKS_PER_SECOND / fps;
	for (const side of ['in', 'out'] as const) {
		const a = animation[side];
		if (!a || a.frames < 1) continue;
		const preset = presetForLegacy(a.preset, side);
		if (!preset) continue;
		const startFrame = side === 'in' ? 0 : clip.duration - 1 - a.frames;
		const time = (f: number) =>
			clip.sourceIn + (clip.speed.reverse ? clip.duration - 1 - f : f) * F * clip.speed.rate;
		const groups = buildPresetAnimators(preset, {
			newId: (p) => `${p}_legacy_${n++}`,
			start: time(startFrame),
			flicksPerSecond:
				(((clip.speed.reverse ? -1 : 1) * (FLICKS_PER_SECOND * (a.frames / fps))) / preset.duration) *
				clip.speed.rate,
			snap: (t) => Math.round(t),
			threeD: false,
		});
		const unit = a.params.unit;
		const based =
			unit === 'char' ? 'characters' : unit === 'word' ? 'words' : unit === 'line' ? 'lines' : undefined;
		if (based) for (const g of groups) for (const s of g.selectors) s.basedOn = based;
		out.push(...groups);
	}
	return out;
}

/** The typeset drawing of a text layer at one frame. */
export function TypesetText({
	layer,
	source,
	hidden,
}: {
	layer: LayerProps;
	source: TypesetSourceProps;
	hidden: boolean;
}) {
	const uid = useId().replace(/[^\w-]/g, '');
	const { width: compWidth, height: compHeight } = useVideoConfig();
	const expressionsFor = useContext(TextExpressionContext);
	const t = layer.contentTime;
	const content = sourceTextContentAt(source, t);
	const fonts = layer.fonts;
	const pointText = source.box.autoSize === 'width';
	const family = (s: Pick<TextStyle, 'fontId' | 'weight' | 'italic'>) => fontFamilyFor(s, fonts);
	const baseKey = JSON.stringify([content, source.box.width, pointText, fonts?.map((f) => f.family)]);
	// Cached by key inside measureTypeset (content, box, fonts).
	const layout = measureTypeset({ content, width: source.box.width, pointText, family }, baseKey);
	const expressions: TextSelectorExpressionHost | undefined =
		expressionsFor?.(layer.clip.clipId) ?? undefined;
	const threeD = !!source.perCharacter3d;
	const animators = useMemo(() => {
		const legacy = legacyAnimators(layer.clip, source.animation, layer.fps);
		return [...legacy, ...(source.animators ?? [])];
	}, [layer.clip, source, layer.fps]);
	const ctx = { time: t, layerId: clipLayerId(layer.clip.clipId), ...(expressions ? { expressions } : {}) };
	let lay = layout;
	let xfs = charTransforms(animators, lay.glyphs, lay.counts, ctx, threeD);
	// Character Offset / Value substitutions; Adjust Kerning lays the substituted text out again.
	let subs = lay.glyphs.map((g, i) => (g.isSpace ? null : substituteCharacter(g.text, xfs[i]!)));
	if (subs.some((s, i) => s !== null && xfs[i]!.charAlign === 'adjustKerning')) {
		const map = new Map<number, string>();
		subs.forEach((s, i) => {
			if (s !== null) map.set(i, s);
		});
		const key = `${baseKey}|${JSON.stringify([...map])}`;
		const relaid = measureTypeset(
			{ content, width: source.box.width, pointText, family, substitutions: map },
			key,
		);
		const prev = xfs;
		lay = { ...relaid, glyphs: relaid.glyphs.map((g, i) => ({ ...g, text: map.get(i) ?? g.text })) };
		xfs = prev;
		subs = lay.glyphs.map(() => null);
	}
	const styleOf = (i: number) => lay.styles[lay.glyphs[i]!.style]!;
	const cssOf = lay.styles.map((s) => charFlowCss(s, family(s)));
	// Variable font axes: the animated advance moves the characters after it.
	const vadv = lay.glyphs.map((g, i) => {
		const axes = xfs[i]!.axes;
		if (g.isSpace || subs[i] || !Object.values(axes).some((v) => v !== 0)) return 0;
		const css = cssOf[g.style]!;
		const s = styleOf(i);
		return (
			measureAdvance(g.text, {
				...css,
				fontVariationSettings: variationSettings(s, axes) ?? 'normal',
				position: 'static',
				top: 0,
			}) - measureAdvance(g.text, { ...css, position: 'static', top: 0 })
		);
	});
	const subAdv = lay.glyphs.map((g, i) => {
		const sub = subs[i];
		if (!sub) return null;
		return measureAdvance(sub, { ...cssOf[g.style]!, position: 'static', top: 0 });
	});
	const laid: LaidGlyph[] = lay.glyphs.map((g, i) => {
		const s = styleOf(i);
		const stroke = s.strokes?.[0];
		return {
			origin: [g.rect?.left ?? 0, g.baseline],
			advance: g.rect?.width ?? 0,
			size: s.sizePx,
			lineIndex: g.lineIndex,
			wordIndex: g.wordIndex,
			charIndex: g.charIndex,
			isSpace: g.isSpace || !g.rect,
			fill: s.fill as RGBA,
			stroke: (stroke?.color ?? [0, 0, 0, 0]) as RGBA,
			strokeWidth: stroke && stroke.widthPx > 0 ? stroke.widthPx : 0,
		};
	});
	// Path Options: the mask's path (normalised over the layer box) in text-box pixels.
	const po = source.pathOptions;
	const mask = po
		? ((layer.clip as { masks?: Mask[] }).masks ?? []).find((m) => m.id === po.maskId)
		: undefined;
	let path: Parameters<typeof placeGlyphs>[2]['path'];
	if (po && mask) {
		const resolved = resolveMask(mask, t);
		const measure = new PathMeasure(maskPathInPixels(resolved.path, layer.props.box), po.reversePath);
		if (!measure.isEmpty)
			path = {
				measure,
				perpendicular: po.perpendicularToPath,
				force: po.forceAlignment,
				firstMargin: evaluate(po.firstMargin, t),
				lastMargin: evaluate(po.lastMargin, t),
			};
	}
	const more = source.moreOptions;
	const align0 = lay.paragraphs[0]?.align ?? content.style.align;
	const placed = placeGlyphs(laid, xfs, {
		...(more
			? {
					moreOptions: {
						anchorPointGrouping: more.anchorPointGrouping,
						groupingAlignment: evaluate(more.groupingAlignment, t),
					},
				}
			: {}),
		threeD,
		...(path ? { path } : {}),
		lineBoxes: lay.lineBoxes,
		align: align0 === 'center' ? 1 : align0 === 'right' ? 2 : 0,
		variableAdvance: vadv,
		substitutedAdvance: subAdv,
	});
	// Perspective of per-character 3D: the comp camera (centre of the frame) seen from the layer.
	const inv = invertMatrix(layer.props.matrix);
	const camera = inv
		? [
				inv.a * (compWidth / 2) + inv.c * (compHeight / 2) + inv.e,
				inv.b * (compWidth / 2) + inv.d * (compHeight / 2) + inv.f,
			]
		: [source.box.width / 2, source.box.height / 2];
	const fillAndStroke = more?.fillAndStroke ?? 'perCharacter';
	const blend = more?.interCharacterBlending ?? 'normal';
	type Pass = { g: PlacedGlyph; stroke: boolean };
	const passesOf = (g: PlacedGlyph): Pass[] => {
		const s = styleOf(g.index);
		const hasStroke = g.strokeWidth > 0 && g.stroke[3] > 0;
		const strokeUnder = (s.strokes?.[0]?.position ?? 'outside') === 'outside';
		const fill: Pass = { g, stroke: false };
		if (!hasStroke) return [fill];
		const st: Pass = { g, stroke: true };
		return strokeUnder ? [st, fill] : [fill, st];
	};
	const visible = placed.filter((g) => g.xf.opacity > 0);
	let passes: Pass[];
	if (fillAndStroke === 'allFillsOverAllStrokes')
		passes = [
			...visible.flatMap((g) => passesOf(g).filter((p) => p.stroke)),
			...visible.map((g) => ({ g, stroke: false })),
		];
	else if (fillAndStroke === 'allStrokesOverAllFills')
		passes = [
			...visible.map((g) => ({ g, stroke: false })),
			...visible.flatMap((g) => passesOf(g).filter((p) => p.stroke)),
		];
	else passes = visible.flatMap(passesOf);
	const svgFilters: ReactNode[] = [];
	const nodes = passes.map((p, k) => {
		const g = p.g;
		const lg = lay.glyphs[g.index]!;
		const s = styleOf(g.index);
		const sub = subs[g.index];
		const text = drawnText(lay.glyphs, g.index, sub ?? lg.text);
		const css = cssOf[lg.style]!;
		const height = lg.rect?.height ?? glyphSize(s) * 1.2;
		const adv = g.xf.charAlign;
		const dx =
			sub && subAdv[g.index] !== null
				? adv === 'left'
					? 0
					: adv === 'right'
						? (lg.rect?.width ?? 0) - subAdv[g.index]!
						: ((lg.rect?.width ?? 0) - subAdv[g.index]!) / 2
				: 0;
		const bx = g.xf.blur[0];
		const by = g.xf.blur[1];
		let filter: string | undefined;
		if (bx > 0.05 || by > 0.05) {
			// EffectCraft: a Gaussian of σ = blur / 2 in layer pixels per axis.
			if (Math.abs(bx - by) < 1e-6) filter = `blur(${(bx / 2).toFixed(3)}px)`;
			else {
				const id = `${uid}-b${k}`;
				svgFilters.push(
					<filter
						key={id}
						id={id}
						x="-50%"
						y="-50%"
						width="200%"
						height="200%"
						colorInterpolationFilters="sRGB"
					>
						<feGaussianBlur stdDeviation={`${(bx / 2).toFixed(3)} ${(by / 2).toFixed(3)}`} />
					</filter>,
				);
				filter = `url(#${id})`;
			}
		}
		const fauxBold = s.fauxBold ? fauxBoldWidth(glyphSize(s)) : 0;
		const paint: CSSProperties = p.stroke
			? {
					color: 'transparent',
					WebkitTextStroke: `${(((s.strokes?.[0]?.position ?? 'outside') === 'outside' ? 2 : 1) * g.strokeWidth).toFixed(3)}px ${rgbaCss(g.stroke)}`,
				}
			: {
					color: rgbaCss(g.fill),
					...(fauxBold > 0 ? { WebkitTextStroke: `${fauxBold.toFixed(3)}px ${rgbaCss(g.fill)}` } : {}),
					...(s.shadow ? { textShadow: shadowCss(s.shadow) } : {}),
				};
		const baseline = drawnBaseline({ ...css, position: 'absolute', top: 0 }, height);
		return (
			<div
				key={`${g.index}-${p.stroke ? 's' : 'f'}`}
				data-text-char={g.index}
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					...(threeD
						? {
								perspective: `${cameraZoom(compWidth)}px`,
								perspectiveOrigin: `${camera[0]}px ${camera[1]}px`,
							}
						: {}),
					...(filter ? { filter } : {}),
					...(g.xf.opacity < 100 ? { opacity: Math.max(0, Math.min(1, g.xf.opacity / 100)) } : {}),
					...(blend !== 'normal' ? { mixBlendMode: blend } : {}),
				}}
			>
				<div
					style={{
						position: 'absolute',
						left: 0,
						top: 0,
						transformOrigin: '0 0',
						transform: cssMatrix3d(g.m),
						...(threeD ? { backfaceVisibility: 'visible' } : {}),
					}}
				>
					<span
						style={{
							...css,
							position: 'absolute',
							left: g.local[0] + dx,
							top: g.local[1] - baseline,
							height,
							lineHeight: `${height}px`,
							whiteSpace: 'pre',
							letterSpacing: 'normal',
							fontKerning: 'none',
							direction: 'ltr',
							unicodeBidi: 'isolate',
							...(s.fauxItalic
								? {
										transform: `skewX(${(-Math.atan(FAUX_ITALIC_SLANT) * 180) / Math.PI}deg)`,
										transformOrigin: `0 ${baseline}px`,
									}
								: {}),
							...(variationSettings(s, g.xf.axes)
								? { fontVariationSettings: variationSettings(s, g.xf.axes) }
								: {}),
							...paint,
						}}
					>
						{text}
					</span>
				</div>
			</div>
		);
	});
	return (
		<div
			data-text-block=""
			data-text-typeset=""
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				width: '100%',
				height: '100%',
				...(blend !== 'normal' ? { isolation: 'isolate' } : {}),
				...(hidden ? { visibility: 'hidden' } : {}),
			}}
		>
			{svgFilters.length ? (
				<svg width={0} height={0} aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
					<defs>{svgFilters}</defs>
				</svg>
			) : null}
			{nodes}
		</div>
	);
}

function shadowCss(shadow: NonNullable<TextStyle['shadow']>): string {
	const rad = (shadow.angleDeg * Math.PI) / 180;
	return `${Math.cos(rad) * shadow.distancePx}px ${Math.sin(rad) * shadow.distancePx}px ${shadow.blurPx}px ${rgbaCss(shadow.color)}`;
}
