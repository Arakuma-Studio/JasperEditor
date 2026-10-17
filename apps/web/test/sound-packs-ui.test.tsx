// Sound packs in the web app (spec 12 §2.7, P6-R1; wp-note "Phase 6 → WP6.1 sound packs"): Preferences ▸ Sound Library
// ▸ Packs lists the catalogue with the licence badge, links, sizes and state; Install shows the licence before anything
// is downloaded ("Accept Licence and Download") and follows the job; Remove asks first; a job an agent started shows
// its progress; the Library's empty state and panel menu open the Packs section; installed packs are Sources
// collections whose search asks for that pack.
import type { EngineJob, SoundPackInfo } from '@jasper/api';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommand, registerCommands } from '../src/commands/registry.ts';
import { soundCommands } from '../src/commands/sound.ts';
import soundLibrary from '../src/panels/soundLibrary/index.ts';
import { AuditionPlayer, setAuditionPlayer } from '../src/sound/audition.ts';
import { hostOf, installConfirmBody, PacksSection, requestPacksFocus } from '../src/sound/PacksSection.tsx';
import { soundLibraryPrefs } from '../src/sound/prefs.ts';
import { fakeSoundEngine, soundEntry, soundPack } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown, status: 'connected' }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	useEngineOrNull: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
}));

const { SoundLibraryPanel } = await import('../src/panels/soundLibrary/SoundLibraryPanel.tsx');

beforeAll(() => {
	registerCommands(soundCommands);
});
beforeEach(() => {
	localStorage.clear();
	soundLibraryPrefs.reload();
	setAuditionPlayer(
		new AuditionPlayer({
			createContext: () => ({}) as never,
			fetchBytes: async () => new ArrayBuffer(4),
			raf: () => 0,
			cancelRaf: () => {},
		}),
	);
});
afterEach(() => {
	cleanup();
	closeAllDialogs();
	setAuditionPlayer(null);
});

const job = (over: Partial<EngineJob> = {}): EngineJob =>
	({
		id: 'job_1',
		kind: 'sound-pack-install',
		state: 'running',
		progress: 0.5,
		stage: 'Downloading',
		title: 'Install sound pack',
		priority: 'user',
		origin: { type: 'user' },
		createdAt: '2026-10-17T00:00:00.000Z',
		...over,
	}) as EngineJob;

/** A fake engine for the Packs section: the list changes when a pack is installed or removed. */
function packsEngine(initial: SoundPackInfo[]) {
	let packs = initial;
	const calls: string[] = [];
	const jobs = new Map<string, EngineJob[]>();
	const client = {
		listSoundPacks: async () => ({ packs, catalogErrors: [] }),
		installSoundPack: async (id: string) => {
			calls.push(`install:${id}`);
			jobs.set('job_1', [
				job(),
				job({
					state: 'succeeded',
					progress: 1,
					result: {
						packId: id,
						alreadyInstalled: false,
						sounds: 45,
						installedBytes: 1,
						downloadedBytes: 1,
						indexJobId: 'job_2',
					},
				}),
			]);
			jobs.set('job_2', [job({ id: 'job_2', kind: 'sound-index', state: 'succeeded' })]);
			packs = packs.map((p) =>
				p.id === id
					? { ...p, state: 'installed', indexedSounds: p.sounds, installedBytes: p.installBytes }
					: p,
			);
			return job({ state: 'queued', progress: null });
		},
		removeSoundPack: async (id: string) => {
			calls.push(`remove:${id}`);
			packs = packs.map((p) =>
				p.id === id ? { ...p, state: 'available', indexedSounds: 0, installedBytes: null } : p,
			);
			return { packId: id, removed: true, removedSounds: 45, freedBytes: 1, job: null };
		},
		getJob: async (id: string) => {
			const list = jobs.get(id) ?? [job({ id, state: 'succeeded' })];
			return list.length > 1 ? list.shift()! : list[0]!;
		},
	};
	return { client, calls };
}

function renderPacks(packs: SoundPackInfo[]) {
	const e = packsEngine(packs);
	mocks.client = e.client;
	render(
		<>
			<PacksSection />
			<DialogHost />
		</>,
	);
	return e;
}

