// Reference sound profiles in the editor (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"), on a real session with a fake
// engine: the pure model (candidates, paths, the request, the select's options, row texts); Preferences ▸ Sound Library
// ▸ Reference profiles (list, Rename with Enter, Export downloads the file, Delete asks first, Import a file, a damaged
// file reported); the New Reference Profile dialog (media and sequences picked, the job's progress, what was measured
// and skipped); the Sound Check header's select (one History entry, undo; New… selects the new profile) and the
// Reference rows (differences first, every metric on demand, advice, translated).
import type { EngineJob, SoundCheckReference, SoundProfileBuildRequest, SoundProfileSummary } from '@jasper/api';
import { soundDesignSettingsOf } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../src/i18n/runtime.ts';
import {
	buildRequest,
	NEW_PROFILE,
	NO_PROFILE,
	parsePaths,
	profileFileName,
	profileOptions,
	referenceCandidates,
	rowRange,
	rowValue,
	selectedProfile,
} from '../src/sound/profile-model.ts';
import { ReferenceProfilesSection, ReferenceRows, ReferenceSelect } from '../src/sound/ReferenceProfiles.tsx';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: 'connected', subscribe: () => () => {}, capabilities: null }),
	useEngineOrNull: () => ({ client: mocks.client, status: 'connected', subscribe: () => () => {} }),
	useCapabilities: () => ({ capabilities: null, flags: new Set(['engine']) }),
}));
const downloads: { name: string; text: string }[] = [];
vi.mock('../src/panels/text/state.ts', async (orig) => ({
	...((await orig()) as Record<string, unknown>),
	downloadBytes: (bytes: Uint8Array, name: string) => downloads.push({ name, text: new TextDecoder().decode(bytes) }),
}));

const P1 = 'sprf_0000000000000001';
const P2 = 'sprf_0000000000000002';
const summary = (id: string, name: string, n = 3): SoundProfileSummary => ({
	id,
	name,
	n,
	createdAt: '2026-10-18T10:00:00.000Z',
	updatedAt: '2026-10-18T10:00:00.000Z',
	references: Array.from({ length: n }, (_, i) => ({
		id: `ref_${i + 1}`,
		title: `Film ${i + 1}.mp4`,
		kind: 'media' as const,
		durationSec: 60,
		hasPicture: true,
	})),
	warnings: [],
});

function fakeEngine() {
	let profiles = [summary(P1, 'My channel'), summary(P2, 'Launch films', 5)];
	const calls: { kind: string; arg?: unknown }[] = [];
	const job = (state: EngineJob['state'], extra: Partial<EngineJob> = {}): EngineJob => ({
		id: 'job_p',
		kind: 'sound-profile',
		title: 'Reference profile',
		origin: { type: 'user' },
		state,
		progress: state === 'succeeded' ? 1 : 0.5,
		stage: state === 'running' ? '1 of 2: Film 1.mp4 — Measuring' : undefined,
		createdAt: '2026-10-18T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 2,
		...extra,
	});
	let polls = 0;
	const client = {
		async listSoundProfiles() {
			calls.push({ kind: 'list' });
			return { profiles, unreadable: [{ file: 'sprf_00000000000000bb.json', error: 'not JSON' }], paths: true };
		},
		async getSoundProfile(id: string) {
			calls.push({ kind: 'get', arg: id });
			return { format: 'jasper-sound-profile', version: 1, id, name: 'My channel', references: [] };
		},
		async renameSoundProfile(id: string, name: string) {
			calls.push({ kind: 'rename', arg: { id, name } });
			profiles = profiles.map((p) => (p.id === id ? { ...p, name } : p));
			return profiles.find((p) => p.id === id)!;
		},
		async deleteSoundProfile(id: string) {
			calls.push({ kind: 'delete', arg: id });
			profiles = profiles.filter((p) => p.id !== id);
			return { deleted: true, id };
		},
		async importSoundProfile(req: { profile: unknown }) {
			calls.push({ kind: 'import', arg: req });
			const p = summary('sprf_0000000000000003', 'Shared');
			profiles = [...profiles, p];
			return p;
		},
		async buildSoundProfile(req: SoundProfileBuildRequest) {
			calls.push({ kind: 'build', arg: req });
			return job('running');
		},
		async getJob() {
			polls++;
			if (polls < 2) return job('running');
			const p = summary('sprf_0000000000000004', 'New one', 2);
			profiles = [...profiles, p];
			return job('succeeded', {
				result: {
					profile: p,
					skipped: [{ title: 'short.wav', reason: 'it is shorter than 3 s (1.00 s)' }],
					warnings: ['only 2 reference(s): the ranges are too narrow to judge by; use 5 or more'],
					timings: {},
				},
			});
		},
		async cancelJob() {
			calls.push({ kind: 'cancel' });
			return job('cancelled');
		},
	};
	return { client, calls };
}

