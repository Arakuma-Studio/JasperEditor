// Proposals for new features (spec 15 §2.1): the feature table and its agent policies (Project Settings ▸ Agent
// Proposals, default on; sound design unchanged), the setting's command (merged, undoable, the agent guard), lenient
// reading and repair; budgets (E_TOO_LARGE with a range that fits); finer anchors (decorated clips and cut frames);
// producer refreshes of stale items.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	agentProposalsAllowed,
	anchorProblem,
	approvalReasons,
	CURRENT_SCHEMA_VERSION,
	checkInvariants,
	createCounterIdSource,
	createProposal,
	cutAnchorKey,
	defaultRegistries,
	EDIT_AUTOMATION_FEATURE,
	loadProject,
	makeEnvelope,
	PROPOSAL_FEATURE_MODEL_STRINGS,
	PROPOSAL_FEATURES,
	PROPOSAL_LIMITS,
	type Proposal,
	type ProposalContext,
	projectFeaturePolicy,
	projectSettingFeatures,
	proposalBudget,
	proposalFeatureInfo,
	refreshProposalItems,
	repairDocument,
	revalidate,
	SOUND_DESIGN_FEATURE,
	SUBTITLES_FEATURE,
	TRANSCRIPT_CLEANUP_FEATURE,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const NOW = '2026-10-25T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
const AGENT = { agent: 'test-agent' };
let idn = 0;
const nextId = () => `prp_${String(++idn).padStart(16, '0')}`;

describe('proposal features', () => {
	it('lists sound design and the three workflow features with groups, nouns and producers', () => {
		expect(PROPOSAL_FEATURES.map((f) => f.id)).toEqual([
			SOUND_DESIGN_FEATURE,
			EDIT_AUTOMATION_FEATURE,
			SUBTITLES_FEATURE,
			TRANSCRIPT_CLEANUP_FEATURE,
		]);
		expect(proposalFeatureInfo(SOUND_DESIGN_FEATURE)!.agentAccept).toEqual({
			setting: 'sound-sequence',
			default: false,
		});
		expect(projectSettingFeatures().map((f) => [f.id, f.agentAccept.default])).toEqual([
			[EDIT_AUTOMATION_FEATURE, true],
			[SUBTITLES_FEATURE, true],
			[TRANSCRIPT_CLEANUP_FEATURE, true],
		]);
		// sound design keeps its review order (Hero, Support, Bed, Layers)
		expect(proposalFeatureInfo(SOUND_DESIGN_FEATURE)!.groups.map((g) => g.id)).toEqual([
			'hero',
			'support',
			'bed',
			'layer',
		]);
		expect(PROPOSAL_FEATURE_MODEL_STRINGS).toContain('Cut kits');
		expect(PROPOSAL_FEATURE_MODEL_STRINGS).toContain('{0} subtitles');
		for (const f of PROPOSAL_FEATURES) expect(new Set(f.groups.map((g) => g.id)).size).toBe(f.groups.length);
	});

	it('Allow agents to apply …: default on, merged per feature, undoable, a policy per feature', () => {
		const h = new Harness();
		for (const f of projectSettingFeatures()) expect(agentProposalsAllowed(h.doc, f.id)).toBe(true);
		expect(agentProposalsAllowed(h.doc, SOUND_DESIGN_FEATURE)).toBeNull();
		expect(agentProposalsAllowed(h.doc, 'mystery')).toBeNull();
		const before = h.doc;
		h.ok([{ type: 'project.updateSettings', settings: { agentProposals: { subtitles: false } } }]);
		h.ok([{ type: 'project.updateSettings', settings: { agentProposals: { 'transcript-cleanup': false } } }]);
		// merged: the first entry is kept
		expect(agentProposalsAllowed(h.doc, SUBTITLES_FEATURE)).toBe(false);
		expect(agentProposalsAllowed(h.doc, TRANSCRIPT_CLEANUP_FEATURE)).toBe(false);
		expect(agentProposalsAllowed(h.doc, EDIT_AUTOMATION_FEATURE)).toBe(true);
		// other settings fields keep their replace semantics and are untouched
		expect(h.doc.settings.defaultTransitionFrames).toBe(before.settings.defaultTransitionFrames);
		expect(checkInvariants(h.doc)).toEqual([]);
		const p = { feature: SUBTITLES_FEATURE } as Proposal;
		expect(projectFeaturePolicy(SUBTITLES_FEATURE)(h.doc, p)).toMatchObject({ allowed: false });
		expect((projectFeaturePolicy(SUBTITLES_FEATURE)(h.doc, p) as { reason: string }).reason).toContain(
			'Allow agents to apply subtitles proposals',
		);
		expect(projectFeaturePolicy(EDIT_AUTOMATION_FEATURE)(h.doc, p)).toEqual({ allowed: true });
		// undo = the document before
		expect(agentProposalsAllowed(before, SUBTITLES_FEATURE)).toBe(true);
		// strict command validation
		const bad = h.tx([
			{ type: 'project.updateSettings', settings: { agentProposals: { subtitles: 'yes' } } },
		]);
		expect(bad.ok ? null : bad.errors[0]!.code).toBe('E_SCHEMA');
	});

	it('an agent turning a feature on needs the user’s approval; turning it off does not', () => {
		const on = { type: 'project.updateSettings', settings: { agentProposals: { subtitles: true } } };
		const off = { type: 'project.updateSettings', settings: { agentProposals: { subtitles: false } } };
		expect(approvalReasons({ commands: [on] })).toEqual([
			'agentProposals subtitles: true in project.updateSettings (command 1) lets agents apply subtitles proposals',
		]);
		expect(approvalReasons({ commands: [off] })).toEqual([]);
		expect(approvalReasons({ commands: [on], dryRun: true })).toEqual([]);
	});

	it('reads an unreadable setting as off, loads it, and repairs it to off with a report', () => {
		const h = new Harness();
		const doc = structuredClone(h.doc);
		(doc.settings as Record<string, unknown>).agentProposals = {
			subtitles: 'maybe',
			'edit-automation': true,
		};
		expect(agentProposalsAllowed(doc, EDIT_AUTOMATION_FEATURE)).toBe(false);
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-PROJECT-SETTINGS')).toBe(true);
		const r = repairDocument(doc, createCounterIdSource(900));
		expect((r.document.settings as Record<string, unknown>).agentProposals).toEqual({
			subtitles: false,
			'edit-automation': true,
			'transcript-cleanup': false,
		});
		expect(r.report.some((e) => e.action === 'reset-project-settings')).toBe(true);
		expect(checkInvariants(r.document)).toEqual([]);
		// a file with it never fails to load
		for (const junk of [{ subtitles: 'maybe' }, 'on', 42, [true], null]) {
			const d = structuredClone(h.doc);
			(d.settings as Record<string, unknown>).agentProposals = junk;
			const env = makeEnvelope(
				{ ...d, schemaVersion: CURRENT_SCHEMA_VERSION },
				{
					revision: 1,
					savedAt: NOW,
					platform: 'test',
				},
			);
			const loaded = loadProject(JSON.parse(JSON.stringify(env)));
			expect(loaded.issues).toEqual([]);
			for (const f of projectSettingFeatures())
				expect(agentProposalsAllowed(loaded.document, f.id)).toBe(false);
		}
	});
});

