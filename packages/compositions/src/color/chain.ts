// Planning of a layer's colour stage (S06:CG-040/041/045, CGU-005): which effects become passes of the canvas
// effect chain on the layer's source picture and which stay CSS/SVG wrapper stages (LayerBox).
//
// - Colour runs are exactly the engine's (`effectRuns` over the stack order): one baked-LUT pass each.
// - Non-colour effects BEFORE the last colour run must be applied before it: a CSS-`filter` effect (blur…) becomes
//   a 2D canvas pass in the chain; crop, flips and the corner pin commute with pointwise colour and stay CSS/
//   matrix stages; anything else stays a CSS stage (order approximation).
// - Effects after the last colour run stay CSS/SVG stages as in M1.
// - Without WebGL2 (preview only) the M1 colour effects fall back to their CSS/SVG preview and Lumetri is skipped
//   ("Grade unavailable"); before/after bypass drops every colour effect of the clip.
import {
	applyLut,
	colorRunKey,
	defaultEffectRegistry,
	type EffectRegistry,
	effectRuns,
	type MediaHandle,
	PREVIEW_LUT_SIZE,
	type ResolvedEffect,
	type SequenceColorInfo,
	workingKey,
} from '@jasper/project';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { cancelRender, continueRender, delayRender, type EffectDescriptor } from 'remotion';
import { colorLut, colorLutCpu, cssFilter } from './effects.ts';
import { canUseWebGl2, colorStageBackend } from './gl.ts';
import { bakedRunLut, loadedColorConfig, loadedLutAsset, loadLutAsset, lutUrlKey } from './luts.ts';
import { useColorStageStatus } from './status.ts';

/** Effects that commute with pointwise colour ops (geometry only). */
const COLOR_COMMUTING_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.crop',
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
	'jasper.corner-pin',
]);

type ChainStep =
	| { kind: 'lut'; effects: ResolvedEffect[] }
	| { kind: 'css'; effect: ResolvedEffect; filter: string };

type ColorPlan = {
	/** Canvas passes on the source picture, in order. */
	steps: ChainStep[];
	/** Effects drawn as CSS/SVG wrapper stages (LayerBox), stack order. */
	cssEffects: ResolvedEffect[];
	/** True when the layer has enabled colour effects (grade present). */
	graded: boolean;
	/** Colour effects that cannot be drawn (no WebGL2, preview): the chip "Grade unavailable". */
	unavailable: boolean;
};

function planColorStage(
	effects: readonly ResolvedEffect[],
	opts: { webgl: boolean; bypass: boolean; registry?: EffectRegistry },
): ColorPlan {
	const registry = opts.registry ?? defaultEffectRegistry;
	const isColor = (fx: ResolvedEffect) => fx.enabled && !!registry.get(fx.effectId, fx.effectVersion)?.color;
	const graded = effects.some(isColor);
	if (!graded) return { steps: [], cssEffects: [...effects], graded, unavailable: false };
	if (opts.bypass) {
		// color-mgmt: the before/after bypass shows the source colour-managed (the input transform stays).
		const kept = effects.filter(
			(fx) => !isColor(fx) || !!registry.get(fx.effectId, fx.effectVersion)?.internal,
		);
		if (!kept.some(isColor)) return { steps: [], cssEffects: kept, graded, unavailable: false };
		return planColorStage(kept, { ...opts, bypass: false });
	}
	if (!opts.webgl) {
		// M1 colour effects keep their CSS/SVG approximation; effects without one (Lumetri) are skipped.
		const css = effects.filter((fx) => {
			if (!isColor(fx)) return true;
			const spec = registry.get(fx.effectId, fx.effectVersion)!;
			return !!(spec.preview.css || spec.preview.svgFilter);
		});
		return { steps: [], cssEffects: css, graded, unavailable: true };
	}
	const runs = effectRuns(effects, registry);
	let lastColor = -1;
	runs.forEach((r, i) => {
		if (r.kind === 'color') lastColor = i;
	});
	const steps: ChainStep[] = [];
	const cssEffects: ResolvedEffect[] = [];
	runs.forEach((r, i) => {
		if (r.kind === 'color') {
			steps.push({ kind: 'lut', effects: r.effects });
			return;
		}
		const fx = r.effect;
		if (i > lastColor || COLOR_COMMUTING_EFFECTS.has(fx.effectId)) {
			cssEffects.push(fx);
			return;
		}
		const spec = registry.get(fx.effectId, fx.effectVersion);
		const css = spec?.preview.css?.(fx.params as never);
		if (css && Object.keys(css).length === 0) return; // identity
		if (css && Object.keys(css).length === 1 && typeof css.filter === 'string') {
			steps.push({ kind: 'css', effect: fx, filter: css.filter });
			return;
		}
		cssEffects.push(fx);
	});
	// Disabled / unknown effects keep flowing to the CSS stage builder (it skips them), in stack order.
	const inRuns = new Set(
		runs.flatMap((r) => (r.kind === 'color' ? r.effects.map((e) => e.id) : [r.effect.id])),
	);
	for (const fx of effects) if (!inRuns.has(fx.id)) cssEffects.push(fx);
	const order = new Map(effects.map((fx, i) => [fx.id, i]));
	cssEffects.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
	return { steps, cssEffects, graded, unavailable: false };
}

