// Effect and transition vocabulary: JasperEditor registry ids ↔ the names documents use. JasperEditor's catalogue
// carries Premiere Pro's names ("Cross Dissolve", "Dip to Black", "Constant Power", "Gaussian Blur", …), which are
// also what FCP7 XML / AAF / OTIO files written by Premiere and Resolve use.
import {
	CONSTANT_GAIN,
	CONSTANT_POWER,
	CROSS_DISSOLVE,
	CUSTOM_FADE,
	DIP_TO_BLACK,
	defaultEffectRegistry,
	type EffectSpec,
	EXPONENTIAL_FADE,
	TRANSITION_SPECS,
	transitionSpec,
} from '@jasper/project';
import type { Report } from './report.ts';

export { CONSTANT_GAIN, CONSTANT_POWER, CROSS_DISSOLVE, CUSTOM_FADE, DIP_TO_BLACK, EXPONENTIAL_FADE };

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
	// Premiere's match names and effect ids (FCP7 XML: <effectid>KGAudioTransCrossFade3dB</effectid>), and the Spanish
	// display names a Spanish Premiere writes (Potencia constante, Ganancia constante, Fundido exponencial,
	// Fundido personalizado).
	kgaudiotranscrossfade3db: CONSTANT_POWER,
	kgaudiotranscrossfade0db: CONSTANT_GAIN,
	'exponential fade': EXPONENTIAL_FADE,
	'custom fade': CUSTOM_FADE,
	'potencia constante': CONSTANT_POWER,
	'ganancia constante': CONSTANT_GAIN,
	'fundido exponencial': EXPONENTIAL_FADE,
	'fundido personalizado': CUSTOM_FADE,
};

/**
 * The JasperEditor transition for a document's transition name (or id). Unknown names become Cross Dissolve
 * (Constant Power on audio) with a warning naming the transition.
 */
export function transitionFromName(name: string, audio: boolean, report: Report): string {
	const known = knownTransition(name, audio);
	if (known) return known;
	const fallback = audio ? CONSTANT_POWER : CROSS_DISSOLVE;
	report.warn(`transition "${name}" is not supported; imported as ${transitionLabel(fallback)}`, {
		subject: { kind: 'transition', name },
		instead: transitionLabel(fallback),
	});
	return fallback;
}

/** The JasperEditor transition of a document's transition name, id or label, or null when it is not known. */
export function knownTransition(name: string, audio: boolean): string | null {
	const n = norm(name);
	const alias = (audio ? AUDIO_ALIASES : VIDEO_ALIASES)[n];
	if (alias && transitionSpec(alias)) return alias;
	const kind = audio ? 'audio' : 'video';
	const byId = TRANSITION_SPECS.find((s) => s.id === name.trim() && s.appliesTo === kind);
	if (byId) return byId.id;
	const byLabel = TRANSITION_SPECS.find((s) => s.appliesTo === kind && norm(s.label) === n);
	return byLabel?.id ?? null;
}

/** Display (Premiere) name of a transition id. */
export function transitionLabel(effectId: string): string {
	return transitionSpec(effectId)?.label ?? effectId;
}

/** A registry effect by id or display name (case-insensitive), for `appliesTo` when given. */
export function effectSpecOf(idOrName: string, appliesTo?: 'video' | 'audio'): EffectSpec | null {
	const direct = defaultEffectRegistry.get(idOrName.trim());
	if (direct && (!appliesTo || direct.appliesTo === appliesTo)) return direct;
	const n = norm(idOrName);
	return (
		defaultEffectRegistry
			.list()
			.find(
				(s) =>
					(!appliesTo || s.appliesTo === appliesTo) &&
					(norm(s.label) === n ||
						norm(s.id) === n ||
						norm(s.label).replace(/ /g, '') === n.replace(/ /g, '') ||
						norm(s.id.replace(/^jasper\./, '')).replace(/ /g, '') === n.replace(/ /g, '')),
			) ?? null
	);
}