describe('proposal budgets (E_TOO_LARGE)', () => {
	const item = (i: number, commands: number) => ({
		id: `i${i}`,
		label: `Item ${i}`,
		meta: { frame: i * 10 },
		commands: Array.from({ length: commands }, (_, k) => ({ type: 'marker.add', frame: i * 10 + k })),
	});

	it('fits, or names how many items fit in time order and the range they cover', () => {
		expect(proposalBudget([item(0, 3)])).toMatchObject({ fits: true, commands: 3, items: 1 });
		const over = proposalBudget(Array.from({ length: 30 }, (_, i) => item(29 - i, 200)));
		expect(over.fits).toBe(false);
		if (over.fits) return;
		expect(over.code).toBe('E_TOO_LARGE');
		expect(over.fit).toBe(Math.floor(PROPOSAL_LIMITS.maxCommands / 200));
		expect(over.suggestedRange).toEqual({ start: 0, end: over.fit * 10 });
		expect(over.message).toContain(`frames 0–${over.fit * 10}`);
	});

	it('property: the items that fit are the longest prefix in time order within every cap', () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ frame: fc.nat(10_000), n: fc.integer({ min: 1, max: 900 }) }), {
					minLength: 1,
					maxLength: 40,
				}),
				(rows) => {
					const items = rows.map((r, i) => ({
						id: `i${i}`,
						label: 'x',
						meta: { frame: r.frame },
						commands: Array.from({ length: r.n }, () => ({ type: 'marker.add', frame: 0 })),
					}));
					const b = proposalBudget(items);
					const total = rows.reduce((s, r) => s + r.n, 0);
					expect(b.fits).toBe(total <= PROPOSAL_LIMITS.maxCommands);
					if (b.fits) return;
					const ordered = rows.map((r, i) => ({ ...r, i })).sort((a, c) => a.frame - c.frame || a.i - c.i);
					let sum = 0;
					let fit = 0;
					for (const r of ordered) {
						if (sum + r.n > PROPOSAL_LIMITS.maxCommands) break;
						sum += r.n;
						fit++;
					}
					expect(b.fit).toBe(fit);
				},
			),
			{ numRuns: 200, seed: 31 },
		);
	});

	it('createProposal refuses an over-cap draft with E_TOO_LARGE and the detail', () => {
		const h = new Harness();
		const r = createProposal(
			h.doc,
			{
				feature: EDIT_AUTOMATION_FEATURE,
				title: 'Decorate Cuts',
				sequenceId: h.seqId,
				items: Array.from({ length: 12 }, (_, i) => item(i, 500)),
			},
			{ id: nextId(), projectId: h.doc.projectId, author: AGENT, now: NOW, revision: 0 },
			CTX,
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]!.code).toBe('E_TOO_LARGE');
		expect(r.errors[0]!.detail).toMatchObject({ fit: 10, suggestedRange: { start: 0, end: 100 } });
	});
});

