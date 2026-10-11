import type { CommandOf } from '@jasper/project';
// Default transitions (S10:TUI-031/033, D-30): a per-user preference (web localStorage, like the timeline
// prefs), never part of the project and never in History. One type per medium, the alignment of the two-sided
// transitions that Ctrl+D / Ctrl+Shift+D / Shift+D / "Apply Default Transitions" create, and the unit each
// default-duration field of Preferences ▸ Timeline is shown in (the durations themselves are project settings,
// TUI-032). The Effects panel badge, the timeline commands, the agent bridge (`preferences.get`) and the
// Preferences ▸ Timeline page read it.
import { CONSTANT_POWER, CROSS_DISSOLVE, transitionSpec } from '@jasper/project';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type TransitionAlignment = 'center' | 'start-at-cut' | 'end-at-cut';
export type DurationUnit = 'frames' | 'seconds';
export type DurationField = 'video' | 'audio' | 'still';

type TransitionDefaults = {
	version: 2;
	video: string;
	audio: string;
	/** Alignment of the two-sided transitions the default-transition commands create (fades are fixed). */
	alignment: TransitionAlignment;
	/** Display/entry unit of each default duration in Preferences ▸ Timeline (storage is always frames). */
	units: Record<DurationField, DurationUnit>;
};

export const TRANSITION_ALIGNMENTS: readonly { value: TransitionAlignment; label: string }[] = [
	{ value: 'center', label: 'Center at Cut' },
	{ value: 'start-at-cut', label: 'Start at Cut' },
	{ value: 'end-at-cut', label: 'End at Cut' },
];

/** Same key as v1 (`{version: 1, video, audio}`): the extra fields are filled in when they are missing. */
const KEY = 'jasper.transitions.defaults.v1';

/** Premiere's defaults: video length in frames, audio and stills in seconds; dissolve / power, centred. */
function builtInTransitionDefaults(): TransitionDefaults {
	return {
		version: 2,
		video: CROSS_DISSOLVE,
		audio: CONSTANT_POWER,
		alignment: 'center',
		units: { video: 'frames', audio: 'seconds', still: 'seconds' },
	};
}

const isAlignment = (v: unknown): v is TransitionAlignment =>
	v === 'center' || v === 'start-at-cut' || v === 'end-at-cut';
const isUnit = (v: unknown): v is DurationUnit => v === 'frames' || v === 'seconds';

/** Validates a stored value (any version); unknown or wrong-medium ids fall back to the built-ins. */
export function parseTransitionDefaults(raw: unknown): TransitionDefaults {
	const d = builtInTransitionDefaults();
	if (!raw || typeof raw !== 'object') return d;
	const p = raw as Record<string, unknown>;
	const units = (p.units && typeof p.units === 'object' ? p.units : {}) as Record<string, unknown>;
	const id = (v: unknown, medium: 'video' | 'audio') =>
		typeof v === 'string' && transitionSpec(v)?.appliesTo === medium ? v : d[medium];
	return {
		version: 2,
		video: id(p.video, 'video'),
		audio: id(p.audio, 'audio'),
		alignment: isAlignment(p.alignment) ? p.alignment : d.alignment,
		units: {
			video: isUnit(units.video) ? units.video : d.units.video,
			audio: isUnit(units.audio) ? units.audio : d.units.audio,
			still: isUnit(units.still) ? units.still : d.units.still,
		},
	};
}

function load(): TransitionDefaults {
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		return parseTransitionDefaults(raw ? JSON.parse(raw) : null);
	} catch {
		return builtInTransitionDefaults();
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
			/* storage unavailable: keep in memory */
		}
	});
	// Another window of the app changed them (same origin): follow, so both apply the same defaults.
	globalThis.addEventListener?.('storage', (e: StorageEvent) => {
		if (e.key !== KEY) return;
		const next = parseTransitionDefaults(e.newValue ? safeJson(e.newValue) : null);
		if (JSON.stringify(next) !== JSON.stringify(s.getState())) s.setState(next, true);
	});
	store = s;
	return s;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export function updateTransitionDefaults(patch: Partial<Omit<TransitionDefaults, 'version'>>): void {
	const s = transitionDefaults();
	s.setState(parseTransitionDefaults({ ...s.getState(), ...patch }), true);
}

/** "Set Selected as Default Transition": the medium follows the transition's spec. */
export function setDefaultTransition(effectId: string): boolean {
	const spec = transitionSpec(effectId);
	if (!spec) return false;
	updateTransitionDefaults({ [spec.appliesTo]: spec.id });
	return true;
}

/** The fields the default-transition commands add to `transition.applyDefault` (TUI-030/033). */
export function defaultTransitionFields(
	media: readonly ('video' | 'audio')[],
): Pick<CommandOf<'transition.applyDefault'>, 'media' | 'videoEffectId' | 'audioEffectId' | 'alignment'> {
	const p = transitionDefaults().getState();
	return {
		media: [...media],
		...(media.includes('video') ? { videoEffectId: p.video } : {}),
		...(media.includes('audio') ? { audioEffectId: p.audio } : {}),
		...(p.alignment !== 'center' ? { alignment: p.alignment } : {}),
	};
}

/** What the agent bridge answers to `preferences.get` (S10:TUI-034). */
export function transitionPreferences(): { video: string; audio: string; alignment: TransitionAlignment } {
	const { video, audio, alignment } = transitionDefaults().getState();
	return { video, audio, alignment };
}

/** "Reset" in Preferences ▸ Timeline, and tests. */
export function resetTransitionDefaults(): void {
	transitionDefaults().setState(builtInTransitionDefaults(), true);
}
