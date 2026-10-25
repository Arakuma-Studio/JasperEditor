// Describe-it search in the editor (spec 12 P6-E14, WP-E9): the Sound Library's Describe toggle sends the query as a
// description and says what the engine did with it (the model, or the words without it), described rows carry their
// match; Find Moment… lists a recording's moments, auditions a range and inserts one at the playhead as one undo
// step (or says the model is needed); Preferences ▸ Sound Library ▸ Describe-it search shows the licence before the
// download, follows it, shows a model whose location is pending as not available, and asks before removing.
import type { EngineJob, SoundEntry, SoundSearchRequest, SoundSemanticModel } from '@jasper/api';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/commands/registry.ts';
import { soundCommands } from '../src/commands/sound.ts';
import { AuditionPlayer } from '../src/sound/audition.ts';
import { registerSoundDialogs } from '../src/sound/dialogs.tsx';
import { SOUND_FIND_MOMENT_DIALOG } from '../src/sound/FindMomentDialog.tsx';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { fakeSoundEngine, mockAuditionPlayer, registeredPadded, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown, status: 'connected' }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	useEngineOrNull: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
}));

const { SoundLibraryPanel } = await import('../src/panels/soundLibrary/SoundLibraryPanel.tsx');
const { DescribeSearchSection } = await import('../src/sound/DescribeSearchSection.tsx');

const starts: unknown[][] = [];
beforeAll(() => {
	registerCommands(soundCommands);
	registerSoundDialogs();
});
let restoreAudition = () => {};
beforeEach(() => {
	localStorage.clear();
	soundLibraryPrefs.reload();
	starts.length = 0;
	const audio = {
		currentTime: 0,
		state: 'running',
		destination: {},
		resume: async () => {},
		close: async () => {},
		decodeAudioData: async () => ({ length: 48_000 * 30, numberOfChannels: 2, duration: 30 }),
		createBufferSource: () => ({
			connect() {},
			disconnect() {},
			start: (...a: unknown[]) => starts.push(a),
			stop() {},
			onended: null,
		}),
		createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1, setTargetAtTime() {} } }),
		createChannelSplitter: () => ({ connect() {}, disconnect() {} }),
		createAnalyser: () => ({ connect() {}, disconnect() {}, fftSize: 2048, getFloatTimeDomainData() {} }),
	};
	restoreAudition = mockAuditionPlayer(
		new AuditionPlayer({
			createContext: () => audio as never,
			fetchBytes: async () => new ArrayBuffer(4),
			raf: () => 0,
			cancelRaf: () => {},
		}),
	);
});
afterEach(() => {
	cleanup();
	closeAllDialogs();
	restoreAudition();
});

const job = (over: Partial<EngineJob> = {}): EngineJob =>
	({
		id: 'job_1',
		kind: 'sound-moment',
		state: 'succeeded',
		progress: 1,
		stage: 'Done',
		title: 'Find moment',
		priority: 'user',
		origin: { type: 'user' },
		createdAt: '2026-10-18T00:00:00.000Z',
		...over,
	}) as EngineJob;

const model = (over: Partial<SoundSemanticModel> = {}): SoundSemanticModel => ({
	id: 'clap-larger-general',
	name: 'CLAP (LAION larger_clap_general)',
	description: 'Finds sounds by what they sound like.',
	license: 'Apache-2.0',
	licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
	attribution: 'CLAP larger_clap_general by LAION',
	sourceUrl: 'https://huggingface.co/laion/larger_clap_general',
	revision: 'ada0c23a36c4e8582805bb38fec3905903f18b41',
	sizeBytes: 781_202_617,
	missingBytes: 777_699_276,
	installed: false,
	available: true,
	unavailableReason: null,
	job: null,
	...over,
});

