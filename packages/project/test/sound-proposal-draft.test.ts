// Sound design proposal items (spec 12 §2.5, P3-R3 / P3-R5; wp-note "Phase 3 → WP3.2"): setup items (bin, sounds,
// new cues) and place items with requires and alternatives; accepted through the generic proposal model they place the
// sound on the cue in one transaction, an alternative places another sound, and nothing a place item needs is missing.
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	applyTransaction,
	type ClipSfx,
	composeAcceptTx,
	createProposal,
	defaultRegistries,
	dependencyClosure,
	isSetupItem,
	type LibraryProvenance,
	type Proposal,
	type ProposalContext,
	planAccept,
	rejectItems,
	SETUP_NOT_NEEDED,
	type SoundProposalMedia,
	type SoundProposalPlacement,
	selectAlternative,
	settleSetupItems,
	soundCuesOf,
	soundProposalItems,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const NOW = '2026-10-16T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
type SfxClip = AudioClip & { sfx?: ClipSfx };

let n = 0;
function sound(title: string, fingerprint?: string): SoundProposalMedia {
	n++;
	const soundId = `snd_${n.toString(16).padStart(16, '0')}`;
	const library: LibraryProvenance = {
		...LIB,
		soundId,
		title,
		types: ['hit'],
		descriptors: {
			...LIB.descriptors!,
			peakSec: 0.0705,
			onsetSec: 0.06,
			headQuietSec: 0.05,
			durationSec: 0.55,
		},
		leadSilenceSec: 0.05,
	};
	const asset = videoAsset({ kind: 'audio', seconds: 0.55 }) as Record<string, unknown>;
	if (fingerprint) asset.fingerprint = fingerprint;
	return {
		soundId,
		title,
		fingerprint: asset.fingerprint as string,
		kind: 'audio',
		existingMediaId: null,
		library,
		register: { type: 'media.register', asset, name: title, ref: '$x', itemRef: '$xi' },
	};
}

