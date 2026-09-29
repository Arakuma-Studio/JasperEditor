import { z } from 'zod';
import { LabelColorSchema, RationalSchema, RGBASchema } from '../../schema/common.ts';
import { AnimNumberSchema } from '../../schema/common.ts';
import { CaptionStyleSchema, MarkerTypeSchema, TrackKindSchema } from '../../schema/sequence.ts';
import {
	cmd,
	ContentTimeInputSchema,
	IdRefSchema,
	RefDeclSchema,
	TimeInputSchema,
	TrackRefSchema,
} from './common.ts';

const SettingsPatch = z.strictObject({
	frameRate: RationalSchema.optional(),
	width: z.number().int().optional(),
	height: z.number().int().optional(),
	dropFrame: z.boolean().optional(),
	startTimecodeFrames: z.number().int().min(0).optional(),
	backgroundColor: RGBASchema.optional(),
});

export const SequenceCreateCmd = cmd('sequence.create', {
	name: z.string().min(1),
	preset: z.string().optional(),
	settings: SettingsPatch.optional(),
	fromMediaId: IdRefSchema.optional(),
	binId: IdRefSchema.nullable().optional(),
	tracks: z.strictObject({ video: z.number().int().min(1), audio: z.number().int().min(1) }).optional(),
	ref: RefDeclSchema.optional(),
	id: z.string().optional(),
});
export const SequenceUpdateSettingsCmd = cmd('sequence.updateSettings', {
	sequenceId: IdRefSchema.optional(),
	settings: SettingsPatch,
	reposition: z.enum(['keep-offset-from-center', 'scale-proportionally', 'keep-pixels']).optional(),
});
export const SequenceDuplicateCmd = cmd('sequence.duplicate', {
	sequenceId: IdRefSchema,
	name: z.string().optional(),
	ref: RefDeclSchema.optional(),
});
export const SequenceDeleteCmd = cmd('sequence.delete', { sequenceId: IdRefSchema, force: z.boolean().optional() });
export const SequenceSetInOutCmd = cmd('sequence.setInOut', {
	sequenceId: IdRefSchema.optional(),
	in: TimeInputSchema.nullable(),
	out: TimeInputSchema.nullable(),
});
export const SequenceSetWorkAreaCmd = cmd('sequence.setWorkArea', {
	sequenceId: IdRefSchema.optional(),
	start: TimeInputSchema.nullable(),
	end: TimeInputSchema.nullable(),
});

const markerFields = {
	name: z.string().optional(),
	markerType: MarkerTypeSchema.optional(),
	duration: TimeInputSchema.optional(),
	color: LabelColorSchema.optional(),
	comment: z.string().optional(),
	url: z.string().optional(),
};
/** Sequence scope (`frame`) or clip scope (`clipId` + `flicks`) (S01:SEQ-008, CMD-014). */
export const MarkerAddCmd = cmd('marker.add', {
	sequenceId: IdRefSchema.optional(),
	frame: TimeInputSchema.optional(),
	clipId: IdRefSchema.optional(),
	flicks: ContentTimeInputSchema.optional(),
	...markerFields,
	ref: RefDeclSchema.optional(),
	id: z.string().optional(),
});
export const MarkerUpdateCmd = cmd('marker.update', {
	markerId: IdRefSchema,
	frame: TimeInputSchema.optional(),
	flicks: ContentTimeInputSchema.optional(),
	...markerFields,
});
export const MarkerRemoveCmd = cmd('marker.remove', { markerIds: z.array(IdRefSchema).min(1) });

export const TrackAddCmd = cmd('track.add', {
	sequenceId: IdRefSchema.optional(),
	kind: TrackKindSchema,
	/** Insert position within the kind's list (0 = V1/A1). Default: after the last track. */
	index: z.number().int().min(0).optional(),
	count: z.number().int().min(1).max(99).optional(),
	name: z.string().nullable().optional(),
	ref: RefDeclSchema.optional(),
});
export const TrackRemoveCmd = cmd('track.remove', {
	sequenceId: IdRefSchema.optional(),
	trackIds: z.array(TrackRefSchema).min(1),
	force: z.boolean().optional(),
});
export const TrackUpdateCmd = cmd('track.update', {
	sequenceId: IdRefSchema.optional(),
	trackId: TrackRefSchema,
	patch: z.strictObject({
		name: z.string().nullable().optional(),
		locked: z.boolean().optional(),
		syncLock: z.boolean().optional(),
		output: z.boolean().optional(),
		mute: z.boolean().optional(),
		solo: z.boolean().optional(),
		/** A number sets the static value (stopwatch off); an Animatable replaces the property. */
		volumeDb: z.union([z.number(), AnimNumberSchema]).optional(),
		pan: z.union([z.number(), AnimNumberSchema]).optional(),
		channelFormat: z.enum(['mono', 'stereo']).optional(),
		visible: z.boolean().optional(),
		styleDefaults: CaptionStyleSchema.optional(),
	}),
});

export const SEQUENCE_COMMANDS = [
	SequenceCreateCmd,
	SequenceUpdateSettingsCmd,
	SequenceDuplicateCmd,
	SequenceDeleteCmd,
	SequenceSetInOutCmd,
	SequenceSetWorkAreaCmd,
	MarkerAddCmd,
	MarkerUpdateCmd,
	MarkerRemoveCmd,
	TrackAddCmd,
	TrackRemoveCmd,
	TrackUpdateCmd,
] as const;
