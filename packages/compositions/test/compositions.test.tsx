import {
	applyTransaction,
	buildRenderSnapshot,
	CROP_EFFECT,
	createCounterIdSource,
	createEffectRegistry,
	createEmptyProject,
	defaultRegistries,
	type EffectSpec,
	FLICKS_PER_SECOND,
	layerMatrix,
	type MediaHandle,
	type RenderSnapshot,
	type RenderVisualClip,
	type ResolvedEffect,
	resolveSceneAt,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	ASSET_COMPOSITION_ID,
	assetCanvas,
	assetDurationFrames,
	audioGainAt,
	blendModeCss,
	calculateAssetMetadata,
	calculateSequenceMetadata,
	DEFAULT_RENDER_OPTIONS,
	dbToGain,
	EMPTY_RENDER_DOC,
	effectStages,
	FRAME_DEPENDENT_KINDS,
	fontFormatFromUrl,
	jsonEqual,
	layerComponentFor,
	layerPropsAt,
	layerViewEqual,
	MotionGraphicLayer,
	mediaSrc,
	OfflineCard,
	type RenderDoc,
	rgbaCss,
	SEQUENCE_COMPOSITION_ID,
	SequenceComposition,
	SolidLayer,
	stabilizeRenderDoc,
	textBlockStyle,
	trimBeforeFrames,
	UnsupportedLayer,
	VideoLayer,
	videoSource,
	videoTrimBefore,
	volumeFrameToClipFrame,
} from '../src/index.ts';

const ctx = (ids: ReturnType<typeof createCounterIdSource>) => ({
	ids,
	now: () => 't',
	revision: 0,
	registries: defaultRegistries(),
});

const XF = {
	rotation: 37,
	uniformScale: false,
	scale: 80,
	scaleWidth: 150,
	anchor: [12, 34],
	position: [700, 400],
};

function makeProject() {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'C', preset: 'hd-1080p-25' });
	const { document, result } = applyTransaction(
		doc,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 50, track: 'V1', color: [0, 0.5, 1, 1] },
				{
					type: 'clip.addText',
					at: 10,
					duration: 40,
					track: 'V2',
					content: { text: 'Hello' },
					box: { autoSize: 'none', width: 400, height: 120 },
					transform: XF as never,
				},
			],
		},
		ctx(ids),
	);
	expect(result.ok).toBe(true);
	return { document, ids };
}

function makeDoc(): RenderSnapshot {
	const { document } = makeProject();
	return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

const HANDLE: MediaHandle = {
	url: '/media/mk_1',
	proxyUrl: '/media/mk_1/proxy/720',
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: 10 * FLICKS_PER_SECOND,
	hasAudio: true,
	rotation: 0,
};

function renderFrame(doc: RenderDoc, frame: number) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={doc.settings.fps.num / doc.settings.fps.den}
			frameToDisplay={frame}
		/>,
	);
}

function parseMatrix(css: string): number[] {
	const m = /matrix\(([^)]+)\)/.exec(css);
	if (!m) throw new Error(`no matrix in ${css}`);
	return m[1]!.split(',').map((x) => Number(x.trim()));
}

describe('metadata', () => {
	it('computes fps, size and duration from the document', async () => {
		const doc = makeDoc();
		const args = (d: RenderDoc) => ({
			props: { doc: d, options: DEFAULT_RENDER_OPTIONS },
			defaultProps: { doc: d, options: DEFAULT_RENDER_OPTIONS },
			abortSignal: new AbortController().signal,
			compositionId: SEQUENCE_COMPOSITION_ID,
			isRendering: false,
		});
		expect(await calculateSequenceMetadata(args(doc))).toEqual({
			durationInFrames: 50,
			fps: 25,
			width: 1920,
			height: 1080,
		});
		const vertical = {
			...doc,
			settings: { ...doc.settings, width: 1080, height: 1920, fps: { num: 30000, den: 1001 } },
			durationFrames: 7,
		};
		const meta = await calculateSequenceMetadata(args(vertical));
		expect(meta).toEqual({ durationInFrames: 7, fps: 30000 / 1001, width: 1080, height: 1920 });
		expect((await calculateSequenceMetadata(args(EMPTY_RENDER_DOC))).durationInFrames).toBe(1);
		expect(rgbaCss([1, 0.5, 0, 0.25])).toBe('rgba(255, 128, 0, 0.25)');
	});

	it('computes asset metadata for the Source monitor', async () => {
		const meta = await calculateAssetMetadata({
			props: { asset: HANDLE, fps: 30 },
			defaultProps: { asset: HANDLE, fps: 30 },
			abortSignal: new AbortController().signal,
			compositionId: ASSET_COMPOSITION_ID,
			isRendering: false,
		});
		expect(meta).toEqual({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 });
		expect(assetCanvas({ ...HANDLE, kind: 'audio', width: null, height: null })).toEqual({
			width: 1280,
			height: 720,
		});
		expect(assetDurationFrames({ asset: { ...HANDLE, kind: 'image', durationFlicks: null }, fps: 25 })).toBe(
			125,
		);
	});
});

