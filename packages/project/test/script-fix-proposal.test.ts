// Spec 17 SC-060…SC-062 (and SC-054): the `transcript-correction` proposal feature, the item builder, per-item default
// selection (Maybe items unselected: an accept of "all" leaves them, an agent's "all" never takes the maybe group,
// explicit ids take any), staleness of fix items through the replaceWords dry run, accepting everything as one
// transaction, and cleanup analyses going stale after a fix through the existing detection.
import { describe, expect, it } from 'vitest';
import { analyzeSequenceCleanup, type CleanupAnalysis } from '../src/cleanup/sequence.ts';
import {
	acceptAllItemIds,
	composeAcceptTx,
	createProposal,
	defaultRegistries,
	FLICKS_PER_SECOND,
	PROPOSAL_FEATURE_MODEL_STRINGS,
	type Proposal,
	type ProposalContext,
	planAccept,
	proposalFeatureInfo,
	revalidate,
	TRANSCRIPT_CLEANUP_FEATURE,
	TRANSCRIPT_CORRECTION_FEATURE,
	type TranscriptFixCandidate,
	type TranscriptFixDecision,
	transcriptFixEditProblem,
	transcriptFixItem,
	transcriptFixItemId,
} from '../src/index.ts';
import { GOLDEN_EVENTS, goldenSequence } from './cleanup-golden-fixture.ts';
import { synthRecording } from './cleanup-synth.ts';
import { Harness } from './helpers.ts';

const NOW = '2026-10-27T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
const sec = (x: number) => Math.round(x * FLICKS_PER_SECOND);
let idn = 0;
const nextId = () => `prp_${String(++idn).padStart(16, '0')}`;

