// Spec 17 in the session (scapply): `transcript.replaceWords` with its subtitle and caption-track patch is ONE History
// entry (undo restores the exact previous document, redo the exact result), `scriptFix.configure` too; the review
// items carry their default selection (SC-061) and applying the selected ones goes through the accept route.
import { setImmediate } from 'node:timers/promises';
import {
	type CommandInput,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, type ProposalsController, proposalsFor } from '../src/index.ts';
import { FakeEngine } from './fake-proposals-engine.ts';

const REG = defaultRegistries();
const sec = (x: number) => Math.round(x * FLICKS_PER_SECOND);

const AUDIO = {
	kind: 'audio' as const,
	fingerprint: `q1:${'5'.repeat(64)}`,
	originalName: 'voice.wav',
	sizeBytes: 1000,
	container: 'wav',
	probe: {
		durationFlicks: 20 * FLICKS_PER_SECOND,
		startTimecode: null,
		streams: [
			{
				index: 0,
				type: 'audio' as const,
				codec: 'pcm_s16le',
				sampleRate: 48000,
				channels: 1,
				channelLayout: 'mono',
			},
		],
		rotationDegrees: 0 as const,
		hasAlpha: false,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store' as const, engineId: 'local', key: 'mk_voice' }],
	derivation: null,
	importedAt: '2026-10-27T00:00:00.000Z',
};

function open() {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'Fix', preset: 'hd-1080p-30' });
	let session!: EditorSession;
	const engine = new FakeEngine(() => session);
	session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-27T10:00:00.000Z', registries: REG },
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	const ok = (commands: unknown[]) => {
		const r = session.apply({
			label: 'Setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const m = ok([{ type: 'media.register', asset: AUDIO, ref: '$m' }]).refs.$m!;
	ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: ['A1'] } }]);
	const words: Array<[string, number, number]> = [
		['Hoy', 0.2, 0.5],
		['abrimos', 0.5, 1.0],
		['Pixel', 1.0, 1.3],
		['forch', 1.3, 1.7],
		['y', 1.7, 1.8],
		['la', 2.0, 2.2],
		['tienda.', 2.2, 2.7],
	];
	const t = ok([
		{
			type: 'transcript.create',
			mediaId: m,
			language: 'es',
			origin: 'whisper-local',
			words: words.map(([text, s, e]) => ({ text, start: sec(s), end: sec(e) })),
		},
	]).results[0] as { transcriptId: string };
	return { session, engine, seqId, ok, transcriptId: t.transcriptId };
}

const merge = (transcriptId: string): CommandInput =>
	({
		type: 'transcript.replaceWords',
		transcriptId,
		edits: [
			{
				start: sec(1.0),
				end: sec(1.7),
				expect: ['Pixel', 'forch'],
				words: [{ text: 'Pixelforge', start: sec(1.0), end: sec(1.7), confidence: 0.8 }],
			},
		],
	}) as CommandInput;

describe('script fixes in the session history', () => {
	it('replaceWords with its subtitle and caption patch is one undo step, exact both ways', () => {
		const { session, ok, transcriptId } = open();
		ok([{ type: 'captions.generate', template: 'builtin:word-highlight', cutAware: false }]);
		ok([{ type: 'transcript.createCaptions' }]);
		const step = (commands: CommandInput[]) => {
			const before = structuredClone(session.getCommitted());
			const depth = session.getState().history.index;
			const r = session.apply({ label: 'Fix', origin: 'user', commands });
			expect(r.ok, JSON.stringify(r)).toBe(true);
			expect(session.getState().history.index).toBe(depth + 1);
			const after = structuredClone(session.getCommitted());
			expect(session.undo().ok).toBe(true);
			expect(session.getCommitted()).toEqual(before);
			expect(session.redo().ok).toBe(true);
			expect(session.getCommitted()).toEqual(after);
			return { r, after };
		};
		const { r, after } = step([merge(transcriptId)]);
		const res = (r.ok ? r.results[0] : null) as { patched: { kind: string }[] };
		expect(res.patched.map((p) => p.kind).sort()).toEqual(['caption', 'subtitle']);
		const seq = Object.values(after.sequences)[0]!;
		const texts = Object.values(seq.clips)
			.filter((c) => c.kind === 'text')
			.map((c) => (c as { content: { text: string } }).content.text)
			.join(' ');
		expect(texts).toContain('Pixelforge');
		expect(texts).not.toContain('forch');
		step([
			{ type: 'scriptFix.configure', settings: { strictness: 'generous' }, reject: ['fp:1'] } as CommandInput,
		]);
		expect((Object.values(session.getCommitted().sequences)[0] as { scriptFix?: unknown }).scriptFix).toEqual(
			{
				settings: { strictness: 'generous' },
				rejected: ['fp:1'],
			},
		);
	});
});

describe('review items carry their default selection (SC-061)', () => {
	it('selected follows the item; applying the selected ones is one transaction', async () => {
		const { session, engine, seqId, transcriptId } = open();
		const c: ProposalsController = proposalsFor(session, {
			engine,
			setTimer: (fn: () => void) => setTimeout(fn, 0),
			clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
		});
		c.connect(engine.subscribe);
		const p = engine.create(
			{
				feature: 'transcript-correction',
				title: 'Fix transcript',
				sequenceId: seqId,
				items: [
					{ id: 'fix', label: 'Pixel forch → Pixelforge', group: 'fix', commands: [merge(transcriptId)] },
					{
						id: 'maybe',
						label: '+ → en',
						group: 'maybe',
						selected: false,
						commands: [
							{
								type: 'transcript.replaceWords',
								transcriptId,
								edits: [
									{
										start: sec(1.8),
										end: sec(2.0),
										expect: [],
										words: [{ text: 'en', start: sec(1.82), end: sec(1.98), confidence: null }],
									},
								],
							},
						],
					},
				],
			},
			{ agent: 'fixer' },
		);
		await c.setActive(p.id);
		expect(c.getState().items.map((it) => [it.id, it.selected])).toEqual([
			['fix', true],
			['maybe', false],
		]);
		await c.setItemDecision(['fix'], 'accept');
		const r = await c.apply({ trusted: true });
		expect(r.ok, JSON.stringify(r)).toBe(true);
		await setImmediate();
		const words = (session.getCommitted() as ProjectDocument).transcripts[transcriptId]!.words.map(
			(w) => w.text,
		);
		expect(words).toEqual(['Hoy', 'abrimos', 'Pixelforge', 'y', 'la', 'tienda.']);
		c.dispose();
	});
});
