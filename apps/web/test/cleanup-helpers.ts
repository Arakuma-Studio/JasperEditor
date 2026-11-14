// Fixtures of the Clean Up UI tests (spec 14 TC-070): an editor session holding the synthetic golden recording
// (voiced tones with Whisper-like word timings, `packages/project/test/cleanup-synth.ts`) on A1 with its transcript and
// script, and a fake engine whose `cleanup-analysis` job runs the real pure analysis on the document it is sent (as the
// engine does) and serves the voice analysis.
import type { CleanupAnalysisFile, CleanupAnalyzeRequest, EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	analyzeSequenceCleanup,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EditRepeat,
	flicksPerFrame,
	type ProjectDocument,
	type Sequence,
	sequenceCleanupSettings,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { GOLDEN_EVENTS, GOLDEN_SCRIPT } from '../../../packages/project/test/cleanup-golden-fixture.ts';
import { synthRecording } from '../../../packages/project/test/cleanup-synth.ts';
import { videoAsset } from '../../../packages/project/test/helpers.ts';

export const REC = synthRecording(GOLDEN_EVENTS, 7);

export type FakeCleanupEngine = {
	client: EngineClient;
	calls: string[];
	/** Make the next job fail with this error. */
	failNext: { code: string; message: string } | null;
	/** Jobs stay running until released. */
	hold: boolean;
	release(): void;
};

export function fakeCleanupEngine(): FakeCleanupEngine {
	const calls: string[] = [];
	const files = new Map<string, CleanupAnalysisFile>();
	const jobs = new Map<string, EngineJob>();
	let n = 0;
	const state: FakeCleanupEngine = {
		client: null as never,
		calls,
		failNext: null,
		hold: false,
		release() {
			state.hold = false;
		},
	};
	const job = (id: string, patch: Partial<EngineJob>): EngineJob =>
		({
			id,
			kind: 'cleanup-analysis',
			title: 'Clean Up Voice – analysis',
			origin: { type: 'user' },
			state: 'running',
			progress: 0.5,
			stage: 'Voice analysis',
			createdAt: '2026-10-26T10:00:00.000Z',
			priority: 'interactive',
			cpuSlots: 1,
			...patch,
		}) as EngineJob;
	const client = {
		analyzeCleanup: async (req: CleanupAnalyzeRequest) => {
			calls.push(
				`analyze ${JSON.stringify({ clipIds: req.clipIds, range: req.range, decisions: req.decisions, editRepeats: req.editRepeats })}`,
			);
			const id = `job_${++n}`;
			if (state.failNext) {
				const error = { ...state.failNext, retryable: false };
				state.failNext = null;
				jobs.set(id, job(id, { state: 'failed', error } as never));
				return jobs.get(id)!;
			}
			const doc = (req.document as { document: ProjectDocument }).document;
			const seq = doc.sequences[req.sequenceId!] as Sequence;
			// the check of the cuts (the engine transcribes the kept clips): one restart at the start of the first clip
			const first = Object.values(seq.clips)
				.flatMap((x) => ('mediaId' in x && 'channels' in x ? [x] : []))
				.sort((x, y) => x.start - y.start)[0];
			const editRepeats: EditRepeat[] =
				req.editRepeats && first
					? [
							{
								source: 'spans',
								where: 'cut',
								kind: 'restart',
								suggested: 'remove',
								text: 'y si',
								kept: 'y si buscas',
								range: [first.start, first.start + 9],
								cuts: [
									{
										clipId: first.id,
										mediaId: first.mediaId,
										stream: first.channels.streamIndex,
										start: first.sourceIn,
										end: first.sourceIn + 9 * flicksPerFrame(seq.settings.frameRate),
									},
								],
								confidence: 0.8,
							},
						]
					: [];
			const a = analyzeSequenceCleanup({
				doc,
				seq,
				voice: () => REC.voice,
				settings: sequenceCleanupSettings(seq),
				...(req.decisions ? { decisions: req.decisions } : {}),
				scope: {
					...(req.clipIds ? { clipIds: req.clipIds } : {}),
					...(req.range ? { range: req.range } : {}),
				},
				...(req.editRepeats ? { editRepeats } : {}),
			});
			if (!a.ok) {
				jobs.set(
					id,
					job(id, {
						state: 'failed',
						error: { code: a.code, message: a.message, retryable: false },
					} as never),
				);
				return jobs.get(id)!;
			}
			const analysisId = `cla_${n}`;
			files.set(analysisId, {
				format: 'jasper-cleanup-analysis',
				version: 1,
				analysisId,
				projectId: req.projectId,
				sequenceId: seq.id,
				revision: -1,
				createdAt: '2026-10-26T10:00:00.000Z',
				analysis: a,
			});
			const byKind: Record<string, number> = {};
			for (const f of a.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
			const result = {
				analysisId,
				url: `/api/cleanup/analyses/${analysisId}`,
				projectId: req.projectId,
				sequenceId: seq.id,
				findings: a.findings.length,
				byKind,
				groups: a.groups.length,
				ranges: a.plan.ranges.length,
				stats: a.plan.stats,
				voice: { cached: [], analysed: a.media.map((m) => m.mediaId), missing: [] },
				elapsedMs: 12,
				...(req.editRepeats
					? {
							editRepeats: {
								spans: Object.keys(seq.clips).length,
								cached: 0,
								transcribed: Object.keys(seq.clips).length,
								jobIds: ['job_speech'],
								found: editRepeats.length,
								suggestedRemove: editRepeats.length,
								missing: [],
							},
						}
					: {}),
			};
			jobs.set(id, job(id, { state: 'running', result } as never));
			return jobs.get(id)!;
		},
		getJob: async (id: string) => {
			const j = jobs.get(id)!;
			if (j.state === 'running' && !state.hold) {
				const done = { ...j, state: 'succeeded', progress: 1, stage: 'Done' } as EngineJob;
				jobs.set(id, done);
				return done;
			}
			return j;
		},
		cancelJob: async (id: string) => {
			calls.push(`cancel ${id}`);
			const j = { ...jobs.get(id)!, state: 'cancelled' } as EngineJob;
			jobs.set(id, j);
			return j;
		},
		getCleanupAnalysis: async (id: string) => {
			calls.push(`file ${id}`);
			return files.get(id)!;
		},
		getVoiceAnalysis: async (key: string, stream?: number) => {
			calls.push(`voice ${key} ${stream}`);
			return REC.voice;
		},
		call: async (name: string) => {
			calls.push(`call ${name}`);
			if (name === 'cleanupPresetsList') return { revision: 0, presets: [] };
			throw new Error(`unexpected route ${name}`);
		},
	};
	state.client = client as unknown as EngineClient;
	return state;
}

/** A session with the golden recording on A1 (30 fps), its Spanish transcript and the script attached. */
export function cleanupSession(engine: EngineClient, opts: { script?: boolean } = {}) {
	const ids = createCounterIdSource(3);
	const document = createEmptyProject({ ids, name: 'Clean Up test', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: 'prj_cleanup',
		document,
		ctx: { ids, now: () => '2026-10-26T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
		coalesceWindowMs: 0,
		engine,
	});
	const seqId = Object.keys(document.sequences)[0]!;
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: videoAsset({ seconds: REC.durationS, kind: 'audio' }), ref: '$m' },
			{ type: 'clip.place', source: { mediaId: '$m' }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const mediaId = r.refs.$m!;
	const t = session.apply({
		label: 'setup transcript',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{
				type: 'transcript.create',
				mediaId,
				language: 'es',
				origin: 'manual',
				words: REC.words.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence })),
			},
			...(opts.script === false
				? []
				: [{ type: 'cleanup.configure', script: { name: 'Guion', text: GOLDEN_SCRIPT } }]),
		] as never[],
	});
	if (!t.ok) throw new Error(JSON.stringify(t.errors));
	return { session, seqId, mediaId };
}

export const seqOf = (session: EditorSession, id: string) => session.getCommitted().sequences[id] as Sequence;
export const seqLength = (seq: Sequence) =>
	Math.max(0, ...Object.values(seq.clips).map((c) => c.start + c.duration));
