import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type MediaHandle,
	type RenderSnapshot,
	type RenderVisualClip,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	ASSET_COMPOSITION_ID,
	calculateAssetMetadata,
	calculateSequenceMetadata,
	DEFAULT_RENDER_OPTIONS,
	EMPTY_RENDER_DOC,
	mediaSrc,
	type RenderDoc,
	SEQUENCE_COMPOSITION_ID,
	SequenceComposition,
	videoSource,
} from '../src/index.ts';

const ctx = (ids: ReturnType<typeof createCounterIdSource>) => ({
	ids,
	now: () => 't',
	revision: 0,
	registries: defaultRegistries(),
});
function makeDoc(): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'C', preset: 'hd-1080p-25' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [{ type: 'clip.addSolid', at: 0, duration: 50, track: 'V1', color: [0, 0.5, 1, 1] }],
		},
		ctx(ids),
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
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
	});
});
describe('offline media', () => {
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
		expect(container.textContent).toContain('interview.mov');
	});
});

describe('browser media routing (S04:PX-004)', () => {
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
});