describe('Preferences ▸ Sound Library ▸ Packs', () => {
	it('lists each pack with its licence badge, links, sizes, sound count and state', async () => {
		renderPacks([
			soundPack(),
			soundPack({
				id: 'kenney-rpg-audio',
				title: 'RPG Audio',
				state: 'installed',
				indexedSounds: 49,
				sounds: 49,
			}),
		]);
		const list = await screen.findByRole('list', { name: 'Sound packs' });
		const rows = within(list).getAllByRole('listitem');
		expect(rows).toHaveLength(2);
		const ui = rows[0]!;
		expect(ui.textContent).toContain('UI Audio');
		expect(ui.textContent).toContain('Kenney (www.kenney.nl)');
		expect(ui.querySelector('[data-license-badge="CC0"]')).toBeTruthy();
		expect(ui.textContent).toContain('45 sounds · 402 KB download · 281 KB on disk');
		expect(ui.textContent).toContain('Not installed');
		expect(ui.textContent).toContain('No credit required');
		expect(within(ui).getByRole('link', { name: 'Licence text' }).getAttribute('href')).toBe(
			'https://creativecommons.org/publicdomain/zero/1.0/',
		);
		expect(within(ui).getByRole('link', { name: 'Pack page' }).getAttribute('href')).toBe(
			'https://kenney.nl/assets/ui-audio',
		);
		expect(within(ui).getByRole('button', { name: 'Install UI Audio' })).toBeTruthy();
		expect(within(ui).queryByRole('button', { name: 'Remove UI Audio' })).toBeNull();
		const rpg = rows[1]!;
		expect(rpg.textContent).toContain('Installed');
		expect(rpg.textContent).toContain('49 in the library');
		expect(within(rpg).queryByRole('button', { name: 'Install RPG Audio' })).toBeNull();
		expect(within(rpg).getByRole('button', { name: 'Remove RPG Audio' })).toBeTruthy();
	});

	it('shows the licence before downloading; Cancel downloads nothing', async () => {
		const e = renderPacks([soundPack()]);
		fireEvent.click(await screen.findByRole('button', { name: 'Install UI Audio' }));
		const dialog = await screen.findByTestId('confirm-dialog');
		expect(dialog.textContent).toContain('Install “UI Audio”?');
		expect(dialog.textContent).toContain('402 KB download from kenney.nl');
		expect(dialog.textContent).toContain(
			'Licence: CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/)',
		);
		expect(dialog.textContent).toContain('No credit is required.');
		expect(dialog.textContent).toContain('Licence checked on kenney.nl (2026-10-17)');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		});
		expect(e.calls).toEqual([]);
	});

	it('Accept Licence and Download installs, follows the install and index jobs, and shows the pack installed', async () => {
		const e = renderPacks([soundPack()]);
		fireEvent.click(await screen.findByRole('button', { name: 'Install UI Audio' }));
		const dialog = await screen.findByTestId('confirm-dialog');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Accept Licence and Download' }));
		});
		await waitFor(() => expect(e.calls).toEqual(['install:kenney-ui-audio']));
		await waitFor(
			() => expect(screen.getByTestId('sound-pack-state-kenney-ui-audio').textContent).toBe('Installed'),
			{
				timeout: 5000,
			},
		);
		expect(screen.queryByTestId('sound-pack-progress-kenney-ui-audio')).toBeNull();
	});

	it('Remove asks first (danger) and removes', async () => {
		const e = renderPacks([soundPack({ state: 'installed', indexedSounds: 45, installedBytes: 288_000 })]);
		fireEvent.click(await screen.findByRole('button', { name: 'Remove UI Audio' }));
		const dialog = await screen.findByTestId('confirm-dialog');
		expect(dialog.textContent).toContain('Projects that already use them keep their own copies');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
		});
		await waitFor(() => expect(e.calls).toEqual(['remove:kenney-ui-audio']));
		await waitFor(() =>
			expect(screen.getByTestId('sound-pack-state-kenney-ui-audio').textContent).toBe('Not installed'),
		);
	});

	it('a job someone else started shows its progress and disables the buttons; damaged and outdated packs offer Repair / Update', async () => {
		renderPacks([
			soundPack({ job: job({ progress: 0.42, stage: 'Downloading' }) }),
			soundPack({ id: 'b', title: 'B', state: 'damaged' }),
			soundPack({ id: 'c', title: 'C', state: 'outdated' }),
		]);
		expect((await screen.findByTestId('sound-pack-progress-kenney-ui-audio')).textContent).toBe(
			'Downloading 42 %',
		);
		expect((screen.getByRole('button', { name: 'Install UI Audio' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(screen.getByRole('button', { name: 'Install B' }).textContent).toBe('Repair…');
		expect(screen.getByRole('button', { name: 'Install C' }).textContent).toBe('Update…');
		expect(screen.getByRole('button', { name: 'Remove B' })).toBeTruthy();
	});

	it('an engine that fails is reported, never thrown', async () => {
		mocks.client = {
			listSoundPacks: async () => {
				throw new Error('engine down');
			},
		};
		render(<PacksSection />);
		expect((await screen.findByRole('alert')).textContent).toContain('engine down');
	});

	it('the confirmation names the credit line of a CC BY pack', () => {
		expect(
			installConfirmBody(soundPack({ license: 'CC-BY-4.0', attribution: '"X" by Y (CC BY 4.0)' })),
		).toContain('Credit required: "X" by Y (CC BY 4.0)');
		expect(hostOf('not a url')).toBe('not a url');
		expect(hostOf(null)).toBe('');
	});

	it('Install Sound Packs… (command) opens the Sound Library page and focuses the Packs section', async () => {
		const opened: unknown[] = [];
		const cmd = getCommand('soundLibrary.installPacks')!;
		expect(cmd.label).toBe('Install Sound Packs…');
		await cmd.run({ ui: { openDialog: (...a: unknown[]) => opened.push(a) }, session: null } as never, {});
		expect(opened[0]).toEqual(['shell.preferences', { page: 'sound-library', session: null }]);
		renderPacks([soundPack()]);
		const section = screen.getByTestId('sound-prefs-packs');
		await waitFor(() => expect(document.activeElement).toBe(section));
		// only once: a later mount does not take the focus again
		cleanup();
		renderPacks([soundPack()]);
		await screen.findByRole('button', { name: 'Install UI Audio' });
		expect(document.activeElement).not.toBe(screen.getByTestId('sound-prefs-packs'));
		requestPacksFocus();
		cleanup();
		renderPacks([soundPack()]);
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('sound-prefs-packs')));
	});
});