/** Media ids referenced by `{mediaId}` params of the given effects. */
export function referencedMedia(effects: readonly ResolvedEffect[]): string[] {
	const out = new Set<string>();
	for (const fx of effects)
		for (const v of Object.values(fx.params)) {
			const id = (v as { mediaId?: unknown } | null)?.mediaId;
			if (typeof id === 'string' && id) out.add(id);
		}
	return [...out];
}

// ---------------------------------------------------------------- document context

export type ColorDocValue = {
	/** The document's media handles (LUT assets referenced by effect params, S06:LUT-003). */
	media: Record<string, MediaHandle | null>;
	/** Preview before/after: clips whose colour effects are bypassed (S06:CGU-005). */
	bypass: ReadonlySet<string>;
	isPreview: boolean;
	/** color-mgmt: the working space of the (nested) sequence being drawn (absent = Rec. 709 defaults). */
	working?: SequenceColorInfo;
};

/** color-mgmt: the colour-op context of a document (working space, OCIO configs by media id). */
export function colorOpsContext(doc: ColorDocValue): {
	working?: SequenceColorInfo;
	colorConfig: (mediaId: string) => ReturnType<typeof loadedColorConfig> & {};
} {
	return {
		...(doc.working ? { working: doc.working } : {}),
		colorConfig: (id) => {
			const u = doc.media[id]?.url;
			return (u ? loadedColorConfig(u) : null) ?? (null as never);
		},
	};
}
const EMPTY: ColorDocValue = { media: {}, bypass: new Set(), isPreview: true };
export const ColorDocContext = createContext<ColorDocValue>(EMPTY);

// ---------------------------------------------------------------- hook

export type ColorStage = {
	/** Canvas effect descriptors for `<Video effects>` / `<Img effects>` / `ColorCanvas` (empty = none). */
	effects: EffectDescriptor[];
	/** Effects for LayerBox's CSS/SVG stages. */
	cssEffects: ResolvedEffect[];
	/** Show the "Grade unavailable" chip (preview only). */
	unavailable: boolean;
	/** LUT assets still loading (the preview draws ungraded meanwhile; renders wait). */
	pending: boolean;
};

