// M2 animation contracts in the compositions (ARCHITECTURE §20.4): isFrameDependent, font readiness, the shape
// placeholder layer and the anime-template placeholder card.
import {
	anim,
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	defaultShape,
	defaultTransform,
	type ProjectDocument,
	type RenderSnapshot,
	type RenderVisualClip,
	shapeIntrinsicBox,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	FontsReadyContext,
	isFrameDependent,
	LAYER_COMPONENTS,
	layerViewEqual,
	type RenderDoc,
	SequenceComposition,
	ShapeLayer,
	useDocumentFonts,
	useFontsReady,
} from '../src/index.ts';

function makeDoc(): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addText',
					at: 0,
					duration: 60,
					track: 'V3',
					content: { text: 'Hello world' },
					box: { autoSize: 'none', width: 600, height: 120 },
					ref: '$t',
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	expect(result.ok).toBe(true);
	const doc = JSON.parse(JSON.stringify(document)) as ProjectDocument;
	const seq = Object.values(doc.sequences)[0]!;
	const text = seq.clips[result.ok ? result.refs.$t! : '']! as Record<string, unknown>;
	text.textAnimation = { in: { preset: 'fade', version: 1, durationFrames: 10, params: {} } };
	const frame = { width: 1920, height: 1080 };
	const common = (id: string, trackId: string, name: string) => ({
		id,
		trackId,
		start: 0,
		duration: 60,
		sourceIn: 0,
		speed: { rate: 1, reverse: false, maintainPitch: false },
		name,
		label: 'magenta' as const,
		enabled: true,
		linkId: null,
		groupId: null,
		markers: [],
		opacity: anim(100),
		blendMode: 'normal' as const,
		effects: [],
	});
	const shape = defaultShape('ellipse', { size: [300, 200] });
	seq.clips.clp_00000000000SHAPE = {
		...common('clp_00000000000SHAPE', seq.videoTracks[0]!.id, 'Ellipse'),
		kind: 'shape',
		shape,
		transform: defaultTransform(shapeIntrinsicBox(shape), frame, 'none'),
	};
	seq.clips.clp_00000000000ANIME = {
		...common('clp_00000000000ANIME', seq.videoTracks[1]!.id, 'Reveal'),
		kind: 'motion-graphic',
		template: { id: 'title-reveal', version: 1, renderer: 'anime' },
		params: {},
		canvas: 'sequence',
		transform: defaultTransform(frame, frame, 'none'),
	};
	return buildRenderSnapshot(doc, seq.id, { resolveMedia: () => null, resolveFont: () => null });
}

const clipsOf = (doc: RenderSnapshot) => doc.videoTracks.flatMap((t) => t.clips);

function renderFrame(doc: RenderDoc, frame: number) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={frame}
		/>,
	);
}

describe('isFrameDependent (ARCHITECTURE §20.4)', () => {
	const doc = makeDoc();
	const byKind = (k: string) => clipsOf(doc).find((c) => c.kind === k)!;
	it('frame-dependent kinds, animated text and keyframed shapes', () => {
		for (const kind of ['motion-graphic', 'animated-image', 'composition'] as const)
			expect(isFrameDependent({ kind, source: { unsupported: kind } })).toBe(true);
		const text = byKind('text');
		expect(isFrameDependent(text)).toBe(true);
		const plain = {
			...text,
			source: { ...(text.source as object), animation: undefined },
		} as RenderVisualClip;
		expect(isFrameDependent(plain)).toBe(false);
		const shape = byKind('shape');
		expect(isFrameDependent(shape)).toBe(false);
		const src = (shape.source as { shape: ReturnType<typeof defaultShape> }).shape;
		const keyed = {
			...shape,
			source: {
				shape: {
					...src,
					cornerRadius: {
						value: 0,
						keyframes: [
							{
								id: 'kf_0000000000000001',
								time: 0,
								value: 4,
								interpolation: 'linear' as const,
								easeIn: { influence: 0.3, slope: 0 },
								easeOut: { influence: 0.3, slope: 0 },
							},
						],
					},
				},
			},
		} as RenderVisualClip;
		expect(isFrameDependent(keyed)).toBe(true);
	});
	it('layerViewEqual re-renders animated text per frame', () => {
		const text = byKind('text');
		const view = {
			Component: () => null,
			clip: text,
			props: {} as never,
			localFrame: 1,
			contentTime: 0,
			fps: 30,
			media: null,
			options: DEFAULT_RENDER_OPTIONS,
		};
		expect(layerViewEqual(view, { ...view, localFrame: 2 })).toBe(false);
		const still = { ...view, clip: byKind('shape') };
		expect(layerViewEqual(still, { ...still, localFrame: 2 })).toBe(true);
	});
});

describe('font readiness (S11:FIX-003 contract)', () => {
	it('useFontsReady: true without a provider, the provider value otherwise', () => {
		expect(renderHook(() => useFontsReady(['Inter'])).result.current).toBe(true);
		const wrap = (allLoaded: boolean) =>
			function Wrap({ children }: { children: React.ReactNode }) {
				return <FontsReadyContext.Provider value={{ allLoaded }}>{children}</FontsReadyContext.Provider>;
			};
		expect(renderHook(() => useFontsReady(['Inter']), { wrapper: wrap(false) }).result.current).toBe(false);
		expect(renderHook(() => useFontsReady([]), { wrapper: wrap(false) }).result.current).toBe(true);
		const perFamily = ({ children }: { children: React.ReactNode }) => (
			<FontsReadyContext.Provider value={{ allLoaded: false, isLoaded: (f) => f === 'Inter' }}>
				{children}
			</FontsReadyContext.Provider>
		);
		expect(renderHook(() => useFontsReady(['Inter']), { wrapper: perFamily }).result.current).toBe(true);
		expect(renderHook(() => useFontsReady(['Inter', 'Lato']), { wrapper: perFamily }).result.current).toBe(
			false,
		);
	});
	it('useDocumentFonts reports when the document faces have settled', async () => {
		expect(renderHook(() => useDocumentFonts([])).result.current).toBe(true);
		const fonts = [
			{ fontId: 'fnt_1', family: 'Nope', weight: 400, style: 'normal' as const, url: '/x.woff2' },
		];
		const h = renderHook(() => useDocumentFonts(fonts));
		await waitFor(() => expect(h.result.current).toBe(true));
	});
});

describe('placeholder layers', () => {
	it('shapes draw a grey intrinsic box through LayerBox; anime templates draw their implementation', () => {
		expect(LAYER_COMPONENTS.shape).toBe(ShapeLayer);
		const doc = makeDoc();
		const r = renderFrame(doc, 5);
		const shape = r.container.querySelector<HTMLElement>('[data-kind="shape"]')!;
		expect(shape).not.toBeNull();
		expect(shape.style.width).toBe('300px');
		expect(shape.style.height).toBe('200px');
		expect(r.container.querySelector('svg[data-shape="ellipse"]')).not.toBeNull();
		const mg = r.container.querySelector<HTMLElement>('[data-mg-renderer="anime"]')!;
		// wp-m2-anime-templates mounted the implementation in place of the contracts' placeholder card.
		expect(mg.querySelector('[data-anime-template="title-reveal@1"]')).not.toBeNull();
		expect(mg.querySelector('[data-mg-badge]')).toBeNull();
	});
});