function fixture() {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: { ...audioAsset(30), originalName: 'Episode 1.wav' }, ref: '$a' },
			{ type: 'media.register', asset: { ...audioAsset(1), originalName: 'blip.wav' }, ref: '$b' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const engine = fakeEngine();
	mocks.client = engine.client;
	return { session, seqId, engine, mediaId: r.refs.$a! };
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
	toasts.dismissAll();
	downloads.length = 0;
});
afterEach(async () => {
	cleanup();
	closeAllDialogs();
	await setLanguage('en');
});

describe('profile model', () => {
	it('candidates, paths, the request, the options, row texts', () => {
		const { session, mediaId, seqId } = fixture();
		const c = referenceCandidates(session.getCommitted());
		// the 1 s blip is too short to be a reference
		expect(c.media.map((m) => m.mediaId)).toEqual([mediaId]);
		expect(c.media[0]).toMatchObject({ seconds: 30, hasPicture: false });
		expect(c.sequences.map((s) => s.sequenceId)).toEqual([seqId]);
		expect(parsePaths(' /a/b.mp4\n\nrel.mp4\nC:\\films\\x.mov ')).toEqual({
			paths: ['/a/b.mp4', 'C:\\films\\x.mov'],
			bad: ['rel.mp4'],
		});
		expect(buildRequest({ name: ' ', projectId: 'p', mediaIds: ['m'], sequenceIds: [], paths: [] })).toMatchObject({
			ok: false,
		});
		expect(buildRequest({ name: 'x', projectId: 'p', mediaIds: [], sequenceIds: [], paths: [] })).toMatchObject({
			ok: false,
			why: 'Choose at least one reference',
		});
		expect(
			buildRequest({ name: 'Mine', projectId: 'p', mediaIds: ['m'], sequenceIds: ['s'], paths: ['/x.mp4'] }),
		).toEqual({
			ok: true,
			request: { name: 'Mine', projectId: 'p', mediaIds: ['m'], sequenceIds: ['s'], paths: ['/x.mp4'] },
		});
		expect(buildRequest({ name: 'x', projectId: null, mediaIds: [], sequenceIds: [], paths: ['/x'] })).toEqual({
			ok: true,
			request: { name: 'x', paths: ['/x'] },
		});
		const opts = profileOptions([summary(P1, 'Mine')], 'sprf_00000000000000ff');
		expect(opts.map((o) => o.value)).toEqual([NO_PROFILE, P1, 'sprf_00000000000000ff', NEW_PROFILE]);
		expect(opts[2]!.label).toMatch(/Missing profile/);
		expect(rowValue('band_air', -19.5)).toBe('−19.5 dB');
		expect(rowValue('cuts_with_sound', 0.8)).toBe('80 %');
		expect(rowRange({ metric: 'band_air', range: [-22.5, -17.5], basis: 'references' })).toBe('−22.5 dB … −17.5 dB');
		expect(rowRange({ metric: 'cuts_with_sound', range: [0.75, null], basis: 'references' })).toBe('≥ 75 %');
		expect(rowRange({ metric: 'end_silence_s', range: [null, 0.3], basis: 'references' })).toBe('≤ 0.30 s');
		expect(profileFileName('My channel / 2026')).toBe('My_channel_2026.sound-profile.json');
	});
});

