// AGENTS §0 / §4: an export never encodes the "Media Offline" card (or the silence of an offline sound) in place of the
// footage. The plan refuses media that is offline when it starts (`MEDIA_OFFLINE`, planner.ts); a file that changes or
// goes away while the export runs fails the job by name (`MEDIA_CHANGED_DURING_EXPORT`): its frames were decoded
// partly from the file the export planned with and partly from whatever replaced it (or not at all), and the registry
// no longer vouches for it (size / mtime, S04:AS-010). Re-opening the new file mid-export would mix two contents.
import type { RenderSnapshot, RenderVisualClip } from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import { fileMatches, type MediaRecord } from '../media/registry.ts';

/** What the guard reads of a planned export (`PlannedExport`). */
type Planned = {
	snapshot: RenderSnapshot;
	/** mediaId → the registry record the plan resolved (online then). */
	media: Record<string, { record: Pick<MediaRecord, 'originalName' | 'storage' | 'sizeBytes' | 'mtimeMs'> }>;
	joined?: readonly { snapshot: RenderSnapshot }[] | undefined;
};

/** A clip that shows (or plays) a media file, over sequence frames `[start, end)` of the exported sequence. */
export type MediaUse = {
	mediaId: string;
	clipId: string;
	name: string;
	/** An audio clip (silent when its media is missing) rather than a picture (the offline card). */
	sound: boolean;
	start: number;
	end: number;
};

/** Clips listed per media in errors and blockers (the rest are counted). */
const MAX_LISTED = 20;

/**
 * The clips of a snapshot that show or play a media file, with the frames of the exported sequence they cover (with
 * their transition handles), clipped to the snapshot's range. A clip inside a nested sequence covers its nest clip's
 * frames. `names` names audio clips (the snapshot does not carry their names).
 */
export function mediaUsesOf(
	snap: RenderSnapshot,
	names?: (clipId: string) => string | undefined,
): MediaUse[] {
	const out: MediaUse[] = [];
	const within = (a: number, b: number) => ({
		start: Math.max(a, snap.range.start),
		end: Math.min(b, snap.range.end),
	});
	const visit = (clips: readonly RenderVisualClip[], outer: { start: number; end: number } | null) => {
		for (const c of clips) {
			const span = outer ?? within(c.start - (c.headHandle ?? 0), c.start + c.duration + (c.tailHandle ?? 0));
			if (span.end <= span.start) continue;
			if ('mediaId' in c.source)
				out.push({ mediaId: c.source.mediaId, clipId: c.clipId, name: c.name, sound: false, ...span });
			if ('nest' in c.source) {
				const sub = c.source.nest.snapshot;
				visit(
					sub.videoTracks.flatMap((t) => t.clips),
					span,
				);
				visit(
					(sub.matteTracks ?? []).flatMap((t) => t.clips),
					span,
				);
			}
		}
	};
	visit(
		snap.videoTracks.flatMap((t) => t.clips),
		null,
	);
	visit(
		(snap.matteTracks ?? []).flatMap((t) => t.clips),
		null,
	);
	for (const a of snap.audioClips) {
		if (a.generator) continue;
		const span = within(a.start - (a.headHandle ?? 0), a.start + a.duration + (a.tailHandle ?? 0));
		if (span.end <= span.start) continue;
		out.push({
			mediaId: a.mediaId,
			clipId: a.clipId,
			name: names?.(a.clipId) ?? a.clipId,
			sound: true,
			...span,
		});
	}
	return out;
}

/** The clips of a snapshot whose media is offline (null handle): they would draw the offline card or play silence. */
export function offlineUsesOf(
	snap: RenderSnapshot,
	names?: (clipId: string) => string | undefined,
): MediaUse[] {
	return mediaUsesOf(snap, names).filter((u) => snap.media[u.mediaId] === null);
}

/** `"name" frames a–b` of a clip, for messages. */
export function describeUse(u: Pick<MediaUse, 'name' | 'start' | 'end'>): string {
	return `"${u.name}" (frames ${u.start}–${u.end})`;
}

