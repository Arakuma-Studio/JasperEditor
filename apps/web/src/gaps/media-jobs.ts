// Create Proxies, Attach Proxies and ingest from the client's side (workstream gaps, docs/wp-notes/gaps.md §PRJ-8):
// submit `POST /api/media-jobs`, follow the engine job at module level (it completes while dialogs are closed) and,
// when it succeeds, commit ONE transaction: `media.attachProxy` per proxy ("Create Proxies"), `media.relink` to the
// copies ("Ingest: Copy") or the transcodes ("Ingest: Transcode", Replace Footage semantics). Failures and skipped
// media surface as a toast. Progress is the Jobs panel's (engine jobs).
import type { MediaJobRequest, MediaJobResult, RegisteredMedia } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	attachedProxyFrom as attachedProxyFromFile,
	mediaJobCommands,
	projectSettingsOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { mediaKeyOf } from '../import/assets.ts';
import { errorText, followJob } from '../processing/engine-jobs.ts';

export type ProxyDestination = MediaJobRequest['destination'];

/** The proxy record attached for a registered file (re-exported for the dialogs). */
export const attachedProxyFrom = (
	reg: RegisteredMedia,
	origin: 'created' | 'attached' | 'ingest',
	preset?: string | null,
) => attachedProxyFromFile(reg, origin, preset);

const LABELS = { proxy: 'Create Proxies', copy: 'Ingest: Copy', transcode: 'Ingest: Transcode' } as const;

/**
 * Starts a media job over the given media of the session's project and applies its result when it succeeds. Resolves
 * with the job id once submitted (the application happens later). Media that are not on the engine are reported.
 */
export async function startMediaJob(
	engine: EngineClient,
	session: EditorSession,
	opts: {
		op: MediaJobRequest['op'];
		mediaIds: readonly string[];
		preset?: string;
		destination: ProxyDestination;
		origin?: 'created' | 'ingest';
		/** Called after a successful job was applied (also when every item was skipped). */
		onDone?(applied: number): void;
	},
): Promise<string | null> {
	const doc = session.getCommitted();
	const items: MediaJobRequest['items'] = [];
	for (const id of new Set(opts.mediaIds)) {
		const a = doc.media[id];
		const key = mediaKeyOf(a);
		if (a && key) items.push({ mediaKey: key, mediaId: id, name: a.originalName });
	}
	if (!items.length) {
		toast({
			kind: 'warning',
			title: `${LABELS[opts.op]}: nothing to do`,
			detail: 'Select media imported through the engine.',
		});
		return null;
	}
	const scratch = projectSettingsOf(doc).scratch.media;
	const destination: ProxyDestination =
		opts.destination.mode === 'project' && scratch && !opts.destination.folder
			? { mode: 'project', folder: scratch }
			: opts.destination;
	let job: { id: string };
	try {
		job = await engine.call('mediaJobs', {
			body: {
				projectId: session.projectId,
				op: opts.op,
				...(opts.preset ? { preset: opts.preset } : {}),
				destination,
				items,
			},
		});
	} catch (e) {
		toast({ kind: 'error', title: `${LABELS[opts.op]} failed`, detail: errorText(e) });
		return null;
	}
	void followJob(engine, job.id).then(
		(done) => {
			if (done.state !== 'succeeded') {
				if (done.state !== 'cancelled')
					toast({
						kind: 'error',
						title: `${LABELS[opts.op]} failed`,
						detail: done.error?.message ?? done.state,
					});
				return;
			}
			const result = done.result as MediaJobResult;
			const { commands, skipped } = mediaJobCommands(
				session.getCommitted(),
				result,
				opts.origin ?? 'created',
			);
			const notes = [...result.skipped.map((s) => s.reason), ...skipped];
			if (commands.length) {
				const r = session.apply({ label: LABELS[opts.op], origin: 'user', commands: commands as never[] });
				if (!r.ok) {
					toast({ kind: 'error', title: `${LABELS[opts.op]}: not applied`, detail: r.errors[0]?.message });
					return;
				}
			}
			opts.onDone?.(commands.length);
			toast({
				kind: notes.length ? 'warning' : 'success',
				title: `${LABELS[opts.op]}: ${commands.length} clip${commands.length === 1 ? '' : 's'} done`,
				...(notes.length ? { detail: notes.join(' · ') } : {}),
			});
		},
		(e) => toast({ kind: 'error', title: `${LABELS[opts.op]} failed`, detail: errorText(e) }),
	);
	return job.id;
}

/**
 * Project Settings ▸ Ingest Settings at import time: copies, transcodes and / or proxies of the media just imported
 * (Premiere: Copy, Transcode, Create Proxies, Copy and Create Proxies). Proxies of copied media are made from the
 * copies (the engine reads the copy once the copy job finishes).
 */
export async function runIngest(
	engine: EngineClient,
	session: EditorSession,
	mediaIds: readonly string[],
): Promise<void> {
	const ing = projectSettingsOf(session.getCommitted()).ingest;
	if (!ing.enabled || !mediaIds.length) return;
	const destination: ProxyDestination = ing.destination
		? { mode: 'folder', folder: ing.destination }
		: { mode: 'next-to-media' };
	const doc = session.getCommitted();
	const videos = mediaIds.filter((id) => doc.media[id]?.kind === 'video');
	const proxies = () =>
		videos.length
			? startMediaJob(engine, session, {
					op: 'proxy',
					mediaIds: videos,
					...(ing.preset ? { preset: ing.preset } : {}),
					destination,
					origin: 'ingest',
				})
			: Promise.resolve(null);
	switch (ing.action) {
		case 'copy':
			await startMediaJob(engine, session, { op: 'copy', mediaIds, destination, origin: 'ingest' });
			return;
		case 'transcode':
			if (videos.length)
				await startMediaJob(engine, session, {
					op: 'transcode',
					mediaIds: videos,
					...(ing.preset ? { preset: ing.preset } : {}),
					destination,
					origin: 'ingest',
				});
			return;
		case 'proxies':
			await proxies();
			return;
		case 'copyAndProxies': {
			await startMediaJob(engine, session, {
				op: 'copy',
				mediaIds,
				destination,
				origin: 'ingest',
				onDone: () => void proxies(),
			});
			return;
		}
	}
}
