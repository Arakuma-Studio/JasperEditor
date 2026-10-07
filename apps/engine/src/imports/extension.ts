// The `imports` native extension (imports workstream): makes sure every render that draws media in a browser (the
// Remotion path, stills on it, layer bakes of the native/hybrid path) gets what the composition needs to show them
// exactly like the native export decodes them:
// - Lottie / vector media: the signed URL of their document (`loaderUrl`);
// - stills the browser cannot decode or with a pixel interpretation: their `display` PNG (`proxyUrl`,
//   `browserDecodable: false`);
// - videos with a pixel interpretation (field order, alpha): their interpreted ProRes `master` (`url`,
//   `browserDecodable: false` → <OffthreadVideo>).
// It also hands the native composite the display picture of Photoshop documents (their composite, which ffmpeg's PSD
// decoder does not reproduce).
import {
	browserPictureNeed,
	mediaLoaderPath,
	type MediaAsset,
	type MediaHandle,
	type RenderSnapshot,
} from '@jasper/project';
import type { NativeExtension } from '../export/native-ext.ts';
import type { PlannedExport } from '../export/planner.ts';
import { needsBake } from '../layer-bake/layer.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { VariantService } from './variants.ts';

/** Engine URL paths (unsigned) per media id prepared for one export / nested snapshot. */
export type ImportsArtifacts = Map<string, { url?: string; proxyUrl?: string; loaderUrl?: string }>;

const ARTIFACTS = new WeakMap<object, ImportsArtifacts>();

/** What the `imports` extension prepared for a planned export (layer bakes read it for their own documents). */
export function importsArtifactsOf(planned: object): ImportsArtifacts | null {
	return ARTIFACTS.get(planned) ?? null;
}

/** A media handle with the signed URLs the browser needs (see the module comment). */
export function withImportsUrls(
	handle: MediaHandle | null,
	art: { url?: string; proxyUrl?: string; loaderUrl?: string } | undefined,
	sign: (path: string) => string,
): MediaHandle | null {
	if (!handle || !art) return handle;
	const out: MediaHandle = { ...handle };
	if (art.loaderUrl) out.loaderUrl = sign(art.loaderUrl);
	if (art.proxyUrl) {
		out.proxyUrl = sign(art.proxyUrl);
		out.browserDecodable = false;
	}
	if (art.url) {
		out.url = sign(art.url);
		out.browserDecodable = false;
	}
	return out;
}

/** Media ids drawn by the browser in this export: all of them on the Remotion path, baked layers' on the native one. */
function browserDrawnMedia(snapshot: RenderSnapshot, purpose: 'native' | 'remotion'): Set<string> {
	const out = new Set<string>();
	const visit = (snap: RenderSnapshot) => {
		for (const t of [...snap.videoTracks, ...(snap.matteTracks ?? [])])
			for (const c of t.clips) {
				if ('nest' in c.source) visit(c.source.nest.snapshot);
				if (!('mediaId' in c.source)) continue;
				if (purpose === 'remotion' || needsBake(c)) out.add(c.source.mediaId);
			}
	};
	visit(snapshot);
	return out;
}

export function createImportsExtension(deps: {
	variants: VariantService;
	registry: MediaRegistry;
}): NativeExtension {
	return {
		id: 'imports',
		prepareForRemotion: true,
		async prepare(planned: PlannedExport, ctx) {
			const purpose = ctx.purpose ?? 'native';
			const art: ImportsArtifacts = new Map();
			const drawn = browserDrawnMedia(planned.snapshot, purpose);
			for (const [mediaId, local] of Object.entries(planned.media)) {
				const asset = planned.document.media[mediaId] as MediaAsset | undefined;
				if (!asset) continue;
				const r = local.record;
				// Photoshop documents (ag-psd composite) and stills ffmpeg does not demux as images (HEIF items in an ISO BMFF
				// container: no `-loop`): the native composite also uses the display picture.
				if (
					asset.kind === 'image' &&
					!asset.vector &&
					(r.layered || !/(^|,)(image2|[a-z0-9]+_pipe|png|webp)(,|$)/.test(r.container))
				) {
					const need = browserPictureNeed(asset);
					ctx.stage('Preparing pictures');
					local.display = await deps.variants.ensureAndWait(
						r,
						'display',
						need.variant,
						ctx.signal,
						ctx.jobId,
					);
				}
				if (!drawn.has(mediaId)) continue;
				const need = browserPictureNeed(asset);
				const entry: { url?: string; proxyUrl?: string; loaderUrl?: string } = {};
				if (need.loader) {
					const p = mediaLoaderPath(asset);
					if (p) entry.loaderUrl = p;
				} else if (need.picture === 'display') {
					ctx.stage('Preparing pictures');
					await deps.variants.ensureAndWait(r, 'display', need.variant, ctx.signal, ctx.jobId);
					entry.proxyUrl = deps.variants.url(r, 'display', need.variant);
				} else if (need.picture === 'proxy') {
					ctx.stage('Preparing interpreted footage');
					await deps.variants.ensureAndWait(r, 'master', need.variant, ctx.signal, ctx.jobId);
					entry.url = deps.variants.url(r, 'master', need.variant);
				}
				if (Object.keys(entry).length) art.set(mediaId, entry);
			}
			ARTIFACTS.set(planned, art);
			return art;
		},
		adaptRemotionDoc(doc, prepared, { signUrl }) {
			const art = prepared as ImportsArtifacts | undefined;
			if (!art?.size) return doc;
			const media: RenderSnapshot['media'] = {};
			for (const [id, h] of Object.entries(doc.media)) media[id] = withImportsUrls(h, art.get(id), signUrl);
			return { ...doc, media };
		},
	};
}
