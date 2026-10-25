// social-comment@1 through the real layer path (S11:ATP-005; social-comment design §7.7): clip params → render
// snapshot → SequenceComposition → MotionGraphicLayer → the TikTok card, its avatar URL resolved from the project medium
// (AnimeTemplateProps.mediaUrls → TemplateImage); an offline avatar draws the visible placeholder.
import { mgRegistry } from '@jasper/mg-templates';
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
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, SequenceComposition } from '../src/index.ts';

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

function frame(doc: ProjectDocument, resolve: (a: MediaAsset) => MediaHandle | null, at = 100) {
	const snap: RenderSnapshot = buildRenderSnapshot(doc, Object.keys(doc.sequences)[0]!, {
		resolveMedia: resolve,
		resolveFont: () => null,
	});
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc: snap, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={snap.settings.width}
			compositionHeight={snap.settings.height}
			durationInFrames={Math.max(1, snap.durationFrames)}
			fps={30}
			frameToDisplay={at}
		/>,
	);
}

describe('social-comment@1 in the sequence composition', () => {
	it('draws the TikTok comment card with the uploaded avatar the snapshot resolved', () => {
		const { doc, mediaId } = project({ variant: 'tiktok-comment', displayName: 'Luna' }, true);
		const view = frame(doc, (a) => handle(`https://engine.test/media/${a.id}?sig=1`));
		expect(view.container.querySelector('[data-mg-template="social-comment@1"]')).not.toBeNull();
		expect(view.container.querySelector('[data-social-variant="tiktok-comment"]')).not.toBeNull();
		expect(view.getByTestId('social-avatar-media').getAttribute('src')).toBe(
			`https://engine.test/media/${mediaId}?sig=1`,
		);
		expect(view.container.querySelector('[data-template-param="displayName"]')!.textContent).toBe('Luna');
		view.unmount();
	});

	it('an offline avatar draws the visible placeholder; no avatar draws the TikTok default', () => {
		const offline = frame(project({}, true).doc, () => null);
		expect(offline.container.querySelector('[data-template-image="placeholder"]')).not.toBeNull();
		offline.unmount();
		const none = frame(project({}, false).doc, (a) => handle(`/m/${a.id}`));
		expect(none.container.querySelector('[data-social-avatar="default"]')).not.toBeNull();
		none.unmount();
	});

	it('draws the X post card through the layer: uploaded avatar, @handle, counts; no avatar draws the X default', () => {
		const { doc, mediaId } = project(
			{ variant: 'x-post', handle: 'luna', likes: 1234, verified: true },
			true,
		);
		const view = frame(doc, (a) => handle(`https://engine.test/media/${a.id}?sig=1`));
		expect(view.container.querySelector('[data-social-variant="x-post"]')).not.toBeNull();
		expect(view.getByTestId('social-avatar-media').getAttribute('src')).toBe(
			`https://engine.test/media/${mediaId}?sig=1`,
		);
		expect(view.container.querySelector('[data-part="handle"]')!.textContent).toBe('@luna');
		expect(view.container.querySelector('[data-template-param="handle"]')!.textContent).toBe('luna');
		expect(view.container.querySelector('[data-part="likes"]')!.textContent).toBe('1.2K');
		view.unmount();
		const none = frame(project({ variant: 'x-post' }, false).doc, (a) => handle(`/m/${a.id}`));
		expect(none.container.querySelector('[data-social-avatar="default"]')).not.toBeNull();
		none.unmount();
	});
});
