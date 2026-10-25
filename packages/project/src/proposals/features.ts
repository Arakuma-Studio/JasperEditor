// Proposal features (spec 15 §2.1 EA-001/EA-002, shared by specs 13–15): who produces proposals, how the Review
// panel groups their items, and whether an agent may accept them. Sound design (spec 12) keeps its per-sequence
// "Allow agents to apply sound proposals" (`soundDesign.settings.agentsMayApply`, default off); the workflow
// features are governed per project by Project Settings ▸ Agent Proposals (`settings.agentProposals`, default on: the
// user asked for agent-driven automation; every accept is one undoable "Agent: …" History entry and destructive
// commands inside still need the user's approval card). Pure data and readers: the engine registers the policies
// (`ProposalService.registerPolicy`), the editor and MCP read the same table.
import { type ProjectAgentProposals, ProjectAgentProposalsSchema, type ProjectDocument } from '../schema/document.ts';
import { soundDesignSettingsOf } from '../schema/sound.ts';
// type-only: gaps/settings (the invariants) reads this module, so it must not evaluate the proposal schema first
import type { Proposal } from './schema.ts';

/** = `SOUND_DESIGN_FEATURE` (./schema.ts), repeated so this table needs no runtime import of the schema module. */
const SOUND_DESIGN = 'sound-design';

export const EDIT_AUTOMATION_FEATURE = 'edit-automation';
export const SUBTITLES_FEATURE = 'subtitles';
export const TRANSCRIPT_CLEANUP_FEATURE = 'transcript-cleanup';

/** A Review group a producer declares: items carry its id in `meta.group` (or `group`); order = declaration order. */
export type ProposalFeatureGroup = { id: string; label: string };

/** Where "Allow agents to apply <feature> proposals" lives. */
export type ProposalAgentAccept =
	/** Project Settings ▸ Agent Proposals (`settings.agentProposals[feature]`), `default` when absent. */
	| { setting: 'project'; default: boolean }
	/** Sound design: the proposal's sequence (`soundDesign.settings.agentsMayApply`, default off). */
	| { setting: 'sound-sequence'; default: false };

export type ProposalFeatureInfo = {
	id: string;
	/** English display name (a model string: the editor translates it). */
	name: string;
	/** What its proposals are, for agents (MCP `list_proposal_features`). */
	description: string;
	/** "1 cut kit" / "{0} cut kits": the noun the Review uses for the feature's items (model strings). */
	itemNoun: { one: string; other: string };
	agentAccept: ProposalAgentAccept;
	/** Review groups in order (items naming another group follow, alphabetically). */
	groups: readonly ProposalFeatureGroup[];
	/** Tools / editor commands that create its proposals (documentation for agents). */
	producers: readonly string[];
};

/** The built-in proposal features. */
export const PROPOSAL_FEATURES: readonly ProposalFeatureInfo[] = [
	{
		id: SOUND_DESIGN,
		name: 'Sound design',
		description:
			'Sound effects, beds, room tone and level changes placed on visual cues (spec 12). Agents may apply them only where the user turned on "Allow agents to apply sound proposals" for the sequence.',
		itemNoun: { one: '1 sound', other: '{0} sounds' },
		agentAccept: { setting: 'sound-sequence', default: false },
		groups: [
			{ id: 'hero', label: 'Hero' },
			{ id: 'support', label: 'Support' },
			{ id: 'bed', label: 'Bed' },
			{ id: 'layer', label: 'Layers' },
		],
		producers: [
			'plan_sound_design',
			'place_sound',
			'rebalance_sfx',
			'apply_delivery',
			'lay_ambience_bed',
			'fill_room_tone',
			'Sequence ▸ Sound Design ▸ Auto Sound Pass…',
		],
	},
	{
		id: EDIT_AUTOMATION_FEATURE,
		name: 'Editing automation',
		description:
			'Decorations of the cut (spec 15): cut kits on adjustment clips, punch-in zooms, Ken Burns moves, reactions, overlay slides, music beds and stingers, alone or combined by a style recipe.',
		itemNoun: { one: '1 edit', other: '{0} edits' },
		agentAccept: { setting: 'project', default: true },
		groups: [
			{ id: 'cut-kits', label: 'Cut kits' },
			{ id: 'punch-ins', label: 'Punch-ins' },
			{ id: 'ken-burns', label: 'Ken Burns' },
			{ id: 'reactions', label: 'Reactions' },
			{ id: 'slides', label: 'Overlay slides' },
			{ id: 'music', label: 'Music beds' },
			{ id: 'stingers', label: 'Stingers' },
		],
		producers: [
			'decorate_cuts',
			'add_punch_ins',
			'add_ken_burns',
			'place_reactions',
			'slide_overlays',
			'lay_music_bed',
			'add_stingers',
			'apply_style',
			'Sequence ▸ Automate',
		],
	},
	{
		id: SUBTITLES_FEATURE,
		name: 'Subtitles',
		description:
			'Automatic subtitles (spec 13): subtitle text clips built from the transcript, aligned to the cuts and styled with a template.',
		itemNoun: { one: '1 subtitle', other: '{0} subtitles' },
		agentAccept: { setting: 'project', default: true },
		groups: [
			{ id: 'subtitles', label: 'Subtitles' },
			{ id: 'alignment', label: 'Cut alignment' },
			{ id: 'styles', label: 'Styles' },
		],
		producers: ['generate_subtitles', 'align_captions_to_cuts', 'Sequence ▸ Generate Subtitles…'],
	},
	{
		id: TRANSCRIPT_CLEANUP_FEATURE,
		name: 'Transcript cleanup',
		description:
			'Voice and transcript cleanup (spec 14): cuts of restarts, retakes, false starts, fillers, repeats, pauses and off-script talk, and transcript fixes.',
		itemNoun: { one: '1 cut', other: '{0} cuts' },
		agentAccept: { setting: 'project', default: true },
		groups: [
			{ id: 'restarts', label: 'Restarts' },
			{ id: 'retakes', label: 'Retakes' },
			{ id: 'false-starts', label: 'False starts' },
			{ id: 'fillers', label: 'Fillers' },
			{ id: 'repeats', label: 'Repeats' },
			{ id: 'off-script', label: 'Off-script' },
			{ id: 'pauses', label: 'Pauses' },
			{ id: 'transcript', label: 'Transcript fixes' },
			{ id: 'review', label: 'To review' },
		],
		producers: ['analyze_voice', 'plan_cleanup', 'Sequence ▸ Clean Up Voice…'],
	},
];

