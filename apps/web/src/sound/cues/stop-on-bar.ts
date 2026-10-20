// Stop Before Next on the bar line (spec 12 §4 P6-E11; wp-note sound-design "final carry-over cleanup", item 5): the
// cue menu and Properties ▸ Cue put the stop-before's ramp end on the music's downbeat (else beat) before the hit, the
// same rule the plan job applies (`stopBeforeFor`), when the sequence's style stops on the bar (default on) and the
// music under the cue has beats the engine already analysed (Suggest Cues…, Auto Sound Pass…, Music to picture); else
// the plain 0.25 s. Nothing is analysed here: the engine answers from its cache only (`cachedOnly`).
import type { EngineClient } from '@jasper/engine-client';
import {
	type Command,
	cachedMusicGrid,
	type MusicGrid,
	musicClips,
	type ProjectDocument,
	type Sequence,
	STOP_BEFORE_DEFAULT,
	sequenceStopsOnBar,
	soundCuesOf,
	stopBeforeFor,
} from '@jasper/project';

/** Whether a bar line can matter: an engine to ask, the style on and Essential Sound music in the sequence. */
export function mayStopOnBar(
	engine: Pick<EngineClient, 'audioBeats'> | null | undefined,
	doc: ProjectDocument,
	seq: Sequence,
): boolean {
	return (
		typeof engine?.audioBeats === 'function' && sequenceStopsOnBar(seq) && musicClips(doc, seq).length > 0
	);
}

/** The analysed music grid of a sequence (empty without an engine, with the style off, or with nothing analysed). */
export async function analysedMusicGrid(
	engine: Pick<EngineClient, 'audioBeats'> | null | undefined,
	doc: ProjectDocument,
	seq: Sequence,
): Promise<MusicGrid[]> {
	if (!engine || !mayStopOnBar(engine, doc, seq)) return [];
	return cachedMusicGrid(doc, seq, (req) =>
		engine.audioBeats({ ...req, cachedOnly: true }).catch(() => null),
	);
}

/**
 * Runs `then` with the grid: at once (synchronously) when no bar line can matter, else after the engine answered from
 * its cache.
 */
export function withMusicGrid(
	engine: Pick<EngineClient, 'audioBeats'> | null | undefined,
	doc: ProjectDocument,
	seq: Sequence,
	then: (grid: readonly MusicGrid[]) => void,
): void {
	if (!mayStopOnBar(engine, doc, seq)) then([]);
	else void analysedMusicGrid(engine, doc, seq).then(then);
}

/**
 * The `soundCue.update` commands that turn Stop Before Next on for `cueIds` of `seq` (the committed document's), each on
 * the bar line where the grid has one; `onBar` counts those.
 */
export function stopBeforeNextCommands(
	seq: Sequence,
	cueIds: readonly string[],
	grid: readonly MusicGrid[],
): { commands: Command[]; onBar: number } {
	const cues = new Map(soundCuesOf(seq).map((c) => [c.id, c]));
	let onBar = 0;
	const commands: Command[] = [];
	for (const id of cueIds) {
		const c = cues.get(id);
		if (!c) continue;
		const s = stopBeforeFor(seq, c.frame, grid, STOP_BEFORE_DEFAULT);
		if (s.on) onBar++;
		commands.push({ type: 'soundCue.update', cueId: id, stopBefore: s.stopBefore } as Command);
	}
	return { commands, onBar };
}
