// AGENTS §4: a composition clip's offline card is the Program monitor's while it waits; a render (export, still,
// bake) never encodes it in place of the composition: it fails with the reason.
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	EMPTY_PROBE,
	type RenderCompositionSource,
	resolveSceneAt,
} from '@jasper/project';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompositionLayer, DEFAULT_RENDER_OPTIONS, type LayerProps } from '../src/index.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

function layer(
	isPreview: boolean,
	edit: (src: RenderCompositionSource) => RenderCompositionSource,
): LayerProps {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	const hash = 'a'.repeat(64);
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'media.register',
					ref: '$m',
					asset: {
						kind: 'mg-bundle',
						fingerprint: `q1:${hash}`,
						originalName: 'bundle',
						sizeBytes: 100,
						container: 'remotion-bundle',
						probe: EMPTY_PROBE,
						locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${hash.slice(0, 24)}` }],
						derivation: null,
						importedAt: '2026-10-01T00:00:00.000Z',
						mgBundle: {
							remotionVersion: '4.0.499',
							bundleHash: hash,
							builtAt: '2026-10-01T00:00:00.000Z',
							source: { type: 'bundle-upload', path: null, name: 'bundle' },
							compositions: [
								{
									id: 'Title',
									width: 1920,
									height: 1080,
									fps: 30,
									durationInFrames: 90,
									defaultProps: {},
									propsSchema: { type: 'object', properties: {} },
									schemaSource: 'inferred',
								},
							],
						},
					},
				},
				{ type: 'clip.addComposition', composition: { mediaId: '$m', id: 'Title' }, at: 0, track: 'V1' },
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const snap = buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	const l = resolveSceneAt(snap, 10)[0]!;
	const source = l.clip.source as { composition: RenderCompositionSource };
	return {
		clip: { ...l.clip, source: { composition: edit(source.composition) } },
		props: l.props,
		localFrame: l.localFrame,
		contentTime: l.contentTime,
		fps: 30,
		media: null,
		options: { ...DEFAULT_RENDER_OPTIONS, isPreview },
	};
}

describe('composition clips that cannot be drawn', () => {
	it('show the offline card in the preview and fail a render with the reason', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const cases: [(s: RenderCompositionSource) => RenderCompositionSource, RegExp][] = [
			[(s) => ({ ...s, bundle: null }), /MG_BUNDLE_MISSING/],
			[(s) => ({ ...s, info: null }), /MG_COMPOSITION_MISSING/],
		];
		for (const [edit, error] of cases) {
			const preview = render(<CompositionLayer {...layer(true, edit)} />);
			expect(preview.container.querySelector('[data-mg-card="offline"]')).not.toBeNull();
			preview.unmount();
			expect(() => render(<CompositionLayer {...layer(false, edit)} />)).toThrow(error);
		}
		// A render whose master was not provided (the engine renders masters before it starts).
		expect(() => render(<CompositionLayer {...layer(false, (s) => s)} />)).toThrow(/MG_RENDER_FAILED/);
	});
});