const BY_ID = new Map(PROPOSAL_FEATURES.map((f) => [f.id, f]));

/** The built-in feature with this id, or undefined (proposals of other features are refused to agents). */
export function proposalFeatureInfo(id: string): ProposalFeatureInfo | undefined {
	return BY_ID.get(id);
}

/** Features whose agent accept is a project setting (Project Settings ▸ Agent Proposals), in table order. */
export function projectSettingFeatures(): ProposalFeatureInfo[] {
	return PROPOSAL_FEATURES.filter((f) => f.agentAccept.setting === 'project');
}

/** The stored per-feature entries when readable (null: absent or unreadable). Never throws. */
export function readAgentProposals(settings: unknown): ProjectAgentProposals | null {
	const v = settings && typeof settings === 'object' ? (settings as { agentProposals?: unknown }).agentProposals : undefined;
	if (v === undefined) return {};
	const r = ProjectAgentProposalsSchema.safeParse(v);
	return r.success ? r.data : null;
}

/**
 * Whether the project lets agents apply `feature` proposals (Project Settings ▸ Agent Proposals): the stored entry,
 * else the feature's default. An unreadable setting counts as off (the safe side; repair reports it). null for a
 * feature whose agent accept is not a project setting (sound design, unknown features).
 */
export function agentProposalsAllowed(doc: Pick<ProjectDocument, 'settings'>, feature: string): boolean | null {
	const f = BY_ID.get(feature);
	if (!f || f.agentAccept.setting !== 'project') return null;
	const stored = readAgentProposals(doc.settings);
	if (stored === null) return false;
	return Object.hasOwn(stored, feature) ? stored[feature] === true : f.agentAccept.default;
}

export type ProposalPolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * The agent accept policy of a project-setting feature: allowed while Project Settings ▸ Agent Proposals has it on.
 * The engine registers one per feature (`ProposalService.registerPolicy`).
 */
export function projectFeaturePolicy(feature: string) {
	return (doc: ProjectDocument, _proposal: Proposal): ProposalPolicyDecision => {
		const f = BY_ID.get(feature);
		if (agentProposalsAllowed(doc, feature) === true) return { allowed: true };
		const name = f?.name.toLowerCase() ?? feature;
		return {
			allowed: false,
			reason: `Agents may not apply ${name} proposals in this project: the user turned off "Allow agents to apply ${name} proposals" (Project Settings ▸ General ▸ Agent Proposals); they review and apply them in the editor`,
		};
	};
}

/** Per sequence of the document, whether agents may apply sound proposals there (spec 12). */
export function soundAgentAcceptBySequence(doc: Pick<ProjectDocument, 'sequences'>): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const [id, seq] of Object.entries(doc.sequences ?? {})) {
		try {
			out[id] = soundDesignSettingsOf(seq).agentsMayApply === true;
		} catch {
			out[id] = false;
		}
	}
	return out;
}

/** Names the editor translates (feature names, item nouns, group labels). */
export const PROPOSAL_FEATURE_MODEL_STRINGS: readonly string[] = PROPOSAL_FEATURES.flatMap((f) => [
	f.name,
	f.itemNoun.one,
	f.itemNoun.other,
	...f.groups.map((g) => g.label),
]);
