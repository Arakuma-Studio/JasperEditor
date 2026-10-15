import { DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import {
	DEFAULT_GAPS_PREFS,
	gapsPrefs,
	labelDefault,
	labelName,
	parseGapsPrefs,
} from '../src/gaps/app-prefs.ts';
import { applyMotionPreference } from '../src/gaps/startup.ts';
import { largeTrimOffset, postrollSeconds, prerollSeconds } from '../src/panels/timeline/state/trim-mode.ts';
import { autoSavePolicy } from '../src/runtime/save.ts';
import { PREFERENCES_DIALOG, registerPreferencesDialog } from '../src/shell/preferences/index.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => gapsPrefs.reset());
afterEach(() => cleanup());

describe('preference pages', () => {
	it('Playback and Trim values drive the commands; Auto Save drives the policy', async () => {
		registerPreferencesDialog();
		render(<DialogHost />);
		act(() => void openDialog(PREFERENCES_DIALOG, { page: 'trim' }));
		const f = await screen.findByTestId('pref-large-trim');
		fireEvent.change(f, { target: { value: '12' } });
		fireEvent.blur(f);
		expect(largeTrimOffset()).toBe(12);
		gapsPrefs.set({ playback: { prerollSeconds: 3, postrollSeconds: 1 } });
		expect([prerollSeconds(), postrollSeconds()]).toEqual([3, 1]);
		gapsPrefs.set({ autoSave: { enabled: false, maxIntervalSeconds: 30 } });
		expect(autoSavePolicy()).toEqual({ enabled: false, maxIntervalMs: 30_000 });
	});

	it('labels: names and defaults; reduced motion attribute', () => {
		gapsPrefs.set({ labels: { names: { violet: 'Interviews' }, defaults: { bin: 'rose' } } });
		expect(labelName('violet')).toBe('Interviews');
		expect(labelDefault('bin')).toBe('rose');
		gapsPrefs.set({ appearance: { reducedMotion: 'on' } });
		const el = document.createElement('div');
		applyMotionPreference(el);
		expect(el.getAttribute('data-pr-motion')).toBe('reduced');
	});

	it('parses hostile storage values to the defaults', () => {
		expect(parseGapsPrefs(null)).toEqual(DEFAULT_GAPS_PREFS);
		const p = parseGapsPrefs({
			trim: { largeTrimOffset: 1e9 },
			labels: { names: { nope: 'x', rose: 5 }, defaults: { bin: 'bogus' } },
			appearance: { language: '../../etc' },
		});
		expect(p.trim.largeTrimOffset).toBe(100);
		expect(p.labels).toEqual({ names: {}, defaults: {} });
		expect(p.appearance.language).toBe('en');
	});
});
