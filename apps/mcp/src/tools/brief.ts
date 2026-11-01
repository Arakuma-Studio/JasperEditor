// Spec 18 AF-BRF-004: the sequence brief (what the human wants the video to be: text, platform, target length, aspect)
// and the project's agent notes, for agents. Reading is free; set_brief and add_agent_note are one undoable History
// entry each ("Agent: …"). Notes are signed with this agent's name (the transaction origin); removing notes is the
// user's (Sequence ▸ Brief…), so no tool removes them. docs/wp-notes/agent-footage-brief.md.
import {
	AGENT_NOTE_LIMITS,
	AgentNoteTextSchema,
	BriefAspectSchema,
	BriefDurationSchema,
	BriefPlatformSchema,
	BriefTextSchema,
	briefAspect,
	DELIVERY_TARGETS,
	type ProjectDocument,
	readAgentNotes,
	readSequenceBrief,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	applyCommands,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';

/** "W:H" of a sequence frame reduced (1920×1080 → 16:9). */
function frameAspect(seq: Sequence): string {
	const { width, height } = seq.settings;
	if (!(width > 0 && height > 0)) return '?';
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const g = gcd(Math.round(width), Math.round(height)) || 1;
	return `${Math.round(width) / g}:${Math.round(height) / g}`;
}

function briefBody(doc: ProjectDocument, seq: Sequence) {
	const brief = readSequenceBrief(seq);
	const target = brief?.platform ? DELIVERY_TARGETS.find((t) => t.id === brief.platform) : undefined;
	const wanted = briefAspect(brief);
	const frame = frameAspect(seq);
	return {
		sequenceId: seq.id,
		sequenceName:
			Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === seq.id)?.name ?? seq.id,
		brief,
		...(target
			? { platform: { id: target.id, name: target.name, aspect: target.aspect, form: target.form } }
			: {}),
		sequenceFrame: {
			width: seq.settings.width,
			height: seq.settings.height,
			aspect: frame,
			frameRate: seq.settings.frameRate,
		},
		...(wanted ? { aspectMatches: wanted === frame } : {}),
		agentNotes: readAgentNotes(doc).length,
	};
}

export function registerBriefTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_brief',
		{
			title: 'Get the brief',
			description:
				"Reads a sequence's brief — what the user wants the video to be (text: goal, audience, tone, must-keep moments; platform; targetDurationSec; aspect) — with the platform's frame shape, whether the sequence frame matches it, and how many agent notes the project has. Read it before cutting; brief null = the user stated nothing yet.",
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg },
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			return jsonResult(briefBody(doc, pickSequence(doc, a.sequenceId)));
		},
	);

	defineTool(
		ctx,
		'set_brief',
		{
			title: 'Set the brief',
			description:
				"Changes a sequence's brief in one undo step: the fields you give replace the stored ones, omitted fields are kept, null clears a field; clear: true removes the whole brief. The brief is the user's statement of intent — change it only when the user asks or confirms (e.g. they told you the platform in chat).",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				text: BriefTextSchema.optional(),
				platform: BriefPlatformSchema.nullable().optional(),
				targetDurationSec: BriefDurationSchema.nullable().optional(),
				aspect: BriefAspectSchema.nullable().optional(),
				clear: z.boolean().optional().describe('Remove the whole brief (no other field may be given)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const fields = {
				...(a.text !== undefined ? { text: a.text } : {}),
				...(a.platform !== undefined ? { platform: a.platform } : {}),
				...(a.targetDurationSec !== undefined ? { targetDurationSec: a.targetDurationSec } : {}),
				...(a.aspect !== undefined ? { aspect: a.aspect } : {}),
			};
			const given = Object.keys(fields).length;
			if (a.clear ? given > 0 : given === 0)
				throw new ToolError(
					'E_INVALID_PARAM',
					a.clear
						? 'clear: true takes no other brief field'
						: 'Give at least one brief field, or clear: true',
					'Fields: text, platform, targetDurationSec, aspect (null clears one).',
				);
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			return applyCommands(
				ctx,
				a.projectId,
				'Edit Brief',
				[{ type: 'sequence.setBrief', sequenceId: seq.id, brief: a.clear ? null : fields }],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'list_agent_notes',
		{
			title: 'List agent notes',
			description:
				'Lists the notes agents kept about this project (oldest first: id, at, author, text) — decisions, chosen takes, open questions from earlier sessions. Read them when you start working on a project.',
			input: {
				projectId: ProjectIdArg,
				limit: z
					.number()
					.int()
					.min(1)
					.max(AGENT_NOTE_LIMITS.maxEntries)
					.optional()
					.describe('Only the newest N notes (default: all, at most 500)'),
			},
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const all = readAgentNotes(doc);
			const notes = a.limit ? all.slice(-a.limit) : all;
			return jsonResult({ total: all.length, max: AGENT_NOTE_LIMITS.maxEntries, notes });
		},
	);

	defineTool(
		ctx,
		'add_agent_note',
		{
			title: 'Add an agent note',
			description: `Keeps a note in the project for later sessions and other agents (one undo step; signed with your client name, timestamped). Use it for decisions and facts worth remembering ("take 3 of the intro has the cleanest audio"), not for progress chatter. At most ${AGENT_NOTE_LIMITS.maxEntries} notes per project; only the user removes notes (Sequence ▸ Brief…).`,
			input: { projectId: ProjectIdArg, text: AgentNoteTextSchema },
			annotations: EDIT,
		},
		async (a, extra) =>
			applyCommands(
				ctx,
				a.projectId,
				'Add Agent Note',
				[{ type: 'project.addAgentNote', text: a.text }],
				extra,
			),
	);
}
