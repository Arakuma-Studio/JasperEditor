// Sound Library review fixes outside the panel: Preferences ▸ Sound Library never leaves a promise rejection unhandled
// and keeps a typed folder path until the engine accepts it; the timeline's sound-drop tooltip names the track
// under a drag from another window by its label (A2) and speaks the UI language; the credits dialog's licence
// warnings are translated from their codes.
import type { SoundRoot } from '@jasper/api';
import type { SoundCreditRow, SoundCreditWarning } from '@jasper/project';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../src/i18n/runtime.ts';
import { soundDropTooltip } from '../src/panels/timeline/model/sound-drop-tooltip.ts';
import { creditWarningText } from '../src/sound/dialogs.tsx';
import { fakeSoundEngine } from './sound-helpers.ts';

const mocks = vi.hoisted(() => {
	const listeners = new Set<(e: { type: string }) => void>();
	const subscribe = (l: (e: { type: string }) => void) => {
		listeners.add(l);
		return () => listeners.delete(l);
	};
	return { client: null as unknown, listeners, subscribe };
});
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: 'connected', subscribe: mocks.subscribe }),
	useEngineOrNull: () => ({ client: mocks.client, status: 'connected', subscribe: mocks.subscribe }),
}));

const { SoundLibraryPreferencesPage } = await import('../src/sound/PreferencesPage.tsx');

afterEach(async () => {
	cleanup();
	await setLanguage('en');
});

describe('Preferences ▸ Sound Library', () => {
	it('handles a failing engine without unhandled rejections (rescan, library change)', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on('unhandledRejection', onUnhandled);
		try {
			const engine = fakeSoundEngine([]);
			let calls = 0;
			const real = engine.client.soundLibraryStatus;
			engine.client.soundLibraryStatus = async () => {
				calls++;
				if (calls > 1) throw new Error('engine gone');
				return real();
			};
			mocks.client = engine.client;
			render(<SoundLibraryPreferencesPage />);
			await screen.findByText(/0 sounds/);
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
				await new Promise((r) => setTimeout(r, 20));
			});
			await act(async () => {
				for (const l of [...mocks.listeners]) l({ type: 'sounds.changed' });
				await new Promise((r) => setTimeout(r, 20));
			});
			expect(calls).toBeGreaterThanOrEqual(3);
			await screen.findByText('The library status is not available.');
			await new Promise((r) => setTimeout(r, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('keeps the typed folder path when the engine refuses it, and clears it once saved', async () => {
		const engine = fakeSoundEngine([]);
		let refuse = true;
		(engine.client as { putSoundRoots: unknown }).putSoundRoots = async (req: {
			roots: { path: string }[];
		}) => {
			if (refuse) throw new Error('Not a folder');
			return {
				roots: req.roots.map(
					(r, i) =>
						({
							id: `root${i}`,
							path: r.path,
							label: '',
							license: 'LicenseRef-UserProvided',
							enabled: true,
						}) as SoundRoot,
				),
				local: true,
				job: null,
				removedSounds: 0,
			} as never;
		};
		mocks.client = engine.client;
		render(<SoundLibraryPreferencesPage />);
		const input = (await screen.findByTestId('sound-prefs-new-path')) as HTMLInputElement;
		fireEvent.change(input, { target: { value: '/home/me/sfx' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-prefs-add-folder'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('sound-prefs-message').textContent).toMatch(/Not a folder/),
		);
		expect(input.value).toBe('/home/me/sfx');
		refuse = false;
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-prefs-add-folder'));
		});
		await waitFor(() => expect(screen.getByTestId('sound-prefs-message').textContent).toBe('Folders saved.'));
		expect(input.value).toBe('');
	});
});

describe('sound drop tooltip', () => {
	const seq = { audioTracks: [{ id: 'trk_aaaa' }, { id: 'trk_bbbb' }] } as never;

	it('names the track under a drag from another window by its label, not its id', () => {
		const lines = soundDropTooltip(
			seq,
			{ plan: null, preferredTrackId: 'trk_bbbb', align: 'peak', snapEdge: null },
			null,
			'00:00:01:15',
		);
		expect(lines).toEqual(['peak → 00:00:01:15', 'Sound → A2']);
		expect(
			soundDropTooltip(
				seq,
				{ plan: null, preferredTrackId: null, align: 'start', snapEdge: null },
				'Pop',
				'x',
			),
		).toEqual(['start → x', 'Pop → A1']);
	});

	it('speaks the UI language', async () => {
		await setLanguage('es');
		const plan = { track: { kind: 'new', name: 'SFX 1', label: 'A3' } } as never;
		const lines = soundDropTooltip(
			seq,
			{ plan, preferredTrackId: null, align: 'peak', snapEdge: 'start' },
			null,
			'00:00:01:15',
		);
		expect(lines).toEqual([
			'pico → 00:00:01:15',
			'Sonido → pista nueva SFX 1 (A3)',
			'borde de inicio ajustado',
		]);
	});
});

describe('credits warnings', () => {
	const row = (over: Partial<SoundCreditRow>): SoundCreditRow => ({
		mediaId: 'med_1',
		soundId: 'snd_0000000000000001',
		title: 'Crunch',
		author: '',
		license: 'CC-BY-NC-4.0',
		licenseUrl: null,
		sourceUrl: null,
		attribution: null,
		requiresAttribution: true,
		shareAlike: false,
		usedIn: [],
		sequenceIds: [],
		...over,
	});
	const warn = (code: SoundCreditWarning['code']): SoundCreditWarning => ({
		code,
		mediaId: 'med_1',
		message: 'English text from @jasper/project',
	});

	it('are written from their code in the UI language (English and Spanish)', async () => {
		const rows = [row({})];
		expect(creditWarningText(warn('W_LICENSE_NC'), rows)).toBe(
			'“Crunch” (med_1) is licensed for non-commercial use only (CC-BY-NC-4.0)',
		);
		await setLanguage('es');
		const texts = (
			[
				'W_LICENSE_NC',
				'W_LICENSE_ND',
				'W_USER_PROVIDED',
				'W_LICENSE_UNKNOWN',
				'W_CREDIT_INCOMPLETE',
				'W_SHARE_ALIKE',
			] as const
		).map((c) => creditWarningText(warn(c), rows));
		expect(texts[0]).toBe('“Crunch” (med_1) solo tiene licencia para uso no comercial (CC-BY-NC-4.0)');
		for (const t of texts) {
			expect(t).toContain('“Crunch” (med_1)');
			expect(t).not.toMatch(/licensed|licence|folder|credit|English/);
		}
		// a warning of an unknown sound keeps the model's text rather than inventing one
		expect(creditWarningText({ ...warn('W_LICENSE_NC'), mediaId: 'med_x' }, rows)).toBe(
			'English text from @jasper/project',
		);
	});
});
