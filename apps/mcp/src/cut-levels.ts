// Cut levels for agent transactions (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"): a cut command
// that moves its edges off speech — `transcript.extract` / `transcript.lift` by default, `range.extract` /
// `range.lift` / `clip.trim` / `clip.split` with `snapToSilence: true` — needs the voice analysis around its edges in
// the command (commands are pure). Before a transaction is sent, this attaches those windows from the engine's cached
// voice analyses (never computed here: without one the cut stays exact and the command warns `W_NO_LEVELS`).
import {
	type CleanupVoice,
	cutLevelWindows,
	type ProjectDocument,
	type Sequence,
	sequenceWords,
	wordRangeFrames,
} from '@jasper/project';
import type { ToolContext } from './context.ts';

type Cmd = Record<string, unknown> & { type?: unknown };

const SNAP_BY_DEFAULT = new Set(['transcript.extract', 'transcript.lift']);
const SNAP_OPT_IN = new Set(['range.extract', 'range.lift', 'clip.trim', 'clip.split']);

const wants = (c: Cmd) =>
	!c.levels &&
	((SNAP_BY_DEFAULT.has(String(c.type)) && c.snapToSilence !== false) ||
		(SNAP_OPT_IN.has(String(c.type)) && c.snapToSilence === true));

/** A sequence frame of a time argument (frames, `{frames}`, `{seconds}`); null for anything else. */
function frameOf(seq: Sequence, t: unknown): number | null {
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	if (typeof t === 'number' && Number.isFinite(t)) return Math.round(t);
	if (t && typeof t === 'object') {
		const o = t as { frames?: unknown; seconds?: unknown };
		if (typeof o.frames === 'number') return Math.round(o.frames);
		if (typeof o.seconds === 'number') return Math.round(o.seconds * fps);
	}
	return null;
}

/** The sequence frames a cut command will cut at (empty when they are not known before it runs). */
function framesOf(doc: ProjectDocument, seq: Sequence, c: Cmd): number[] {
	switch (c.type) {
		case 'range.extract':
		case 'range.lift':
			return [frameOf(seq, c.from), frameOf(seq, c.to)].filter((f): f is number => f !== null);
		case 'clip.split': {
			const f = frameOf(seq, c.at);
			return f === null ? [] : [f];
		}
		case 'clip.trim': {
			const clip = seq.clips[String(c.clipId)];
			if (!clip || typeof c.deltaFrames !== 'number') return [];
			return [(c.edge === 'in' ? clip.start : clip.start + clip.duration) + c.deltaFrames];
		}
		default: {
			const words = sequenceWords(doc, seq);
			if (typeof c.fromWord !== 'number' || typeof c.toWord !== 'number') return [];
			return wordRangeFrames(words, c.fromWord, c.toWord, seq.settings.frameRate) ?? [];
		}
	}
}

/** `commands` with the cut levels attached where a cut command asks for them (see the module comment). */
export async function withCutLevels(
	ctx: Pick<ToolContext, 'engine'>,
	load: () => Promise<{ doc: ProjectDocument }>,
	commands: unknown[],
	sequenceId: string | undefined,
	signal?: AbortSignal,
): Promise<unknown[]> {
	if (!commands.some((c) => c && typeof c === 'object' && wants(c as Cmd))) return commands;
	const { doc } = await load();
	const cache = new Map<string, CleanupVoice | null>();
	const read = async (mediaId: string, stream: number) => {
		const key = `${mediaId}\u0000${stream}`;
		if (cache.has(key)) return cache.get(key)!;
		const loc = doc.media[mediaId]?.locators.find((l) => l.type === 'engine-store');
		let v: CleanupVoice | null = null;
		if (loc?.type === 'engine-store')
			try {
				v = await ctx.engine((e) => e.getVoiceAnalysis(loc.key, stream, signal));
			} catch (e) {
				// no analysis (or none readable): the cut stays exact and says so (`W_NO_LEVELS`)
				if (signal?.aborted) throw e;
			}
		cache.set(key, v);
		return v;
	};
	const out: unknown[] = [];
	for (const raw of commands) {
		const c = raw as Cmd;
		if (!c || typeof c !== 'object' || !wants(c)) {
			out.push(raw);
			continue;
		}
		const sid = typeof c.sequenceId === 'string' ? c.sequenceId : sequenceId;
		const seq =
			(sid ? doc.sequences[sid] : undefined) ??
			(c.type === 'clip.trim'
				? Object.values(doc.sequences).find((s) => s.clips[String(c.clipId)])
				: Object.values(doc.sequences).length === 1
					? Object.values(doc.sequences)[0]
					: undefined);
		const frames = seq ? framesOf(doc, seq, c) : [];
		if (!seq || !frames.length) {
			out.push(raw);
			continue;
		}
		// read the analyses of the audio media near the cut first (the window builder is synchronous)
		for (const clip of Object.values(seq.clips))
			if (clip.kind === 'audio' && clip.enabled) await read(clip.mediaId, clip.channels.streamIndex);
		const levels = cutLevelWindows(seq, frames, (m, s) => cache.get(`${m}\u0000${s}`) ?? null);
		out.push(levels.length ? { ...c, levels } : raw);
	}
	return out;
}