describe('layer dispatch', () => {
	it('dispatches layers by kind with offline and unsupported fallbacks', () => {
		const doc = makeDoc();
		const [solid] = resolveSceneAt(doc, 20);
		expect(layerComponentFor({ clip: solid!.clip, media: null })).toBe(SolidLayer);
		const video = { ...solid!.clip, kind: 'video' as const, source: { mediaId: 'med_x' } };
		expect(layerComponentFor({ clip: video, media: null })).toBe(OfflineCard);
		expect(layerComponentFor({ clip: video, media: HANDLE })).toBe(VideoLayer);
		expect(
			layerComponentFor({ clip: { ...solid!.clip, kind: 'motion-graphic' as const }, media: null }),
		).toBe(MotionGraphicLayer);
		expect(layerComponentFor({ clip: { ...solid!.clip, kind: 'captions' as const }, media: null })).toBe(
			UnsupportedLayer,
		);
	});

	it('renders the Media Offline card for offline media', () => {
		const doc = makeDoc();
		const solid = doc.videoTracks[0]!.clips[0]!;
		const offline: RenderVisualClip = {
			...solid,
			kind: 'video',
			name: 'interview.mov',
			source: { mediaId: 'med_x' },
		};
		const d: RenderDoc = {
			...doc,
			videoTracks: [{ ...doc.videoTracks[0]!, clips: [offline] }],
			media: { med_x: null },
		};
		const { container } = renderFrame(d, 5);
		const card = container.querySelector('[data-offline-card]');
		expect(card?.textContent).toContain('Media Offline');
		expect(card?.textContent).toContain('interview.mov');
	});
});

