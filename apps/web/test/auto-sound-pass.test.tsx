// Sequence ▸ Sound Design ▸ Auto Sound Pass… (WP3.3b, spec 12 §2.7 "Review", P3-R3 style options): cue sources with
// "found · kept" counts, sound sources with their library counts, palette / kit, density, respect dialogue; the only
// button is Propose: it runs the plan route (job progress shown), opens review on the proposal it stores, applies
// nothing; "nothing to propose" keeps the dialog open with the reason; closing it while the job runs cancels the job.
import type { SoundDesignPlanRequest } from '@jasper/api';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { AutoSoundPassDialog, autoPassRequest, NO_MIX } from '../src/sound/AutoSoundPassDialog.tsx';
import { fakePlanEngine, planResult, storeProposal } from './review-helpers.ts';
import { fakeSoundEngine, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(() => cleanup());

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
	await act(async () => {
		fireEvent.keyDown(trigger, { key: 'Enter' });
	});
	const option = await screen.findByRole('option', { name });
	await act(async () => {
		fireEvent.keyDown(option, { key: 'Enter' });
	});
}

function setup(
	build?: (
		req: SoundDesignPlanRequest,
		proposals: FakeEngine,
	) => ReturnType<Parameters<typeof fakePlanEngine>[1]>,
	runningPolls?: number,
) {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 1, 0, 1] },
			{ type: 'clip.addSolid', at: 120, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
			{ type: 'marker.add', frame: 150, name: 'sfx: boom' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const proposals = new FakeEngine(() => session);
	const c = proposalsFor(session, { engine: proposals });
	const entries = [soundEntry({ title: 'Crunch' }), soundEntry({ title: 'Thud' })];
	const sounds = fakeSoundEngine(entries);
	let stored = '';
	const plan = fakePlanEngine(
		session,
		(build && ((req) => build(req, proposals))) ??
			((req) => {
				stored = storeProposal(proposals, seqId, 'Sound design: Seq', [60, 120, 150]).id;
				return planResult({ proposalId: stored, projectId: req.projectId, sequenceId: seqId, placed: 3 });
			}),
		runningPolls,
	);
	const engine = { ...sounds.client, ...plan };
	const closed: unknown[] = [];
	const reviewed: number[] = [];
	const toasts: string[] = [];
	render(
		<SessionProvider session={session}>
			<AutoSoundPassDialog
				session={session}
				engine={engine as never}
				sequenceId={seqId}
				close={(x) => closed.push(x)}
				toast={(t) => toasts.push(t.message)}
				onReview={() => reviewed.push(1)}
			/>
		</SessionProvider>,
	);
	return { session, seqId, c, plan, closed, reviewed, toasts, stored: () => stored, entries };
}

describe('Auto Sound Pass… dialog', () => {
	it('shows cue sources with counts and sound sources with library counts; Propose sends the choices and opens review', async () => {
		const t = setup();
		const dialog = await screen.findByTestId('auto-sound-pass-dialog');
		await settle();
		const edits = dialog.querySelector('[data-cue-source-count="edits"]')!;
		expect(edits.textContent).toBe('2 found · 2 kept');
		expect(dialog.querySelector('[data-cue-source-count="markers"]')!.textContent).toBe('1 found · 1 kept');
		expect(within(screen.getByTestId('auto-pass-sound-sources')).getByText('2 sounds')).toBeTruthy();
		expect(within(dialog).queryByRole('button', { name: /Apply/ })).toBeNull();
		// untick a cue source and a sound source; prefer the starter kit
		fireEvent.click(within(dialog.querySelector('[data-cue-source="markers"]')!).getByRole('checkbox'));
		fireEvent.click(within(dialog.querySelector('[data-sound-source="synth"]')!).getByRole('checkbox'));
		await chooseOption(screen.getByRole('combobox', { name: 'Palette / kit' }), 'Prefer Starter kit');
		const rev = t.session.revision;
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
		});
		await waitFor(() => expect(t.closed).toHaveLength(1), { timeout: 5000 });
		const req = t.plan.requests[0]!;
		expect(req).toMatchObject({
			projectId: t.session.projectId,
			sequenceId: t.seqId,
			cues: 'auto',
			style: { density: 'balanced', respectDialogue: true, sources: ['starter', 'pack', 'folder'] },
		});
		expect(req.style?.cueSources).toEqual([
			'edits',
			'transitions',
			'keyframes',
			'text',
			'mg',
			'clipEdges',
			'camera3d',
		]);
		expect(req.style?.palette).toEqual(t.entries.map((e) => e.id));
		expect(req.range).toBeUndefined();
		// nothing applied; review is on the new proposal
		expect(t.session.revision).toBe(rev);
		expect(t.c.getState().activeId).toBe(t.stored());
		expect(t.reviewed).toEqual([1]);
		t.c.exit();
	});

	it('nothing to propose: the reason is shown and the dialog stays open', async () => {
		const t = setup((req) =>
			planResult({
				proposalId: null,
				projectId: req.projectId,
				sequenceId: req.sequenceId!,
				skipped: [{ cueId: 'c1', frame: 60, reason: 'no commercial-safe sound of type hit' }],
			}),
		);
		const dialog = await screen.findByTestId('auto-sound-pass-dialog');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
		});
		await waitFor(
			() =>
				expect(screen.getByTestId('auto-pass-summary').textContent).toMatch(
					/^Nothing to propose\. 1 cue skipped/,
				),
			{ timeout: 5000 },
		);
		expect(t.closed).toEqual([]);
		expect(t.c.getState().activeId).toBeNull();
	});

	it('a plan with warnings or conflicts: review opens and the dialog lists them until Close', async () => {
		const t = setup((req, proposals) => {
			const stored = storeProposal(proposals, req.sequenceId!, 'Sound design: Seq', [150]).id;
			const r = planResult({
				proposalId: stored,
				projectId: req.projectId,
				sequenceId: req.sequenceId!,
				placed: 1,
			});
			return {
				...r,
				report: {
					...r.report,
					// (the model test names a conflict by its item's sound and cue time; a valid event is long to build)
					warnings: [
						{
							code: 'W_DIALOGUE_BAND',
							message:
								'clp_9: during speech its dominant band (2000 Hz) is in 1–4 kHz; prefer a type whose dominant band is outside 1–4 kHz (here: boom)',
						},
					],
					conflicts: [
						{ clipId: 'clp_9', itemId: 'place:001', kept: 'consistency', lost: 'dialogue', message: 'x' },
					],
				},
			};
		});
		const dialog = await screen.findByTestId('auto-sound-pass-dialog');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
		});
		const notes = await screen.findByTestId('auto-pass-notes', undefined, { timeout: 5000 });
		expect(notes.textContent).toContain('Plan notes: 1 conflict · 1 warning');
		const items = within(screen.getByTestId('auto-pass-notes-list')).getAllByRole('listitem');
		expect(items).toHaveLength(2);
		expect(items[0]!.textContent).toContain('1–4 kHz');
		expect(items[0]!.textContent).toContain('boom');
		expect(items[1]!.textContent).toContain('±2 dB');
		expect(t.reviewed).toEqual([1]);
		expect(t.closed).toEqual([]);
		await act(async () => {
			const primary = within(dialog).getByRole('button', { name: 'Close', exact: true });
			// WP6.5a: Close alone once the proposal is made
			expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
			fireEvent.click(primary);
		});
		await waitFor(() => expect(t.closed).toHaveLength(1));
		t.c.exit();
	});

	it('closing it while the job runs cancels the job (and leaves no review)', async () => {
		// the job runs until it is cancelled (a loaded host must not let it finish before the click)
		const t = setup(undefined, Number.POSITIVE_INFINITY);
		const dialog = await screen.findByTestId('auto-sound-pass-dialog');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
		});
		await waitFor(() => expect(t.plan.requests).toHaveLength(1));
		expect(screen.getByTestId('auto-pass-progress')).toBeTruthy();
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		});
		await waitFor(() => expect(t.plan.cancelled).toEqual(['job_1']), { timeout: 5000 });
		expect(t.c.getState().activeId).toBeNull();
	});

	it('the request: a range only when not the whole sequence; every source on = the defaults', () => {
		const { session, seqId } = makeSession();
		const all = autoPassRequest(
			session,
			seqId,
			{
				range: 'sequence',
				cueSources: new Set([
					'edits',
					'transitions',
					'keyframes',
					'text',
					'mg',
					'clipEdges',
					'camera3d',
					'markers',
				]),
				density: 'rich',
				palette: 'project',
				soundSources: new Set(['starter', 'pack', 'folder', 'synth']),
				respectDialogue: false,
			},
			{ start: 0, end: 100 },
			null,
		) as SoundDesignPlanRequest;
		expect(all).toEqual({
			projectId: session.projectId,
			sequenceId: seqId,
			cues: 'auto',
			style: { density: 'rich', respectDialogue: false, palette: 'project' },
		});
		const io = autoPassRequest(
			session,
			seqId,
			{
				range: 'inout',
				cueSources: new Set(['edits']),
				density: 'sparse',
				palette: 'none',
				soundSources: new Set(['synth']),
				respectDialogue: true,
			},
			{ start: 10, end: 50 },
			null,
		);
		expect(io).toMatchObject({
			range: { start: 10, end: 50 },
			style: { cueSources: ['edits'], sources: ['synth'], palette: [] },
		});
	});

	it('Phase 4 mix options: room glue with its send level, stop before / build into heroes, a delivery preset', async () => {
		const t = setup();
		const dialog = await screen.findByTestId('auto-sound-pass-dialog');
		await settle();
		const mix = screen.getByTestId('auto-pass-mix');
		const room = within(mix).getByRole('checkbox', { name: /Room glue/ });
		const slider = within(screen.getByTestId('auto-pass-room')).getByRole('slider');
		expect(slider.getAttribute('data-disabled')).not.toBeNull();
		fireEvent.click(room);
		await act(async () => {
			fireEvent.keyDown(within(screen.getByTestId('auto-pass-room')).getByRole('slider'), {
				key: 'ArrowRight',
			});
		});
		fireEvent.click(within(mix).getByRole('checkbox', { name: /Stop before heroes/ }));
		fireEvent.click(within(mix).getByRole('checkbox', { name: /Build into heroes/ }));
		await chooseOption(
			screen.getByRole('combobox', { name: 'Delivery' }),
			'Web / streaming · −14 LUFS · −1 dBTP',
		);
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
		});
		await waitFor(() => expect(t.closed).toHaveLength(1), { timeout: 5000 });
		expect(t.plan.requests[0]!.style).toMatchObject({
			roomGlue: { sendDb: -15.5 },
			stopBefore: true,
			build: true,
			delivery: 'web',
		});
		t.c.exit();
	});

	it('the mix options stay out of the request when off', () => {
		const { session, seqId } = makeSession();
		const base = {
			range: 'sequence' as const,
			cueSources: new Set<never>(),
			density: 'balanced' as const,
			palette: 'none' as const,
			soundSources: new Set<never>(),
			respectDialogue: true,
		};
		const off = autoPassRequest(session, seqId, { ...base, mix: NO_MIX }, null, null).style!;
		for (const k of ['roomGlue', 'stopBefore', 'build', 'delivery']) expect(off).not.toHaveProperty(k);
		const on = autoPassRequest(
			session,
			seqId,
			{ ...base, mix: { roomGlue: -20, stopBefore: true, build: false, delivery: 'podcast' } },
			null,
			null,
		).style!;
		expect(on).toMatchObject({ roomGlue: { sendDb: -20 }, stopBefore: true, delivery: 'podcast' });
		expect(on).not.toHaveProperty('build');
	});
});