describe('Sound Library panel and packs', () => {
	it('the panel menu has Install Sound Packs…; the empty state offers it', async () => {
		expect(
			soundLibrary.menu?.some((m) => m.type === 'command' && m.command === 'soundLibrary.installPacks'),
		).toBe(true);
		const engine = fakeSoundEngine([]);
		mocks.client = engine.client;
		const { session } = makeSession();
		render(
			<SessionProvider session={session}>
				<SoundLibraryPanel instanceId="sl" visible />
			</SessionProvider>,
		);
		await screen.findByTestId('sound-empty');
		expect(screen.getByTestId('sound-install-packs').textContent).toBe('Install Sound Packs…');
	});

	it('lists installed packs under Sources and searches only that pack', async () => {
		const entries = [
			soundEntry({
				title: 'Click A',
				source: { type: 'pack', packId: 'kenney-ui-audio', file: 'Audio/click1.ogg' },
			}),
		];
		const engine = fakeSoundEngine(entries, {
			packs: [soundPack({ state: 'installed' }), soundPack({ id: 'kenney-rpg-audio', title: 'RPG Audio' })],
		});
		mocks.client = engine.client;
		const { session } = makeSession();
		render(
			<SessionProvider session={session}>
				<SoundLibraryPanel instanceId="sl" visible />
			</SessionProvider>,
		);
		await screen.findByRole('listbox', { name: 'Sounds' });
		const select = screen.getByRole('combobox', { name: 'Collection' });
		await act(async () => {
			fireEvent.keyDown(select, { key: 'Enter' });
		});
		const option = await screen.findByRole('option', { name: 'Sources › Packs › UI Audio' });
		// a pack that is not installed is not a collection
		expect(screen.queryByRole('option', { name: 'Sources › Packs › RPG Audio' })).toBeNull();
		await act(async () => {
			fireEvent.keyDown(option, { key: 'Enter' });
		});
		await waitFor(() => expect(engine.calls.search.at(-1)?.packId).toBe('kenney-ui-audio'));
	});
});