describe('Preferences ▸ Sound Library ▸ Reference profiles', () => {
	it('lists, renames, exports, deletes after asking, imports; the dialog builds a profile', async () => {
		const { session, engine, mediaId } = fixture();
		render(
			<SessionProvider session={session}>
				<ReferenceProfilesSection session={session} />
				<DialogHost />
			</SessionProvider>,
		);
		await screen.findByText('My channel');
		expect(screen.getByText('Launch films')).toBeTruthy();
		expect(screen.getByText(/5 references: Film 1\.mp4, Film 2\.mp4/)).toBeTruthy();
		expect(screen.getByText(/1 damaged profile file\(s\) were moved aside: sprf_00000000000000bb\.json \(not JSON\)/)).toBeTruthy();
		// rename: Enter commits
		fireEvent.click(screen.getByTestId(`sound-profile-rename-${P1}`));
		const field = screen.getByTestId(`sound-profile-name-${P1}`) as HTMLInputElement;
		fireEvent.change(field, { target: { value: 'Our channel' } });
		fireEvent.keyDown(field, { key: 'Enter' });
		await screen.findByText('Our channel');
		expect(engine.calls.find((c) => c.kind === 'rename')?.arg).toEqual({ id: P1, name: 'Our channel' });
		// export: the profile file, downloaded
		fireEvent.click(screen.getByTestId(`sound-profile-export-${P1}`));
		await waitFor(() => expect(downloads).toHaveLength(1));
		expect(downloads[0]!.name).toBe('Our_channel.sound-profile.json');
		expect(JSON.parse(downloads[0]!.text)).toMatchObject({ format: 'jasper-sound-profile', id: P1 });
		// delete asks first; cancel keeps it
		fireEvent.click(screen.getByTestId(`sound-profile-delete-${P2}`));
		const confirm = await screen.findByTestId('confirm-dialog');
		expect(within(confirm).getByText(/building it again needs its 5 references/)).toBeTruthy();
		fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
		await settle();
		expect(engine.calls.some((c) => c.kind === 'delete')).toBe(false);
		fireEvent.click(screen.getByTestId(`sound-profile-delete-${P2}`));
		fireEvent.click(within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: 'Delete Profile' }));
		await waitFor(() => expect(screen.queryByText('Launch films')).toBeNull());
		// import a file
		const file = new File([JSON.stringify({ format: 'jasper-sound-profile' })], 'shared.json', {
			type: 'application/json',
		});
		fireEvent.change(screen.getByTestId('sound-profiles-import-file'), { target: { files: [file] } });
		await screen.findByText('Shared');
		const junk = new File(['not json'], 'junk.json', { type: 'application/json' });
		fireEvent.change(screen.getByTestId('sound-profiles-import-file'), { target: { files: [junk] } });
		await waitFor(() =>
			expect(JSON.stringify(toasts.getState())).toMatch(/The profile was not imported/),
		);
		// New Reference Profile…: name and media, the job's progress, what was measured and skipped
		fireEvent.click(screen.getByTestId('sound-profiles-new'));
		const dialog = await screen.findByTestId('new-reference-profile-dialog');
		expect(within(dialog).getByTestId('new-reference-profile-why').textContent).toBe('Give the profile a name');
		fireEvent.change(within(dialog).getByTestId('new-reference-profile-name'), { target: { value: 'New one' } });
		fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Episode 1.wav' }));
		fireEvent.change(within(dialog).getByTestId('new-reference-profile-paths'), {
			target: { value: '/films/a.mp4\nrelative.mp4' },
		});
		expect(within(dialog).getByRole('alert').textContent).toMatch(/Not absolute, left out: relative\.mp4/);
		fireEvent.click(within(dialog).getByRole('button', { name: 'Build Profile' }));
		await within(dialog).findByTestId('new-reference-profile-result');
		expect(engine.calls.find((c) => c.kind === 'build')?.arg).toEqual({
			name: 'New one',
			projectId: session.projectId,
			mediaIds: [mediaId],
			paths: ['/films/a.mp4'],
		});
		expect(within(dialog).getByText('“New one”: 2 references measured.')).toBeTruthy();
		expect(within(dialog).getByText(/Skipped short\.wav: it is shorter than 3 s/)).toBeTruthy();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
		await screen.findByText('New one');
	});
});

