// Proposal tools (spec 12 §2.5, §2.10, P3-R5; wp-note "Phase 3 → WP3.2"; spec 15 §2.1): the proposal features and
// whether agents may accept them here (list_proposal_features), read proposals (with a text table of their ghosts),
// wait for the user's review (decisions, swapped alternatives, notes), accept (policy-gated per feature), reject and
// refresh (the producer re-plans stale items). Proposals are stored by the engine per project, outside the document
// and its undo history; accepting items is ONE transaction (one undo step).
import {
	type ProposalCreateResponse,
	type ProposalFeature,
	ProposalInvalidDetailSchema,
	type ProposalRefreshResponse,
	type ProposalResponse,
	type ProposalSummary,
	SoundCheckProposalSummarySchema,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	acceptAllItemIds,
	COMMAND_CATALOG,
	defaultRegistries,
	isSetupItem,
	mixFingerprint,
	OPEN_OBJECT,
	type ProjectDocument,
	type Proposal,
	type ProposalItem,
	type ProposalItemFailure,
	previewProposal,
	proposalCounts,
	proposalDecided,
	proposalItemGroup,
	ROUGH_CUT_FEATURE,
	ROUGH_CUT_GROUPS,
	ROUGH_CUT_LIMITS,
	RoughCutInputSchema,
	roughCutDraft,
	type Sequence,
	sequenceTimecode,
	soundCuesOf,
	TITLE_ART_FEATURE,
	trackLabel,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	loadDoc,
	progressReporter,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, RequestCancelled, ToolError } from '../errors.ts';
import { proposalCheckSummary } from './sound-check.ts';

export const PROPOSALS_GUIDE = `Proposals (spec 12 §2.5): a reviewable set of edits stored by the engine per project, outside the document and its undo history. Each item is a list of ordinary commands with a state (pending, accepted, rejected, stale, invalid), optional alternatives (other command sets the user can cycle, e.g. another sound for the same cue), the items it requires (setup: a bin, imported sounds, new cues) and the user's note. Accepting items is ONE transaction: one undo step in History.
- Propose, don't apply: plan_sound_design, place_sound, rebalance_sfx, apply_delivery, lay_ambience_bed and fill_room_tone (mode "propose", their default) store a proposal and change nothing. Tell the user it is waiting in the editor's Review panel, where they hear it in context, keep or reject each item, cycle its alternates, leave notes and apply. Never accept your own proposal unless the user asked you to apply it.
- Read: list_proposals {projectId} lists them (counts per state); get_proposal {projectId, proposalId} gives every item with its state, reason (why it is stale or invalid), selected alternative, the user's note, and a text table of what the undecided items would create (ghosts: track, start, end, sound).
- Wait: wait_for_proposal {projectId, proposalId} returns when the user changed something (or the proposal was applied or discarded; until: "decided" waits until nothing is left to decide), at most 900 s: per item accepted | rejected | pending | stale | invalid, "swapped" when they chose an alternative, and their notes. Read the notes and act on them (a new proposal for what they asked); call it again to keep waiting.
- Your own cut: propose_edits {projectId, sequenceId, title, strategy, items} turns a multi-step edit (selects, removals, retakes, reorders, B-roll) into ONE "Rough cut" proposal the user reviews instead of a pile of apply_commands History entries: the strategy (1–8 sentences) shows above the items, each item carries its reason, beat and quote. Every item is dry-run first; any failure stores nothing and lists the failing item indices. Agents may not apply rough cuts unless Project Settings ▸ Agent Proposals allows it (off by default): hand it over and wait_for_proposal.
- Features: list_proposal_features {projectId} lists the proposal features (sound-design, edit-automation, subtitles, transcript-cleanup, transcript-correction, rough-cut, title-art), their producing tools, Review groups (items name theirs in meta.group), whether you may apply them here and whether their producer refreshes stale items.
- Apply: accept_proposal {projectId, proposalId, itemIds: "all" | [ids]} works for an agent only where the feature allows it: sound design when the user turned on "Allow agents to apply sound proposals" for the sequence (off by default); editing automation, subtitles and transcript cleanup while Project Settings ▸ Agent Proposals allows them (on by default; the user may turn them off); rough cuts only when the user turned them on there (off by default). Refused → E_APPROVAL_REQUIRED: do not retry, ask the user to apply it in the Review panel. Accepting is still one undoable "Agent: …" step, and destructive commands inside still ask the user. Stale items (the edit changed under them) refuse the whole accept unless partial: true. "all" takes only the items that are selected (an item with selected: false — e.g. a Maybe transcript fix — is offered unchecked) and, for transcript fixes, never the maybe group: name such items' ids to apply them, and only when the user asked. reject_proposal {itemIds} marks items rejected (the document is untouched).
- Stale items: refresh_proposal {projectId, proposalId} asks the feature's producer to re-plan them on the current edit (they come back pending; nothing is applied) — never accept a stale item as it was planned. Refused with E_NOT_REFRESHABLE when the producer cannot re-plan: propose the changed part again.
- Producers of new features: a proposal whose accept would exceed one transaction (5 000 commands / 20 MB; 2 000 items) is refused with E_TOO_LARGE and details.suggestedRange (frames that fit): run the pass on that range, then the rest. Batch commands keep passes small: clip.addAdjustmentBatch (adjustment clips with effects and keys relative to each item) and keyframe.addBatch (keys on many clips) — one command per item. Anchor decorations with meta.anchorOn {clips: [decorated clip ids], cuts: [{trackId, frame}]} so they go stale when the cut moves.
- Check before you hand it over: sound_check {projectId, proposalId} runs Sound Check on the proposal's preview (the current edit with its items applied; nothing changes) and says what it fixes and introduces, per item ("fixes 3 · introduces 1"). plan_sound_design {check: true} does it for you. The result is kept on the proposal: get_proposal shows it (soundCheck), and so does the user's Review panel, next to each item.
- One writer, one proposal per pass: when you weigh alternatives (another sound, another level, a different cue), test them yourself and merge the best into ONE proposal — its items' alternatives carry the other sounds — rather than handing the user several competing proposals. Run sound_check {proposalId} on it before asking for review, and never hand over a proposal that introduces errors without saying so (say which item and what). Review it through the lenses in SOUND_GUIDE ("Review lenses").`;

