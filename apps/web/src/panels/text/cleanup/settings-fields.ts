// Every Clean Up setting the drawer shows (spec 14 TC-040: all TC-011 / TC-021 / TC-022 / TC-023 / TC-024 values with
// units), in the groups of `CleanupSettings`. Bounds come from the zod schema (`packages/project/src/cleanup/schema.ts`);
// `scale` converts stored values to what is shown (shares 0…1 as %, seconds as ms where the spec speaks in ms).
import type { CleanupSettings } from '@jasper/project';

export type SettingGroup = keyof CleanupSettings;

export type SettingField =
	| {
			group: SettingGroup;
			key: string;
			type: 'number';
			label: string;
			unit: string;
			min: number;
			max: number;
			step: number;
			/** Shown = stored × scale. */
			scale?: number;
			integer?: boolean;
	  }
	| { group: SettingGroup; key: string; type: 'choice'; label: string; options: readonly string[] }
	| { group: SettingGroup; key: string; type: 'bool'; label: string };

const RULE3 = ['remove', 'review', 'off'] as const;
const RULE2 = ['review', 'off'] as const;

export const GROUP_LABELS: Record<SettingGroup, string> = {
	rules: 'What to look for',
	thresholds: 'Detection thresholds',
	edges: 'Edit points',
	gaps: 'Pauses and breaths',
	guards: 'Guards',
	joins: 'Joins',
};

/** Choice values as shown. */
export const CHOICE_LABELS: Record<string, string> = {
	remove: 'Remove',
	review: 'Review',
	off: 'Off',
	keep: 'Keep',
	level: 'Audio level',
	speech: 'Speech frames',
	word: 'Word timings',
	floor: 'Noise floor',
};

