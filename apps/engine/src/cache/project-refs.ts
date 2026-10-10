// What a saved project needs from the cache, computed from its document (M3, S04:CA-012): the media cache files and
// proxies of every media asset it holds (by content fingerprint, CA-001), the pre-renders (preview and master) of its
// composition clips (the render keys the editor and the export ask for, S08:MGC-023/031/032) and the Motion Templates
// posters of its composition bundles. Caches whose keys depend on an export's evaluation (baked LUTs, warped layers,
// graphics bakes) are referenced through the ref sets that exports record (`CacheService.commitHolderRefs`).
import type { MgPrerenderRequest } from '@jasper/api';
import {
	audioPreviewSegments,
	buildRenderSnapshot,
	compositionClipRenderRange,
	compositionSequenceFrames,
	type ProjectDocument,
	previewSegments,
	type Rational,
	type RenderVisualClip,
} from '@jasper/project';
import { fingerprintHex } from '../media/fingerprint.ts';

export type ProjectCacheRefs = {
	/** Fingerprint hex (64) of every media asset (derivatives live under `cache/<hex>/`). */
	fingerprints: Set<string>;
	/** `mg/<key>` pre-render keys of the composition clips (previews and export masters). */
	mgRenderKeys: Set<string>;
	/** Bundle hashes (Motion Templates posters `mg/posters/<hash>/`). */
	bundleHashes: Set<string>;
	/** parity (roto): matte set keys of the document's roto objects (`cache/roto/sets/<key>/`). */
	rotoKeys?: Set<string>;
	/** previews: content hashes of every sequence's current video and audio segments (`cache/previews/<fmt>/<hash>.*`). */
	previewHashes?: Set<string>;
};

/** The render-key function of the mg-bundles service (`prerenderKey`). */
export type RenderKeyFn = (
	req: Pick<
		MgPrerenderRequest,
		'compositionId' | 'props' | 'width' | 'height' | 'fps' | 'startFrame' | 'durationFrames'
	>,
	bundleHash: string,
) => string;

/** Render key of a motion-graphic (fframes) clip in a snapshot (M1 mg service `clipRenderKey`). */
export type ClipRenderKeyFn = (clip: RenderVisualClip, fps: Rational) => string | null;

/**
 * The cache references of a stored document. Tolerant: unknown shapes are skipped; a sequence whose snapshot fails
 * (older or invalid document) only loses its composition keys (media references come from the raw document).
 */
export function projectCacheRefs(
	doc: unknown,
	renderKey: RenderKeyFn,
	fframesKey: ClipRenderKeyFn | null = null,
): ProjectCacheRefs {
	const out: ProjectCacheRefs = {
		fingerprints: new Set(),
		mgRenderKeys: new Set(),
		bundleHashes: new Set(),
		rotoKeys: new Set(),
		previewHashes: new Set(),
	};
	const d = doc as Partial<ProjectDocument> | null;
	if (!d || typeof d !== 'object') return out;
	// previews: the segments of every sequence as the document stands (undone states age out with the kind's limit).
	for (const seqId of Object.keys(d.sequences ?? {})) {
		try {
			for (const s of previewSegments(d as ProjectDocument, seqId)) out.previewHashes!.add(s.hash);
			for (const s of audioPreviewSegments(d as ProjectDocument, seqId)) out.previewHashes!.add(s.hash);
		} catch {
			// an invalid or older document: no preview references
		}
	}
	// parity (roto): computed mattes of roto objects (also undo states would need the engine; the saved ones count).
	for (const seq of Object.values(d.sequences ?? {}))
		for (const clip of Object.values((seq as { clips?: Record<string, unknown> }).clips ?? {})) {
			const rotos = (clip as { rotos?: { result?: { key?: unknown } | null }[] }).rotos;
			for (const r of Array.isArray(rotos) ? rotos : [])
				if (typeof r?.result?.key === 'string') out.rotoKeys!.add(r.result.key);
		}
	for (const asset of Object.values(d.media ?? {})) {
		const a = asset as { fingerprint?: unknown; mgBundle?: { bundleHash?: unknown } } | null;
		if (typeof a?.fingerprint === 'string') {
			try {
				out.fingerprints.add(fingerprintHex(a.fingerprint));
			} catch {
				// not an engine fingerprint (browser-only media)
			}
		}
		if (typeof a?.mgBundle?.bundleHash === 'string') out.bundleHashes.add(a.mgBundle.bundleHash);
	}
	if (out.bundleHashes.size === 0 && !fframesKey) return out;
	for (const seqId of Object.keys(d.sequences ?? {})) {
		try {
			const snap = buildRenderSnapshot(d as ProjectDocument, seqId, {
				resolveMedia: () => null,
				resolveFont: () => null,
			});
			const fps = snap.settings.fps;
			for (const clip of snap.videoTracks.flatMap((t) => t.clips)) {
				// fframes motion-graphic clips (M1): master and preview live under one key.
				if (fframesKey && 'mg' in clip.source) {
					const k = fframesKey(clip, fps);
					if (k) out.mgRenderKeys.add(k);
					continue;
				}
				const src = 'composition' in clip.source ? clip.source.composition : null;
				if (!src?.info || !src.bundle?.hash) continue;
				const total = compositionSequenceFrames(src.info, fps);
				const base = {
					compositionId: src.compositionId,
					props: src.props,
					width: src.canvas.width,
					height: src.canvas.height,
					fps: { num: fps.num, den: fps.den },
				};
				// Preview (editor, MGC-023): the whole composition at the sequence rate.
				out.mgRenderKeys.add(renderKey({ ...base, startFrame: 0, durationFrames: total }, src.bundle.hash));
				// Master (native export, MGC-032): the drawn span incl. transition handles.
				const range = compositionClipRenderRange(clip, fps, total);
				out.mgRenderKeys.add(
					renderKey(
						{ ...base, startFrame: range.startFrame, durationFrames: range.durationFrames },
						src.bundle.hash,
					),
				);
			}
		} catch {
			// an invalid or older document: media references only
		}
	}
	return out;
}
