// Shared fixture of the Fix Transcript UI tests (spec 17 scweb): a session (with a fake engine media URL) whose A1
// plays one recording with an invented Spanish transcript, and the three kinds of review items the engine makes — a
// fix decided by the audio, a spelling join decided without it, and a Maybe offered unselected — built with the real
// item builder (`transcriptFixItem`), so their meta and commands are the producer's. No user data.
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type ProjectDocument,
	type Sequence,
	transcriptFixItem,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { audioAsset } from './proposal-helpers.ts';

export const sec = (x: number) => Math.round(x * FLICKS_PER_SECOND);

/** Hoy probamos Glimer box en Nova play y la demo — with "Glimer box" and "Nova play" misrecognised. */
export const WORDS: Array<[string, number, number]> = [
	['Hoy', 0.2, 0.5],
	['probamos', 0.5, 0.9],
	['Glimer', 1.0, 1.3],
	['box', 1.3, 1.68],
	['en', 1.8, 1.95],
	['Nova', 2.0, 2.3],
	['play', 2.3, 2.6],
	['y', 2.7, 2.8],
	['la', 3.0, 3.2],
	['demo', 3.2, 3.6],
];

export function fixSession(opts: { engine?: unknown; words?: Array<[string, number, number]> } = {}) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-27T00:00:00.000Z', registries: defaultRegistries() },
		...(opts.engine ? { engine: opts.engine as never } : {}),
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	const asset = audioAsset(10);
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset, ref: '$m' },
			{ type: 'clip.place', source: { mediaId: '$m' }, at: 0, tracks: { audio: 'A1' } },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const mediaId = r.refs.$m!;
	const words = opts.words ?? WORDS;
	const t = session.apply({
		label: 'transcript',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{
				type: 'transcript.create',
				mediaId,
				language: 'es',
				origin: 'whisper-local',
				words: words.map(([text, a, b]) => ({ text, start: sec(a), end: sec(b), confidence: 0.9 })),
			},
		] as never[],
	});
	if (!t.ok) throw new Error(JSON.stringify(t.errors));
	const transcriptId = (t.results[0] as { transcriptId: string }).transcriptId;
	const mediaKey = (asset.locators[0] as { key: string }).key;
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const doc0 = () => session.getCommitted() as ProjectDocument;
	return { session, seqId, mediaId, mediaKey, transcriptId, seq, doc: doc0 };
}

const cand = (
	transcriptId: string,
	mediaId: string,
	c: {
		kind: 'sub' | 'merge' | 'join' | 'del' | 'glossary';
		category: 'proper' | 'english' | 'function' | 'other';
		asr: string[];
		script: string[];
		start: number;
		end: number;
		before: string[];
		after: string[];
		fp: string;
	},
) => ({
	transcriptId,
	mediaId,
	kind: c.kind,
	category: c.category,
	asr: c.asr,
	script: c.script,
	start: sec(c.start),
	end: sec(c.end),
	contextBefore: c.before,
	contextAfter: c.after,
	fingerprint: c.fp,
});

/** The three items: fix (audio, Δ +2.3), spelling (join, no audio), maybe (Δ −2.8, unselected). */
export function fixItems(transcriptId: string, mediaId: string) {
	const fix = transcriptFixItem(
		cand(transcriptId, mediaId, {
			kind: 'merge',
			category: 'proper',
			asr: ['Glimer', 'box'],
			script: ['Glimmerbox'],
			start: 1.0,
			end: 1.68,
			before: ['Hoy', 'probamos'],
			after: ['en', 'Nova'],
			fp: 'sf1~m~glimmer',
		}),
		{ group: 'fix', rule: 'audio', deltaTok: 2.3 },
		{
			start: sec(1.0),
			end: sec(1.68),
			expect: ['Glimer', 'box'],
			words: [{ text: 'Glimmerbox', start: sec(1.0), end: sec(1.68), confidence: 0.8 }],
		},
		{ id: 'fix:1' },
	);
	const spelling = transcriptFixItem(
		cand(transcriptId, mediaId, {
			kind: 'join',
			category: 'proper',
			asr: ['Nova', 'play'],
			script: ['NovaPlay'],
			start: 2.0,
			end: 2.6,
			before: ['box', 'en'],
			after: ['y', 'la'],
			fp: 'sf1~m~novaplay',
		}),
		{ group: 'spelling', rule: 'join', deltaTok: null },
		{
			start: sec(2.0),
			end: sec(2.6),
			expect: ['Nova', 'play'],
			words: [{ text: 'NovaPlay', start: sec(2.0), end: sec(2.6), confidence: null }],
		},
		{ id: 'fix:2' },
	);
	const maybe = transcriptFixItem(
		cand(transcriptId, mediaId, {
			kind: 'sub',
			category: 'function',
			asr: ['la'],
			script: ['una'],
			start: 3.0,
			end: 3.2,
			before: ['play', 'y'],
			after: ['demo'],
			fp: 'sf1~m~una',
		}),
		{ group: 'maybe', rule: 'maybe', deltaTok: -2.8 },
		{
			start: sec(3.0),
			end: sec(3.2),
			expect: ['la'],
			words: [{ text: 'una', start: sec(3.0), end: sec(3.2), confidence: 0.4 }],
		},
		{ id: 'fix:3' },
	);
	return [fix, spelling, maybe];
}