/** The fake engine of the sound tests plus Describe-it search: `mode` decides what a described search answers. */
function describeEngine(
	entries: SoundEntry[],
	opts: { mode: 'semantic' | 'keywords'; momentsFail?: string },
) {
	const base = fakeSoundEngine(entries);
	const calls = {
		search: [] as SoundSearchRequest[],
		moments: [] as unknown[],
		install: [] as string[],
		remove: [] as string[],
	};
	let models = [
		model(),
		model({
			id: 'clap-int8',
			name: 'CLAP int8',
			available: false,
			unavailableReason: 'Not available yet: the model download location is pending',
		}),
	];
	const client = {
		...base.client,
		registerSound: async (id: string) => registeredPadded(entries.find((e) => e.id === id)!),
		searchSounds: async (req: SoundSearchRequest) => {
			calls.search.push(req);
			if (!req.describe) return base.client.searchSounds(req);
			if (opts.mode === 'keywords') {
				const r = await base.client.searchSounds({ ...req, q: req.describe });
				return {
					...r,
					describe: {
						mode: 'keywords' as const,
						reason: 'not installed',
						model: null,
						embedded: 0,
						pending: 2,
						jobId: null,
					},
				};
			}
			const r = await base.client.searchSounds({ ...req, describe: undefined });
			return {
				...r,
				results: r.results.map((x, i) => ({
					...x,
					match: {
						z: i === 0 ? 3.4 : 1.2,
						verdict: i === 0 ? ('strong' as const) : ('none' as const),
						cosine: 0.3,
					},
				})),
				describe: {
					mode: 'semantic' as const,
					reason: null,
					model: 'clap-larger-general',
					embedded: entries.length,
					pending: 0,
					jobId: null,
				},
			};
		},
		soundSemanticStatus: async () => ({
			status: models[0]!.installed ? ('ready' as const) : ('not-installed' as const),
			reason: null,
			model: models[0]!,
			total: 2,
			embedded: models[0]!.installed ? 1 : 0,
			job: null,
		}),
		soundSemanticModels: async () => ({ models }),
		installSoundSemanticModel: async (id: string) => {
			calls.install.push(id);
			models = models.map((m) => (m.id === id ? { ...m, installed: true, missingBytes: 0 } : m));
			return job({ kind: 'model-download', state: 'queued' });
		},
		removeSoundSemanticModel: async (id: string) => {
			calls.remove.push(id);
			models = models.map((m) => (m.id === id ? { ...m, installed: false } : m));
			return { modelId: id, freedBytes: 1, removedEmbeddings: 2 };
		},
		embedSounds: async () => job({ kind: 'sound-embed' }),
		findSoundMoments: async (soundId: string, req: unknown) => {
			calls.moments.push({ soundId, req });
			if (opts.momentsFail)
				throw Object.assign(new Error('Find Moment is unavailable: the model is not installed'), {
					code: opts.momentsFail,
				});
			return job({ state: 'queued' });
		},
		getJob: async (id: string) =>
			job({
				id,
				result: {
					soundId: entries[0]!.id,
					description: 'high',
					model: 'clap-larger-general',
					durationSec: 30,
					startSec: 0,
					endSec: 30,
					lengthSec: 1,
					moments: [
						{
							startSec: 17.1,
							endSec: 18,
							match: { z: 3.1, verdict: 'strong', cosine: 0.4 },
							headDb: -60,
							tailDb: -12,
							trimmed: true,
						},
					],
					computed: 7,
					cached: 0,
				},
			}),
	};
	return { client, calls };
}

function mount(mode: 'semantic' | 'keywords', momentsFail?: string) {
	const entries = [soundEntry({ title: 'SFX_0001', durationSec: 30 }), soundEntry({ title: 'SFX_0002' })];
	const e = describeEngine(entries, { mode, ...(momentsFail ? { momentsFail } : {}) });
	mocks.client = e.client;
	const { session, seqId } = makeSession();
	session.transport.seek(45);
	render(
		<SessionProvider session={session}>
			<SoundLibraryPanel instanceId="sl" visible />
			<DialogHost />
		</SessionProvider>,
	);
	return { ...e, session, seqId, entries };
}

