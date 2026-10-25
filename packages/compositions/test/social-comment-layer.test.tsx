// social-comment@1 through the real layer path (S11:ATP-005; social-comment design §7.7–7.8): clip params → render
// snapshot (template assets declared by `requiredAssets`, resolved like the engine does) → MotionGraphicLayer → the
// TikTok card: avatar from the project medium (mediaUrls → TemplateImage), emoji images of the pack (emojiUrls →
// EmojiImage); an offline avatar draws the visible placeholder.
import { mgRegistry, templateAssetOptions } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type MediaHandle,
	type ProjectDocument,
	type RenderSnapshot,
	resolveSceneAt,
} from '@jasper/project';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ColorDocContext } from '../src/color/chain.ts';
import {
	DEFAULT_RENDER_OPTIONS,
	EmojiTableContext,
	FontsReadyContext,
	type LayerProps,
	MotionGraphicLayer,
} from '../src/index.ts';

const PNG: Omit<MediaAsset, 'id'> = {
	kind: 'image',
	fingerprint: `q1:${'c'.repeat(64)}`,
	originalName: 'face.png',
	sizeBytes: 100,
	container: 'png_pipe',
	probe: {
		durationFlicks: null,
		startTimecode: null,
		streams: [],
		rotationDegrees: 0,
		hasAlpha: false,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_face' }],
	derivation: null,
	importedAt: '2026-10-25T00:00:00.000Z',
};

function project(
	params: Record<string, unknown>,
	withAvatar: boolean,
): { doc: ProjectDocument; mediaId: string } {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'Comments', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) };
	const reg = applyTransaction(
		base,
		{ label: 'import', origin: 'user', commands: [{ type: 'media.register', asset: PNG }] },
		ctx,
	);
	if (!reg.result.ok) throw new Error(JSON.stringify(reg.result.errors));
	const mediaId = (reg.result.results[0] as { mediaId: string }).mediaId;
	const add = applyTransaction(
		reg.document,
		{
			label: 'add',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V1',
					template: { id: 'social-comment', version: 1 },
					params: { ...params, avatar: withAvatar ? { mediaId } : null },
				},
			],
		},
		ctx,
	);
	if (!add.result.ok) throw new Error(JSON.stringify(add.result.errors));
	return { doc: add.document, mediaId };
}

const handle = (url: string): MediaHandle => ({
	url,
	proxyUrl: null,
	kind: 'image',
	width: 400,
	height: 400,
	durationFlicks: null,
	hasAudio: false,
	rotation: 0,
});

// Remotion counts NODE_ENV=test as a render (getRemotionEnvironment); the Player behaviour needs another value.
// happy-dom reports every image as complete at once (a browser does so only once it loaded or broke).
const completeDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
beforeEach(() => {
	vi.stubEnv('NODE_ENV', 'development');
	Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => false });
});
afterEach(() => {
	vi.unstubAllEnvs();
	if (completeDesc) Object.defineProperty(HTMLImageElement.prototype, 'complete', completeDesc);
});

const EMOJI = (pack: string, g: string) =>
	`https://engine.test/fonts/emoji/${pack}/${[...g].map((c) => c.codePointAt(0)!.toString(16)).join('-')}.png`;

/** The clip's layer at `at` through the render snapshot with the template assets resolved (WP2's path). */
function layer(doc: ProjectDocument, resolve: (a: MediaAsset) => MediaHandle | null, at = 100) {
	const fonts: string[] = [];
	const snap: RenderSnapshot = buildRenderSnapshot(doc, Object.keys(doc.sequences)[0]!, {
		resolveMedia: resolve,
		resolveFont: () => null,
		templateAssets: templateAssetOptions(mgRegistry, {
			font: (f) => {
				fonts.push(`${f.family} ${f.weight}`);
				return `/fonts/tiktok-sans/${f.weight}.woff2`;
			},
			emoji: EMOJI,
		}),
	});
	// the sequence composition provides these tables (SequenceComposition: Emoji/Image tables, ColorDocContext)
	const l = resolveSceneAt(snap, at)[0]!;
	const props: LayerProps = {
		clip: l.clip,
		props: l.props,
		localFrame: l.localFrame,
		contentTime: l.contentTime,
		fps: 30,
		media: null,
		options: { ...DEFAULT_RENDER_OPTIONS, isPreview: true },
		fonts: snap.fonts,
	};
	const view = render(
		<FontsReadyContext.Provider value={{ allLoaded: true }}>
			<EmojiTableContext.Provider value={snap.emoji}>
				<ColorDocContext.Provider value={{ media: snap.media, bypass: new Set(), isPreview: true }}>
					<MotionGraphicLayer {...props} />
				</ColorDocContext.Provider>
			</EmojiTableContext.Provider>
		</FontsReadyContext.Provider>,
	);
	return { view, fonts, snap };
}

describe('social-comment@1 in the motion-graphic layer', () => {
	it('draws the TikTok comment card: uploaded avatar, its declared TikTok Sans faces and Apple emoji images', () => {
		const { doc, mediaId } = project({ variant: 'tiktok-comment', displayName: 'Luna ✨' }, true);
		const { view, fonts } = layer(doc, (a) => handle(`https://engine.test/media/${a.id}?sig=1`));
		expect(new Set(fonts)).toEqual(new Set(['TikTok Sans 500', 'TikTok Sans 600']));
		expect(view.container.querySelector('[data-mg-template="social-comment@1"]')).not.toBeNull();
		expect(view.container.querySelector('[data-social-variant="tiktok-comment"]')).not.toBeNull();
		expect(view.getByTestId('social-avatar-media').getAttribute('src')).toBe(
			`https://engine.test/media/${mediaId}?sig=1`,
		);
		expect(view.container.querySelector('[data-template-param="displayName"]')!.textContent).toBe('Luna ');
		expect(view.container.querySelector('[data-template-param="displayName"] img')!.getAttribute('alt')).toBe(
			'✨',
		);
		const emoji = [...view.container.querySelectorAll('img[data-emoji]')].map((i) => i.getAttribute('src'));
		expect(emoji).toEqual([EMOJI('apple', '✨'), EMOJI('apple', '😊')]);
		expect(view.container.querySelector('[data-missing-asset]')).toBeNull();
		view.unmount();
	});

	it('an offline avatar draws the visible placeholder; no avatar draws the TikTok default', () => {
		const offline = layer(project({}, true).doc, () => null);
		expect(offline.view.container.querySelector('[data-template-image="placeholder"]')).not.toBeNull();
		offline.view.unmount();
		const none = layer(project({}, false).doc, (a) => handle(`/m/${a.id}`));
		expect(none.view.container.querySelector('[data-social-avatar="default"]')).not.toBeNull();
		none.view.unmount();
	});
});
