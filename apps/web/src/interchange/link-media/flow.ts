// Link Media flow (docs/wp-notes/link-media.md §5), without React: verify a located file, let the engine find the
// others (relink-scan job + its full result), and link everything as one undoable transaction.
import type {
	AssetRelinkResponse,
	EngineJob,
	RegisteredMedia,
	RelinkAnchor,
	RelinkCriterion,
	RelinkScanRequest,
	RelinkScanResult,
} from '@jasper/api';
import { RELINK_MAX_ASSETS } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyRelinkTransaction,
	type MediaAsset,
	relinkMediaCommand,
	resetInterpretationCommand,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { t } from '../../i18n/runtime.ts';
import { LOCAL_ENGINE_ID } from '../../import/assets.ts';

/** Match File Properties and the Link Media options (Premiere's defaults: Align Timecode and Relink others on). */
export type LinkOptions = {
	/** File Name, File Extension, Media Start, File Size, Media Duration, Streams. */
	match: {
		name: boolean;
		extension: boolean;
		mediaStart: boolean;
		size: boolean;
		duration: boolean;
		streams: boolean;
	};
	alignTimecode: boolean;
	relinkOthers: boolean;
	preserveInterpretation: boolean;
};

export const DEFAULT_LINK_OPTIONS: LinkOptions = {
	match: { name: true, extension: true, mediaStart: false, size: false, duration: true, streams: true },
	alignTimecode: true,
	relinkOthers: true,
	preserveInterpretation: true,
};

/** The engine request's criteria: `ignoreExtension` says File Extension is off (the engine reads `name` alone). */
export function criteriaOf(o: LinkOptions): { match: RelinkCriterion[]; ignoreExtension: boolean } {
	const match = (Object.keys(o.match) as RelinkCriterion[]).filter(
		(k) => o.match[k as keyof LinkOptions['match']],
	);
	return { match: match.length ? match : ['name'], ignoreExtension: !o.match.extension };
}

/** A file found for an asset, waiting to be linked (or for the user's confirmation). */
export type Found = {
	assetId: string;
	path: string;
	media: RegisteredMedia;
	match: AssetRelinkResponse['match'];
	diff: AssetRelinkResponse['diff'];
	needsConfirm: boolean;
	how: string;
};

export type ScanOutcome = {
	found: Found[];
	ambiguous: RelinkScanResult['ambiguous'];
	notFound: string[];
	scannedFiles: number;
	truncated: boolean;
	timedOut: boolean;
	mappings: RelinkScanResult['mappings'];
};

const POLL_MS = 400;

/** Runs a `relink-scan` job and fetches its full result; `onJob` sees every update (for progress and Cancel). */
export async function runScan(
	engine: EngineClient,
	projectId: string,
	req: RelinkScanRequest,
	onJob: (j: EngineJob) => void,
): Promise<ScanOutcome> {
	const assets = req.assets.slice(0, RELINK_MAX_ASSETS);
	const job = await engine.relinkScan(projectId, { ...req, assets });
	onJob(job);
	let end = job;
	while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(end.state)) {
		await new Promise((r) => setTimeout(r, POLL_MS));
		end = await engine.getJob(job.id);
		onJob(end);
	}
	if (end.state === 'cancelled') throw new LinkCancelled();
	if (end.state !== 'succeeded') throw new Error(end.error?.message ?? t('The search {0}', end.state));
	const r = await engine.relinkScanResult(projectId, job.id);
	return {
		found: r.found.map((f) => ({
			assetId: f.assetId,
			path: f.path,
			media: f.media,
			match: f.match,
			diff: f.diff,
			needsConfirm: f.needsConfirm ?? f.match === 'different',
			how: f.step ?? 'search',
		})),
		ambiguous: r.ambiguous ?? [],
		notFound: [...r.notFound, ...req.assets.slice(RELINK_MAX_ASSETS).map((a) => (a as { id: string }).id)],
		scannedFiles: r.scannedFiles,
		truncated: r.truncated,
		timedOut: r.timedOut ?? false,
		mappings: r.mappings ?? [],
	};
}

export class LinkCancelled extends Error {
	constructor() {
		super('cancelled');
	}
}

/** The asset's last known path and project-relative path (the anchor's `from`). */
export function lastKnownPath(a: MediaAsset): { path: string | null; relativePath: string | null } {
	for (const l of a.locators)
		if (l.type === 'path') return { path: l.path, relativePath: l.relativeToProject ?? null };
	return { path: null, relativePath: null };
}

export function anchorOf(a: MediaAsset, newPath: string): RelinkAnchor | null {
	const { path, relativePath } = lastKnownPath(a);
	return path ? { from: path, to: newPath, relativePath } : null;
}

/** Engine body of an asset: the fields relinking compares (heavy optional fields are not needed). */
export function relinkBody(a: MediaAsset): MediaAsset {
	return {
		id: a.id,
		kind: a.kind,
		fingerprint: a.fingerprint,
		originalName: a.originalName,
		sizeBytes: a.sizeBytes,
		container: a.container,
		probe: a.probe,
		locators: a.locators.filter((l) => l.type === 'path' || l.type === 'engine-store'),
		derivation: null,
		importedAt: a.importedAt,
		...(a.sourceRange ? { sourceRange: a.sourceRange } : {}),
	} as MediaAsset;
}

export type ApplyOutcome =
	| { ok: true; linked: string[]; unaligned: { mediaId: string; reason: string }[] }
	| { ok: false; error: string };

/** Links found files as one undoable transaction ("Link Media (n)"). */
export async function applyLinks(
	session: EditorSession,
	links: readonly { assetId: string; media: RegisteredMedia; force: boolean }[],
	o: LinkOptions,
): Promise<ApplyOutcome> {
	const doc = session.getCommitted();
	const usable = links.filter((l) => doc.media[l.assetId]);
	if (!usable.length) return { ok: true, linked: [], unaligned: [] };
	const assets = usable.map((l) => doc.media[l.assetId] as MediaAsset);
	const commands: Record<string, unknown>[] = usable.map((l, i) =>
		relinkMediaCommand(assets[i]!, l.media, {
			force: l.force,
			alignTimecode: o.alignTimecode,
			engineId: LOCAL_ENGINE_ID,
		}),
	);
	if (!o.preserveInterpretation) {
		const reset = resetInterpretationCommand(assets);
		if (reset) commands.push(reset);
	}
	const label = usable.length === 1 ? t('Link Media') : t('Link Media ({0})', usable.length);
	const { result, unaligned } = await applyRelinkTransaction(commands, (cmds) =>
		session.apply({ label, origin: 'user', commands: cmds as never }),
	);
	if (!result.ok) return { ok: false, error: result.errors[0]?.message ?? t('Linking failed') };
	return { ok: true, linked: usable.map((l) => l.assetId), unaligned };
}