describe('Describe in the Sound Library', () => {
	it('sends the query as a description and shows the matches', async () => {
		const { calls } = mount('semantic');
		await screen.findAllByRole('option');
		fireEvent.click(screen.getByTestId('sound-describe'));
		expect(screen.getByTestId('sound-describe').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('sound-describe-info').textContent).toContain('source, material, action');
		fireEvent.change(screen.getByLabelText('Search sounds'), { target: { value: 'glass shattering' } });
		await waitFor(() => expect(calls.search.some((r) => r.describe === 'glass shattering')).toBe(true));
		const last = calls.search.at(-1)!;
		expect(last.q).toBeUndefined();
		await waitFor(() => expect(document.querySelector('[data-match-verdict="strong"]')).toBeTruthy());
		expect(screen.getByTestId('sound-describe-info').getAttribute('data-describe-mode')).toBe('semantic');
		// Clear filters keeps Describe on
		fireEvent.click(screen.getByText('Clear filters'));
		expect(screen.getByTestId('sound-describe').getAttribute('aria-pressed')).toBe('true');
	});

	it('says when the model is missing and the words are searched instead', async () => {
		mount('keywords');
		await screen.findAllByRole('option');
		fireEvent.click(screen.getByTestId('sound-describe'));
		fireEvent.change(screen.getByLabelText('Search sounds'), { target: { value: 'SFX_0001' } });
		await waitFor(() =>
			expect(screen.getByTestId('sound-describe-info').getAttribute('data-describe-mode')).toBe('keywords'),
		);
		expect(screen.getByTestId('sound-describe-info').textContent).toContain('searching the words instead');
		expect(document.querySelector('[data-match-verdict]')).toBeNull();
	});
});

describe('Find Moment…', () => {
	it('is in the row menu of long sounds only', async () => {
		mount('semantic');
		const options = await screen.findAllByRole('option');
		fireEvent.contextMenu(options.find((o) => o.getAttribute('aria-label')!.startsWith('SFX_0001'))!);
		const item = await screen.findByRole('menuitem', { name: 'Find Moment…' });
		expect(item.getAttribute('aria-disabled')).not.toBe('true');
		fireEvent.keyDown(item, { key: 'Escape' });
		cleanup();
		mount('semantic');
		const again = await screen.findAllByRole('option');
		fireEvent.contextMenu(again.find((o) => o.getAttribute('aria-label')!.startsWith('SFX_0002'))!);
		const short = await screen.findByRole('menuitem', { name: /Find Moment/ });
		expect(short.getAttribute('aria-disabled')).toBe('true');
	});

	it('lists the moments, auditions a range and inserts one at the playhead (one undo step)', async () => {
		const { session, seqId, entries, calls } = mount('semantic');
		await screen.findAllByRole('option');
		await act(async () => {
			void openDialog(SOUND_FIND_MOMENT_DIALOG, { entry: entries[0]!, session });
		});
		const dialog = await screen.findByTestId('sound-find-moment-dialog');
		fireEvent.change(within(dialog).getByTestId('sound-find-moment-description'), {
			target: { value: 'a single key press' },
		});
		fireEvent.click(within(dialog).getByRole('button', { name: 'Find' }));
		const results = await within(dialog).findByTestId('sound-find-moment-results');
		expect(calls.moments).toEqual([
			{ soundId: entries[0]!.id, req: { description: 'a single key press', lengthSec: 2, count: 5 } },
		]);
		expect(results.textContent).toContain('0:17.10 – 0:18.00');
		expect(results.textContent).toContain('Strong match');
		expect(results.textContent).toContain('cut before it fades');
		await act(async () => {
			fireEvent.click(within(dialog).getByTestId('sound-find-moment-play-0'));
		});
		await waitFor(() => expect(starts.at(-1)).toEqual([0, 17.1, expect.closeTo(0.9, 6)]));
		await act(async () => {
			fireEvent.click(within(dialog).getByTestId('sound-find-moment-insert-0'));
		});
		await waitFor(() => expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(1));
		const clip = Object.values(session.getCommitted().sequences[seqId]!.clips)[0]! as {
			start: number;
			sourceIn: number;
		};
		expect(clip.start).toBe(45);
		// the registered copy has 50 ms of lead silence in front
		expect(clip.sourceIn).toBe(Math.round((17.1 + 0.05) * FLICKS_PER_SECOND));
		const history = session.getState().history.entries;
		expect(history).toHaveLength(1);
		expect(history[0]!.label).toContain('Add Sound Moment');
		expect(within(dialog).getByTestId('sound-find-moment-status').textContent).toContain('Added a moment');
	});

	it('says the model is needed (and opens the preferences) when it is not installed', async () => {
		const { entries, session, calls } = mount('keywords', 'MODEL_NOT_INSTALLED');
		await screen.findAllByRole('option');
		await act(async () => {
			void openDialog(SOUND_FIND_MOMENT_DIALOG, { entry: entries[0]!, session });
		});
		const dialog = await screen.findByTestId('sound-find-moment-dialog');
		// an empty description is refused before anything is asked
		fireEvent.click(within(dialog).getByRole('button', { name: 'Find' }));
		expect((await within(dialog).findByTestId('sound-find-moment-error')).textContent).toBe(
			'Describe the moment first',
		);
		expect(calls.moments).toEqual([]);
		fireEvent.change(within(dialog).getByTestId('sound-find-moment-description'), {
			target: { value: 'a dog barking' },
		});
		fireEvent.click(within(dialog).getByRole('button', { name: 'Find' }));
		await waitFor(() =>
			expect(within(dialog).getByTestId('sound-find-moment-error').textContent).toContain(
				'needs the optional Describe-it search model',
			),
		);
		expect(within(dialog).getByRole('button', { name: 'Open Preferences' })).toBeTruthy();
	});
});

