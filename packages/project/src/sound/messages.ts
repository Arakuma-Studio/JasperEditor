// Sound-design texts people see in the editor that the model (not the web app) writes: the History labels agents'
// tools compose ("Agent: Place Sound Crunchy impact", "Agent: Sound Cues (add 2, edit 1)") and the refusals of the
// placement, swap and cue commands that the editor shows in its notices. Templates with `{0}`… placeholders (ids,
// titles, numbers: never translated). The editor lists them in its model strings (apps/web/i18n/model-strings.ts) and
// its runtime translates a label or message that matches one (`translateName`, apps/web/src/i18n/runtime.ts).
// `test/sound-messages.test.ts` checks that every refusal written in the sound handlers has its template here.
import { SOUND_CHECK_MODEL_STRINGS } from './check.ts';
import { REFERENCE_MODEL_STRINGS } from './profile.ts';

/** History labels of the MCP sound tools (`soundText` fills them). */
export const SOUND_LABELS = {
	/** insert_sound */
	addSound: 'Add Sound {0}',
	/** import_sounds and the Sound Library's Import to Project: one sound (its title) / several */
	importSound: 'Import Sound {0}',
	importSounds: 'Import {0} Sounds',
	/** place_sound: one layer (its title) / several layers */
	placeSound: 'Place Sound {0}',
	placeSounds: 'Place {0} Sounds',
	/** swap_sound */
	swapSound: 'Swap Sound {0}',
	/** align_peak: one clip / with its layers */
	alignPeak: 'Align Sound Peak',
	alignPeaks: 'Align {0} Sound Peaks',
	/** detect_sound_peak (the editor's Detect Peak) */
	detectPeak: 'Detect Peak',
	/** set_sound_cues: "Sound Cues (add 2, edit 1, remove 1, resync)" */
	soundCues: 'Sound Cues',
	cuesAdd: 'add {0}',
	cuesEdit: 'edit {0}',
	cuesRemove: 'remove {0}',
	cuesResync: 'resync',
} as const;

/** Refusals of `media.setLibraryInfo`, `soundCue.*`, `soundDesign.*` and the placement planners. */
export const SOUND_MESSAGES = [
	'Media not found: {0}',
	'Library provenance applies to audio media, not {0} ({1})',
	'Sequence not found: {0}',
	'Sound cue not found: {0}',
	'Sound cue not found in sequence {0}: {1}',
	'Unknown sound type "{0}"; the types are {1}',
	'The {0} this cue anchors to does not exist in the sequence',
	'Track not found: {0}',
	'Clip {0} would start before frame 0',
	'Clip {0} cannot move to frame {1}: other audio is there',
	'A sequence holds at most {0} sound cues',
	'Malformed cue id: {0}',
	'Cue id already in use: {0}',
	'anchorOffset needs an anchor',
	'Pan keyframe offsets must increase',
	'{0} is a {1} track; sounds go on audio tracks',
	'{0} has audio between frames {1} and {2}; placing never overwrites (use track "auto")',
	'soundDesign.place needs exactly one of cueId or frame',
	'frame must be between 0 and {0}',
	'A cue holds at most {0} layers (it has {1})',
	'Media {0} has no sound to place',
	'Media {0} has no length',
	'Media {0} has no peak descriptor (not a Sound Library sound): align it by its start or end, or set its library info',
	'The resulting speed is out of range',
	'{0} is not an audio clip',
	'A reversed clip cannot be swapped',
	'{0} was not placed by sound design and its media has no peak',
	'Media {0} has no sound',
	'Media {0} has no peak descriptor (not a Sound Library sound)',
	'The new sound does not fit on its track between frames {0} and {1}',
	'{0} is not a placed or library sound (place it with soundDesign.place first)',
	'A palette holds at most {0} sounds',
	'{0} is not an audio track',
	'Submix track not found: {0}',
	'The peak is past the end of the media ({0} flicks)',
	'The sound has no timing',
	'The sound has no length',
	'The sound is too short to place',
	"the sound's {0} is {1} s into it: aligned at frame {2} it would start at frame {3}, before the sequence",
	'report names {0}, which has no gain',
	'Unknown temp ref {0}: bind it with "ref" on a placement layer earlier in the transaction',
	'{0} is given twice',
	'Clip not found: {0}',
	'Clip not found in {0}: {1}',
	'{0} is not a sound effect (Essential Sound type SFX, or a placed sound): the solver sets sound effect gains only',
	'{0} is not a sound effect (Essential Sound type SFX, or a placed sound): auto gain applies to sound effects',
	'frame must be inside the sequence (0–{0})',
	'The mix of {0} changed since it was measured (its audio, mixer, media or delivery); measure it again',
	"{0} is not a library sound's copy (an audio media)",
	'The new copy must be audio media, not {0}',
	'Cannot replace {0}: {1}',
	'The new copy is already in the project as {0}',
	'{0} would not fit the new copy of {1}',
	'{0} would not fit the new copy of {1}: the clips keep the older copy; the new one is another media',
	// acknowledged Sound Check findings (spec 12 §4 P6-E4)
	'reason must not be empty: say why the finding is deliberate',
	'key {0} is not a {1} finding (keys start with their code)',
	'Only the user can acknowledge an error ({0}): ask them to review it in the Sound Check panel, or fix it',
	'target.frame must be inside the sequence (0–{0})',
	'A sequence holds at most {0} acknowledged findings: unacknowledge some first',
	'No acknowledged finding {0} in {1}',
] as const;

/** Every sound-design template the editor translates (labels, refusals, Sound Check findings and fixes). */
export const SOUND_MODEL_STRINGS: readonly string[] = [
	...Object.values(SOUND_LABELS),
	...SOUND_MESSAGES,
	...SOUND_CHECK_MODEL_STRINGS,
	...REFERENCE_MODEL_STRINGS,
];

/** A template with its `{n}` placeholders filled. */
export function soundText(template: string, ...args: readonly (string | number)[]): string {
	return template.replace(/\{(\d+)\}/g, (m, i: string) =>
		Number(i) < args.length ? String(args[Number(i)]) : m,
	);
}
