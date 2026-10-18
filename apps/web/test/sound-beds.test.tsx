// Ambience beds and room tone in the editor (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): Sequence ▸ Sound Design ▸
// Lay Ambience Bed… (the library's ambiences, the measured scenes with their loop lines, a scene's own bed, joining a
// scene to the one before, Lay Beds in apply mode as ONE History entry with Undo, Propose for Review in propose mode)
// and Fill Room Tone (enabled only with a gap between dialogue clips; apply mode; the toast names the tone and its
// distance to the floor), the menu entries, and `editedScenes`.
import type { SoundBedsPlan, SoundBedsRequest, SoundRoomToneRequest } from '@jasper/api';
import type { Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, openDialog, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { registerAllCommands } from '../src/commands/index.ts';
import { getCommand, isCommandEnabled, runCommand } from '../src/commands/registry.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { editedScenes } from '../src/sound/AmbienceBedDialog.tsx';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => toasts.dismissAll());
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

const FOREST = 'snd_00000000000f0001';
const CAFE = 'snd_00000000000f0002';
const TONE = 'snd_00000000000f0003';

const scene = (start: number, end: number, reason: 'start' | 'edit' | 'marker', title = 'Forest') => ({
	start,
	end,
	timecode: `00:00:0${Math.floor(start / 30)}:00`,
	endTimecode: `00:00:0${Math.floor(end / 30)}:00`,
	reason,
	label: '',
	sound: {
		soundId: title === 'Forest' ? FOREST : CAFE,
		mediaId: '$bed0',
		title,
		loudnessLufs: -28,
		window: { startSec: 0.05, endSec: 4.05, levelDb: -30, levelStdDb: 0.9, onsetsPerMin: 0, spikes: 0, clean: true, whole: false },
		loop: {
			inSec: 0.15,
			outSec: 3.983,
			crossfadeSec: 1.5,
			fade: 'equal-power' as const,
			levelDiffDb: 0,
			spectralDistanceDb: 0.2,
			correlation: 0,
			midpointDb: 0,
		},
	},
	gainDb: -2.1,
});

function fixture(opts: { dialogueGap?: boolean } = {}) {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: audioAsset(20), ref: '$a' },
			{ type: 'clip.place', source: { mediaId: '$a' }, at: 0, tracks: { audio: 'A1' }, ref: '$x' },
			...(opts.dialogueGap
				? [
						{ type: 'clip.trim', clipId: '$x', edge: 'out', deltaFrames: -480 },
						{ type: 'clip.place', source: { mediaId: '$a' }, at: 150, tracks: { audio: 'A1' }, ref: '$y' },
						{ type: 'essentialSound.setType', clipIds: ['$x', '$y'], audioType: 'dialogue' },
					]
				: []),
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const amb = r.refs.$a!;
	const plans: SoundBedsRequest[] = [];
	const lays: SoundBedsRequest[] = [];
	const fills: SoundRoomToneRequest[] = [];
	const plan = (): SoundBedsPlan => ({
		sequenceId: seqId,
		purpose: 'ambience',
		scenes: [scene(0, 200, 'start'), scene(200, 400, 'edit'), scene(400, 600, 'marker')],
		commands: [{ type: 'soundDesign.layBed' }],
		warnings: [],
		sources: ['edits', 'markers'],
	});
	const job = (result: unknown) => ({
		id: 'job_1',
		kind: 'sound-design',
		state: 'succeeded',
		progress: 1,
		title: 'x',
		result,
	});
	const client = {
		searchSounds: async () => ({
			results: [
				{ sound: { id: FOREST, title: 'Forest', types: ['ambience'] } },
				{ sound: { id: CAFE, title: 'Café', types: ['ambience'] } },
				{ sound: { id: TONE, title: 'Room tone', types: ['roomtone', 'ambience'] } },
			],
		}),
		planAmbienceBeds: async (req: SoundBedsRequest) => {
			plans.push(req);
			return plan();
		},
		layAmbienceBeds: async (req: SoundBedsRequest) => {
			lays.push(req);
			let revision = session.revision;
			if (req.mode === 'apply') {
				// the engine relays ONE transaction into the session as the user's own edit
				const t = session.apply({
					label: 'Lay Ambience Bed',
					origin: 'user',
					sequenceId: seqId,
					commands: [
						{ type: 'soundDesign.layBed', range: { start: 0, end: 600 }, mediaId: amb, loop: { inSec: 0.15, outSec: 4 } },
					] as never[],
				});
				if (!t.ok) throw new Error(JSON.stringify(t.errors));
				revision = session.revision;
			}
			return job({
				projectId: session.projectId,
				sequenceId: seqId,
				mode: req.mode,
				applied: req.mode === 'apply',
				revision,
				proposalId: req.mode === 'propose' ? 'prp_0000000000000001' : null,
				plan: plan(),
			});
		},
		fillRoomTone: async (req: SoundRoomToneRequest) => {
			fills.push(req);
			const t = session.apply({
				label: 'Fill Room Tone',
				origin: 'user',
				sequenceId: seqId,
				commands: [
					{ type: 'soundDesign.layBed', purpose: 'roomtone', shots: [{ start: 82, end: 158 }], mediaId: amb, gainDb: -7.8 },
				] as never[],
			});
			if (!t.ok) throw new Error(JSON.stringify(t.errors));
			return job({
				projectId: session.projectId,
				sequenceId: seqId,
				mode: 'apply',
				applied: true,
				revision: session.revision,
				proposalId: null,
				plan: {
					sequenceId: seqId,
					gaps: [{ start: 90, end: 150, timecode: '00:00:03:00', fill: { start: 82, end: 158 } }],
					floor: { levelDb: -52, bandsDb: [-60, -62, -64, -66, -68, -70, -72], clipIds: ['x'], seconds: 1 },
					candidates: [],
					chosen: {
						source: 'library',
						sound: { ...scene(0, 1, 'start').sound, soundId: TONE, title: 'Room tone pink' },
						distanceDb: 0.2,
						gainDb: -7.8,
						why: 'the closest',
					},
					commands: [],
					warnings: [],
				},
			});
		},
		getJob: async () => job(null),
		cancelJob: async () => undefined,
	};
	const ctx = createCommandContext({
		engine: client as never,
		session,
		focus: { panel: 'timeline', instanceId: 'x' },
		capabilities: ['engine'],
		openDialog: (kind, props) => void openDialog(kind, props),
	});
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	const view = () => (
		<SessionProvider session={session}>
			<DialogHost />
		</SessionProvider>
	);
	return { session, seqId, ctx, plans, lays, fills, seq, labels, view };
}

