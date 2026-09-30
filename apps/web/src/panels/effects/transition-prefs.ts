// Default transitions (S10:TUI-031, D-30): a per-user preference (web localStorage, like the timeline
// prefs), one per medium. Ctrl+D / Ctrl+Shift+D / Shift+D and the Effects panel badge read it.
import { CONSTANT_POWER, CROSS_DISSOLVE, transitionSpec } from '@jasper/project';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type TransitionDefaults = { version: 1; video: string; audio: string };

const KEY = 'jasper.transitions.defaults.v1';

export function builtInDefaults(): TransitionDefaults {
	return { version: 1, video: CROSS_DISSOLVE, audio: CONSTANT_POWER };
}

function load(): TransitionDefaults {
	const d = builtInDefaults();
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		if (!raw) return d;
		const p = JSON.parse(raw) as Partial<TransitionDefaults>;
		return {
			version: 1,
			video: p.video && transitionSpec(p.video)?.appliesTo === 'video' ? p.video : d.video,
			audio: p.audio && transitionSpec(p.audio)?.appliesTo === 'audio' ? p.audio : d.audio,
		};
	} catch {
		return d;
	}
}

let store: StoreApi<TransitionDefaults> | null = null;

export function transitionDefaults(): StoreApi<TransitionDefaults> {
	if (store) return store;
	const s = createStore<TransitionDefaults>(() => load());
	s.subscribe((v) => {
		try {
			globalThis.localStorage?.setItem(KEY, JSON.stringify(v));
		} catch {
			/* storage unavailable */
		}
	});
	store = s;
	return s;
}

/** "Set Selected as Default Transition": the medium follows the transition's spec. */
export function setDefaultTransition(effectId: string): boolean {
	const spec = transitionSpec(effectId);
	if (!spec) return false;
	const s = transitionDefaults();
	s.setState({ ...s.getState(), [spec.appliesTo]: spec.id });
	return true;
}

/** Test helper. */
export function resetTransitionDefaults(): void {
	transitionDefaults().setState(builtInDefaults());
}
