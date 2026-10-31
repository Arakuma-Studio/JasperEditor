// Spec 18 AF-BRF-001 / AF-BRF-002: the sequence brief (`sequence.setBrief`) and the project's agent notes
// (`project.addAgentNote`, `project.removeAgentNote`). Each command is one undo step. docs/wp-notes/agent-footage-brief.md.
import { z } from 'zod';
import {
	AgentNoteAuthorSchema,
	AgentNoteTextSchema,
	BriefAspectSchema,
	BriefDurationSchema,
	BriefPlatformSchema,
	BriefTextSchema,
} from '../../brief/model.ts';
import { cmd, IdRefSchema } from './common.ts';

/** Brief fields to change: given fields replace the stored ones, omitted ones are kept, null clears one. */
export const SequenceBriefPatchSchema = z.strictObject({
	text: BriefTextSchema.optional(),
	platform: BriefPlatformSchema.nullable().optional(),
	targetDurationSec: BriefDurationSchema.nullable().optional(),
	aspect: BriefAspectSchema.nullable().optional(),
});
export type SequenceBriefPatch = z.infer<typeof SequenceBriefPatchSchema>;

export const SequenceSetBriefCmd = cmd('sequence.setBrief', {
	sequenceId: IdRefSchema.optional(),
	/** The fields to change (merged into the stored brief); null removes the whole brief. */
	brief: SequenceBriefPatchSchema.nullable(),
});

export const ProjectAddAgentNoteCmd = cmd('project.addAgentNote', {
	text: AgentNoteTextSchema,
	/** Ignored for agent transactions (the note is signed with the agent's name); default "user" otherwise. */
	author: AgentNoteAuthorSchema.optional(),
});

export const ProjectRemoveAgentNoteCmd = cmd('project.removeAgentNote', {
	noteId: IdRefSchema,
});

export const BRIEF_COMMANDS = [
	SequenceSetBriefCmd,
	ProjectAddAgentNoteCmd,
	ProjectRemoveAgentNoteCmd,
] as const;