/** V1: clip A [0, 60) and clip B [60, 120) — one cut at 60. */
function cutSetup() {
	const h = new Harness();
	h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
		{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
	]);
	const [a, b] = h.clips('V1');
	const trackId = a!.trackId;
	return { h, a: a!, b: b!, trackId };
}

const kitItem = (id: string, trackId: string, frame: number, clipIds: string[]) => ({
	id,
	label: `Kit at ${frame}`,
	meta: { group: 'cut-kits', frame, anchorOn: { clips: clipIds, cuts: [{ trackId, frame }] } },
	commands: [
		{
			type: 'clip.addAdjustmentBatch',
			trackId: 'V2',
			items: [{ start: frame - 10, length: 20, effects: [{ effectId: 'jasper.gaussian-blur' }] }],
		},
	],
});

function propose(h: Harness, items: unknown[]): Proposal {
	const r = createProposal(
		h.doc,
		{ feature: EDIT_AUTOMATION_FEATURE, title: 'Decorate Cuts', sequenceId: h.seqId, items },
		{ id: nextId(), projectId: h.doc.projectId, author: AGENT, now: NOW, revision: h.revision },
		{ ...CTX, revision: h.revision },
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.proposal;
}

describe('finer anchors (spec 15 EA-003)', () => {
	it('anchors the decorated clips and the cut frame; a moved cut makes the item stale with where it went', () => {
		const { h, a, b, trackId } = cutSetup();
		const p = propose(h, [kitItem('k60', trackId, 60, [a.id, b.id])]);
		const it0 = p.items[0]!;
		expect(it0.state).toBe('pending');
		expect(it0.anchors?.[cutAnchorKey(trackId, 60)]).toBe(`cut:${trackId}:60:${a.id}:${b.id}`);
		expect(Object.keys(it0.anchors ?? {})).toEqual(expect.arrayContaining([a.id, b.id]));
		// the user trims A's end and slides B: the cut is at 50 now
		h.ok([
			{ type: 'clip.trim', clipId: a.id, edge: 'out', deltaFrames: -10 },
			{ type: 'clip.move', clipIds: [b.id], deltaFrames: -10 },
		]);
		const rv = revalidate(h.doc, p, { ...CTX, revision: h.revision });
		expect(rv.proposal.items[0]!.state).toBe('stale');
		const prob = anchorProblem(h.doc, {
			[cutAnchorKey(trackId, 60)]: it0.anchors![cutAnchorKey(trackId, 60)]!,
		});
		expect(prob).toMatchObject({ entity: 'cut', change: 'frame', at: 60, to: 50 });
	});

	it('a cut that is gone (its clips no longer meet) is reported deleted', () => {
		const { h, a, b, trackId } = cutSetup();
		const p = propose(h, [kitItem('k60', trackId, 60, [])]);
		h.ok([{ type: 'clip.move', clipIds: [b.id], deltaFrames: 30 }]);
		const key = cutAnchorKey(trackId, 60);
		expect(anchorProblem(h.doc, { [key]: p.items[0]!.anchors![key]! })).toMatchObject({
			entity: 'cut',
			change: 'deleted',
			at: 60,
		});
		expect(a.id).toBeTruthy();
	});

	it('ignores malformed anchorOn entries (bounded, lenient)', () => {
		const { h, trackId } = cutSetup();
		const p = propose(h, [
			{
				...kitItem('k', trackId, 60, []),
				meta: { anchorOn: { clips: [42, 'nope'], cuts: [{ trackId, frame: -1 }, { frame: 3 }, 'x'] } },
			},
		]);
		expect(Object.keys(p.items[0]!.anchors ?? {}).filter((k) => k.startsWith('cut@'))).toEqual([]);
	});
});

describe('refreshProposalItems (Refresh proposal)', () => {
	it('swaps re-planned stale items in as pending with fresh anchors; drops become invalid; decisions stay', () => {
		const { h, a, b, trackId } = cutSetup();
		const p0 = propose(h, [
			kitItem('k60', trackId, 60, [a.id, b.id]),
			{ id: 'mark', label: 'Marker', commands: [{ type: 'marker.add', frame: 5 }] },
		]);
		h.ok([
			{ type: 'clip.trim', clipId: a.id, edge: 'out', deltaFrames: -10 },
			{ type: 'clip.move', clipIds: [b.id], deltaFrames: -10 },
		]);
		const stale = revalidate(h.doc, p0, CTX).proposal;
		expect(stale.items[0]!.state).toBe('stale');
		const r = refreshProposalItems(
			h.doc,
			{ ...stale, items: stale.items.map((it) => (it.id === 'mark' ? { ...it, note: 'keep it' } : it)) },
			['k60'],
			{ items: [kitItem('k60', trackId, 50, [a.id, b.id])] },
			CTX,
			NOW,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.refreshed).toEqual(['k60']);
		const k = r.proposal.items[0]!;
		expect(k.state).toBe('pending');
		expect(k.anchors?.[cutAnchorKey(trackId, 50)]).toBeDefined();
		expect(r.proposal.items[1]!.note).toBe('keep it');
		// a drop
		const d = refreshProposalItems(
			h.doc,
			stale,
			['k60'],
			{ items: [], dropped: [{ itemId: 'k60', reason: 'the cut is gone' }] },
			CTX,
			NOW,
		);
		expect(d.ok && d.proposal.items[0]!.state).toBe('invalid');
		expect(d.ok && d.proposal.items[0]!.reason).toContain('the cut is gone');
		// nothing returned: unchanged
		const u = refreshProposalItems(h.doc, stale, ['k60'], { items: [] }, CTX, NOW);
		expect(u.ok && u.unchanged).toEqual(['k60']);
	});

	it('refuses replacing decided or unrequested items, other ids, other refs and malformed results', () => {
		const { h, a, b, trackId } = cutSetup();
		const p = propose(h, [
			{ ...kitItem('k60', trackId, 60, [a.id, b.id]) },
			{ id: 't', label: 'Track', commands: [{ type: 'track.add', kind: 'video', ref: '$fx' }] },
		]);
		const rejected = {
			...p,
			items: p.items.map((it) => (it.id === 'k60' ? { ...it, state: 'rejected' as const } : it)),
		};
		const codes = (pp: Proposal, ids: string[], res: unknown) => {
			const r = refreshProposalItems(h.doc, pp, ids, res, CTX, NOW);
			return r.ok ? [] : r.errors.map((e) => e.code);
		};
		expect(codes(rejected, ['k60'], { items: [kitItem('k60', trackId, 60, [])] })).toEqual([
			'E_INVALID_PARAM',
		]);
		expect(codes(p, ['t'], { items: [kitItem('k60', trackId, 60, [])] })).toEqual(['E_INVALID_PARAM']);
		expect(codes(p, ['k60'], { items: [{ ...kitItem('zz', trackId, 60, []) }] })).toEqual(['E_NOT_FOUND']);
		expect(
			codes(p, ['t'], {
				items: [{ id: 't', label: 'Track', commands: [{ type: 'track.add', kind: 'video', ref: '$other' }] }],
			}),
		).toEqual(['E_INVALID_PARAM']);
		expect(codes(p, ['k60'], { items: 'x' })).toEqual(['E_SCHEMA']);
		expect(
			codes(p, ['k60'], {
				items: [{ ...kitItem('k60', trackId, 60, []), commands: [{ type: 'marker.add', frme: 1 }] }],
			}),
		).toEqual(['E_SCHEMA']);
	});
});
