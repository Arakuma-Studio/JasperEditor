// Effect and transition vocabulary: JasperEditor registry ids ↔ the names documents use. JasperEditor's catalogue
// carries Premiere Pro's names ("Cross Dissolve", "Dip to Black", "Constant Power", "Gaussian Blur", …), which are
// also what FCP7 XML / AAF / OTIO files written by Premiere and Resolve use.
import {
	CONSTANT_GAIN,
	CONSTANT_POWER,
	CROSS_DISSOLVE,
	DIP_TO_BLACK,
	defaultEffectRegistry,
	type EffectSpec,
	TRANSITION_SPECS,
	type TransitionSpec,
	transitionSpec,
} from '@jasper/project';
import type { Report } from './report.ts';

export { CONSTANT_GAIN, CONSTANT_POWER, CROSS_DISSOLVE, DIP_TO_BLACK };

const norm = (s: string) =>
	s
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, ' ');

const VIDEO_ALIASES: Record<string, string> = {
	dissolve: CROSS_DISSOLVE,
	'cross dissolve': CROSS_DISSOLVE,
	crossdissolve: CROSS_DISSOLVE,
	'smpte dissolve': CROSS_DISSOLVE,
	d: CROSS_DISSOLVE,
	'video dissolve': CROSS_DISSOLVE,
	'videodissolve 2': CROSS_DISSOLVE,
	'fade to black': DIP_TO_BLACK,
	'dip to color dissolve': 'jasper.dip-to-color',
	'fade in fade out dissolve': DIP_TO_BLACK,
	'video fade to black': DIP_TO_BLACK,
	'fade to color': 'jasper.dip-to-color',
	'edge wipe': 'jasper.wipe',
	'smpte wipe': 'jasper.wipe',
	w: 'jasper.wipe',
	'dip to white': 'jasper.dip-to-white',
};

const AUDIO_ALIASES: Record<string, string> = {
	dissolve: CONSTANT_POWER,
	'cross dissolve': CONSTANT_POWER,
	'cross fade (+3db)': CONSTANT_POWER,
	'cross fade +3db': CONSTANT_POWER,
	'crossfade (+3db)': CONSTANT_POWER,
	'cross fade': CONSTANT_POWER,
	crossfade: CONSTANT_POWER,
	'cross fade (0db)': CONSTANT_GAIN,
	'cross fade 0db': CONSTANT_GAIN,
	'crossfade (0db)': CONSTANT_GAIN,
	'mono audio dissolve': CONSTANT_POWER,
	monoaudiodissolve: CONSTANT_POWER,
	'simple mono audio dissolve': CONSTANT_POWER,
	'constant power': CONSTANT_POWER,
	'constant gain': CONSTANT_GAIN,
};

/** The registry entry of a transition id (null when unknown). */
export function transitionSpecOf(effectId: string): TransitionSpec | null {
	return transitionSpec(effectId);
}

/**
 * The JasperEditor transition for a document's transition name (or id). Unknown names become Cross Dissolve
 * (Constant Power on audio) with a warning naming the transition.
 */
export function transitionFromName(name: string, audio: boolean, report: Report): string {
	const n = norm(name);
	const alias = (audio ? AUDIO_ALIASES : VIDEO_ALIASES)[n];
	if (alias && transitionSpec(alias)) return alias;
	const kind = audio ? 'audio' : 'video';
	const byId = TRANSITION_SPECS.find((s) => s.id === name.trim() && s.appliesTo === kind);
	if (byId) return byId.id;
	const byLabel = TRANSITION_SPECS.find((s) => s.appliesTo === kind && norm(s.label) === n);
	if (byLabel) return byLabel.id;
	const fallback = audio ? CONSTANT_POWER : CROSS_DISSOLVE;
	report.warn(`transition "${name}" is not supported; imported as ${transitionLabel(fallback)}`, {
		subject: { kind: 'transition', name },
		instead: transitionLabel(fallback),
	});
	return fallback;
}

/** Display (Premiere) name of a transition id. */
export function transitionLabel(effectId: string): string {
	return transitionSpec(effectId)?.label ?? effectId;
}

export function isAudioTransition(effectId: string): boolean {
	return transitionSpec(effectId)?.appliesTo === 'audio';
}

/** A registry effect by id or display name (case-insensitive), for `appliesTo` when given. */
export function effectSpecOf(idOrName: string, appliesTo?: 'video' | 'audio'): EffectSpec | null {
	const direct = defaultEffectRegistry.get(idOrName.trim());
	if (direct && (!appliesTo || direct.appliesTo === appliesTo)) return direct;
	const n = norm(idOrName);
	return (
		defaultEffectRegistry
			.list()
			.find((s) => (!appliesTo || s.appliesTo === appliesTo) && (norm(s.label) === n || norm(s.id) === n)) ??
		null
	);
}
