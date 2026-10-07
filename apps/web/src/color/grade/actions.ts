// color-grade: panel actions that write several Lumetri params at once — Auto (Basic Correction), Apply Match
// (Color Wheels & Match), the HSL Secondary eyedroppers, the Looks browser and section resets. Each is ONE
// transaction: the clip's first Lumetri instance is edited (params that are keyframed get a key at the playhead),
// or one instance is added carrying every value.
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	type Command,
	type EffectInstance,
	LUMETRI_EFFECT_ID,
	makeEnvelope,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { planSet } from '../../panels/properties/lib/model.ts';
import { lumetriRow } from '../model.ts';

/** Commands that set Lumetri `values` on `clip` (its instance `fx`, or a new instance when null). */
export function planLumetriValues(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	fx: EffectInstance | null,
	values: Record<string, unknown>,
	frame: number,
): { commands: Command[]; skipped: boolean } {
	if (!fx)
		return {
			commands: [
				{
					type: 'effect.add',
					target: { clipId: clip.id },
					effectId: LUMETRI_EFFECT_ID,
					params: values,
				} as Command,
			],
			skipped: false,
		};
	const commands: Command[] = [];
	let skipped = false;
	for (const [name, value] of Object.entries(values)) {
		const row = lumetriRow(doc, seq, clip, fx, name, frame);
		const plan = planSet(row, frame, () => value);
		if (plan.skipped.length) skipped = true;
		commands.push(...plan.commands);
	}
	return { commands, skipped };
}

/** Applies Lumetri values in one transaction; returns an error message or null. */
export function applyLumetriValues(
	session: EditorSession,
	label: string,
	clip: Clip,
	fx: EffectInstance | null,
	values: Record<string, unknown>,
): string | null {
	const s = session.getState();
	const seq = Object.values(s.document.sequences).find((q) => q.clips[clip.id]);
	if (!seq) return 'The clip is no longer in a sequence';
	const frame = session.transport.getState().frame;
	const { commands, skipped } = planLumetriValues(s.document, seq, clip, fx, values, frame);
	if (!commands.length)
		return skipped ? 'Move the playhead over the clip to add keyframes to its animated params' : null;
	const r = session.apply({ label, origin: 'user', commands });
	return r.ok ? null : (r.errors[0]?.message ?? `${label} failed`);
}

function envelopeOf(session: EditorSession) {
	return makeEnvelope(session.getCommitted(), {
		revision: session.getState().revision,
		savedAt: new Date().toISOString(),
		platform: 'web',
	}) as never;
}

const seqOf = (session: EditorSession, clip: Clip) =>
	Object.values(session.getCommitted().sequences).find((q) => q.clips[clip.id]) ?? null;

/** The frame Auto / Apply Match analyse: the playhead when it is on the clip, else the clip's middle. */
function analysisFrame(session: EditorSession, clip: Clip): number {
	const f = session.transport.getState().frame;
	return f >= clip.start && f < clip.start + clip.duration ? f : clip.start + Math.floor(clip.duration / 2);
}

/** Basic Correction ▸ Auto: the engine analyses the clip's picture before Lumetri; one "Auto Tone" step. */
export async function runAutoTone(
	session: EditorSession,
	engine: EngineClient,
	clip: Clip,
	fx: EffectInstance | null,
): Promise<string | null> {
	const seq = seqOf(session, clip);
	if (!seq) return 'The clip is no longer in a sequence';
	const r = await engine.gradingAutoTone({
		envelope: envelopeOf(session),
		sequenceId: seq.id,
		clipId: clip.id,
		...(fx ? { effectId: fx.id } : {}),
		frame: analysisFrame(session, clip),
	});
	const { saturation: _unchanged, ...tone } = r.params;
	return applyLumetriValues(session, 'Auto Tone', clip, fx, tone);
}

export type MatchOutcome = { error: string | null; note?: string };

/** Color Wheels & Match ▸ Apply Match against the comparison reference; one "Apply Match" step. */
export async function runApplyMatch(
	session: EditorSession,
	engine: EngineClient,
	clip: Clip,
	fx: EffectInstance | null,
	reference: { sequenceId: string; frame: number },
	faceDetection: boolean,
): Promise<MatchOutcome> {
	const seq = seqOf(session, clip);
	if (!seq) return { error: 'The clip is no longer in a sequence' };
	const r = await engine.gradingMatch({
		envelope: envelopeOf(session),
		sequenceId: seq.id,
		clipId: clip.id,
		...(fx ? { effectId: fx.id } : {}),
		frame: analysisFrame(session, clip),
		reference,
		faceDetection,
	});
	const error = applyLumetriValues(session, 'Apply Match', clip, fx, r.params);
	const note =
		faceDetection && r.faceNote
			? 'Face Detection used the skin-tone test (install the face model in Preferences ▸ Roto & Face Tracking to detect faces).'
			: faceDetection && r.faces
				? `Face Detection: ${r.faces.current} face(s) in the clip, ${r.faces.reference} in the reference.`
				: undefined;
	return { error, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------- Face Detection preference

const FACE_KEY = 'jasper.lumetri.faceDetection';

export function faceDetectionPref(): boolean {
	try {
		return globalThis.localStorage?.getItem(FACE_KEY) !== '0';
	} catch {
		return true;
	}
}

export function setFaceDetectionPref(on: boolean): void {
	try {
		globalThis.localStorage?.setItem(FACE_KEY, on ? '1' : '0');
	} catch {
		// storage unavailable: per session only
	}
}
