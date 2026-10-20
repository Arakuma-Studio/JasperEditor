// Suggest Cues… with the engine's measured sources (spec 12 §2.7 "sources (with counts)", P6-R2; wp-note "Phase 6 →
// WP6.2"): the dialog asks what is measured without starting anything; a source not analysed shows Analyze…, which
// starts its analysis, follows its job and asks again; the measured cues merge into the dialog's derivation (counts,
// Suggest adds them anchored to the footage); snap to the beat; an engine error leaves the dialog usable.
import type { EngineJob, SoundCuesRequest, SoundCuesResponse } from '@jasper/api';
import { type Sequence, soundCuesOf } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuggestCuesDialog } from '../src/sound/cues/SuggestCuesDialog.tsx';
import { planSuggestion } from '../src/sound/cues/suggest.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

afterEach(() => cleanup());

function footage() {
	const { session, seqId } = makeSession();
	const reg = session.apply({
		label: 'm',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'media.register', asset: { ...videoAsset(10, false), derivation: null } }] as never[],
	});
	if (!reg.ok) throw new Error(JSON.stringify(reg.errors));
	const mediaId = (reg.results[0] as { mediaId: string }).mediaId;
	const r = session.apply({
		label: 'p',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1' }, ref: '$v' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, seqId, mediaId, clipId: r.refs.$v! };
}

const base = (seqId: string): Omit<SoundCuesResponse, 'analysis' | 'engineCues'> => ({
	projectId: 'prj_x',
	sequenceId: seqId,
	revision: 1,
	frameRate: { num: 30, den: 1 },
	durationFrames: 300,
	density: 'rich',
	respectDialogue: true,
	cues: [],
	stats: {
		bySource: {},
		dropped: { rate: 0, gap: 0, maxCues: 0, confidence: 0, range: 0 },
		heroesDemoted: 0,
		found: 0,
		kept: 0,
	},
	warnings: [],
	dialogue: [],
	storedCues: 0,
});

describe('Suggest Cues… engine sources', () => {
	it('not analysed → Analyze… follows the job → the picture-motion cues are counted and suggested', async () => {
		const { session, seqId, mediaId, clipId } = footage();
		const anchor = { type: 'scene' as const, mediaId, mediaSec: 1.5, clipId };
		let analysed = false;
		const calls: SoundCuesRequest[] = [];
		const job: EngineJob = {
			id: 'job_motion',
			kind: 'motion-analysis',
			title: 'Picture motion analysis (10.0 s)',
			origin: { type: 'user' },
			state: 'running',
			progress: 0.4,
			createdAt: '2026-10-17T00:00:00.000Z',
			priority: 'user',
			cpuSlots: 2,
		} as EngineJob;
		const engine = {
			soundDesignCues: vi.fn(async (req: SoundCuesRequest): Promise<SoundCuesResponse> => {
				calls.push(req);
				const sources = req.opts?.sources ?? [];
				const state = (s: string) =>
					s === 'beat'
						? { state: 'none' as const, jobIds: [], found: 0 }
						: s === 'pixel'
							? analysed
								? { state: 'ready' as const, jobIds: [], found: 2 }
								: req.opts?.analyze === false
									? { state: 'missing' as const, jobIds: [], found: 0 }
									: { state: 'pending' as const, jobIds: ['job_motion'], found: 0 }
							: { state: 'ready' as const, jobIds: [], found: 0 };
				return {
					...base(seqId),
					analysis: Object.fromEntries(sources.map((s) => [s, state(s)])),
					engineCues:
						analysed && sources.includes('pixel')
							? [
									{
										key: 'pixel:move:a',
										frame: 45,
										kind: 'move',
										weight: 'support',
										types: ['whoosh', 'swish'],
										align: 'peak',
										anchor,
										confidence: 0.45,
										reason: 'Picture motion: Something moves right',
										window: { start: 31, end: 61 },
										from: 'pixel',
										size: 0.05,
									},
									{
										key: 'pixel:land:a',
										frame: 60,
										kind: 'land',
										weight: 'support',
										types: ['tap', 'thump'],
										align: 'peak',
										anchor: { ...anchor, mediaSec: 2 },
										confidence: 0.45,
										reason: 'Picture motion stops',
										from: 'pixel',
										size: 0.05,
									},
								]
							: [],
				};
			}),
			getJob: vi.fn(async () => {
				analysed = true;
				return { ...job, state: 'succeeded', progress: 1 } as EngineJob;
			}),
		};
		const close = vi.fn();
		render(
			<SessionProvider session={session}>
				<SuggestCuesDialog session={session} sequenceId={seqId} close={close} engine={engine as never} />
			</SessionProvider>,
		);
		// opening asks without starting anything
		await screen.findByText('Not analysed yet');
		expect(calls[0]!.opts).toMatchObject({ analyze: false, sources: ['scene', 'beat', 'pixel'] });
		expect(calls[0]!.projectId).toBe(session.projectId);
		const analyze = await screen.findByTestId('analyze-pixel');
		await act(async () => {
			fireEvent.click(analyze);
		});
		await waitFor(() => expect(engine.getJob).toHaveBeenCalled());
		expect(calls[1]!.opts).toMatchObject({ analyze: true, sources: ['pixel'] });
		await waitFor(() =>
			expect(document.querySelector('[data-cue-source-count="pixel"]')?.textContent).toBe('2 found · 0 kept'),
		);
		// tick it: counted, and Suggest adds them (one undo step), anchored to the footage
		const row = document.querySelector('[data-cue-source="pixel"]')!;
		await act(async () => {
			fireEvent.click(row.querySelector('button[role="checkbox"]')!);
		});
		await waitFor(() =>
			expect(document.querySelector('[data-cue-source-count="pixel"]')?.textContent).toBe('2 found · 2 kept'),
		);
		const n = session.getState().history.entries.length;
		fireEvent.click(await screen.findByRole('button', { name: 'Suggest 2 Cues' }));
		const cues = soundCuesOf(session.getCommitted().sequences[seqId] as Sequence);
		expect(cues.map((c) => [c.kind, c.frame, c.anchor?.type])).toEqual([
			['move', 45, 'scene'],
			['land', 60, 'scene'],
		]);
		expect(session.getState().history.entries).toHaveLength(n + 1);
	});

	it('an engine error leaves the edit sources usable', async () => {
		const { session, seqId } = footage();
		const engine = {
			soundDesignCues: vi.fn(async () => {
				throw new Error('offline');
			}),
			getJob: vi.fn(),
		};
		render(
			<SessionProvider session={session}>
				<SuggestCuesDialog session={session} sequenceId={seqId} close={vi.fn()} engine={engine as never} />
			</SessionProvider>,
		);
		await screen.findByTestId('suggest-cues-engine-sources-error');
		expect(screen.getAllByText('Analysis failed').length).toBe(3);
		expect(document.querySelector('[data-cue-source="edits"]')).not.toBeNull();
	});

	it('planSuggestion: snap to the beat moves a measured move onto a beat frame', () => {
		const { session, seqId, mediaId, clipId } = footage();
		const anchor = { type: 'scene' as const, mediaId, mediaSec: 1.5, clipId };
		const move = {
			key: 'pixel:m',
			frame: 45,
			kind: 'move' as const,
			weight: 'support' as const,
			types: ['whoosh' as const],
			align: 'peak' as const,
			anchor,
			confidence: 0.45,
			reason: 'Picture motion',
			from: 'pixel' as const,
			size: 0.1,
		};
		const beat = {
			key: 'beat:b',
			frame: 47,
			kind: 'beat' as const,
			weight: 'ambient' as const,
			types: ['tick' as const],
			align: 'peak' as const,
			anchor: { type: 'clip' as const, clipId, edge: 'start' as const },
			confidence: 0.25,
			reason: 'Beat',
			from: 'beat' as const,
			size: 1,
		};
		const opts = {
			sources: new Set<never>(),
			engineSources: new Set(['pixel'] as const),
			engineCues: [move, beat],
			range: 'sequence' as const,
			density: 'rich' as const,
			respectDialogue: true,
			replace: true,
		};
		expect(planSuggestion(session.getCommitted(), seqId, opts).adds.map((c) => c.frame)).toEqual([45]);
		const snapped = planSuggestion(session.getCommitted(), seqId, { ...opts, snapToBeats: true });
		expect(snapped.adds.map((c) => [c.frame, c.anchorOffset])).toEqual([[47, 2]]);
		expect(snapped.found.pixel).toBe(1);
		expect(snapped.kept.beat).toBe(0);
	});
});