describe('layer pipeline', () => {
	it('stacks tracks bottom → top and positions layers with the @jasper/project matrix', () => {
		const doc = makeDoc();
		const { container } = renderFrame(doc, 20);
		const layers = [...container.querySelectorAll<HTMLElement>('[data-clip-id]')];
		expect(layers.map((l) => l.dataset.kind)).toEqual(['solid', 'text']);
		const text = layers[1]!;
		expect(text.style.transformOrigin).toBe('0 0');
		const [a, b, c, d, e, f] = parseMatrix(text.style.transform);
		const expected = layerMatrix({
			position: [700, 400],
			anchor: [12, 34],
			scale: 80,
			scaleWidth: 150,
			uniformScale: false,
			rotation: 37,
			flipH: false,
			flipV: false,
		});
		for (const [got, want] of [
			[a, expected.a],
			[b, expected.b],
			[c, expected.c],
			[d, expected.d],
			[e, expected.e],
			[f, expected.f],
		] as const)
			expect(got).toBeCloseTo(want, 9);
		// rotation × non-uniform scale × anchor: the anchor lands on the position
		expect(expected.a * 12 + expected.c * 34 + expected.e).toBeCloseTo(700, 9);
		expect(expected.b * 12 + expected.d * 34 + expected.f).toBeCloseTo(400, 9);
		// and the scene resolver (used by the overlay) agrees with the rendered element
		const scene = resolveSceneAt(doc, 20);
		expect(scene[1]!.props.matrix).toEqual(expected);
		expect(text.style.width).toBe('400px');
		expect(text.textContent).toContain('Hello');
	});

	it('orders crop first, then enabled known effects, bypassing unknown ones', () => {
		const blur: EffectSpec = {
			id: 'test.blur',
			version: 1,
			label: 'Blur',
			category: 'Blur & Sharpen',
			appliesTo: 'video',
			params: [],
			preview: { css: (p) => ({ filter: `blur(${p.radius}px)` }) },
			native: null,
			capabilities: { preview: 'css', export: ['remotion'] },
		};
		const svgFx: EffectSpec = {
			...blur,
			id: 'test.svg',
			preview: { svgFilter: (_p, uid) => `<filter id="${uid}"><feGaussianBlur stdDeviation="2"/></filter>` },
		};
		const registry = createEffectRegistry([CROP_EFFECT, blur, svgFx]);
		const fx = (
			id: string,
			effectId: string,
			params: ResolvedEffect['params'],
			enabled = true,
		): ResolvedEffect => ({
			id,
			effectId,
			effectVersion: 1,
			enabled,
			params,
		});
		const stages = effectStages(
			[
				fx('fx_1', 'test.blur', { radius: 4 }),
				fx('fx_2', 'jasper.crop', { left: 10, top: 0, right: 5, bottom: 0 }),
				fx('fx_3', 'unknown.fx', {}),
				fx('fx_4', 'test.blur', { radius: 9 }, false),
				fx('fx_5', 'test.svg', {}),
			],
			'fx-clp',
			registry,
		);
		expect(stages.map((s) => s.id)).toEqual(['fx_2', 'fx_1', 'fx_5']);
		expect(stages[0]!.style.clipPath).toBe('inset(0% 5% 0% 10%)');
		expect(stages[1]!.style.filter).toBe('blur(4px)');
		expect(stages[2]!.style.filter).toBe('url(#fx-clp-fx_5)');
		expect(stages[2]!.svg?.markup).toContain('id="fx-clp-fx_5"');
	});

	it('renders crop innermost and the transform/opacity/blend outermost', () => {
		const doc = makeDoc();
		const text = doc.videoTracks[1]!.clips[0]!;
		const cropped: RenderVisualClip = {
			...text,
			blendMode: 'screen',
			opacity: { value: 40, keyframes: [] },
			effects: [
				{
					id: 'fx_c',
					effectId: 'jasper.crop',
					effectVersion: 1,
					enabled: true,
					params: { left: { value: 20, keyframes: [] } },
				},
			],
		};
		const d: RenderDoc = {
			...doc,
			videoTracks: [doc.videoTracks[0]!, { ...doc.videoTracks[1]!, clips: [cropped] }],
		};
		const { container } = renderFrame(d, 20);
		const outer = container.querySelector<HTMLElement>('[data-kind="text"]')!;
		expect(outer.style.opacity).toBe('0.4');
		expect(outer.style.mixBlendMode).toBe('screen');
		const crop = outer.querySelector<HTMLElement>('[data-effect="jasper.crop"]')!;
		expect(crop.style.clipPath).toContain('20%');
		expect(crop.querySelector('[data-layer-source]')).toBeTruthy();
		expect(blendModeCss('add')).toBe('plus-lighter');
		expect(blendModeCss('normal')).toBeUndefined();
	});

	it('keeps static layer props identical across frames and memoizes frame-independent layers', () => {
		const doc = makeDoc();
		const text = doc.videoTracks[1]!.clips[0]!;
		const p1 = layerPropsAt(text, 12, doc);
		const p2 = layerPropsAt(text, 40, doc);
		expect(p1.props).toBe(p2.props);
		expect(p1.contentTime).not.toBe(p2.contentTime);
		const animated: RenderVisualClip = {
			...text,
			opacity: {
				value: 100,
				keyframes: [
					{
						id: 'kf_1',
						time: 0,
						value: 0,
						interpolation: 'linear',
						easeIn: { influence: 1 / 3, slope: 1 },
						easeOut: { influence: 1 / 3, slope: 1 },
					},
					{
						id: 'kf_2',
						time: FLICKS_PER_SECOND,
						value: 100,
						interpolation: 'linear',
						easeIn: { influence: 1 / 3, slope: 1 },
						easeOut: { influence: 1 / 3, slope: 1 },
					},
				],
			},
		};
		const a1 = layerPropsAt(animated, 10, doc);
		const a2 = layerPropsAt(animated, 20, doc);
		expect(a1.props).not.toBe(a2.props);
		expect(a1.props.opacity).toBe(0);
		expect(a2.props.opacity).toBeCloseTo(40, 6);

		const base = {
			Component: SolidLayer,
			clip: text,
			props: p1.props,
			localFrame: 2,
			contentTime: 0,
			fps: 25,
			media: null,
			options: DEFAULT_RENDER_OPTIONS,
			fonts: [],
		};
		expect(layerViewEqual(base, { ...base, localFrame: 3, contentTime: 99 })).toBe(true);
		expect(layerViewEqual(base, { ...base, props: a1.props })).toBe(false);
		const mg = { ...base, clip: { ...text, kind: 'motion-graphic' as const } };
		expect(FRAME_DEPENDENT_KINDS.has('motion-graphic')).toBe(true);
		expect(layerViewEqual(mg, { ...mg, localFrame: 3 })).toBe(false);
	});
});