const ProposalIdArg = z.string().regex(/^prp_[0-9A-HJKMNP-TV-Z]{16}$/, 'a proposal id: prp_ + 16 characters');
const ItemSelectionArg = z
	.union([z.literal('all'), z.array(z.string().min(1).max(64)).min(1).max(2000)])
	.describe('"all", or item ids (get_proposal)');

/** Hint when an agent may not apply a proposal (the policy gate). */
export const APPROVAL_REQUIRED_HINT =
	'Only the user can apply this proposal: ask them to review it in the editor (Review panel: ✓ / ✕ per item, alternates, notes) and apply it there, or to allow agents — sound design: "Allow agents to apply sound proposals" for this sequence (Preferences ▸ Sound Library); editing automation, subtitles, transcript cleanup, rough cuts: "Allow agents to apply <feature> proposals" (Project Settings ▸ General ▸ Agent Proposals; rough cuts are off by default). Do not retry; call wait_for_proposal to learn their decisions.';

/** Proposal calls with the proposal codes' hints. */
async function proposalCall<T>(ctx: ToolContext, fn: Parameters<ToolContext['engine']>[0]): Promise<T> {
	try {
		return (await ctx.engine(fn)) as T;
	} catch (e) {
		if (e instanceof EngineError) {
			const inner = (e.detail as { code?: unknown } | undefined)?.code;
			const code = typeof inner === 'string' ? inner : e.code;
			const status = e.status ? { httpStatus: e.status } : undefined;
			if (code === 'E_APPROVAL_REQUIRED' || e.code === 'APPROVAL_REQUIRED')
				throw new ToolError('E_APPROVAL_REQUIRED', e.message, APPROVAL_REQUIRED_HINT, status);
			if (code === 'E_TOO_LARGE' || e.code === 'PROPOSAL_TOO_LARGE') {
				const d = (e.detail ?? {}) as { fit?: unknown; suggestedRange?: unknown };
				throw new ToolError(
					'E_TOO_LARGE',
					e.message,
					'Nothing was stored: run the pass on details.suggestedRange (sequence frames), then on the rest.',
					{ ...status, fit: d.fit, suggestedRange: d.suggestedRange },
				);
			}
			if (code === 'E_NOT_REFRESHABLE' || e.code === 'PROPOSAL_NOT_REFRESHABLE')
				throw new ToolError(
					'E_NOT_REFRESHABLE',
					e.message,
					'This feature’s producer does not re-plan items: propose the changed part again (and reject_proposal the stale items).',
					status,
				);
			if (e.code === 'PROPOSAL_NOT_FOUND')
				throw new ToolError(
					'E_PROPOSAL_NOT_FOUND',
					e.message,
					'Unknown proposal (deleted, expired after 30 days, or evicted): list_proposals lists the project’s proposals.',
					status,
				);
			if (code === 'E_PROPOSAL_STALE' || e.code === 'PROPOSAL_STALE')
				throw new ToolError(
					'E_PROPOSAL_STALE',
					e.message,
					'Some items no longer fit the edit (the clips or cues they follow moved or are gone). Nothing was applied: accept again with partial: true to apply the rest, or make a new proposal.',
					{
						...status,
						...(e.detail && typeof e.detail === 'object'
							? { stale: (e.detail as { stale?: unknown }).stale }
							: {}),
					},
				);
		}
		throw e;
	}
}

const metaOf = (it: { meta?: unknown }) =>
	it.meta && typeof it.meta === 'object' ? (it.meta as Record<string, unknown>) : {};

/** The item's decision as an agent reads it. */
function decisionOf(it: ProposalItem) {
	const k = it.selectedAlternative ?? 0;
	const alt = k > 0 ? it.alternatives?.[k - 1] : undefined;
	return {
		itemId: it.id,
		label: it.label,
		group: it.group,
		state: it.state,
		...(it.reason ? { reason: it.reason } : {}),
		...(alt ? { swapped: { alternative: k, label: alt.label } } : {}),
		...(it.note ? { note: it.note } : {}),
		// spec 17 SC-061: offered unselected (an "all" accept leaves it out)
		...(it.selected === false ? { selected: false } : {}),
	};
}

