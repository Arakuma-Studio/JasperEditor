// Template media params end to end (C1, docs/wp-notes/social-comments.md "Template media params"): a test-only anime
// template with a `mediaParam()` avatar (not in the catalogue) goes params → render snapshot → the sequence
// composition → AnimeTemplateProps.mediaUrls → TemplateImage, with the URL the consumer resolved for the medium.
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
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, type RenderOptions, SequenceComposition } from '../src/index.ts';

vi.mock('@jasper/mg-templates', async (importOriginal) => {
	const m = await importOriginal<typeof import('@jasper/mg-templates')>();
	const { AVATAR_TEST_TEMPLATE } = await import('../../mg-templates/test/fixtures/avatar-test-template.ts');
	return { ...m, mgRegistry: m.createMgRegistry([...m.MG_CATALOG, AVATAR_TEST_TEMPLATE]) };
});
vi.mock('@jasper/motion/templates', async (importOriginal) => {
	const m = await importOriginal<typeof import('@jasper/motion/templates')>();
	const { AvatarTest } = await import('../../motion/test/fixtures/avatar-test-impl.tsx');
	return {
		...m,
		ANIME_TEMPLATE_IMPLS: Object.freeze({ ...m.ANIME_TEMPLATE_IMPLS, 'avatar-test@1': AvatarTest }),
	};
});

const { mgRegistry } = await import('@jasper/mg-templates');

const PNG: Omit<MediaAsset, 'id'> = {
	kind: 'image',
	fingerprint: `q1:${'b'.repeat(64)}`,
	originalName: 'avatar.png',
	sizeBytes: 100,
	container: 'png_pipe',
	probe: {
		durationFlicks: null,
		startTimecode: null,
		streams: [],
		rotationDegrees: 0,
		hasAlpha: true,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_avatar' }],
	derivation: null,
	importedAt: '2026-10-25T00:00:00.000Z',
};

function project(withAvatar: boolean): { doc: ProjectDocument; mediaId: string } {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'Avatars', preset: 'hd-1080p-30' });
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
					duration: 30,
					track: 'V1',
					template: { id: 'avatar-test', version: 1 },
					params: { name: 'Zed', avatar: withAvatar ? { mediaId } : null },
				},
			],
		},
		ctx,
	);
	if (!add.result.ok) throw new Error(JSON.stringify(add.result.errors));
	return { doc: add.document, mediaId };
}

const handle = (url: string, extra: Partial<MediaHandle> = {}): MediaHandle => ({
	url,
	proxyUrl: null,
	kind: 'image',
	width: 400,
	height: 400,
	durationFlicks: null,
	hasAudio: false,
	rotation: 0,
	...extra,
});

function snapshot(doc: ProjectDocument, resolve: (a: MediaAsset) => MediaHandle | null): RenderSnapshot {
	return buildRenderSnapshot(doc, Object.keys(doc.sequences)[0]!, {
		resolveMedia: resolve,
		resolveFont: () => null,
	});
}

function renderFrame(doc: RenderSnapshot, options: RenderOptions = DEFAULT_RENDER_OPTIONS) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={5}
		/>,
	);
}

describe('template media params in the sequence composition', () => {
	it('the avatar URL the consumer resolved reaches the template through mediaUrls and TemplateImage', () => {
		const { doc, mediaId } = project(true);
		const snap = snapshot(doc, (a) => handle(`https://engine.test/media/${a.id}?sig=1`));
		expect(snap.media[mediaId]?.url).toBe(`https://engine.test/media/${mediaId}?sig=1`);
		const view = renderFrame(snap);
		const img = view.getByTestId('avatar') as HTMLImageElement;
		expect(img.getAttribute('src')).toBe(`https://engine.test/media/${mediaId}?sig=1`);
		expect(img.getAttribute('alt')).toBe('Zed');
		fireEvent.load(img);
		view.unmount();
	});

	it('a picture the browser cannot decode uses its display picture (proxy), like stills', () => {
		const { doc, mediaId } = project(true);
		const snap = snapshot(doc, () =>
			handle('https://engine.test/media/orig.heic', {
				browserDecodable: false,
				proxyUrl: 'https://engine.test/media/display.png',
			}),
		);
		const view = renderFrame(snap);
		expect(view.getByTestId('avatar').getAttribute('src')).toBe('https://engine.test/media/display.png');
		expect(snap.media[mediaId]).not.toBeNull();
		view.unmount();
	});

	it('an offline avatar (no handle) or none draws the template fallback, not a broken image', () => {
		for (const [withAvatar, resolve] of [
			[true, () => null],
			[false, (a: MediaAsset) => handle(`/media/${a.id}`)],
		] as const) {
			const { doc } = project(withAvatar);
			const view = renderFrame(snapshot(doc, resolve));
			expect(view.container.querySelector('[data-avatar-test]')).not.toBeNull();
			expect(view.queryByTestId('avatar')).toBeNull();
			expect(view.container.querySelector('[data-avatar-initials]')?.textContent).toBe('Z');
			view.unmount();
		}
	});
});