async function pick(combo: HTMLElement, option: string) {
	await act(async () => {
		fireEvent.keyDown(combo, { key: 'Enter' });
	});
	const o = await screen.findByRole('option', { name: option });
	await act(async () => {
		fireEvent.keyDown(o, { key: 'Enter' });
	});
}

describe('Sequence ▸ Sound Design: Lay Ambience Bed…, Fill Room Tone', () => {
	it('the menu lists them', () => {
		const sd = MENUBAR.find((m) => m.label === 'Sequence')!.items.find(
			(i) => i.type === 'submenu' && i.label === 'Sound Design',
		) as { items: { command?: string }[] };
		expect(sd.items.map((i) => i.command)).toEqual(expect.arrayContaining(['sound.layAmbienceBed', 'sound.fillRoomTone']));
	});

	it('Lay Ambience Bed…: the ambiences, the measured scenes, a scene’s own bed, a join, Lay Beds as one entry with Undo', async () => {
		const f = fixture();
		render(f.view());
		await act(async () => {
			await runCommand('sound.layAmbienceBed', f.ctx);
		});
		const dialog = await screen.findByTestId('ambience-bed-dialog');
		await waitFor(() => expect(within(dialog).getAllByTestId('ambience-bed-scene')).toHaveLength(3));
		// the default bed: the first library ambience (room tones are not offered)
		expect(f.plans[0]).toMatchObject({ soundId: FOREST, sources: ['edits', 'markers'], crossfadeSec: 1.5 });
		expect(f.plans[0]!.duckUnder).toBeUndefined(); // no dialogue in the sequence
		const rows = within(dialog).getAllByTestId('ambience-bed-scene');
		expect(rows[0]!.textContent).toContain('Start');
		expect(rows[1]!.textContent).toContain('Cut to other footage');
		expect(rows[2]!.textContent).toContain('Scene marker');
		expect(rows[0]!.textContent).toContain(
			'Loop 0.15–3.98 s of the clean window 0.05–4.05 s (±0.9 dB) · 1.5 s crossfade · -2.1 dB',
		);
		// scene 2 gets the café; scene 3 joins it
		await pick(within(rows[1]!).getByRole('combobox', { name: 'Bed of scene 2' }), 'Café');
		await act(async () => {
			fireEvent.click(within(rows[2]!).getByRole('checkbox', { name: 'Join the scene before' }));
		});
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Lay Beds' }));
		});
		await waitFor(() => expect(f.lays).toHaveLength(1));
		expect(f.lays[0]).toMatchObject({
			mode: 'apply',
			soundId: FOREST,
			scenes: [
				{ start: 0, end: 200 },
				{ start: 200, end: 600, soundId: CAFE },
			],
		});
		expect(f.labels().at(-1)).toBe('Lay Ambience Bed');
		const beds = () => Object.values(f.seq().clips).filter((c) => (c as { bed?: unknown }).bed);
		expect(beds().length).toBeGreaterThan(1);
		const tt = toasts.getState().toasts.find((x) => x.title === 'Laid ambience beds under 3 scenes')!;
		expect(tt).toBeDefined();
		act(() => tt.actions!.find((a) => a.label === 'Undo')!.run!());
		expect(beds()).toHaveLength(0);
	});

	it('Propose for Review sends the propose mode; the options change the plan', async () => {
		const f = fixture();
		render(f.view());
		await act(async () => {
			await runCommand('sound.layAmbienceBed', f.ctx);
		});
		const dialog = await screen.findByTestId('ambience-bed-dialog');
		await waitFor(() => expect(within(dialog).getAllByTestId('ambience-bed-scene')).toHaveLength(3));
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Shot changes (measured)' }));
		});
		await waitFor(() => expect(f.plans.at(-1)!.sources).toEqual(['edits', 'markers', 'shots']));
		await act(async () => {
			fireEvent.click(within(dialog).getByTestId('ambience-bed-propose'));
		});
		await waitFor(() => expect(f.lays).toHaveLength(1));
		expect(f.lays[0]).toMatchObject({ mode: 'propose', sources: ['edits', 'markers', 'shots'] });
		// nothing changed in the document
		expect(Object.values(f.seq().clips).filter((c) => (c as { bed?: unknown }).bed)).toHaveLength(0);
	});

	it('Fill Room Tone: needs a gap between dialogue clips; fills it in one entry; the toast names the tone', async () => {
		const none = fixture();
		expect(isCommandEnabled(getCommand('sound.fillRoomTone')!, none.ctx)).toBe(false);
		const f = fixture({ dialogueGap: true });
		expect(isCommandEnabled(getCommand('sound.fillRoomTone')!, f.ctx)).toBe(true);
		await act(async () => {
			await runCommand('sound.fillRoomTone', f.ctx);
		});
		expect(f.fills[0]).toMatchObject({ mode: 'apply', sequenceId: f.seqId });
		expect(f.labels().at(-1)).toBe('Fill Room Tone');
		const tt = toasts.getState().toasts.find((x) => x.title === 'Filled 1 dialogue gap with room tone')!;
		expect(tt.detail).toBe('"Room tone pink", 0.2 dB from the dialogue’s noise floor, at -7.8 dB');
	});

	it('editedScenes: joins go into the scene before, a scene’s own bed only when it differs', () => {
		const p = {
			sequenceId: 's',
			purpose: 'ambience' as const,
			scenes: [scene(0, 100, 'start'), scene(100, 200, 'edit'), scene(200, 300, 'edit'), scene(300, 400, 'edit')],
			commands: [],
			warnings: [],
			sources: [],
		};
		expect(
			editedScenes(
				p,
				[
					{ soundId: null, join: false },
					{ soundId: FOREST, join: false },
					{ soundId: CAFE, join: true },
					{ soundId: CAFE, join: false },
				],
				FOREST,
			),
		).toEqual([
			{ start: 0, end: 100 },
			{ start: 100, end: 300 },
			{ start: 300, end: 400, soundId: CAFE },
		]);
	});
});