/** Compact item view (commands only on request). */
function itemView(it: ProposalItem, withCommands: boolean) {
	const m = metaOf(it);
	const k = it.selectedAlternative ?? 0;
	return {
		...decisionOf(it),
		setup: isSetupItem(it),
		...(it.requires.length ? { requires: it.requires } : {}),
		...(it.alternatives?.length
			? {
					selectedAlternative: k,
					alternatives: [
						{ index: 0, label: it.label },
						...it.alternatives.map((a, i) => ({ index: i + 1, label: a.label })),
					],
				}
			: {}),
		...(typeof m.why === 'string' ? { why: m.why } : typeof m.reason === 'string' ? { why: m.reason } : {}),
		// a rough-cut item (propose_edits): the beat and the words it is about
		...(typeof m.beat === 'string' ? { beat: m.beat } : {}),
		...(typeof m.quote === 'string' ? { quote: m.quote } : {}),
		...(typeof m.timecode === 'string' ? { timecode: m.timecode } : {}),
		...(typeof m.soundId === 'string' ? { soundId: m.soundId } : {}),
		...(typeof m.role === 'string' ? { role: m.role } : {}),
		// a title (propose_title): the look and colourway the item applies
		...(typeof m.lookName === 'string' ? { look: m.lookName } : {}),
		...(typeof m.colorwayName === 'string' ? { colorway: m.colorwayName } : {}),
		...(withCommands
			? {
					commands: it.commands,
					...(it.alternatives?.length ? { alternativeCommands: it.alternatives.map((a) => a.commands) } : {}),
				}
			: {}),
	};
}

/** Most undecided items previewed for the ghost table (each is one transaction on a copy of the document). */
const MAX_GHOST_ITEMS = 400;
const MAX_GHOST_ROWS = 300;

/** A get_timeline-style text table of what the undecided items would create, change or delete. */
export function ghostTable(doc: ProjectDocument, p: Proposal): { table: string; note?: string } {
	const undecided = p.items.filter((i) => i.state === 'pending' || i.state === 'stale');
	if (undecided.length === 0) return { table: '(nothing left to review)' };
	if (undecided.length > MAX_GHOST_ITEMS)
		return {
			table: '',
			note: `${undecided.length} undecided items: too many to preview here; the editor's Review panel shows them on the timeline`,
		};
	const preview = previewProposal(doc, p, 'undecided', {
		registries: defaultRegistries(),
		invariants: 'incremental',
		checkInvariants: false,
	});
	const after = preview.document;
	const seqs = Object.values(after.sequences) as Sequence[];
	const rows: string[] = ['item | state | ghost | track | start | end | what'];
	const label = new Map(p.items.map((i) => [i.id, i]));
	for (const id of preview.applied) {
		const ghost = preview.items[id];
		const it = label.get(id)!;
		if (!ghost) continue;
		// Setup items (a bin, an imported sound, a new cue) in one line each: what they are for is the place item.
		if (isSetupItem(it)) {
			if (rows.length <= MAX_GHOST_ROWS) rows.push(`${id} | ${it.state} | setup | — | — | — | ${it.label}`);
			continue;
		}
		for (const [kind, ids] of [
			['create', ghost.created],
			['change', ghost.changed],
			['delete', ghost.deleted],
		] as const) {
			for (const eid of ids) {
				if (rows.length > MAX_GHOST_ROWS) break;
				const src = kind === 'delete' ? doc : after;
				let line: string | null = null;
				for (const seq of kind === 'delete' ? (Object.values(doc.sequences) as Sequence[]) : seqs) {
					const clip = seq.clips[eid] as
						| { trackId: string; start: number; duration: number; name?: string; mediaId?: string }
						| undefined;
					if (clip) {
						const media = clip.mediaId ? src.media[clip.mediaId] : undefined;
						const lib = (media as { library?: { title?: string } } | undefined)?.library;
						const what = lib?.title ?? clip.name ?? media?.originalName ?? eid;
						line = `${id} | ${it.state} | ${kind} clip | ${trackLabel(seq, clip.trackId) ?? clip.trackId} | ${sequenceTimecode(seq, clip.start)} | ${sequenceTimecode(seq, clip.start + clip.duration)} | ${what}`;
						break;
					}
					const cue = soundCuesOf(seq).find((c) => c.id === eid);
					if (cue) {
						line = `${id} | ${it.state} | ${kind} cue | — | ${sequenceTimecode(seq, cue.frame)} | — | ${cue.kind} ${cue.weight}${cue.reason ? `: ${cue.reason.slice(0, 80)}` : ''}`;
						break;
					}
					const track = [...seq.videoTracks, ...seq.audioTracks].find((t) => t.id === eid);
					if (track) {
						line = `${id} | ${it.state} | ${kind} track | ${trackLabel(seq, eid) ?? eid} | — | — | ${track.name ?? ''}`;
						break;
					}
				}
				if (!line && kind !== 'change') {
					// Media and their Project items: one row (the media); bins and other entities by name.
					const media = src.media[eid];
					const item = src.items[eid];
					if (media) line = `${id} | ${it.state} | ${kind} media | — | — | — | ${media.originalName}`;
					else if (item && item.kind !== 'media')
						line = `${id} | ${it.state} | ${kind} ${item.kind} | — | — | — | ${item.name}`;
					else if (!item) line = `${id} | ${it.state} | ${kind} | — | — | — | ${eid}`;
				}
				if (line) rows.push(line);
			}
		}
	}
	const failed = Object.entries(preview.failed).map(
		([id, errs]) => `${id} | does not apply | ${errs[0]?.code ?? ''}: ${errs[0]?.message ?? ''}`,
	);
	const truncated = rows.length > MAX_GHOST_ROWS;
	return {
		table: [...rows.slice(0, MAX_GHOST_ROWS + 1), ...failed].join('\n'),
		...(truncated ? { note: `only the first ${MAX_GHOST_ROWS} ghosts are listed` } : {}),
	};
}

