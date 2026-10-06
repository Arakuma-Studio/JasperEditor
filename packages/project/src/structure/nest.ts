// Nested sequences (S01:SEQ-010, KND-011; edit-structure, docs/wp-notes/edit-structure.md). Pure helpers shared by the
// commands, the render snapshot, the export and the UI.
//
// The nest model (for importers, e.g. XML interchange, and other workstreams such as multicam):
// - A nested sequence is an ordinary `Sequence` with its own project item. It is shown in another sequence by
//   `nest-video` (picture) and `nest-audio` (sound) clips whose `sequenceId` names it; a video and an audio nest clip
//   of one placement share a link group. The nesting graph is acyclic (INV-009).
// - Content time of a nest clip = time of the nested sequence in flicks (`sourceIn` + speed, like media); frame `n`
//   of the nested sequence is content time `n · flicksPerFrame(nested rate)`. The nested In/Out are ignored; its
//   bound is the nested duration (last clip end).
// - The nested sequence's background is transparent where it has no clips; its picture is its own frame size
//   (the nest clip's intrinsic box). Its master fader and track mix are its audio.
// - Everything a nest clip draws is a pure function of the nested sequence's content: `nestContentKey`.
import { canonicalJson } from '../color/runs.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, mapFrameBetweenRates, type Rational, rationalEquals } from '../time.ts';

export const NEST_KINDS: ReadonlySet<string> = new Set(['nest-video', 'nest-audio']);
/** Depth guard of the recursive renderers (cycles are invariant violations; this keeps a broken file finite). */
export const MAX_NEST_DEPTH = 16;

export function isNestClip(c: { kind: string }): c is Extract<Clip, { kind: 'nest-video' | 'nest-audio' }> {
	return NEST_KINDS.has(c.kind);
}

/** Sequences nested directly in `seq` (by its nest clips). */
export function nestedSequenceIds(seq: Pick<Sequence, 'clips'>): Set<string> {
	const out = new Set<string>();
	for (const c of Object.values(seq.clips)) {
		const s = (c as { sequenceId?: unknown }).sequenceId;
		if (isNestClip(c) && typeof s === 'string') out.add(s);
	}
	return out;
}

/** Every sequence reachable from `seqId` through nest clips (not including itself unless there is a cycle). */
export function nestedClosure(doc: Pick<ProjectDocument, 'sequences'>, seqId: string): Set<string> {
	const out = new Set<string>();
	const stack = [seqId];
	while (stack.length) {
		const s = doc.sequences[stack.pop()!];
		if (!s) continue;
		for (const n of nestedSequenceIds(s)) {
			if (out.has(n)) continue;
			out.add(n);
			stack.push(n);
		}
	}
	return out;
}

/** True when nesting `childId` inside `parentId` would make the nesting graph cyclic (INV-009). */
export function wouldCreateNestCycle(
	doc: Pick<ProjectDocument, 'sequences'>,
	parentId: string,
	childId: string,
): boolean {
	return parentId === childId || nestedClosure(doc, childId).has(parentId);
}

/** Sequences that contain nest clips of `seqId`, with those clips (for delete warnings, match frame…). */
export function nestReferences(
	doc: Pick<ProjectDocument, 'sequences'>,
	seqId: string,
): { sequenceId: string; clipIds: string[] }[] {
	const out: { sequenceId: string; clipIds: string[] }[] = [];
	for (const seq of Object.values(doc.sequences)) {
		const ids = Object.values(seq.clips)
			.filter((c) => isNestClip(c) && (c as { sequenceId: string }).sequenceId === seqId)
			.map((c) => c.id);
		if (ids.length) out.push({ sequenceId: seq.id, clipIds: ids });
	}
	return out;
}

/** Nested sequence frame (its own rate, floor) shown at content time `flicks`. */
export function nestedFrameOfContent(flicks: number, nestedRate: Rational): number {
	return Math.floor(flicks / flicksPerFrame(nestedRate) + 1e-6);
}

// ---------------------------------------------------------------- content key (render caches, previews)

/** FNV-1a 64-bit over a string, as 16 hex digits. Deterministic across runtimes. */
export function fnv1a64(text: string): string {
	let h1 = 0x811c9dc5 >>> 0;
	let h2 = 0xcbf29ce4 >>> 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 ^= c;
		h2 ^= c >>> 8;
		h1 = Math.imul(h1, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ h1, 0x01000193) >>> 0;
	}
	return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Clip fields that never change pixels or samples. */
const COSMETIC_CLIP_FIELDS = new Set(['name', 'label', 'markers', 'groupId']);

/**
 * A stable key of everything a nested sequence renders: its settings, tracks (output/mute/solo, volumes), master,
 * clips (without names, labels, clip markers, grouping), transitions, the media / synthetics / fonts they use
 * (media by engine key, fingerprint and probe duration) and, recursively, the sequences nested in it. Two documents
 * with the same key render the nested sequence identically. Used by the native nest pre-renders and render-segment
 * caches (previews).
 */