function create(h: Harness, items: unknown[]): Proposal {
	const r = createProposal(
		h.doc,
		{ feature: 'sound-design', title: 'Sound pass', sequenceId: h.seqId, items },
		{ id: 'prp_0000000000000001', projectId: h.doc.projectId, author: { agent: 't' }, now: NOW, revision: 0 },
		CTX,
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
	return r.proposal;
}

function accept(h: Harness, p: Proposal, ids: string[] | 'all') {
	const plan = planAccept(h.doc, p, ids, 'user', CTX);
	if (!plan.ok || !plan.composed) throw new Error(JSON.stringify(plan));
	const r = applyTransaction(h.doc, plan.composed.tx, {
		ids: h.ids,
		now: () => NOW,
		revision: 0,
		registries: CTX.registries,
	});
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	return { doc: r.document, composed: plan.composed };
}

describe('soundProposalItems', () => {
	it('builds setup items (bin, sounds, new cue) before place items; requires name them; alternatives swap layer 0', () => {
		const h = new Harness();
		const stored = h.ok([
			{ type: 'soundCue.add', cues: [{ frame: 60, kind: 'cut', weight: 'support', source: 'user' }] },
		]).results[0] as { cueIds: string[] };
		const a = sound('Hit A');
		const b = sound('Hit B');
		const c = sound('Hit C');
		const placements: SoundProposalPlacement[] = [
			{
				id: 'sfx:001',
				label: 'Hit A · cut',
				group: 'support',
				cue: { cueId: stored.cueIds[0]! },
				layers: [{ soundId: a.soundId, role: 'support', rate: 1.01 }],
				ring: [a.soundId, b.soundId],
				alternatives: [{ soundId: b.soundId, label: 'Hit B' }],
			},
			{
				id: 'sfx:002',
				label: 'Hit C · land',
				group: 'hero',
				cue: {
					add: {
						frame: 120,
						kind: 'land',
						weight: 'hero',
						align: 'peak',
						source: 'derived',
						reason: 'logo lands',
					},
					label: 'Cue: land',
				},
				layers: [{ soundId: c.soundId, role: 'hero' }],
				ring: [c.soundId, a.soundId],
				alternatives: [{ soundId: a.soundId, label: 'Hit A' }],
			},
		];
		const built = soundProposalItems(h.doc, h.seqId, [a, b, c], placements, { binName: 'Sound Effects' });
		expect(built.missing).toEqual([]);
		expect(built.items.map((i) => i.id)).toEqual([
			'bin',
			`sound:${a.soundId}`,
			`sound:${b.soundId}`,
			`sound:${c.soundId}`,
			'cue:sfx:002',
			'sfx:001',
			'sfx:002',
		]);
		expect(built.items.filter(isSetupItem).map((i) => i.group)).toEqual(Array(5).fill('setup'));
		const place2 = built.items.find((i) => i.id === 'sfx:002')!;
		expect(place2.requires).toEqual(['cue:sfx:002', `sound:${c.soundId}`, `sound:${a.soundId}`]);
		expect(place2.commands[0]).toMatchObject({
			type: 'soundDesign.place',
			cueId: '$cue0',
			alternatives: [c.soundId, a.soundId],
		});
		const altLayer = (place2.alternatives![0]!.commands[0] as { layers: { mediaId: string }[] }).layers[0]!;
		expect(altLayer.mediaId).toBe(built.mediaOf.get(a.soundId));

		const p = create(h, built.items);
		expect(p.items.every((i) => i.state === 'pending')).toBe(true);
		// Accepting one place item brings exactly its setup (bin, its sounds, its cue): one transaction.
		const closure = dependencyClosure(p, ['sfx:002']).map((i) => i.id);
		expect(closure).toEqual(['bin', `sound:${a.soundId}`, `sound:${c.soundId}`, 'cue:sfx:002', 'sfx:002']);
		const { doc, composed } = accept(h, p, ['sfx:002']);
		expect(composed.tx.commands.length).toBe(5);
		const seq = Object.values(doc.sequences)[0]!;
		const cues = soundCuesOf(seq);
		const land = cues.find((x) => x.frame === 120)!;
		expect(land.placedClipIds).toHaveLength(1);
		const clip = seq.clips[land.placedClipIds![0]!] as SfxClip;
		expect(clip.sfx).toMatchObject({
			cueId: land.id,
			soundId: c.soundId,
			role: 'hero',
			alternatives: [c.soundId, a.soundId],
		});
		// The bin holds the two imported sounds (A comes along as C's alternative).
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin' && i.name === 'Sound Effects')!;
		expect(bin).toBeDefined();
		expect(Object.values(doc.media).filter((m) => (m as { library?: unknown }).library)).toHaveLength(2);
	});

	it('the selected alternative is what gets placed', () => {
		const h = new Harness();
		const a = sound('Hit A');
		const b = sound('Hit B');
		const built = soundProposalItems(
			h.doc,
			h.seqId,
			[a, b],
			[
				{
					id: 'sfx:001',
					label: 'x',
					group: 'support',
					cue: { frame: 45 },
					layers: [{ soundId: a.soundId }],
					ring: [a.soundId, b.soundId],
					alternatives: [{ soundId: b.soundId, label: 'Hit B' }],
				},
			],
			{ binName: 'Sound Effects' },
		);
		const p0 = create(h, built.items);
		const sel = selectAlternative(p0, 'sfx:001', 1, NOW);
		if (!sel.ok) throw new Error('select failed');
		const { doc } = accept(h, sel.proposal, ['sfx:001']);
		const clip = Object.values(Object.values(doc.sequences)[0]!.clips).find(
			(c) => c.kind === 'audio',
		) as SfxClip;
		expect(clip.sfx!.soundId).toBe(b.soundId);
		expect(clip.sfx!.alternatives).toEqual([a.soundId, b.soundId]);
	});

	it('reuses project media (adding missing provenance), shares one media for two ids of one file, needs no bin then', () => {
		const h = new Harness();
		const a = sound('Hit A');
		// A project media of A's file without provenance; and the bin already there.
		const reg = h.ok([
			{ type: 'bin.create', name: 'Sound Effects' },
			{ type: 'media.register', asset: { ...(a.register.asset as object) } },
		]).results[1] as { mediaId: string };
		const b = sound('Hit B', 'q1:'.padEnd(67, 'b'));
		const twin = sound('Hit B (folder copy)', b.fingerprint);
		const built = soundProposalItems(
			h.doc,
			h.seqId,
			[a, b, twin],
			[
				{ id: 'p1', label: 'a', group: 'support', cue: { frame: 30 }, layers: [{ soundId: a.soundId }] },
				{ id: 'p2', label: 'b', group: 'support', cue: { frame: 90 }, layers: [{ soundId: b.soundId }] },
				{ id: 'p3', label: 't', group: 'support', cue: { frame: 150 }, layers: [{ soundId: twin.soundId }] },
			],
			{ binName: 'Sound Effects' },
		);
		expect(built.items.map((i) => i.id)).toEqual([
			`sound:${a.soundId}`,
			`sound:${b.soundId}`,
			'p1',
			'p2',
			'p3',
		]);
		expect(built.items[0]!.commands).toEqual([
			{ type: 'media.setLibraryInfo', mediaId: reg.mediaId, library: a.library },
		]);
		expect(built.mediaOf.get(a.soundId)).toBe(reg.mediaId);
		expect(built.mediaOf.get(twin.soundId)).toBe(built.mediaOf.get(b.soundId));
		expect(built.items.find((i) => i.id === 'p3')!.requires).toEqual([`sound:${b.soundId}`]);
		const p = create(h, built.items);
		const { doc } = accept(h, p, ['p1', 'p2', 'p3']);
		const seq = Object.values(doc.sequences)[0]!;
		expect(Object.values(seq.clips).filter((c) => c.kind === 'audio')).toHaveLength(3);
		expect(Object.keys(doc.media)).toHaveLength(2);
	});

	it('leaves out placements naming sounds it was not given', () => {
		const h = new Harness();
		const a = sound('Hit A');
		const built = soundProposalItems(
			h.doc,
			h.seqId,
			[a],
			[
				{
					id: 'p1',
					label: 'x',
					group: 'support',
					cue: { frame: 30 },
					layers: [{ soundId: a.soundId }],
					alternatives: [{ soundId: 'snd_ffffffffffffffff', label: 'gone' }],
				},
				{ id: 'p2', label: 'y', group: 'support', cue: { frame: 60 }, layers: [{ soundId: a.soundId }] },
			],
			{ binName: 'Sound Effects' },
		);
		expect(built.missing).toEqual(['snd_ffffffffffffffff']);
		expect(built.items.map((i) => i.id)).toEqual(['bin', `sound:${a.soundId}`, 'p2']);
		// "all" through composeAcceptTx is valid structure
		const p = create(h, built.items);
		expect(composeAcceptTx(p, 'all', 'user').ok).toBe(true);
	});

	it('settles setup items nothing needs any more; accepting a rejected item later brings its requirements back', () => {
		const h = new Harness();
		const a = sound('Hit A');
		const b = sound('Hit B');
		const built = soundProposalItems(
			h.doc,
			h.seqId,
			[a, b],
			[
				{
					id: 'p1',
					label: 'a',
					group: 'support',
					cue: { add: { frame: 30, kind: 'cut', weight: 'support', source: 'derived' }, label: 'Cue 30' },
					layers: [{ soundId: a.soundId }],
				},
				{
					id: 'p2',
					label: 'b',
					group: 'support',
					cue: { add: { frame: 90, kind: 'cut', weight: 'support', source: 'derived' }, label: 'Cue 90' },
					layers: [{ soundId: b.soundId }],
					alternatives: [{ soundId: a.soundId, label: 'Hit A' }],
				},
			],
			{ binName: 'Sound Effects' },
		);
		const p0 = create(h, built.items);
		const r = rejectItems(p0, ['p1'], NOW);
		if (!r.ok) throw new Error('reject failed');
		const s1 = settleSetupItems(r.proposal, NOW);
		if (!s1.ok) throw new Error('settle failed');
		// p1's own cue goes; sound A and the bin are still needed by p2 (its alternative).
		expect(s1.changed).toEqual(['cue:p1']);
		expect(s1.proposal.items.find((i) => i.id === 'cue:p1')).toMatchObject({
			state: 'rejected',
			reason: SETUP_NOT_NEEDED,
		});
		const r2 = rejectItems(s1.proposal, ['p2'], NOW);
		if (!r2.ok) throw new Error('reject failed');
		const s2 = settleSetupItems(r2.proposal, NOW);
		if (!s2.ok) throw new Error('settle failed');
		expect(new Set(s2.changed)).toEqual(
			new Set([`sound:${a.soundId}`, `sound:${b.soundId}`, 'cue:p2', 'bin']),
		);
		expect(s2.proposal.items.every((i) => i.state === 'rejected')).toBe(true);
		// settling again changes nothing; non-setup items are never settled
		expect(settleSetupItems(s2.proposal, NOW).changed).toEqual([]);
		// the user changes their mind: accepting p1 brings its rejected requirements along
		const { doc } = accept(h, s2.proposal, ['p1']);
		const seq = Object.values(doc.sequences)[0]!;
		expect(soundCuesOf(seq).find((c) => c.frame === 30)!.placedClipIds).toHaveLength(1);
	});
});
