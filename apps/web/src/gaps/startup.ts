import { gapsPrefs } from './app-prefs.ts';
import { installAudioOutput } from './audio-output.ts';

/** `data-pr-motion="reduced"` on <html> when motion is reduced (by the preference or the system setting). */
export function applyMotionPreference(
	el: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
	if (!el) return;
	const pref = gapsPrefs.get().appearance.reducedMotion;
	let system = false;
	try {
		system = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		system = false;
	}
	const reduced = pref === 'on' || (pref === 'system' && system);
	el.setAttribute('data-pr-motion', reduced ? 'reduced' : 'full');
}

let installed = false;
export function installGapsRuntime(): void {
	if (installed) return;
	installed = true;
	installAudioOutput();
	applyMotionPreference();
	gapsPrefs.subscribe(() => applyMotionPreference());
	try {
		matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () =>
			applyMotionPreference(),
		);
	} catch {
		/* no matchMedia */
	}
}
