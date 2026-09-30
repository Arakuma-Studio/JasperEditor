import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	resolveSceneAt,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	calculateSequenceMetadata,
	DEFAULT_RENDER_OPTIONS,
	EMPTY_RENDER_DOC,
	layerComponentFor,
	MotionGraphicLayer,
	OfflineCard,
	rgbaCss,
	SEQUENCE_COMPOSITION_ID,
	SequenceComposition,
	SolidLayer,
	UnsupportedLayer,
	VideoLayer,
} from '../src/index.ts';

function makeDoc() {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'C', preset: 'hd-1080p-25' });
	const { document } = applyTransaction(
		doc,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 50, track: 'V1', color: [0, 0.5, 1, 1] },
				{ type: 'clip.addText', at: 10, duration: 40, track: 'V2', content: { text: 'Hello' } },
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

describe('@jasper/compositions', () => {
	it('computes metadata from the document', async () => {
		const doc = makeDoc();
		const meta = await calculateSequenceMetadata({
			props: { doc, options: DEFAULT_RENDER_OPTIONS },
			defaultProps: { doc, options: DEFAULT_RENDER_OPTIONS },
			abortSignal: new AbortController().signal,
			compositionId: SEQUENCE_COMPOSITION_ID,
			isRendering: false,
		});
		expect(meta).toEqual({ durationInFrames: 50, fps: 25, width: 1920, height: 1080 });
		const empty = await calculateSequenceMetadata({
			props: { doc: EMPTY_RENDER_DOC, options: DEFAULT_RENDER_OPTIONS },
			defaultProps: { doc: EMPTY_RENDER_DOC, options: DEFAULT_RENDER_OPTIONS },
			abortSignal: new AbortController().signal,
			compositionId: SEQUENCE_COMPOSITION_ID,
			isRendering: false,
		});
		expect(empty.durationInFrames).toBe(1);
		expect(rgbaCss([1, 0.5, 0, 0.25])).toBe('rgba(255, 128, 0, 0.25)');
	});

	it('dispatches layers by kind with offline and unsupported fallbacks', () => {
		const doc = makeDoc();
		const [solid] = resolveSceneAt(doc, 20);
		expect(layerComponentFor({ clip: solid!.clip, media: null })).toBe(SolidLayer);
		const video = { ...solid!.clip, kind: 'video' as const, source: { mediaId: 'med_x' } };
		expect(layerComponentFor({ clip: video, media: null })).toBe(OfflineCard);
		expect(
			layerComponentFor({
				clip: video,
				media: {
					url: '/m',
					proxyUrl: null,
					kind: 'video',
					width: 1,
					height: 1,
					durationFlicks: 1,
					hasAudio: false,
					rotation: 0,
				},
			}),
		).toBe(VideoLayer);
		expect(
			layerComponentFor({ clip: { ...solid!.clip, kind: 'motion-graphic' as const }, media: null }),
		).toBe(MotionGraphicLayer);
		expect(layerComponentFor({ clip: { ...solid!.clip, kind: 'captions' as const }, media: null })).toBe(
			UnsupportedLayer,
		);
	});

	it('renders a frame with layers positioned by the layer matrix', () => {
		const doc = makeDoc();
		const { container } = render(
			<Thumbnail
				component={SequenceComposition}
				inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
				compositionWidth={1920}
				compositionHeight={1080}
				durationInFrames={50}
				fps={25}
				frameToDisplay={20}
			/>,
		);
		const layers = container.querySelectorAll('[data-clip-id]');
		expect(layers.length).toBe(2);
		const text = container.querySelector('[data-kind="text"]') as HTMLElement;
		expect(text.style.transform).toContain('matrix(');
		expect(text.textContent).toContain('Text');
	});
});