export function nestContentKey(doc: ProjectDocument, seqId: string, depth = 0): string {
	const seq = doc.sequences[seqId];
	if (!seq) return `missing:${seqId}`;
	if (depth > MAX_NEST_DEPTH) return `deep:${seqId}`;
	const media = new Set<string>();
	const synthetics = new Set<string>();
	const fonts = new Set<string>();
	const nested = new Map<string, string>();
	const clips: Record<string, unknown> = {};
	const walkRefs = (v: unknown): void => {
		if (Array.isArray(v)) v.forEach(walkRefs);
		else if (v && typeof v === 'object') {
			for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
				if (k === 'mediaId' && typeof x === 'string') media.add(x);
				else if (k === 'syntheticId' && typeof x === 'string') synthetics.add(x);
				else if (k === 'fontId' && typeof x === 'string') fonts.add(x);
				else walkRefs(x);
			}
		}
	};
	for (const c of Object.values(seq.clips)) {
		const kept: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(c)) if (!COSMETIC_CLIP_FIELDS.has(k)) kept[k] = v;
		clips[c.id] = kept;
		walkRefs(kept);
		const s = (c as { sequenceId?: unknown }).sequenceId;
		if (isNestClip(c) && typeof s === 'string' && !nested.has(s))
			nested.set(s, nestContentKey(doc, s, depth + 1));
	}
	walkRefs(seq.master);
	for (const t of [...seq.videoTracks, ...seq.audioTracks]) walkRefs(t.effects);
	const mediaPart = [...media].sort().map((id) => {
		const a = doc.media[id];
		const key = a?.locators.find((l) => l.type === 'engine-store') as { key?: string } | undefined;
		return a
			? [id, key?.key ?? null, a.fingerprint ?? null, a.probe.durationFlicks, a.sourceRange ?? null]
			: [id, null];
	});
	const body = {
		v: 1,
		settings: seq.settings,
		videoTracks: seq.videoTracks.map((t) => ({ id: t.id, output: t.output ?? true, effects: t.effects ?? [] })),
		audioTracks: seq.audioTracks.map((t) => ({
			id: t.id,
			mute: t.mute ?? false,
			solo: t.solo ?? false,
			volumeDb: t.volumeDb ?? null,
			pan: t.pan ?? null,
			effects: t.effects ?? [],
		})),
		master: seq.master,
		clips,
		transitions: seq.transitions,
		links: seq.links,
		media: mediaPart,
		synthetics: [...synthetics].sort().map((id) => doc.synthetics[id] ?? id),
		fonts: [...fonts].sort().map((id) => doc.fonts[id] ?? id),
		nested: [...nested.entries()].sort(([a], [b]) => a.localeCompare(b)),
	};
	return fnv1a64(canonicalJson(body));
}

// ---------------------------------------------------------------- frame-rate conform (render snapshot)

/**
 * A copy of `seq` whose frame-based timing is expressed at `to` (clip starts/ends, transition durations, In/Out,
 * work area, markers; text animator windows keep their length in time). Content times (flicks) are unchanged, so
 * every clip shows the same content at the same time, up to half a frame at its cuts. Clips that collapse to 0
 * frames are dropped. Used to draw a nested sequence of another rate inside its parent (one frame grid).
 */
export function conformSequenceRate(seq: Sequence, to: Rational): Sequence {
	const from = seq.settings.frameRate as Rational;
	if (rationalEquals(from, to)) return seq;
	const map = (f: number) => mapFrameBetweenRates(f, from, to);
	const clips: Sequence['clips'] = {};
	for (const c of Object.values(seq.clips)) {
		const s = map(c.start);
		const e = map(c.start + c.duration);
		if (e - s <= 0) continue;
		const copy = { ...c, start: s, duration: e - s } as Clip & {
			textAnimation?: { in?: { durationFrames: number } | null; out?: { durationFrames: number } | null };
		};
		if (copy.kind === 'text' && copy.textAnimation) {
			const ta = { ...copy.textAnimation };
			for (const side of ['in', 'out'] as const) {
				const a = ta[side];
				if (a) ta[side] = { ...a, durationFrames: Math.max(1, map(a.durationFrames)) };
			}
			copy.textAnimation = ta;
		}
		clips[c.id] = copy;
	}
	const transitions: Sequence['transitions'] = {};
	for (const t of Object.values(seq.transitions)) {
		if ((t.outgoingClipId && !clips[t.outgoingClipId]) || (t.incomingClipId && !clips[t.incomingClipId]))
			continue;
		transitions[t.id] = { ...t, duration: Math.max(1, map(t.duration)) };
	}
	return {
		...seq,
		settings: { ...seq.settings, frameRate: { num: to.num, den: to.den } },
		clips,
		transitions,
		markers: seq.markers.map((m) => ({ ...m, frame: map(m.frame), duration: Math.max(0, map(m.duration)) })),
		inPoint: seq.inPoint === null ? null : map(seq.inPoint),
		outPoint: seq.outPoint === null ? null : map(seq.outPoint),
		workArea: seq.workArea ? { start: map(seq.workArea.start), end: map(seq.workArea.end) } : null,
	};
}