export type ChangedMedia = {
	mediaId: string;
	/** The file name it was registered with. */
	name: string;
	path: string;
	clips: MediaUse[];
};

/**
 * The media an export planned with (its snapshots' online media) whose file no longer matches the record it was
 * planned with: changed, replaced or removed since the plan.
 */
export async function changedMediaOf(planned: Planned): Promise<ChangedMedia[]> {
	const snaps = planned.joined?.map((p) => p.snapshot) ?? [planned.snapshot];
	const used = new Map<string, MediaUse[]>();
	for (const s of snaps) {
		for (const id of Object.keys(s.media)) if (planned.media[id] && !used.has(id)) used.set(id, []);
		for (const u of mediaUsesOf(s)) used.get(u.mediaId)?.push(u);
	}
	const out: ChangedMedia[] = [];
	for (const [mediaId, clips] of used) {
		const { record } = planned.media[mediaId]!;
		if (await fileMatches(record)) continue;
		out.push({ mediaId, name: record.originalName, path: record.storage.path, clips });
	}
	return out;
}

/**
 * `MEDIA_CHANGED_DURING_EXPORT` (retryable: the same export succeeds once the file is final and linked) naming the
 * media, the clips using it and their frames. `cause`: the render's own failure, when the change made it fail.
 */
export function mediaChangedError(
	changed: readonly ChangedMedia[],
	opts: { exposePaths: boolean; cause?: unknown },
): JobError {
	// (job errors carry the message only: it names the file, the clips by name and id, and their frames)
	const listed = changed.slice(0, 5).map((m) => {
		const clips = m.clips
			.slice(0, 3)
			.map((u) => `clip "${u.name}" (${u.clipId}, frames ${u.start}–${u.end})`)
			.join(', ');
		const more = m.clips.length > 3 ? ` and ${m.clips.length - 3} more clip(s)` : '';
		const file = opts.exposePaths ? `${m.name} (${m.path})` : m.name;
		return `${file}${clips ? `, used by ${clips}${more}` : ''}`;
	});
	const others = changed.length > 5 ? ` and ${changed.length - 5} more file(s)` : '';
	const hint =
		'Wait until the file is final, relink it (Replace Footage, or Link Media for a file that moved), then export again.';
	const cause = opts.cause instanceof Error ? opts.cause.message.slice(0, 500) : undefined;
	return new JobError(
		'MEDIA_CHANGED_DURING_EXPORT',
		`Source media changed or went offline on disk during the export: ${listed.join('; ')}${others}. Its frames no longer match what the export started with, so the file was not finished. ${hint}`,
		true,
		{
			media: changed.map((m) => ({
				mediaId: m.mediaId,
				name: m.name,
				...(opts.exposePaths ? { path: m.path } : {}),
				clips: m.clips.slice(0, MAX_LISTED).map((u) => ({
					clipId: u.clipId,
					name: u.name,
					startFrame: u.start,
					endFrame: u.end,
				})),
				...(m.clips.length > MAX_LISTED ? { moreClips: m.clips.length - MAX_LISTED } : {}),
			})),
			hint,
			...(cause ? { cause } : {}),
		},
	);
}

/**
 * Runs an export's render and fails it by name when a planned media file changed meanwhile: after a render that
 * finished (its frames may mix two files) and in place of a render's own failure the change caused (not a cancel).
 */
export async function guardMediaDuring<T>(
	planned: Planned,
	opts: { exposePaths: boolean; signal: AbortSignal },
	render: () => Promise<T>,
): Promise<T> {
	let result: T;
	try {
		result = await render();
	} catch (e) {
		if (opts.signal.aborted) throw e;
		const changed = await changedMediaOf(planned).catch(() => []);
		if (changed.length > 0) throw mediaChangedError(changed, { exposePaths: opts.exposePaths, cause: e });
		throw e;
	}
	const changed = await changedMediaOf(planned);
	if (changed.length > 0) throw mediaChangedError(changed, { exposePaths: opts.exposePaths });
	return result;
}