/** What the undecided items of a proposal would do to clips and tracks, counted once per entity (spec 18 AF-PROP-002). */
export type GhostSummary = {
	clips: { created: number; removed: number; moved: number; trimmed: number; changed: number };
	tracks: { created: number; removed: number };
};

/**
 * Counts what applying every undecided item would do (one preview on a copy of `doc`): clips created and removed,
 * clips moved (start or track changed, length kept), trimmed (length or source in changed) or otherwise changed
 * (effects, keys, properties), tracks created and removed. Never throws (null when it cannot be previewed).
 */
export function ghostSummary(doc: ProjectDocument, p: Proposal): GhostSummary | null {
	try {
		const preview = previewProposal(doc, p, 'undecided', {
			registries: defaultRegistries(),
			invariants: 'incremental',
			checkInvariants: false,
		});
		const after = preview.document;
		type C = { trackId: string; start: number; duration: number; sourceIn?: number };
		const clipIn = (d: ProjectDocument, id: string): C | null => {
			for (const seq of Object.values(d.sequences) as Sequence[]) {
				const c = seq.clips[id] as C | undefined;
				if (c) return c;
			}
			return null;
		};
		const trackIn = (d: ProjectDocument, id: string) =>
			(Object.values(d.sequences) as Sequence[]).some((seq) =>
				[...seq.videoTracks, ...seq.audioTracks].some((t) => t.id === id),
			);
		const out: GhostSummary = {
			clips: { created: 0, removed: 0, moved: 0, trimmed: 0, changed: 0 },
			tracks: { created: 0, removed: 0 },
		};
		for (const id of new Set(preview.ghost.created)) {
			if (clipIn(after, id)) out.clips.created++;
			else if (trackIn(after, id)) out.tracks.created++;
		}
		for (const id of new Set(preview.ghost.deleted)) {
			if (clipIn(doc, id)) out.clips.removed++;
			else if (trackIn(doc, id)) out.tracks.removed++;
		}
		for (const id of new Set(preview.ghost.changed)) {
			const a = clipIn(doc, id);
			const b = a ? clipIn(after, id) : null;
			if (!a || !b) continue;
			if (a.duration !== b.duration || (a.sourceIn ?? 0) !== (b.sourceIn ?? 0)) out.clips.trimmed++;
			else if (a.start !== b.start || a.trackId !== b.trackId) out.clips.moved++;
			else out.clips.changed++;
		}
		return out;
	} catch {
		return null;
	}
}

/** Engine refusals of a rough cut as one tool error listing each failing item (nothing was stored). */
function proposeEditsError(e: unknown): unknown {
	if (!(e instanceof EngineError)) return e;
	const status = e.status ? { httpStatus: e.status } : {};
	const stored =
		'Nothing was stored. Fix or drop the failing items (index = their place in items; commandIndex = the command inside the item; alternative = which alternative set) and call propose_edits again with the whole cut.';
	if (e.code === 'PROPOSAL_INVALID') {
		const d = ProposalInvalidDetailSchema.safeParse(e.detail);
		return new ToolError('E_PROPOSAL_INVALID', e.message, stored, {
			...status,
			failures: d.success ? d.data.items : [],
		});
	}
	if (e.code === 'VALIDATION_FAILED') {
		// a malformed command (unknown type or keys, bad arguments): the engine names its place in the draft
		const errors = (e.detail as { errors?: unknown } | undefined)?.errors;
		const failures: ProposalItemFailure[] = [];
		for (const x of Array.isArray(errors) ? errors.slice(0, ROUGH_CUT_LIMITS.maxItems) : []) {
			const issue = x as { code?: unknown; message?: unknown; path?: unknown; itemId?: unknown };
			const path = Array.isArray(issue.path) ? issue.path : [];
			const index = path[0] === 'items' && typeof path[1] === 'number' ? path[1] : null;
			if (index === null) continue;
			const alt = path[2] === 'alternatives' && typeof path[3] === 'number' ? path[3] + 1 : undefined;
			const ci = alt !== undefined ? path[5] : path[2] === 'commands' ? path[3] : undefined;
			failures.push({
				index,
				itemId: typeof issue.itemId === 'string' ? issue.itemId : `e${index}`,
				...(alt !== undefined ? { alternative: alt } : {}),
				code: typeof issue.code === 'string' ? issue.code : 'E_SCHEMA',
				message: typeof issue.message === 'string' ? issue.message : e.message,
				commandIndex: typeof ci === 'number' ? ci : null,
			});
		}
		if (failures.length)
			return new ToolError(
				'E_PROPOSAL_INVALID',
				e.message,
				`${stored} describe_commands gives each command's arguments.`,
				{
					...status,
					failures,
				},
			);
	}
	if (e.code === 'REVISION_CONFLICT')
		return new ToolError(
			'E_REVISION_MISMATCH',
			e.message,
			'expectedRevision is ahead of the document: read it again (get_project / get_timeline) and pass the revision you planned on.',
			status,
		);
	return e;
}