/** Loads LUT assets (renders hold a delayRender until they arrive); returns a version that bumps on arrival. */
export function useLutAssets(urls: readonly string[], isPreview: boolean): number {
	const [version, setVersion] = useState(0);
	const missing = urls.filter((u) => loadedLutAsset(u) === undefined);
	const missingKey = missing.join('\n');
	// Renders wait for the LUTs of this frame (delayRender from the first render of the layer).
	const [initialHandle] = useState(() =>
		!isPreview && missing.length > 0 ? delayRender(`Loading LUT ${missing[0]}`) : null,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the list of missing URLs
	useEffect(() => {
		if (!missingKey) {
			if (initialHandle !== null) continueRender(initialHandle);
			return;
		}
		let alive = true;
		const handle =
			!isPreview && initialHandle === null ? delayRender(`Loading LUT ${missing[0]}`) : initialHandle;
		Promise.all(missingKey.split('\n').map((u) => loadLutAsset(u))).then(() => {
			if (alive) setVersion((v) => v + 1);
			if (handle !== null) continueRender(handle);
		});
		return () => {
			alive = false;
		};
	}, [missingKey]);
	return version;
}

/**
 * The colour stage of a layer at the current frame: plan, LUT assets, baked LUTs (cached by run key) and the
 * canvas effect descriptors. In renders a document with colour effects and no WebGL2 cancels the render with
 * WEBGL_UNAVAILABLE (S06:CG-042).
 */
export function useColorStage(clipId: string, effects: readonly ResolvedEffect[]): ColorStage {
	const doc = useContext(ColorDocContext);
	const status = useColorStageStatus();
	const webgl = status === 'ok';
	const bypass = doc.isPreview && doc.bypass.has(clipId);
	const plan = useMemo(() => planColorStage(effects, { webgl, bypass }), [effects, webgl, bypass]);
	if (!doc.isPreview && plan.graded && !canUseWebGl2())
		cancelRender(new Error('WEBGL_UNAVAILABLE: colour grading needs WebGL2 in the render browser'));

	const lutEffects = useMemo(() => plan.steps.flatMap((s) => (s.kind === 'lut' ? s.effects : [])), [plan]);
	const mediaIds = useMemo(() => referencedMedia(lutEffects), [lutEffects]);
	const urls = mediaIds.map((id) => doc.media[id]?.url).filter((u): u is string => !!u);
	const version = useLutAssets(urls, doc.isPreview);

	const stepKeys = useMemo(() => {
		const lutKey = (id: string) => {
			const u = doc.media[id]?.url;
			return u ? lutUrlKey(u) : `offline:${id}`;
		};
		const extra = workingKey(doc.working);
		return plan.steps.map((s) =>
			s.kind === 'lut'
				? colorRunKey(s.effects, lutKey, PREVIEW_LUT_SIZE, extra)
				: `css:${s.effect.id}:${s.filter}`,
		);
	}, [plan, doc.media, doc.working]);
	const pending = urls.some((u) => loadedLutAsset(u) === undefined);

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the run keys (+ LUT arrival `version`)
	const descriptors = useMemo(() => {
		if (pending) return [] as EffectDescriptor[];
		const lutOf = (id: string) => {
			const u = doc.media[id]?.url;
			return u ? (loadedLutAsset(u) ?? null) : null;
		};
		const out: EffectDescriptor[] = [];
		const cpu = colorStageBackend() === 'cpu';
		plan.steps.forEach((s, i) => {
			const key = stepKeys[i]!;
			if (s.kind === 'css') {
				out.push(cssFilter({ key, filter: s.filter }));
				return;
			}
			const lut = bakedRunLut(
				clipId,
				key,
				s.effects,
				defaultEffectRegistry,
				lutOf,
				PREVIEW_LUT_SIZE,
				colorOpsContext(doc),
			);
			if (lut) out.push(cpu ? colorLutCpu({ key, lut }) : colorLut({ key, lut }));
		});
		return out;
		// `version` re-bakes once LUT assets arrive.
	}, [stepKeys.join('\u0000'), pending, version, clipId]);

	return {
		effects: descriptors,
		cssEffects: plan.cssEffects,
		unavailable: doc.isPreview && plan.unavailable,
		pending,
	};
}

/**
 * A solid's colour through its colour runs (S06:CG-040 for `solid` layers): a uniform picture needs no canvas
 * pass, the baked run LUTs are applied to the one colour (exactly what `lut3d` does on the native path).
 * Returns the graded straight RGBA and the effects left for the CSS stages.
 */
export function useGradedSolid(
	clipId: string,
	effects: readonly ResolvedEffect[],
	rgba: readonly [number, number, number, number],
): { rgba: [number, number, number, number]; cssEffects: ResolvedEffect[]; unavailable: boolean } {
	const doc = useContext(ColorDocContext);
	const bypass = doc.isPreview && doc.bypass.has(clipId);
	// No GL needed: always "webgl" for the plan (the grade is computed in TS).
	const plan = useMemo(() => planColorStage(effects, { webgl: true, bypass }), [effects, bypass]);
	const lutEffects = plan.steps.flatMap((s) => (s.kind === 'lut' ? s.effects : []));
	const urls = referencedMedia(lutEffects)
		.map((id) => doc.media[id]?.url)
		.filter((u): u is string => !!u);
	const version = useLutAssets(urls, doc.isPreview);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-grades once LUT assets arrive
	const graded = useMemo(() => {
		const c: [number, number, number] = [rgba[0], rgba[1], rgba[2]];
		const lutKey = (id: string) => {
			const u = doc.media[id]?.url;
			return u ? lutUrlKey(u) : `offline:${id}`;
		};
		const lutOf = (id: string) => {
			const u = doc.media[id]?.url;
			return u ? (loadedLutAsset(u) ?? null) : null;
		};
		for (const s of plan.steps) {
			if (s.kind !== 'lut') continue;
			const key = colorRunKey(s.effects, lutKey, PREVIEW_LUT_SIZE, workingKey(doc.working));
			const lut = bakedRunLut(
				clipId,
				key,
				s.effects,
				defaultEffectRegistry,
				lutOf,
				PREVIEW_LUT_SIZE,
				colorOpsContext(doc),
			);
			if (lut) applyLut(lut, c);
		}
		return [c[0], c[1], c[2], rgba[3]] as [number, number, number, number];
	}, [plan, rgba, version, clipId, doc.media, doc.working]);
	return {
		rgba: graded,
		// CSS-filter steps before a grade (a blur of a uniform colour) stay CSS stages.
		cssEffects: [...plan.cssEffects, ...plan.steps.flatMap((s) => (s.kind === 'css' ? [s.effect] : []))].sort(
			(a, b) => effects.indexOf(a) - effects.indexOf(b),
		),
		unavailable: false,
	};
}
