// HTML compositions in the document (schema v13, docs/wp-notes/html-compositions.md): the `mgBundle.html` header is
// read leniently, checked by INV-MG-HTML, dropped by repair, validated by the commands, and handed to renders.
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	checkInvariants,
	createRandomIdSource,
	EMPTY_PROBE,
	loadProject,
	type MediaAsset,
	type MgBundleInfo,
	type RenderCompositionSource,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

function htmlInfo(html: unknown = { entry: 'pano.html', query: 's=2' }): MgBundleInfo {
	return {
		remotionVersion: '4.0.499',
		bundleHash: 'b'.repeat(64),
		builtAt: '2026-11-11T00:00:00.000Z',
		source: { type: 'html-page', path: '/tmp/carrusel/pano.html', name: 'pano.html?s=2' },
		compositions: [
			{
				id: 'pano',
				width: 1080,
				height: 1350,
				fps: 30,
				durationInFrames: 180,
				defaultProps: {},
				propsSchema: { type: 'object', properties: {}, additionalProperties: false },
				schemaSource: 'inferred',
				thumbnailFrame: 89,
			},
		],
		html: html as MgBundleInfo['html'],
	};
}

const htmlAsset = (info: MgBundleInfo): Omit<MediaAsset, 'id'> => ({
	kind: 'mg-bundle',
	fingerprint: `q1:${info.bundleHash}`,
	originalName: 'pano.html?s=2',
	sizeBytes: 43255,
	container: 'html-page',
	probe: EMPTY_PROBE,
	locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${info.bundleHash.slice(0, 24)}` }],
	derivation: null,
	importedAt: '2026-11-11T00:00:00.000Z',
	mgBundle: info,
});

function placed() {
	const h = new Harness({ preset: 'hd-1080p-30' });
	const r = h.ok([{ type: 'media.register', asset: htmlAsset(htmlInfo()) }]);
	const mediaId = (r.results[0] as { mediaId: string }).mediaId;
	const c = h.ok([
		{ type: 'clip.addComposition', composition: { mediaId, id: 'pano' }, at: 0, track: 'V2' },
	]);
	return { h, mediaId, clipId: (c.results[0] as { clipId: string }).clipId };
}

const sourceOf = (h: Harness, clipId: string): RenderCompositionSource => {
	const snap = buildRenderSnapshot(h.doc, h.seq.id, { resolveMedia: () => null, resolveFont: () => null });
	const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!;
	return (clip.source as { composition: RenderCompositionSource }).composition;
};

describe('HTML composition pages (schema v13)', () => {
	it('places the page like any composition and gives renders its entry and query', () => {
		const { h, clipId } = placed();
		expect(h.seq.clips[clipId]).toMatchObject({ kind: 'composition', duration: 180 });
		expect(sourceOf(h, clipId).bundle?.html).toEqual({ entry: 'pano.html', query: 's=2' });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses a page header that could escape its bundle (E_SCHEMA), on register and relink', () => {
		const h = new Harness({ preset: 'hd-1080p-30' });
		const bad = h.tx([
			{ type: 'media.register', asset: htmlAsset(htmlInfo({ entry: '../secret.html', query: '' })) },
		]);
		expect(bad.ok ? null : bad.errors[0]!.code).toBe('E_SCHEMA');
		const { h: h2, mediaId } = placed();
		const relink = h2.tx([
			{
				type: 'media.relink',
				mediaId,
				locator: { type: 'engine-store', engineId: 'local', key: 'mk_cccccccccccccccccccccccc' },
				mgBundle: htmlInfo({ entry: 'pano.html', query: 'a#b' }),
			},
		]);
		expect(relink.ok ? null : relink.errors[0]!.code).toBe('E_SCHEMA');
	});

	it('loads a damaged page header, reports it and drops it with its compositions (the clip stays, as a card)', () => {
		const { h, mediaId, clipId } = placed();
		const doc = structuredClone(h.doc) as unknown as { media: Record<string, { mgBundle: { html: unknown } }> };
		doc.media[mediaId]!.mgBundle.html = { entry: 42 };
		const r = loadProject(doc, { ids: createRandomIdSource() });
		expect(r.repairs.map((x) => x.action)).toContain('drop-html-page');
		expect(r.issues).toEqual([]);
		const asset = r.document.media[mediaId]!;
		expect(asset.mgBundle?.html).toBeUndefined();
		expect(asset.mgBundle?.compositions).toEqual([]);
		const clip = Object.values(r.document.sequences).flatMap((s) => Object.values(s.clips))[0]!;
		expect(clip.id).toBe(clipId);
	});
});