describe('Sound Check: Reference select and rows', () => {
	it('selects the sequence’s profile in one undo step; the rows show differences, then all, translated', async () => {
		const { session, seqId } = fixture();
		render(
			<SessionProvider session={session}>
				<ReferenceSelect session={session} sequenceId={seqId} disabled={false} readOnly={false} />
				<DialogHost />
			</SessionProvider>,
		);
		const trigger = within(await screen.findByTestId('sound-check-reference')).getByRole('combobox', {
			name: 'Compare with reference',
		});
		await settle();
		await act(async () => {
			fireEvent.keyDown(trigger, { key: 'Enter' });
		});
		await act(async () => {
			fireEvent.keyDown(await screen.findByRole('option', { name: 'My channel (3 references)' }), { key: 'Enter' });
		});
		await waitFor(() => expect(selectedProfile(session.getCommitted(), seqId)).toBe(P1));
		const labels = session.getState().history.entries.map((e) => e.label);
		expect(labels.at(-1)).toBe('Compare with Reference Profile');
		act(() => session.undo());
		expect(soundDesignSettingsOf(session.getCommitted().sequences[seqId]!).referenceProfile).toBeUndefined();
		cleanup();

		const reference: SoundCheckReference = {
			profileId: P1,
			name: 'My channel',
			n: 3,
			scoredAgainst: 3,
			leaveOneOut: null,
			source: 'sequence',
			counts: { ok: 1, low: 1, high: 0, na: 0, scored: 2 },
			wholeSequence: true,
			arc: { value: null, median: null, p10: null, p90: null },
			rows: [
				{
					metric: 'band_air',
					group: 'spectrum',
					label: 'Air 8–16 kHz share',
					unit: 'dB',
					decimals: 1,
					value: -26,
					range: [-22.5, -17.5],
					typical: [-21, -19],
					median: -20,
					n: 3,
					status: 'low',
					weight: 'minor',
					basis: 'references',
					why: 'Openness: missing air sounds muffled or low-bitrate.',
					issueId: 'REFERENCE:band_air',
					advice: [
						{
							key: 'No air: it sounds muffled or low-bitrate; use full-band recordings (44.1 or 48 kHz, no low-pass).',
							params: [],
							text: 'No air: it sounds muffled or low-bitrate; use full-band recordings (44.1 or 48 kHz, no low-pass).',
						},
					],
				},
				{
					metric: 'lra',
					group: 'loudness',
					label: 'Loudness range',
					unit: 'LU',
					decimals: 1,
					value: 5,
					range: [3, 7],
					typical: [4, 6],
					median: 5,
					n: 3,
					status: 'ok',
					weight: 'major',
					basis: 'references',
					why: 'How much the loudness swings between quiet and loud passages.',
				},
			],
		};
		const shown: string[] = [];
		const view = render(<ReferenceRows reference={reference} onShow={(id) => shown.push(id)} />);
		expect(screen.getByTestId('sound-check-reference-heading').textContent).toBe(
			'My channel: 1 of 2 scored metrics differ',
		);
		const rows = () => [...view.container.querySelectorAll('[data-reference-metric]')].map((r) => r.getAttribute('data-reference-metric'));
		expect(rows()).toEqual(['band_air']);
		expect(screen.getByText(/No air: it sounds muffled/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Low' }));
		expect(shown).toEqual(['REFERENCE:band_air']);
		fireEvent.click(screen.getByTestId('sound-check-reference-all'));
		expect(rows()).toEqual(['band_air', 'lra']);
		cleanup();
		await setLanguage('es');
		render(<ReferenceRows reference={reference} />);
		expect(screen.getByTestId('sound-check-reference-heading').textContent).toMatch(/^My channel: 1 de 2/);
		expect(screen.queryByText('Air 8–16 kHz share')).toBeNull();
		expect(screen.queryByText(/^No air/)).toBeNull();
	});
});
