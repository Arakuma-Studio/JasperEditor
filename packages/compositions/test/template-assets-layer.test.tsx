// social-comment §7.8: a template's declared fonts and emoji in the layer — emojiUrls, the visible marker and the panel
// report in preview, a failed render on export, failed-face tracking and retry, exact face gating.
import { type AnyMgTemplate, emojiGraphemes, mgRegistry, templateAssetOptions } from '@jasper/mg-templates';
import { MissingAssetReporterContext, type MissingTemplateAsset, retryTemplateAssets } from '@jasper/motion/templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	resolveSceneAt,
} from '@jasper/project';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	EmojiTableContext,
	FontsReadyContext,
	type FontsReadyState,
	type LayerProps,
	MotionGraphicLayer,
	useFontsReadyState,
	useLayerFontsReady,
} from '../src/index.ts';

const GRIN = '\u{1F600}';
const def = mgRegistry.getDefinition('title-reveal', 1) as AnyMgTemplate & { requiredAssets?: unknown };

beforeAll(() => {
	def.requiredAssets = (p: Record<string, unknown>) => ({
		fonts: [{ family: 'Chirp', weight: 700, style: 'normal' }],
		emoji: { pack: 'apple', graphemes: emojiGraphemes(String(p.title ?? '')) },
	});
});
afterAll(() => {
	delete def.requiredAssets;
});
// Remotion counts NODE_ENV=test as a render (getRemotionEnvironment); the Player behaviour needs another value.
beforeEach(() => {
	vi.stubEnv('NODE_ENV', 'development');
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

function setup(title = `Hi ${GRIN}`): { doc: ProjectDocument; clipId: string } {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V1',
					template: { id: 'title-reveal', version: 1 },
					params: { title },
					ref: '$a',
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return { doc: document, clipId: result.refs.$a! };
}

function layer(o: { font?: string | null; emoji?: string | null; isPreview?: boolean } = {}) {
	const { doc, clipId } = setup();
	const snap = buildRenderSnapshot(doc, Object.keys(doc.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
		templateAssets: templateAssetOptions(mgRegistry, {
			font: () => (o.font === undefined ? '/fonts/remote/chirp-700.woff2' : o.font),
			emoji: () => (o.emoji === undefined ? '/fonts/emoji/apple/1/1f600.png' : o.emoji),
		}),
	});
	const l = resolveSceneAt(snap, 60).find((x) => x.clip.clipId === clipId)!;
	const props: LayerProps = {
		clip: l.clip,
		props: l.props,
		localFrame: l.localFrame,
		contentTime: l.contentTime,
		fps: 30,
		media: null,
		options: { ...DEFAULT_RENDER_OPTIONS, isPreview: o.isPreview ?? true },
		fonts: snap.fonts,
	};
	return { snap, props, clipId };
}

function mount(
	l: ReturnType<typeof layer>,
	o: { fonts?: FontsReadyState; reports?: Map<string, readonly MissingTemplateAsset[]> } = {},
) {
	return render(
		<MissingAssetReporterContext.Provider value={(id, assets) => o.reports?.set(id, assets)}>
			<FontsReadyContext.Provider value={o.fonts ?? { allLoaded: true }}>
				<EmojiTableContext.Provider value={l.snap.emoji}>
					<MotionGraphicLayer {...l.props} />
				</EmojiTableContext.Provider>
			</FontsReadyContext.Provider>
		</MissingAssetReporterContext.Provider>,
	);
}

describe('template assets in the motion-graphic layer', () => {
	it('draws without markers when every declared asset is available', async () => {
		const reports = new Map<string, readonly MissingTemplateAsset[]>();
		const l = layer();
		const r = mount(l, { reports });
		expect(r.container.querySelector('[data-missing-asset]')).toBeNull();
		await new Promise((res) => setTimeout(res, 10));
		expect(reports.get(l.clipId) ?? []).toEqual([]);
	});

	it('preview: a missing font gets a visible banner and both missing assets reach the panel', async () => {
		const reports = new Map<string, readonly MissingTemplateAsset[]>();
		const l = layer({ font: null, emoji: null });
		const r = mount(l, { reports });
		const banner = r.container.querySelector('[data-missing-asset="font"]');
		expect(banner?.textContent).toBe('Font "Chirp" 700 is not available');
		await waitFor(() =>
			expect(reports.get(l.clipId)).toEqual(
				expect.arrayContaining([
					{ kind: 'font', family: 'Chirp', weight: 700, style: 'normal' },
					{ kind: 'emoji', pack: 'apple', grapheme: GRIN },
				]),
			),
		);
		r.unmount();
		await waitFor(() => expect(reports.get(l.clipId)).toEqual([]));
	});

	it('preview: a face that failed to load is marked like a missing one', () => {
		const l = layer();
		const r = mount(l, { fonts: { allLoaded: true, isFailed: (family) => family === 'Chirp' } });
		expect(r.container.querySelector('[data-missing-asset="font"]')).not.toBeNull();
	});

	it('export: a template never renders without its declared assets', () => {
		const l = layer({ emoji: null, isPreview: false });
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => mount(l)).toThrow(/Emoji 😀 \(apple\) not available/);
	});

	it('gates the layer on exactly its declared faces', () => {
		const l = layer();
		const asked: string[] = [];
		const state: FontsReadyState = {
			allLoaded: true,
			isLoaded: (family, weight, style) => {
				asked.push(`${family}|${weight}|${style}`);
				return false;
			},
		};
		const { result } = renderHook(() => useLayerFontsReady(l.props.clip, l.snap.fonts), {
			wrapper: ({ children }) => <FontsReadyContext.Provider value={state}>{children}</FontsReadyContext.Provider>,
		});
		expect(result.current).toBe(false);
		expect(asked).toEqual(['Chirp|700|normal']);
	});
});

describe('failed faces and retry', () => {
	it('remembers a face that failed and loads it again after retryTemplateAssets', async () => {
		let fail = true;
		class StubFontFace {
			load() {
				return fail ? Promise.reject(new Error('404')) : Promise.resolve(this);
			}
		}
		vi.stubGlobal('FontFace', StubFontFace);
		Object.defineProperty(document, 'fonts', { configurable: true, value: { add: () => {} } });
		const fonts = [
			{
				fontId: 'template:Retry Sans',
				family: 'Retry Sans',
				weight: 700,
				style: 'normal' as const,
				url: '/fonts/remote/retry.woff2',
			},
		];
		const { result } = renderHook(() => useFontsReadyState(fonts));
		await waitFor(() => expect(result.current.allLoaded).toBe(true));
		expect(result.current.isFailed?.('Retry Sans', 700, 'normal')).toBe(true);
		fail = false;
		await act(async () => retryTemplateAssets());
		await waitFor(() => expect(result.current.isFailed?.('Retry Sans', 700, 'normal')).toBe(false));
		expect(result.current.allLoaded).toBe(true);
	});
});
