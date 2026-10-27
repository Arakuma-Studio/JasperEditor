// Proposal tools (spec 12 §2.5, §2.10, P3-R5; wp-note "Phase 3 → WP3.2"; spec 15 §2.1): the proposal features and
// whether agents may accept them here (list_proposal_features), read proposals (with a text table of their ghosts),
// wait for the user's review (decisions, swapped alternatives, notes), accept (policy-gated per feature), reject and
// refresh (the producer re-plans stale items). Proposals are stored by the engine per project, outside the document
// and its undo history; accepting items is ONE transaction (one undo step).
import {
	type ProposalFeature,
	type ProposalRefreshResponse,
	type ProposalResponse,
	type ProposalSummary,
	SoundCheckProposalSummarySchema,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	acceptAllItemIds,
	defaultRegistries,
	isSetupItem,
	mixFingerprint,
	type ProjectDocument,
	type Proposal,
	type ProposalItem,
	previewProposal,
	proposalCounts,
	proposalDecided,
	type Sequence,
	sequenceTimecode,
	soundCuesOf,
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
- Features: list_proposal_features {projectId} lists the proposal features (sound-design, edit-automation, subtitles, transcript-cleanup, transcript-correction), their producing tools, Review groups (items name theirs in meta.group), whether you may apply them here and whether their producer refreshes stale items.
- Apply: accept_proposal {projectId, proposalId, itemIds: "all" | [ids]} works for an agent only where the feature allows it: sound design when the user turned on "Allow agents to apply sound proposals" for the sequence (off by default); editing automation, subtitles and transcript cleanup while Project Settings ▸ Agent Proposals allows them (on by default; the user may turn them off). Refused → E_APPROVAL_REQUIRED: do not retry, ask the user to apply it in the Review panel. Accepting is still one undoable "Agent: …" step, and destructive commands inside still ask the user. Stale items (the edit changed under them) refuse the whole accept unless partial: true. "all" takes only the items that are selected (an item with selected: false — e.g. a Maybe transcript fix — is offered unchecked) and, for transcript fixes, never the maybe group: name such items' ids to apply them, and only when the user asked. reject_proposal {itemIds} marks items rejected (the document is untouched).
- Stale items: refresh_proposal {projectId, proposalId} asks the feature's producer to re-plan them on the current edit (they come back pending; nothing is applied) — never accept a stale item as it was planned. Refused with E_NOT_REFRESHABLE when the producer cannot re-plan: propose the changed part again.
- Producers of new features: a proposal whose accept would exceed one transaction (5 000 commands / 20 MB; 2 000 items) is refused with E_TOO_LARGE and details.suggestedRange (frames that fit): run the pass on that range, then the rest. Batch commands keep passes small: clip.addAdjustmentBatch (adjustment clips with effects and keys relative to each item) and keyframe.addBatch (keys on many clips) — one command per item. Anchor decorations with meta.anchorOn {clips: [decorated clip ids], cuts: [{trackId, frame}]} so they go stale when the cut moves.
- Check before you hand it over: sound_check {projectId, proposalId} runs Sound Check on the proposal's preview (the current edit with its items applied; nothing changes) and says what it fixes and introduces, per item ("fixes 3 · introduces 1"). plan_sound_design {check: true} does it for you. The result is kept on the proposal: get_proposal shows it (soundCheck), and so does the user's Review panel, next to each item.
- One writer, one proposal per pass: when you weigh alternatives (another sound, another level, a different cue), test them yourself and merge the best into ONE proposal — its items' alternatives carry the other sounds — rather than handing the user several competing proposals. Run sound_check {proposalId} on it before asking for review, and never hand over a proposal that introduces errors without saying so (say which item and what). Review it through the lenses in SOUND_GUIDE ("Review lenses").`;

const ProposalIdArg = z
	.string()
	.regex(/^prp_[0-9A-HJKMNP-TV-Z]{16}$/, 'a proposal id: prp_ + 16 characters')
	.describe('Proposal id (plan_sound_design, place_sound, list_proposals)');
const ItemSelectionArg = z
	.union([z.literal('all'), z.array(z.string().min(1).max(64)).min(1).max(2000)])
	.describe('"all", or item ids (get_proposal)');

/** Hint when an agent may not apply a proposal (the policy gate). */
export const APPROVAL_REQUIRED_HINT =
	'Only the user can apply this proposal: ask them to review it in the editor (Review panel: ✓ / ✕ per item, alternates, notes) and apply it there, or to allow agents — sound design: "Allow agents to apply sound proposals" for this sequence (Preferences ▸ Sound Library); editing automation, subtitles, transcript cleanup: "Allow agents to apply <feature> proposals" (Project Settings ▸ General ▸ Agent Proposals). Do not retry; call wait_for_proposal to learn their decisions.';

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
		...(typeof m.why === 'string' ? { why: m.why } : {}),
		...(typeof m.timecode === 'string' ? { timecode: m.timecode } : {}),
		...(typeof m.soundId === 'string' ? { soundId: m.soundId } : {}),
		...(typeof m.role === 'string' ? { role: m.role } : {}),
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
			description:
				'The proposal features of a project (sound-design, edit-automation, subtitles, transcript-cleanup, transcript-correction): what their proposals are, the tools that produce them, their Review groups (put the group id in an item’s meta.group), the item noun, whether YOU may apply them here (agentAccept: setting "project" → allowed (Project Settings ▸ Agent Proposals, default on); setting "sound-sequence" → per sequence id, default off) and whether their producer re-plans stale items (refreshable, refresh_proposal).',
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
			description:
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
						'Only this feature ("sound-design", "edit-automation", "subtitles", "transcript-cleanup", "transcript-correction")',
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
			description:
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
					: soundCheck
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
				'Waits (at most timeoutSeconds, default 300, max 900) until the user changes the proposal in the editor — keeps or rejects an item, swaps to an alternative, writes a note, applies it — or deletes it; until: "decided" waits until nothing is left to review. since: the updatedAt you last saw (get_proposal; default: now). Returns status (changed | decided | applied | deleted | timeout), counts, and per item (setup items left out) its state: accepted | rejected | pending | stale | invalid, swapped → the alternative they chose, and their note — read the notes and act on them. Sends progress notifications while waiting; call it again after a timeout to keep waiting.',
			input: {
				projectId: ProjectIdArg,
				proposalId: ProposalIdArg,
				since: z.string().max(64).optional().describe('updatedAt you last saw (default: the current one)'),
				until: z
					.enum(['change', 'decided'])
					.optional()
					.describe('"change" (default): any decision; "decided": nothing left to review'),
				timeoutSeconds: z.number().int().min(1).max(900).optional().describe('Default 300, max 900'),
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
				'Applies proposal items as ONE transaction (one undo step; what each requires — bin, imported sounds, new cues — comes along). itemIds "all" = every pending or stale item that is selected (setup items only as requirements; items with selected: false and transcript fixes of the maybe group are left out and listed in notSelected — name their ids to apply them). Policy per feature (list_proposal_features): sound design only when the user turned on "Allow agents to apply sound proposals" for the sequence; editing automation, subtitles and transcript cleanup while Project Settings ▸ Agent Proposals allows them (default on); otherwise it is refused with E_APPROVAL_REQUIRED — then ask the user to apply it in the editor’s Review panel, never retry. Do not accept a proposal the user has not asked you to apply. All-or-nothing unless partial: true (stale items are then skipped and listed). Destructive commands inside still ask the user in the editor.',
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
}
