// Importing Remotion bundles (M2, S08:MGC-010, MGU-001): a project folder on the engine host (local/desktop;
// the engine runs the project's own `remotion bundle`, optionally watching it), or a zip of a built bundle
// uploaded with `purpose: 'mg-bundle'` (web). The RegisteredMedia becomes an `mg-bundle` MediaAsset (with its
// `mgBundle` header) in one "Import Remotion Project" transaction.
import { type RegisteredMedia, UPLOAD_CHUNK_BYTES, UploadOffsetMismatchSchema } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import type { Command, MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { buildMediaAsset, LOCAL_ENGINE_ID, mediaKeyOf } from '../import/assets.ts';
import { clientJobs } from '../import/client-jobs.ts';

export type BundleImportResult = { mediaId: string; reused: boolean; media: RegisteredMedia };

/** Message + hint of an engine error (MG_REMOTION_VERSION etc. carry an actionable hint). */
export function bundleErrorText(e: unknown): string {
	if (e instanceof EngineError) {
		const hint = (e.detail as { hint?: string } | undefined)?.hint;
		return hint ? `${e.message}. ${hint}` : e.message;
	}
	return e instanceof Error ? e.message : String(e);
}

/** The document asset of a registered bundle (keeps the `mgBundle` header). */
function bundleAsset(reg: RegisteredMedia, id: string, now: string): MediaAsset {
	const asset = buildMediaAsset(reg, { id, engineId: LOCAL_ENGINE_ID, now });
	return { ...asset, ...(reg.mgBundle ? { mgBundle: reg.mgBundle } : {}) };
}

/**
 * Adds (or refreshes) the bundle in the project: an asset with the same engine key is reused; a rebuilt
 * version of a bundle already in the project (same project folder) is relinked instead of duplicated.
 */
function commitBundle(
	session: EditorSession,
	reg: RegisteredMedia,
	label = 'Import Remotion Project',
): BundleImportResult {
	const doc = session.getCommitted();
	const same = Object.values(doc.media).find((m) => m.kind === 'mg-bundle' && mediaKeyOf(m) === reg.mediaKey);
	if (same) return { mediaId: same.id, reused: true, media: reg };
	const srcPath = reg.mgBundle?.source.path ?? null;
	const previous = srcPath
		? Object.values(doc.media).find((m) => m.kind === 'mg-bundle' && m.mgBundle?.source.path === srcPath)
		: undefined;
	const commands: Command[] = previous
		? [
				{
					type: 'media.relink',
					mediaId: previous.id,
					locator: { type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey },
					fingerprint: reg.fingerprint,
					mgBundle: reg.mgBundle,
					sizeBytes: reg.sizeBytes,
				} as Command,
			]
		: [
				{
					type: 'media.register',
					asset: bundleAsset(reg, session.ctx.ids.next('med'), new Date().toISOString()),
					name: reg.mgBundle?.source.name ?? reg.originalName,
					label: 'magenta',
					ref: '$bundle',
				} as Command,
			];
	const result = session.apply({ label, origin: 'user', commands });
	if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; ') || 'Import failed');
	const mediaId = previous?.id ?? result.refs.$bundle ?? (result.results[0] as { mediaId?: string })?.mediaId;
	if (!mediaId) throw new Error('Import produced no media');
	return { mediaId, reused: !!previous, media: reg };
}

/** Imports a project folder or built bundle folder on the engine host (local mode). */
export async function importBundleFolder(
	session: EditorSession,
	engine: EngineClient,
	path: string,
	opts: { watch?: boolean } = {},
): Promise<BundleImportResult> {
	const jobId = clientJobs.add({
		kind: 'mg-bundle',
		title: `Import Remotion project – ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`,
		projectId: session.projectId,
		progress: null,
		stage: 'Bundling',
	});
	try {
		const reg = await engine.call('mgBundleImport', {
			body: { path, projectId: session.projectId, ...(opts.watch ? { watch: true } : {}) },
		});
		const out = commitBundle(session, reg);
		clientJobs.update(jobId, { state: 'succeeded', progress: 1, stage: 'Imported' });
		return out;
	} catch (e) {
		clientJobs.update(jobId, {
			state: 'failed',
			error: {
				code: e instanceof EngineError ? e.code : 'ERROR',
				message: bundleErrorText(e),
				retryable: false,
			},
		});
		throw e;
	}
}

/** Uploads a zip of a built bundle (`remotion bundle` output) and imports it (web path). */
export async function importBundleZip(
	session: EditorSession,
	engine: EngineClient,
	file: Blob & { name?: string },
	opts: { signal?: AbortSignal; onProgress?(loaded: number, total: number): void } = {},
): Promise<BundleImportResult> {
	const name = file.name ?? 'bundle.zip';
	const jobId = clientJobs.add({
		kind: 'upload',
		title: `Upload Remotion bundle – ${name}`,
		projectId: session.projectId,
		stage: 'Uploading',
		totalBytes: file.size,
		loadedBytes: 0,
	});
	try {
		const up = await engine.createUpload({
			projectId: session.projectId,
			fileName: name,
			byteSize: file.size,
			mimeType: 'application/zip',
			purpose: 'mg-bundle',
		});
		let offset = up.offset;
		const chunk = up.chunkSize || UPLOAD_CHUNK_BYTES;
		let guard = 0;
		while (offset < file.size) {
			const end = Math.min(file.size, offset + chunk);
			try {
				offset = (await engine.appendUpload(up.uploadId, offset, file.slice(offset, end), opts.signal))
					.offset;
			} catch (e) {
				const m =
					e instanceof EngineError && e.code === 'UPLOAD_OFFSET_MISMATCH'
						? UploadOffsetMismatchSchema.safeParse(e.detail)
						: null;
				if (!m?.success || ++guard > 5) throw e;
				offset = m.data.expectedOffset;
			}
			opts.onProgress?.(offset, file.size);
			clientJobs.update(jobId, { progress: file.size ? offset / file.size : 1, loadedBytes: offset });
		}
		clientJobs.update(jobId, { stage: 'Importing', progress: null });
		const reg = await engine.call('mgBundleImport', {
			body: { uploadId: up.uploadId, projectId: session.projectId },
		});
		const out = commitBundle(session, reg);
		clientJobs.update(jobId, { state: 'succeeded', progress: 1, stage: 'Imported' });
		return out;
	} catch (e) {
		clientJobs.update(jobId, {
			state: 'failed',
			error: {
				code: e instanceof EngineError ? e.code : 'ERROR',
				message: bundleErrorText(e),
				retryable: false,
			},
		});
		throw e;
	}
}

/** Rebuilds a project-folder bundle (MGC-013); the open editor relinks when `mgBundle.rebuilt` arrives. */
export async function rebuildBundle(engine: EngineClient, asset: MediaAsset, projectId: string) {
	const l = asset.locators.find((x) => x.type === 'engine-store');
	if (l?.type !== 'engine-store') throw new Error('The bundle is not stored by the engine');
	return engine.call('mgBundleRebuild', { params: { key: l.key }, body: { projectId } });
}