describe('text', () => {
	it('builds the text block style: fill, outside stroke, box mode, caps', () => {
		const doc = makeDoc();
		const text = doc.videoTracks[1]!.clips[0]!;
		if (!('text' in text.source)) throw new Error('not text');
		const source = {
			...text.source,
			text: {
				...text.source.text,
				style: {
					...text.source.text.style,
					fill: [1, 0, 0, 1] as [number, number, number, number],
					strokes: [
						{
							color: [0, 0, 0, 1] as [number, number, number, number],
							widthPx: 3,
							position: 'outside' as const,
						},
					],
					allCaps: true,
					fontId: 'fnt_1',
				},
			},
			box: { ...text.source.box, autoSize: 'width' as const },
		};
		const style = textBlockStyle(source, [
			{ fontId: 'fnt_1', family: 'Inter', weight: 400, style: 'normal', url: '/fonts/inter.woff2' },
		]);
		expect(style.color).toBe('rgba(255, 0, 0, 1)');
		expect(style.WebkitTextStroke).toBe('6px rgba(0, 0, 0, 1)');
		expect(style.paintOrder).toBe('stroke fill');
		expect(style.whiteSpace).toBe('pre');
		expect(style.textTransform).toBe('uppercase');
		expect(String(style.fontFamily)).toMatch(/^"Inter", /);
		expect(fontFormatFromUrl('/fonts/a.TTF?x=1')).toBe('truetype');
		expect(fontFormatFromUrl('/fonts/abc')).toBeUndefined();
	});
});