function talk() {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const a = H.registerVideo({ seconds: 20 });
	H.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			tracks: { video: 'V1', audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	const list: Array<[string, number, number]> = [
		['Hoy', 0.2, 0.5],
		['abrimos', 0.5, 1.0],
		['Pixel', 1.0, 1.3],
		['forch', 1.3, 1.7],
		['y', 1.7, 1.8],
		['la', 2.0, 2.2],
		['tienda', 2.2, 2.7],
		['Glimer', 3.0, 3.4],
		['box.', 3.4, 3.9],
	];
	const r = H.ok([
		{
			type: 'transcript.create',
			mediaId: a,
			language: 'es',
			origin: 'whisper-local',
			words: list.map(([text, s, e]) => ({ text, start: sec(s), end: sec(e), confidence: 0.3 })),
		},
	]);
	return { H, mediaId: a, transcriptId: (r.results[0] as { transcriptId: string }).transcriptId };
}

function candidates(mediaId: string, transcriptId: string) {
	const base = { transcriptId, mediaId, contextBefore: ['Hoy'], contextAfter: ['y'] };
	const c1: TranscriptFixCandidate = {
		...base,
		kind: 'merge',
		category: 'proper',
		asr: ['Pixel', 'forch'],
		script: ['Pixelforge'],
		start: sec(1.0),
		end: sec(1.7),
		fingerprint: `${mediaId}~pixel forch~pixelforge~hoy abrimos~y la`,
	};
	const d1: TranscriptFixDecision = {
		group: 'fix',
		rule: 'merge',
		deltaTok: -0.4,
	};
	const e1 = {
		start: sec(1.0),
		end: sec(1.7),
		expect: ['Pixel', 'forch'],
		words: [{ text: 'Pixelforge', start: sec(1.0), end: sec(1.69), confidence: 0.82 }],
	};
	const c2: TranscriptFixCandidate = {
		...base,
		kind: 'del',
		category: 'function',
		asr: [],
		script: ['en'],
		start: sec(1.8),
		end: sec(2.0),
		fingerprint: `${mediaId}~~en~forch y~la tienda`,
	};
	const d2: TranscriptFixDecision = {
		group: 'maybe',
		rule: 'maybe',
		deltaTok: -3.5,
	};
	const e2 = {
		start: sec(1.8),
		end: sec(2.0),
		expect: [],
		words: [{ text: 'en', start: sec(1.82), end: sec(1.98), confidence: 0.2 }],
	};
	const c3: TranscriptFixCandidate = {
		...base,
		kind: 'join',
		category: 'proper',
		asr: ['Glimer', 'box.'],
		script: ['Glimmerbox.'],
		start: sec(3.0),
		end: sec(3.9),
		fingerprint: `${mediaId}~glimer box~glimmerbox~la tienda~`,
	};
	const d3: TranscriptFixDecision = {
		group: 'spelling',
		rule: 'join',
		deltaTok: null,
	};
	const e3 = {
		start: sec(3.0),
		end: sec(3.9),
		expect: ['Glimer', 'box.'],
		words: [{ text: 'Glimmerbox.', start: sec(3.0), end: sec(3.9), confidence: null }],
	};
	return [transcriptFixItem(c1, d1, e1), transcriptFixItem(c2, d2, e2), transcriptFixItem(c3, d3, e3)];
}

function propose(H: Harness, items: unknown[]): Proposal {
	const r = createProposal(
		H.doc,
		{ feature: TRANSCRIPT_CORRECTION_FEATURE, title: 'Fix transcript', sequenceId: H.seqId, items },
		{ id: nextId(), projectId: H.doc.projectId, author: { agent: 'fixer' }, now: NOW, revision: H.revision },
		CTX,
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.proposal;
}

describe('transcript-correction feature (SC-060)', () => {
	it('is declared with its name, noun, groups and agent policy; cleanup has no transcript group any more', () => {
		const f = proposalFeatureInfo(TRANSCRIPT_CORRECTION_FEATURE)!;
		expect(f.name).toBe('Transcript fixes');
		expect(f.itemNoun).toEqual({ one: '1 fix', other: '{0} fixes' });
		expect(f.agentAccept).toEqual({ setting: 'project', default: true });
		expect(f.groups).toEqual([
			{ id: 'fix', label: 'Fixes' },
			{ id: 'spelling', label: 'Spelling' },
			{ id: 'maybe', label: 'Maybe' },
		]);
		expect(f.agentAllExcludes).toEqual(['maybe']);
		expect(proposalFeatureInfo(TRANSCRIPT_CLEANUP_FEATURE)!.groups.map((g) => g.id)).not.toContain(
			'transcript',
		);
		for (const s of ['1 fix', '{0} fixes', 'Fixes', 'Spelling', 'Maybe', 'Transcript fixes'])
			expect(PROPOSAL_FEATURE_MODEL_STRINGS).toContain(s);
	});
});

describe('transcript fix items (SC-061)', () => {
	it('builds one replaceWords item per candidate with the meta, and Maybe items unselected', () => {
		const { mediaId, transcriptId } = talk();
		const [a, b, c] = candidates(mediaId, transcriptId);
		expect(a).toMatchObject({
			label: 'Pixel forch → Pixelforge',
			group: 'fix',
			commands: [
				{
					type: 'transcript.replaceWords',
					transcriptId,
					edits: [{ start: sec(1.0), end: sec(1.7), expect: ['Pixel', 'forch'] }],
				},
			],
			meta: {
				group: 'fix',
				kind: 'merge',
				category: 'proper',
				asr: ['Pixel', 'forch'],
				script: ['Pixelforge'],
				deltaTok: -0.4,
				rule: 'merge',
				mediaId,
				start: sec(1.0),
				end: sec(1.7),
				contextBefore: ['Hoy'],
				contextAfter: ['y'],
			},
		});
		expect(a!.selected).toBeUndefined();
		expect(b).toMatchObject({ label: '+ → en', selected: false, group: 'maybe' });
		expect(c!.meta).toMatchObject({ group: 'spelling', deltaTok: null });
		// ids: proposal-safe, stable, distinct per fingerprint
		const ids = [a, b, c].map((x) => x!.id);
		for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
		expect(new Set(ids).size).toBe(3);
		expect(transcriptFixItemId('x'.repeat(500))).toMatch(/^fix:x+:[0-9a-z]+$/);
		expect(transcriptFixItemId('x'.repeat(500)).length).toBeLessThanOrEqual(64);
	});

	it('uses the aligner’s edit verbatim (a span wider than the candidate’s words); refuses a malformed edit', () => {
		const { H, mediaId, transcriptId } = talk();
		const candidate: TranscriptFixCandidate = {
			transcriptId,
			mediaId,
			kind: 'sub',
			category: 'proper',
			asr: ['forch'],
			script: ['forge'],
			start: sec(1.3),
			end: sec(1.7),
			contextBefore: ['abrimos', 'Pixel'],
			contextAfter: ['y', 'la'],
			fingerprint: `${mediaId}~forch~forge`,
		};
		// re-timed by the audio inside previous word end → next word start
		const edit = {
			start: sec(1.3),
			end: sec(1.7),
			expect: ['forch'],
			words: [{ text: 'forge', start: sec(1.32), end: sec(1.7), confidence: 0.7 }],
		};
		// the aligner's edit takes in the word before as well (its span is wider than the candidate's words)
		const wide = {
			start: sec(1.0),
			end: sec(1.7),
			expect: ['Pixel', 'forch'],
			words: [
				{ text: 'Pixel', start: sec(1.0), end: sec(1.25), confidence: 0.9 },
				{ text: 'forge', start: sec(1.25), end: sec(1.7), confidence: 0.7 },
			],
		};
		const it0 = transcriptFixItem(candidate, { group: 'fix', rule: 'sub', deltaTok: -0.8 }, wide);
		expect((it0.commands[0] as { edits: unknown[] }).edits).toEqual([wide]);
		expect(it0.meta).toMatchObject({ start: sec(1.0), end: sec(1.7), asr: ['forch'], script: ['forge'] });
		expect(it0.label).toBe('Pixel forch → Pixel forge');
		// the item applies as is
		const p = propose(H, [it0]);
		const plan = planAccept(H.doc, p, 'all', 'user', CTX);
		if (!plan.ok || !plan.composed) throw new Error('no plan');
		H.ok(plan.composed.tx.commands);
		expect(H.doc.transcripts[transcriptId]!.words.map((w) => w.text).slice(1, 4)).toEqual([
			'abrimos',
			'Pixel',
			'forge',
		]);
		// a malformed edit is the producer's bug: refused with the reason
		const d = { group: 'fix' as const, rule: 'sub', deltaTok: -0.8 };
		expect(() =>
			transcriptFixItem(candidate, d, { ...edit, words: [{ ...edit.words[0]!, end: sec(1.9) }] }),
		).toThrow(/outside the edit's span/);
		expect(() =>
			transcriptFixItem(candidate, d, { ...edit, words: [{ ...edit.words[0]!, text: 'for ge' }] }),
		).toThrow(/without spaces/);
		expect(transcriptFixEditProblem(edit)).toBeNull();
	});

	it('stores the default selection; "all" takes the selected items; explicit ids take any; agents never maybe', () => {
		const { H, mediaId, transcriptId } = talk();
		const items = candidates(mediaId, transcriptId);
		const p = propose(H, items);
		expect(p.items.map((it) => [it.state, it.selected])).toEqual([
			['pending', undefined],
			['pending', false],
			['pending', undefined],
		]);
		const [fix, maybe, spelling] = p.items.map((it) => it.id) as [string, string, string];
		expect(acceptAllItemIds(p)).toEqual([fix, spelling]);
		// a caller that re-selected the Maybe item: still never in an agent's "all"
		const reselected: Proposal = { ...p, items: p.items.map((it) => ({ ...it, selected: true })) };
		expect(acceptAllItemIds(reselected)).toEqual([fix, maybe, spelling]);
		expect(acceptAllItemIds(reselected, { agent: true })).toEqual([fix, spelling]);
		const all = composeAcceptTx(p, 'all', 'user');
		expect(all.ok && all.itemIds).toEqual([fix, spelling]);
		const plan = planAccept(H.doc, p, 'all', 'user', CTX);
		expect(plan.ok && plan.composed?.itemIds).toEqual([fix, spelling]);
		// accepting everything selected is one transaction: the transcript gets both fixes
		if (!plan.ok || !plan.composed) throw new Error('no plan');
		H.ok(plan.composed.tx.commands);
		expect(H.doc.transcripts[transcriptId]!.words.map((w) => w.text)).toEqual([
			'Hoy',
			'abrimos',
			'Pixelforge',
			'y',
			'la',
			'tienda',
			'Glimmerbox.',
		]);
		// explicit ids take the Maybe item too
		const named = planAccept(H.doc, p, [maybe], 'user', CTX);
		expect(named.ok && named.composed?.itemIds).toEqual([maybe]);
	});

	it('a fix item whose words changed is stale through the replaceWords dry run (SC-062)', () => {
		const { H, mediaId, transcriptId } = talk();
		const p = propose(H, candidates(mediaId, transcriptId));
		// the user corrected "forch" by hand meanwhile
		H.ok([{ type: 'transcript.editText', transcriptId, fromWord: 3, toWord: 3, text: 'forge' }]);
		const rv = revalidate(H.doc, p, CTX);
		const fix = p.items[0]!.id;
		expect(rv.stale.map((s) => s.itemId)).toEqual([fix]);
		expect(rv.stale[0]!.reason).toMatch(/^E_STALE: /);
		expect(rv.stale[0]!.problem).toEqual({ type: 'conflict', issue: expect.stringMatching(/^E_STALE/) });
		// all-or-nothing refuses; partial applies the rest (the spelling fix)
		const strict = planAccept(H.doc, rv.proposal, 'all', 'user', CTX);
		expect(!strict.ok && strict.errors.map((e) => e.code)).toEqual(['E_STALE']);
		const partial = planAccept(H.doc, rv.proposal, 'all', 'user', CTX, { partial: true });
		expect(partial.ok && partial.composed?.itemIds).toEqual([p.items[2]!.id]);
	});
});

describe('cleanup goes stale after a fix (SC-054)', () => {
	it('findings over a fixed word get a new fingerprint, so remembered rejections stop matching', () => {
		const rec = synthRecording(GOLDEN_EVENTS, 7);
		const g = goldenSequence(rec);
		const analyse = () => {
			const a = analyzeSequenceCleanup({ doc: g.H.doc, seq: g.H.seq, voice: () => rec.voice, decisions: {} });
			if (!a.ok) throw new Error(a.message);
			return a as CleanupAnalysis;
		};
		const a0 = analyse();
		const t = Object.values(g.H.doc.transcripts).find((x) => x.mediaId === g.mediaId)!;
		const i = t.words.findIndex((w) => w.text.toLowerCase().startsWith('calor'));
		expect(i).toBeGreaterThan(0);
		const w = t.words[i]!;
		const f0 = a0.findings.find((f) => f.range.start <= w.start && f.range.end >= w.end)!;
		expect(f0).toBeTruthy();
		g.H.ok([
			{
				type: 'transcript.replaceWords',
				transcriptId: t.id,
				edits: [
					{
						start: w.start,
						end: w.end,
						expect: [w.text],
						words: [{ text: 'color', start: w.start, end: w.end, confidence: 0.9 }],
					},
				],
			},
		]);
		const a1 = analyse();
		const f1 = a1.findings.find(
			(f) => f.kind === f0.kind && f.range.start <= w.start && f.range.end >= w.end,
		);
		expect(f1).toBeTruthy();
		expect(f1!.fingerprint).not.toBe(f0.fingerprint);
		expect(a1.findings.map((f) => f.fingerprint)).not.toContain(f0.fingerprint);
	});
});
