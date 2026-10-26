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
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	MissingAssetReporterContext,
	type MissingTemplateAsset,
	type RenderOptions,
	SequenceComposition,
} from '../src/index.ts';

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

function renderFrame(
	doc: RenderSnapshot,
	options: RenderOptions = DEFAULT_RENDER_OPTIONS,
	reports?: Map<string, readonly MissingTemplateAsset[]>,
	errors?: Error[],
) {
	return render(
		<MissingAssetReporterContext.Provider value={(id, assets) => reports?.set(id, assets)}>
			<Thumbnail
				// the Thumbnail's error boundary: what a render would fail with
				errorFallback={({ error }) => {
					errors?.push(error);
					return <div data-testid="render-error">{error.message}</div>;
				}}
				component={SequenceComposition}
				inputProps={{ doc, options }}
				compositionWidth={doc.settings.width}
				compositionHeight={doc.settings.height}
				durationInFrames={Math.max(1, doc.durationFrames)}
				fps={30}
				frameToDisplay={5}
			/>
		</MissingAssetReporterContext.Provider>,
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

const UNDECODABLE = () => handle('https://engine.test/media/orig.heic', { browserDecodable: false });

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

	it('render: a picture the browser cannot decode without a display picture fails the render by name', () => {
		// NODE_ENV=test is a render for Remotion (getRemotionEnvironment().isRendering)
		const { doc, mediaId } = project(true);
		const errors: Error[] = [];
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const view = renderFrame(snapshot(doc, UNDECODABLE), DEFAULT_RENDER_OPTIONS, undefined, errors);
			// (React may render the failing tree more than once before giving up)
			expect(errors.length).toBeGreaterThan(0);
			for (const e of errors)
				expect(e.message).toContain(
					`picture ${mediaId} cannot be decoded by the browser and has no display picture`,
				);
			expect(view.container.querySelector('[data-template-image="placeholder"]')).toBeNull();
			view.unmount();
		} finally {
			spy.mockRestore();
		}
	});

	it('Player: an undecodable picture without a display picture is marked and reported, not silent', async () => {
		vi.stubEnv('NODE_ENV', 'development');
		const { doc, mediaId } = project(true);
		const reports = new Map<string, readonly MissingTemplateAsset[]>();
		const view = renderFrame(snapshot(doc, UNDECODABLE), DEFAULT_RENDER_OPTIONS, reports);
		expect(view.queryByTestId('avatar')).toBeNull();
		expect(view.container.querySelector('[data-avatar-initials]')).not.toBeNull();
		expect(view.container.querySelector('[data-missing-asset="image"]')?.textContent).toBe(
			`Picture ${mediaId} is not available`,
		);
		await waitFor(() => expect([...reports.values()].flat()).toEqual([{ kind: 'media', mediaId }]));
		view.unmount();
	});

	it('a picture that fails to load: the Player reports it; a render fails with TemplateImageError', async () => {
		vi.stubEnv('NODE_ENV', 'development');
		const { doc, mediaId } = project(true);
		const snap = snapshot(doc, (a) => handle(`https://engine.test/media/${a.id}?sig=1`));
		const reports = new Map<string, readonly MissingTemplateAsset[]>();
		const view = renderFrame(snap, DEFAULT_RENDER_OPTIONS, reports);
		await act(async () => {
			fireEvent.error(view.getByTestId('avatar'));
		});
		expect(view.queryByTestId('avatar')).toBeNull();
		await waitFor(() => expect([...reports.values()].flat()).toEqual([{ kind: 'media', mediaId }]));
		view.unmount();
		vi.stubEnv('NODE_ENV', 'test');
		const errors: Error[] = [];
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const rendered = renderFrame(snap, DEFAULT_RENDER_OPTIONS, undefined, errors);
			await act(async () => {
				fireEvent.error(rendered.getByTestId('avatar'));
			});
			expect(errors.length).toBeGreaterThan(0);
			expect(new Set(errors.map((e) => e.name))).toEqual(new Set(['TemplateImageError']));
			expect(errors[0]!.message).toContain(`Template picture ${mediaId} could not be loaded`);
			rendered.unmount();
		} finally {
			spy.mockRestore();
		}
	});
});
