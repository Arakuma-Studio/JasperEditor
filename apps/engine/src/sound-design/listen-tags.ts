// Event tags of the listening transcript (spec 12 P6-E14 "event tags in P6-E6"; wp-note "Phase 6 → WP-E9"): with the
// optional Describe-it search model, each listed event is named by the closest of our reference descriptions to the
// audio of the clip it is attributed to, at the event (from 50 ms before the attack, 0.3–2 s long by the event's length,
// at the clip's speed). The clip's own audio is used, not the mix: the mix render is streamed and not kept, and the
// clip's sound is what the event is about. Events of no clip, of a synthetic sound, of a reversed or time-mapped clip
// are not named. At most SOUND_LISTEN_MAX_TAGS events: the transcript's listed ones first, then the others, in time order.
import { SOUND_LISTEN_MAX_TAGS, type SoundListenEvent, type SoundListenResult } from '@jasper/api';
import { FLICKS_PER_SECOND, flicksPerFrame, type ProjectDocument } from '@jasper/project';
import type { MediaRegistry } from '../media/registry.ts';
import { audioWorld } from './bed.ts';

export type EventTag = NonNullable<SoundListenEvent['tag']>;
/** The Describe-it search service's namer (`SemanticService.nameWindows`). */
export type NameWindows = (
	items: { path: string; startSec: number; endSec: number }[],
	signal?: AbortSignal,
) => Promise<(EventTag | null)[]>;

const LEAD_SEC = 0.05;
const MIN_SEC = 0.3;
const MAX_SEC = 2;

/** The line text of an event with its tag. */
export function taggedLine(text: string, tag: EventTag): string {
	return `${text} · sounds like “${tag.text}” (${tag.verdict}, z ${tag.z.toFixed(2)})`;
}

/** The result with its events named (a new object; the input is not changed). */
export async function tagListenEvents(
	result: SoundListenResult,
	doc: ProjectDocument,
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>,
	name: NameWindows,
	signal?: AbortSignal,
): Promise<{ result: SoundListenResult; named: number }> {
	const world = await audioWorld(doc, result.sequenceId, registry);
	const clips = new Map(world.snapshot.audioClips.map((c) => [c.clipId, c]));
	const fpf = flicksPerFrame(result.fps);
	const listed = new Set(result.lines.flatMap((l) => (l.event !== undefined ? [l.event] : [])));
	const order = result.events
		.map((_, i) => i)
		.sort((a, b) => Number(listed.has(b)) - Number(listed.has(a)) || a - b);
	const items: { i: number; path: string; startSec: number; endSec: number }[] = [];
	for (const i of order) {
		if (items.length >= SOUND_LISTEN_MAX_TAGS) break;
		const e = result.events[i]!;
		const c = e.clipId ? clips.get(e.clipId) : undefined;
		if (!c || c.generator || c.mediaTime || c.speed.reverse) continue;
		const rate = c.speed.rate > 0 ? c.speed.rate : 1;
		const path = world.media(c.mediaId)?.path;
		if (!path) continue;
		const content = c.sourceIn + ((e.ms / 1000) * FLICKS_PER_SECOND - c.start * fpf) * rate;
		const atSec = content / FLICKS_PER_SECOND;
		const lenSec = Math.min(MAX_SEC, Math.max(MIN_SEC, e.lengthMs / 1000)) * rate;
		const startSec = Math.max(0, atSec - LEAD_SEC * rate);
		if (!Number.isFinite(startSec) || !Number.isFinite(lenSec)) continue;
		items.push({ i, path, startSec, endSec: atSec + lenSec });
	}
	const tags = await name(
		items.map(({ path, startSec, endSec }) => ({ path, startSec, endSec })),
		signal,
	);
	const byEvent = new Map<number, EventTag>();
	items.forEach((it, k) => {
		const tag = tags[k];
		if (tag) byEvent.set(it.i, tag);
	});
	const events = result.events.map((e, i) => (byEvent.has(i) ? { ...e, tag: byEvent.get(i)! } : e));
	const lines = result.lines.map((l) =>
		l.event !== undefined && byEvent.has(l.event)
			? { ...l, text: taggedLine(l.text, byEvent.get(l.event)!) }
			: l,
	);
	return {
		result: { ...result, events, lines, text: lines.map((l) => `${l.timecode}  ${l.text}`).join('\n') },
		named: byEvent.size,
	};
}