describe('Preferences ▸ Sound Library ▸ Describe-it search', () => {
	it('shows the licence before downloading, follows the job, marks a pending model, asks before removing', async () => {
		const e = describeEngine([soundEntry()], { mode: 'semantic' });
		mocks.client = e.client;
		render(
			<>
				<DescribeSearchSection />
				<DialogHost />
			</>,
		);
		const row = await screen.findByTestId('describe-model-clap-larger-general');
		expect(row.textContent).toContain('Apache-2.0');
		expect(row.getAttribute('data-model-state')).toBe('available');
		const pending = screen.getByTestId('describe-model-clap-int8');
		expect(pending.getAttribute('data-model-state')).toBe('pending');
		expect(screen.getByTestId('describe-model-clap-int8-pending-text').textContent).toBe(
			'Not available yet: the model download location is pending',
		);
		expect((screen.getByTestId('describe-model-clap-int8-pending') as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByTestId('describe-model-clap-larger-general-install'));
		const confirm = await screen.findByRole('dialog');
		expect(confirm.textContent).toContain('Licence: Apache-2.0');
		expect(confirm.textContent).toContain('never makes sounds');
		expect(e.calls.install).toEqual([]);
		await act(async () => {
			fireEvent.click(within(confirm).getByRole('button', { name: 'Accept Licence and Download' }));
		});
		await waitFor(() => expect(e.calls.install).toEqual(['clap-larger-general']));
		await screen.findByTestId('describe-model-clap-larger-general-state');
		expect(screen.getByTestId('describe-embedded').textContent).toContain('1 of 2');
		fireEvent.click(screen.getByTestId('describe-model-clap-larger-general-remove'));
		const ask = await screen.findByRole('dialog');
		expect(ask.textContent).toContain('cached embeddings');
		await act(async () => {
			fireEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
		});
		await waitFor(() => expect(e.calls.remove).toEqual(['clap-larger-general']));
	});
});