describe('transitions (S01 §13)', () => {
	/** Two 20-frame solids cut at frame 20 on V1, with a transition at the cut. */
	function transitionDoc(effectId: string, duration: number): RenderSnapshot {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-25' });
		const { document, result } = applyTransaction(
			doc,
			{
				label: 'setup',
				origin: 'user',
				commands: [
					{ type: 'clip.addSolid', at: 0, duration: 20, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
					{ type: 'clip.addSolid', at: 20, duration: 20, track: 'V1', color: [0, 0, 1, 1], ref: '$b' },
					{ type: 'transition.add', clipId: '$b', edge: 'in', effectId, duration },
				],
			},
			ctx(ids),
		);
		expect(result.ok).toBe(true);
		return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
	}
	const layersAt = (doc: RenderSnapshot, frame: number) => {
		const { container, unmount } = renderFrame(doc, frame);
		const out = {
			opacities: [...container.querySelectorAll<HTMLElement>('[data-clip-id]')].map((e) =>
				Number(e.style.opacity),
			),
			mattes: container.querySelectorAll('[data-transition-matte]').length,
		};
		unmount();
		return out;
	};

	it('draws both clips of a cross dissolve through the span, with complementary ramps', () => {
		const doc = transitionDoc('jasper.cross-dissolve', 10); // span 15…25
		const [a, b] = doc.videoTracks[0]!.clips;
		expect([a!.tailHandle, b!.headHandle]).toEqual([5, 5]);
		expect(layersAt(doc, 14)).toEqual({ opacities: [1], mattes: 0 });
		const mid = layersAt(doc, 17); // third frame of the span: 3/11 of the incoming clip
		expect(mid.opacities).toHaveLength(2);
		expect(mid.opacities[0]).toBeCloseTo(8 / 11, 9);
		expect(mid.opacities[1]).toBeCloseTo(3 / 11, 9);
		const afterCut = layersAt(doc, 22); // the outgoing clip is still drawn from its tail handle
		expect(afterCut.opacities[0]).toBeCloseTo(3 / 11, 9);
		expect(afterCut.opacities[1]).toBeCloseTo(8 / 11, 9);
		expect(layersAt(doc, 25)).toEqual({ opacities: [1], mattes: 0 });
	});

	it('draws a black matte under a dip to black and fades each clip on its own frames', () => {
		const doc = transitionDoc('jasper.dip-to-black', 10); // span 15…25, black on frame 19
		expect(doc.videoTracks[0]!.mattes).toHaveLength(1);
		expect(layersAt(doc, 14)).toEqual({ opacities: [1], mattes: 0 });
		const first = layersAt(doc, 16);
		expect(first.mattes).toBe(1);
		expect(first.opacities).toHaveLength(1);
		expect(first.opacities[0]).toBeCloseTo(3 / 5, 9);
		expect(layersAt(doc, 19)).toEqual({ opacities: [0], mattes: 1 });
		const second = layersAt(doc, 21);
		expect(second.mattes).toBe(1);
		expect(second.opacities[0]).toBeCloseTo(2 / 6, 9);
		expect(layersAt(doc, 25)).toEqual({ opacities: [1], mattes: 0 });
	});

	it('starts the video of an incoming clip inside its head handle', () => {
		const clip = { sourceIn: 2 * FLICKS_PER_SECOND, speed: { rate: 1 } };
		expect(videoTrimBefore(clip, 30)).toBe(60);
		expect(videoTrimBefore({ ...clip, headHandle: 6 }, 30)).toBe(54);
		expect(videoTrimBefore({ ...clip, headHandle: 6, speed: { rate: 2 } }, 30)).toBe(48);
	});
});

describe('media timing and audio gain', () => {
	it('converts sourceIn to trimBefore frames without speed scaling', () => {
		expect(trimBeforeFrames(2 * FLICKS_PER_SECOND, { num: 30, den: 1 })).toBe(60);
		expect(trimBeforeFrames(FLICKS_PER_SECOND, { num: 30000, den: 1001 })).toBeCloseTo(30000 / 1001, 9);
		expect(mediaSrc(HANDLE, { useProxies: false })).toBe('/media/mk_1');
		expect(mediaSrc(HANDLE, { useProxies: true })).toBe('/media/mk_1/proxy/720');
		expect(mediaSrc({ ...HANDLE, proxyUrl: null }, { useProxies: true })).toBe('/media/mk_1');
	});

	it('plays the proxy of an original the browser cannot decode, and renders it off-thread', () => {
		const prores = { ...HANDLE, browserDecodable: false };
		// Mandatory proxy (S04:PX-004): used even when proxies are off.
		expect(mediaSrc(prores, { useProxies: false })).toBe('/media/mk_1/proxy/720');
		expect(videoSource(prores, { useProxies: false, isPreview: true })).toEqual({
			via: 'media',
			src: '/media/mk_1/proxy/720',
		});
		expect(videoSource({ ...prores, proxyUrl: null }, { useProxies: false, isPreview: true })).toEqual({
			via: 'pending-proxy',
		});
		// Renders read the original through the render's FFmpeg; alpha (ProRes 4444) stays transparent.
		expect(videoSource(prores, { useProxies: false, isPreview: false })).toEqual({
			via: 'offthread',
			src: '/media/mk_1',
			transparent: false,
		});
		expect(videoSource({ ...prores, alpha: true }, { useProxies: true, isPreview: false })).toEqual({
			via: 'offthread',
			src: '/media/mk_1',
			transparent: true,
		});
		// Browser-decodable media (H.264, VP9 with alpha) stays on <Video> in previews and renders.
		expect(videoSource({ ...HANDLE, alpha: true }, { useProxies: false, isPreview: false })).toEqual({
			via: 'media',
			src: '/media/mk_1',
		});
		expect(videoSource(HANDLE, { useProxies: true, isPreview: true })).toEqual({
			via: 'media',
			src: '/media/mk_1/proxy/720',
		});
	});

	it('maps the volume-callback frame to the clip-local frame', () => {
		expect(volumeFrameToClipFrame(0, 10)).toBe(0);
		expect(volumeFrameToClipFrame(0, -15)).toBe(15);
		expect(volumeFrameToClipFrame(5, -15)).toBe(20);
	});

	it('evaluates gainDb + volumeDb keyframes + track + master volume', () => {
		const flat = { value: 0, keyframes: [] };
		const clip = {
			start: 100,
			duration: 50,
			sourceIn: 0,
			speed: { rate: 1, reverse: false, maintainPitch: true },
			gainDb: 6,
			volumeDb: { value: -6, keyframes: [] },
			track: { volumeDb: flat, pan: flat },
		};
		const fps = { num: 25, den: 1 };
		expect(audioGainAt(clip, 0, fps)).toBeCloseTo(1, 9);
		// An audio fade out over the clip's last 10 frames (sequence frames 140…150).
		const faded = {
			...clip,
			fades: [{ type: 'out' as const, start: 140, frames: 10, curve: 'linear' as const }],
		};
		expect(audioGainAt(faded, 39, fps)).toBeCloseTo(1, 9);
		expect(audioGainAt(faded, 45, fps)).toBeCloseTo(0.5, 9);
		expect(
			audioGainAt({ ...clip, gainDb: 0 }, 0, fps, { volumeDb: { value: -20, keyframes: [] } }),
		).toBeCloseTo(0.05012, 4);
		const ramp = {
			...clip,
			gainDb: 0,
			volumeDb: {
				value: 0,
				keyframes: [
					{
						id: 'k1',
						time: 0,
						value: -96,
						interpolation: 'linear' as const,
						easeIn: { influence: 1 / 3, slope: 1 },
						easeOut: { influence: 1 / 3, slope: 1 },
					},
					{
						id: 'k2',
						time: FLICKS_PER_SECOND,
						value: 0,
						interpolation: 'linear' as const,
						easeIn: { influence: 1 / 3, slope: 1 },
						easeOut: { influence: 1 / 3, slope: 1 },
					},
				],
			},
		};
		expect(audioGainAt(ramp, 0, fps)).toBe(0);
		expect(audioGainAt(ramp, 25, fps)).toBeCloseTo(1, 9);
		// keyframes are in content time: a clip trimmed 1 s in starts at full volume
		expect(audioGainAt({ ...ramp, sourceIn: FLICKS_PER_SECOND }, 0, fps)).toBeCloseTo(1, 9);
		expect(dbToGain(-Infinity)).toBe(0);
	});
});

describe('stabilizeRenderDoc', () => {
	it('keeps identity of unchanged clips across snapshot rebuilds', () => {
		const { document } = makeProject();
		const seqId = Object.keys(document.sequences)[0]!;
		const opts = { resolveMedia: () => null, resolveFont: () => null };
		const a = buildRenderSnapshot(document, seqId, opts);
		const b = buildRenderSnapshot(document, seqId, opts);
		expect(a).not.toBe(b);
		expect(stabilizeRenderDoc(a, b)).toBe(a);
		const textId = a.videoTracks[1]!.clips[0]!.clipId;
		const { document: moved } = applyTransaction(
			document,
			{
				label: 'move',
				origin: 'user',
				commands: [{ type: 'param.set', target: ['clip', textId, 'transform', 'rotation'], value: 90 }],
			},
			ctx(createCounterIdSource(500)),
		);
		const c = stabilizeRenderDoc(a, buildRenderSnapshot(moved, seqId, opts));
		expect(c).not.toBe(a);
		expect(c.videoTracks[0]).toBe(a.videoTracks[0]);
		expect(c.videoTracks[1]!.clips[0]).not.toBe(a.videoTracks[1]!.clips[0]);
		expect(jsonEqual({ x: [1, { y: 2 }] }, { x: [1, { y: 2 }] })).toBe(true);
		expect(jsonEqual({ x: 1 }, { x: 1, y: undefined })).toBe(false);
	});
});