const ROUGH_CUT_COMMAND_TYPES = Object.keys(COMMAND_CATALOG) as [string, ...string[]];
const RoughCutCommandsArg = z
	.array(
		z
			.looseObject({ type: z.enum(ROUGH_CUT_COMMAND_TYPES).describe('Command type (describe_commands)') })
			.meta(OPEN_OBJECT),
	)
	.min(1)
	.max(ROUGH_CUT_LIMITS.maxItemCommands)
	.describe(
		`1–${ROUGH_CUT_LIMITS.maxItemCommands} commands as apply_commands takes them ({"type": "...", ...})`,
	);

/** Sleeps `ms`, or less when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal.removeEventListener('abort', done);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});
}

const WAIT_POLL_MS = 1000;

/** The non-setup items an "all" accept or reject means (setup items come with the items that require them). */
export function allSelection(p: Proposal, states: readonly ProposalItem['state'][]): string[] {
	return p.items.filter((i) => !isSetupItem(i) && states.includes(i.state)).map((i) => i.id);
}

export function registerProposalTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_proposal_features',
		{
			title: 'List proposal features',
			description: 'The proposal features of a project and whether agents may apply each.',
			details:
				'The proposal features of a project (sound-design, edit-automation, subtitles, transcript-cleanup, transcript-correction, rough-cut, title-art): what their proposals are, the tools that produce them, their Review groups (put the group id in an item’s meta.group), the item noun, whether YOU may apply them here (agentAccept: setting "project" → allowed (Project Settings ▸ Agent Proposals; default on, rough-cut off); setting "sound-sequence" → per sequence id, default off) and whether their producer re-plans stale items (refreshable, refresh_proposal).',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const r = await proposalCall<{ features: ProposalFeature[] }>(ctx, (c) =>
				c.proposalFeatures(projectId),
			);
			return jsonResult({
				projectId,
				features: r.features,
				next: 'Propose with the feature’s tools; accept_proposal only where agentAccept allows it and the user asked you to apply.',
			});
		},
	);

	defineTool(
		ctx,
		'refresh_proposal',
		{
			title: 'Refresh proposal',
			description: "Re-plan a proposal's stale items on the current edit; nothing is applied.",
			details:
				'Asks the proposal’s producer to re-plan its stale items (the clips or cuts they decorate moved) on the current edit: they come back pending for review with fresh anchors; nothing is applied, accepted and rejected items stay. itemIds "stale" (default) = every stale item, or ids of pending, stale or invalid items. reroll: true = "Reroll": re-plan the items with the next seed of each (another draw of the same pass, e.g. another kit family for a Decorate Cuts item; items whose meta.rerollable is true). Refused with E_NOT_REFRESHABLE when the feature’s producer cannot re-plan (propose again instead).',
			input: {
				projectId: ProjectIdArg,
				proposalId: ProposalIdArg,
				itemIds: z
					.union([z.literal('stale'), z.array(z.string().min(1).max(64)).min(1).max(2000)])
					.optional()
					.describe('"stale" (default) or item ids (get_proposal)'),
				reroll: z
					.boolean()
					.optional()
					.describe('Re-plan with the next seed of each item (another draw); default false'),
			},
			annotations: EDIT,
		},
		async ({ projectId, proposalId, itemIds, reroll }) => {
			const r = await proposalCall<ProposalRefreshResponse>(ctx, (c) =>
				c.refreshProposal(projectId, proposalId, {
					itemIds: itemIds ?? 'stale',
					...(reroll ? { reroll: true } : {}),
				}),
			);
			return jsonResult({
				proposalId,
				refreshed: r.refreshed,
				dropped: r.dropped,
				unchanged: r.unchanged,
				stale: r.stale,
				counts: proposalCounts(r.proposal),
				next: r.refreshed.length
					? 'The re-planned items are pending again: the user reviews them (wait_for_proposal), or accept_proposal where allowed.'
					: 'Nothing was re-planned.',
			});
		},
	);

	defineTool(
		ctx,
		'list_proposals',
		{
			title: 'List proposals',
			description:
				'Lists the proposals of a project (newest first): id, feature (sound-design…), title, summary, author, sequence, item count, counts per state (pending, accepted, rejected, stale, invalid), decided (nothing left to review) and when it expires (30 days after its last change). undecided: true keeps only those still under review.',
			input: {
				projectId: ProjectIdArg,
				feature: z
					.string()
					.max(64)
					.optional()
					.describe(
						'Only this feature ("sound-design", "edit-automation", "subtitles", "transcript-cleanup", "transcript-correction", "rough-cut", "title-art")',
					),
				undecided: z.boolean().optional().describe('Only proposals with items still to review'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, feature, undecided }) => {
			const r = await proposalCall<{ proposals: ProposalSummary[]; warnings: string[] }>(ctx, (c) =>
				c.listProposals(projectId),
			);
			const rows = r.proposals.filter(
				(p) => (!feature || p.feature === feature) && (!undecided || !p.decided),
			);
			return jsonResult({
				projectId,
				proposals: rows.map((p) => ({
					proposalId: p.id,
					feature: p.feature,
					title: p.title,
					summary: p.summary,
					author: p.author,
					sequenceId: p.sequenceId,
					createdAt: p.createdAt,
					updatedAt: p.updatedAt,
					expiresAt: p.expiresAt,
					itemCount: p.itemCount,
					counts: p.counts,
					decided: p.decided,
				})),
				...(r.warnings.length ? { warnings: r.warnings } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'get_proposal',
		{
			title: 'Get proposal',
			description: "Read one proposal with every item's state, reason, the user's notes and swaps.",
			details:
				'One proposal with every item: state (pending, accepted, rejected, stale = the edit changed under it, invalid = it never applied), reason, the alternative the user selected (swapped), the user’s note, selected: false when it is offered unselected (an "all" accept leaves it out), what it requires (setup items: bin, imported sounds, new cues), its why-line, plus `ghosts`: a text table (item | state | ghost | track | start | end | what) of what the undecided items would create, change or delete if applied — like get_timeline for the proposal — and `soundCheck`: its last Sound Check (sound_check {proposalId}: fixes · introduces, per item; stale when the mix changed since; null when it was never checked). revalidate (default true) re-checks undecided items against the current edit first (stale items). `updatedAt` is the token for wait_for_proposal {since}. includeCommands: true adds each item’s commands.',
			input: {
				projectId: ProjectIdArg,
				proposalId: ProposalIdArg,
				revalidate: z
					.boolean()
					.optional()
					.describe('Re-check undecided items on the current edit (default true)'),
				includeSetup: z.boolean().optional().describe('List setup items too (default true)'),
				includeCommands: z.boolean().optional().describe('Add each item’s commands (default false)'),
				ghosts: z.boolean().optional().describe('Add the ghost table (default true)'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, proposalId, revalidate, includeSetup, includeCommands, ghosts }) => {
			const r = await proposalCall<ProposalResponse>(ctx, (c) =>
				c.getProposal(projectId, proposalId, { revalidate: revalidate !== false }),
			);
			const p = r.proposal;
			let ghost: { table: string; note?: string } | null = null;
			if (ghosts !== false) {
				try {
					ghost = ghostTable((await loadDoc(ctx, projectId)).doc, p);
				} catch (e) {
					ghost = { table: '', note: `no preview: ${e instanceof Error ? e.message : String(e)}` };
				}
			}
			// the last Sound Check of the proposal (P6-E5), and whether the edit changed since it was made
			const kept = SoundCheckProposalSummarySchema.safeParse(
				(p.report as { check?: unknown } | undefined)?.check,
			);
			let soundCheck: Record<string, unknown> | null = null;
			if (kept.success) {
				let current: boolean | null = null;
				try {
					const doc = (await loadDoc(ctx, projectId)).doc;
					current = mixFingerprint(doc, kept.data.sequenceId) === kept.data.baseMixHash;
				} catch {
					current = null;
				}
				soundCheck = {
					...proposalCheckSummary(kept.data),
					...(current === false
						? {
								stale:
									'The mix changed since this check: run sound_check {proposalId} again before handing it over.',
							}
						: {}),
				};
			}
			return jsonResult({
				proposalId: p.id,
				projectId: p.projectId,
				sequenceId: p.sequenceId,
				feature: p.feature,
				title: p.title,
				summary: p.summary,
				author: p.author,
				createdAt: p.createdAt,
				updatedAt: p.updatedAt,
				expiresAt: r.expiresAt,
				revision: r.revision,
				counts: proposalCounts(p),
				decided: proposalDecided(p),
				items: p.items
					.filter((i) => includeSetup !== false || !isSetupItem(i))
					.map((i) => itemView(i, includeCommands === true)),
				...(ghost ? { ghosts: ghost.table, ...(ghost.note ? { ghostsNote: ghost.note } : {}) } : {}),
				soundCheck,
				next: proposalDecided(p)
					? 'Nothing left to review.'
					: p.feature === TITLE_ART_FEATURE
						? 'Run title_check {projectId, proposalId} if the edit changed, then the user reviews it in the Review panel; call wait_for_proposal {projectId, proposalId, since: updatedAt}.'
						: soundCheck || p.feature === ROUGH_CUT_FEATURE
							? 'The user reviews it in the editor’s Review panel; call wait_for_proposal {projectId, proposalId, since: updatedAt} to learn their decisions and notes.'
							: 'Run sound_check {projectId, proposalId} first (what it fixes and introduces), then ask the user to review it in the Review panel and call wait_for_proposal {projectId, proposalId, since: updatedAt}.',
			});
		},
	);

	defineTool(
		ctx,
		'wait_for_proposal',
		{
			title: 'Wait for proposal review',
			description:
				"Wait for the user's review of a proposal. Read each item's state and note. On `timeout` call again.",
			input: {
				projectId: ProjectIdArg,
				proposalId: ProposalIdArg,
				since: z.string().max(64).optional().describe('Last `updatedAt` you saw.'),
				until: z
					.enum(['change', 'decided'])
					.optional()
					.describe('Default change; decided waits until nothing is left.'),
				timeoutSeconds: z.number().int().min(1).max(900).optional().describe('Default 300, max 900.'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, proposalId, since, until, timeoutSeconds }, extra: Extra) => {
			const report = progressReporter(extra);
			const timeoutMs = (timeoutSeconds ?? 300) * 1000;
			const started = Date.now();
			const get = async (): Promise<ProposalResponse | null> => {
				try {
					return await ctx.engine((c) => c.getProposal(projectId, proposalId));
				} catch (e) {
					if (e instanceof EngineError && e.code === 'PROPOSAL_NOT_FOUND') return null;
					throw e;
				}
			};
			const first = await get();
			if (!first)
				return jsonResult({
					status: 'deleted',
					proposalId,
					message: 'The proposal is gone (the user discarded it, or it expired or was evicted).',
				});
			const token = since ?? first.proposal.updatedAt;
			const body = (status: string, p: Proposal) => {
				const items = p.items.filter((i) => !isSetupItem(i)).map(decisionOf);
				const notes = items
					.filter((i) => i.note)
					.map((i) => ({ itemId: i.itemId, label: i.label, note: i.note! }));
				return {
					status,
					proposalId: p.id,
					updatedAt: p.updatedAt,
					counts: proposalCounts(p),
					decided: proposalDecided(p),
					items,
					...(notes.length ? { notes } : {}),
					next:
						status === 'timeout'
							? 'Nothing changed yet: call wait_for_proposal again (since: updatedAt) to keep waiting.'
							: proposalDecided(p)
								? 'The review is finished. Read the notes; propose again for what the user asked.'
								: 'The user is still reviewing: call wait_for_proposal again with since: updatedAt.',
				};
			};
			let cur = first;
			for (;;) {
				const p = cur.proposal;
				const changed = p.updatedAt !== token;
				if (until === 'decided' ? proposalDecided(p) : changed) {
					const status = proposalDecided(p)
						? p.items.some((i) => i.state === 'accepted')
							? 'applied'
							: 'decided'
						: 'changed';
					return jsonResult(body(status, p));
				}
				const elapsed = Date.now() - started;
				if (elapsed >= timeoutMs) return jsonResult(body('timeout', p));
				report(elapsed / timeoutMs, 1, `Waiting for the user's review of "${p.title}"`);
				await sleep(Math.min(WAIT_POLL_MS, timeoutMs - elapsed), extra.signal);
				if (extra.signal.aborted) throw new RequestCancelled();
				const next = await get();
				if (!next)
					return jsonResult({
						status: 'deleted',
						proposalId,
						message: 'The user discarded the proposal (or it expired).',
					});
				cur = next;
			}
		},
	);

	defineTool(
		ctx,
		'accept_proposal',
		{
			title: 'Accept proposal items',
			description:
				'Apply proposal items in one undo step. Only when the user asked; agents may be refused by policy (`E_APPROVAL_REQUIRED`): then ask them to apply it, never retry.',
			details:
				'Applies proposal items as ONE transaction (one undo step; what each requires — bin, imported sounds, new cues — comes along). itemIds "all" = every pending or stale item that is selected (setup items only as requirements; items with selected: false and transcript fixes of the maybe group are left out and listed in notSelected — name their ids to apply them). Policy per feature (list_proposal_features): sound design only when the user turned on "Allow agents to apply sound proposals" for the sequence; editing automation, subtitles and transcript cleanup while Project Settings ▸ Agent Proposals allows them (default on); rough cuts only when it allows them (default off); otherwise it is refused with E_APPROVAL_REQUIRED — then ask the user to apply it in the editor’s Review panel, never retry. Do not accept a proposal the user has not asked you to apply. All-or-nothing unless partial: true (stale items are then skipped and listed). Destructive commands inside still ask the user in the editor.',
			input: {
				projectId: ProjectIdArg,
				proposalId: ProposalIdArg,
				itemIds: ItemSelectionArg,
				partial: z
					.boolean()
					.optional()
					.describe('Apply what still fits and list the stale items (default false)'),
			},
			annotations: EDIT,
		},
		async ({ projectId, proposalId, itemIds, partial }) => {
			let ids: string[] | 'all' = itemIds;
			let notSelected: string[] = [];
			if (itemIds === 'all') {
				const cur = await proposalCall<ProposalResponse>(ctx, (c) => c.getProposal(projectId, proposalId));
				// spec 17 SC-061: what an agent's "all" takes (selected items; never a feature's agent-excluded groups)
				const take = new Set(acceptAllItemIds(cur.proposal, { agent: true }));
				const open = allSelection(cur.proposal, ['pending', 'stale']);
				notSelected = open.filter((id) => !take.has(id));
				if (cur.proposal.items.some(isSetupItem) || notSelected.length) {
					ids = open.filter((id) => take.has(id));
					if (ids.length === 0)
						throw new ToolError(
							'E_INVALID_PARAM',
							notSelected.length
								? `Nothing selected to accept: ${notSelected.length} item(s) are offered unselected`
								: 'Nothing left to accept: every item is accepted, rejected or invalid',
							notSelected.length
								? 'Unselected items (selected: false, transcript fixes of the maybe group) are applied only by naming their ids, and only when the user asked; get_proposal lists them.'
								: 'get_proposal shows the item states.',
						);
				}
			}
			const r = await proposalCall<{
				proposal: Proposal;
				applied: string[];
				added: string[];
				skipped: string[];
				stale: { itemId: string; reason: string }[];
				result: { label?: string } | null;
				appliedBy: string | null;
				revision: number | null;
			}>(ctx, (c) =>
				c.acceptProposal(projectId, proposalId, { itemIds: ids, ...(partial ? { partial: true } : {}) }),
			);
			return jsonResult({
				proposalId,
				applied: r.applied,
				addedRequirements: r.added,
				alreadyAccepted: r.skipped,
				...(notSelected.length ? { notSelected } : {}),
				stale: r.stale,
				appliedBy: r.appliedBy,
				revision: r.revision,
				counts: proposalCounts(r.proposal),
				next: r.applied.length
					? 'Applied as one undo step. Check it with get_timeline / render_frames; the user can undo it in History.'
					: 'Nothing was applied.',
			});
		},
	);

	defineTool(
		ctx,
		'reject_proposal',
		{
			title: 'Reject proposal items',
			description:
				'Marks proposal items rejected (the document is untouched; accepted items cannot be rejected — they are undone in History). itemIds "all" = every pending or stale item. Use it to withdraw your own proposal or items the user told you to drop.',
			input: { projectId: ProjectIdArg, proposalId: ProposalIdArg, itemIds: ItemSelectionArg },
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, proposalId, itemIds }) => {
			const r = await proposalCall<{ proposal: Proposal; changed: string[] }>(ctx, (c) =>
				c.rejectProposal(projectId, proposalId, { itemIds }),
			);
			return jsonResult({
				proposalId,
				changed: r.changed,
				counts: proposalCounts(r.proposal),
				decided: proposalDecided(r.proposal),
			});
		},
	);

	defineTool(
		ctx,
		'propose_edits',
		{
			title: 'Propose edits (rough cut)',
			description:
				"Propose a multi-step cut for the user's review; nothing changes until they apply it. Each item has a `group`, a `reason` and `commands` as in `apply_commands`. Every item is dry-run: if one fails, nothing is stored. Address clips by id and list ripple edits from the end of the timeline to the start. Then tell the user and call `wait_for_proposal`; agents may not apply it themselves.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: z.string().min(1).max(128),
				title: z.string().min(1).max(200),
				strategy: z
					.string()
					.min(1)
					.max(ROUGH_CUT_LIMITS.maxStrategy)
					.describe(`The plan in 1–${ROUGH_CUT_LIMITS.maxStrategySentences} sentences`),
				expectedRevision: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe('The revision you planned on; items touching later changes are refused.'),
				items: z
					.array(
						z.strictObject({
							group: z.enum(ROUGH_CUT_GROUPS).describe('Review group'),
							reason: z.string().min(1).max(ROUGH_CUT_LIMITS.maxReason).describe('Why this edit'),
							beat: z
								.string()
								.min(1)
								.max(ROUGH_CUT_LIMITS.maxBeat)
								.optional()
								.describe('The story beat, e.g. "Hook"'),
							quote: z
								.string()
								.min(1)
								.max(ROUGH_CUT_LIMITS.maxQuote)
								.optional()
								.describe('The words it keeps or cuts'),
							commands: RoughCutCommandsArg,
							alternatives: z
								.array(
									z.strictObject({
										label: z.string().min(1).max(200).describe('What this alternative does'),
										reason: z.string().min(1).max(ROUGH_CUT_LIMITS.maxReason).optional(),
										commands: RoughCutCommandsArg,
									}),
								)
								.max(ROUGH_CUT_LIMITS.maxAlternatives)
								.optional()
								.describe('Other command sets the user can swap to'),
						}),
					)
					.min(1)
					.max(ROUGH_CUT_LIMITS.maxItems)
					.describe('The edits, in the order they apply'),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, title, strategy, expectedRevision, items }) => {
			const parsed = RoughCutInputSchema.safeParse({ sequenceId, title, strategy, items });
			if (!parsed.success)
				throw new ToolError(
					'E_INVALID_PARAM',
					parsed.error.issues
						.slice(0, 10)
						.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
						.join('; '),
					'Nothing was stored. A rough cut is at most 200 items and 2000 commands; propose a long cut in parts (one proposal per section).',
				);
			let r: ProposalCreateResponse;
			try {
				r = await ctx.engine((c) =>
					c.createProposal(projectId, {
						...roughCutDraft(parsed.data),
						allOrNothing: true,
						...(expectedRevision !== undefined ? { expectedRevision } : {}),
					}),
				);
			} catch (e) {
				throw proposeEditsError(e);
			}
			const p = r.proposal;
			let summary: GhostSummary | null = null;
			let ghost: { table: string; note?: string } = { table: '' };
			try {
				const doc = (await loadDoc(ctx, projectId)).doc;
				summary = ghostSummary(doc, p);
				ghost = ghostTable(doc, p);
			} catch (e) {
				ghost = { table: '', note: `no preview: ${e instanceof Error ? e.message : String(e)}` };
			}
			const groups: Record<string, number> = {};
			for (const it of p.items) groups[proposalItemGroup(it)] = (groups[proposalItemGroup(it)] ?? 0) + 1;
			return jsonResult({
				proposalId: p.id,
				feature: p.feature,
				title: p.title,
				sequenceId: p.sequenceId,
				revision: r.revision,
				updatedAt: p.updatedAt,
				expiresAt: r.expiresAt,
				itemCount: p.items.length,
				counts: proposalCounts(p),
				groups,
				ghostSummary: summary,
				ghosts: ghost.table,
				...(ghost.note ? { ghostsNote: ghost.note } : {}),
				...(r.evicted.length ? { evicted: r.evicted } : {}),
				next: 'Nothing was applied. Tell the user the cut is waiting in the editor’s Review panel (strategy, ghosts, A/B, ✓ / ✕ per item, Apply), then call wait_for_proposal {projectId, proposalId, since: updatedAt} for their decisions and notes. Do not accept it yourself unless the user asked and Project Settings ▸ Agent Proposals allows rough cuts.',
			});
		},
	);
}