export const SETTING_FIELDS: readonly SettingField[] = [
	// rules (TC-011)
	{ group: 'rules', key: 'retake', type: 'choice', label: 'Retakes (earlier takes)', options: RULE3 },
	{ group: 'rules', key: 'restart', type: 'choice', label: 'Restarts', options: RULE3 },
	{ group: 'rules', key: 'falseStart', type: 'choice', label: 'False starts', options: RULE3 },
	{ group: 'rules', key: 'stutter', type: 'choice', label: 'Repeats and stutters', options: RULE3 },
	{ group: 'rules', key: 'fillerVocalic', type: 'choice', label: 'Fillers (eh, em, mmm)', options: RULE3 },
	{ group: 'rules', key: 'fillerPhrase', type: 'choice', label: 'Filler phrases between pauses', options: RULE3 },
	{ group: 'rules', key: 'fillerLexical', type: 'choice', label: 'Discourse markers at a clause start', options: RULE2 },
	{ group: 'rules', key: 'offScript', type: 'choice', label: 'Off-script talk (needs a script)', options: RULE3 },
	{ group: 'rules', key: 'headTail', type: 'choice', label: 'Head and tail (needs a script)', options: RULE3 },
	{ group: 'rules', key: 'pause', type: 'choice', label: 'Pauses', options: RULE3 },
	{ group: 'rules', key: 'breath', type: 'choice', label: 'Breaths', options: RULE3 },
	{ group: 'rules', key: 'untranscribed', type: 'choice', label: 'Voice without words', options: RULE2 },
	{ group: 'rules', key: 'asrSuspect', type: 'choice', label: 'Transcription suspects', options: RULE2 },
	{ group: 'rules', key: 'hallucination', type: 'choice', label: 'Hallucination guard', options: RULE3 },
	// thresholds (TC-011, TC-012)
	{ group: 'thresholds', key: 'phraseGapS', type: 'number', label: 'Phrases split at pauses of', unit: 's', min: 0.05, max: 5, step: 0.05 },
	{ group: 'thresholds', key: 'takeGapS', type: 'number', label: 'Takes split at pauses of', unit: 's', min: 0.1, max: 10, step: 0.1 },
	{ group: 'thresholds', key: 'retakeWindowS', type: 'number', label: 'A later take counts within', unit: 's', min: 1, max: 3600, step: 1 },
	{ group: 'thresholds', key: 'retakeSimilarity', type: 'number', label: 'Retake similarity (content words)', unit: '%', min: 10, max: 100, step: 5, scale: 100 },
	{ group: 'thresholds', key: 'restartWindowWords', type: 'number', label: 'Restart: 3-word repeat within (words)', unit: '', min: 1, max: 500, step: 1, integer: true },
	{ group: 'thresholds', key: 'restartWindowWords2', type: 'number', label: 'Restart: 2-word repeat within (words)', unit: '', min: 1, max: 500, step: 1, integer: true },
	{ group: 'thresholds', key: 'restartWindowS', type: 'number', label: 'Restart: both within', unit: 's', min: 1, max: 3600, step: 1 },
	{ group: 'thresholds', key: 'restartContentLetters', type: 'number', label: 'Restart: content words have at least (letters)', unit: '', min: 1, max: 20, step: 1, integer: true },
	{ group: 'thresholds', key: 'falseStartGapS', type: 'number', label: 'False start: re-said within', unit: 's', min: 0.1, max: 60, step: 0.1 },
	{ group: 'thresholds', key: 'stutterGapS', type: 'number', label: 'Stutter: repeats closer than', unit: 's', min: 0, max: 5, step: 0.05 },
	{ group: 'thresholds', key: 'offScriptMinTokens', type: 'number', label: 'Off-script: phrases with at least (words)', unit: '', min: 1, max: 100, step: 1, integer: true },
	{ group: 'thresholds', key: 'offScriptSimilarity', type: 'number', label: 'Off-script: less than this in the script', unit: '%', min: 0, max: 100, step: 5, scale: 100 },
	{ group: 'thresholds', key: 'markerPhraseMaxWords', type: 'number', label: 'Filler phrases: at most (words)', unit: '', min: 1, max: 10, step: 1, integer: true },
	{ group: 'thresholds', key: 'drawnVowelS', type: 'number', label: 'Drawn-out vowel longer than', unit: 's', min: 0.2, max: 10, step: 0.05 },
	{ group: 'thresholds', key: 'lowConfidence', type: 'number', label: 'Suspect below confidence', unit: '%', min: 0, max: 100, step: 5, scale: 100 },
	{ group: 'thresholds', key: 'minWordS', type: 'number', label: 'Suspect: words shorter than', unit: 'ms', min: 0, max: 1000, step: 10, scale: 1000 },
	{ group: 'thresholds', key: 'maxWordS', type: 'number', label: 'Suspect: words longer than', unit: 's', min: 0.5, max: 60, step: 0.1 },
	{ group: 'thresholds', key: 'untranscribedMinS', type: 'number', label: 'Voice without words at least', unit: 'ms', min: 30, max: 10000, step: 10, scale: 1000 },
	{ group: 'thresholds', key: 'hallucinationRun', type: 'number', label: 'Hallucination: identical words in a row (words)', unit: '', min: 2, max: 100, step: 1, integer: true },
	{ group: 'thresholds', key: 'hallucinationSpeechShare', type: 'number', label: 'Hallucination: speech under the word below', unit: '%', min: 0, max: 100, step: 5, scale: 100 },
	{ group: 'thresholds', key: 'scriptPreferEarlier', type: 'number', label: 'Script: an earlier take wins when it covers more by', unit: '%', min: 0, max: 100, step: 5, scale: 100 },
	{ group: 'thresholds', key: 'scriptLineSimilarity', type: 'number', label: 'Script: a take says a line at', unit: '%', min: 10, max: 100, step: 5, scale: 100 },
	// edges (TC-021)
	{ group: 'edges', key: 'mode', type: 'choice', label: 'Place edit points from', options: ['level', 'speech', 'word'] },
	{ group: 'edges', key: 'reference', type: 'choice', label: 'Level reference', options: ['floor', 'speech'] },
	{ group: 'edges', key: 'outDb', type: 'number', label: 'Out point: decay falls below reference +', unit: 'dB', min: 0, max: 80, step: 1 },
	{ group: 'edges', key: 'inDb', type: 'number', label: 'In point: onset reaches reference +', unit: 'dB', min: 0, max: 80, step: 1 },
	{ group: 'edges', key: 'padBeforeS', type: 'number', label: 'Pad before in points', unit: 'ms', min: 0, max: 2000, step: 10, scale: 1000 },
	{ group: 'edges', key: 'padAfterS', type: 'number', label: 'Pad after out points', unit: 'ms', min: 0, max: 2000, step: 10, scale: 1000 },
	{ group: 'edges', key: 'snapWindowS', type: 'number', label: 'Snap to the quietest frame within', unit: 'ms', min: 0, max: 100, step: 1, scale: 1000 },
	// gaps (TC-022)
	{ group: 'gaps', key: 'maxGapS', type: 'number', label: 'Cut non-speech longer than', unit: 's', min: 0, max: 30, step: 0.01 },
	{ group: 'gaps', key: 'keepGapS', type: 'number', label: 'Air kept inside a sentence', unit: 's', min: 0, max: 30, step: 0.05 },
	{ group: 'gaps', key: 'keepGapSentenceS', type: 'number', label: 'Air kept between sentences', unit: 's', min: 0, max: 30, step: 0.05 },
	{ group: 'gaps', key: 'breath', type: 'choice', label: 'Breaths before an onset', options: ['remove', 'keep'] },
	{ group: 'gaps', key: 'breathKeepMaxS', type: 'number', label: 'Breaths kept up to', unit: 'ms', min: 0, max: 2000, step: 10, scale: 1000 },
	// guards (TC-023)
	{ group: 'guards', key: 'minPieceS', type: 'number', label: 'Shortest kept piece', unit: 's', min: 0, max: 10, step: 0.05 },
	{ group: 'guards', key: 'minCutFrames', type: 'number', label: 'Shortest cut (frames)', unit: '', min: 0, max: 100, step: 1, integer: true },
	{ group: 'guards', key: 'minSliverFrames', type: 'number', label: 'Shortest kept sliver (frames)', unit: '', min: 0, max: 100, step: 1, integer: true },
	{ group: 'guards', key: 'avoidHarshCuts', type: 'bool', label: 'Avoid harsh cuts (keep fillers whose edges are loud)' },
	{ group: 'guards', key: 'harshWindowS', type: 'number', label: 'Quiet frame searched within', unit: 'ms', min: 0, max: 500, step: 5, scale: 1000 },
	// joins (TC-024)
	{ group: 'joins', key: 'fadeMs', type: 'number', label: 'Equal-power micro-fade at every join', unit: 'ms', min: 0, max: 30, step: 1 },
	{ group: 'joins', key: 'jlFrames', type: 'number', label: 'J / L offset of the sound (frames)', unit: '', min: -30, max: 30, step: 1, integer: true },
];

/** The stored value of a field from the shown text, or null when it is not a valid value. */
export function parseFieldValue(f: Extract<SettingField, { type: 'number' }>, text: string): number | null {
	const v = Number(text.replace(',', '.'));
	if (!Number.isFinite(v)) return null;
	if (v < f.min - 1e-9 || v > f.max + 1e-9) return null;
	if (f.integer && !Number.isInteger(v)) return null;
	const stored = v / (f.scale ?? 1);
	return f.integer ? Math.round(stored) : Math.round(stored * 1e6) / 1e6;
}

/** A stored value as shown. */
export function showFieldValue(f: Extract<SettingField, { type: 'number' }>, stored: number): string {
	const v = stored * (f.scale ?? 1);
	return String(Math.round(v * 1000) / 1000);
}
