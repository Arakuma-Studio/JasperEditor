// Synthetic sources (Premiere "New Item", S01:AST-010; edit-structure, docs/wp-notes/edit-structure.md): their
// catalogue, parameters with defaults and validation, and the clips a placement creates. Pure.
//
// Kinds and what they place:
//   color-matte        Color Matte            solid (the colour)
//   black-video        Black Video            solid (opaque black)
//   transparent        Transparent Video      solid (transparent)
//   adjustment         Adjustment Layer       adjustment
//   bars-and-tone      Bars and Tone          solid (SMPTE RP 219 / ARIB STD-B28 HD bars) + synthetic-audio (tone)
//   counting-leader    Universal Counting Leader  solid (the leader) + synthetic-audio (cue blips)
import type { RGBA } from '../schema/common.ts';
import type { SyntheticKind, SyntheticSource } from '../schema/media.ts';
import { FLICKS_PER_SECOND } from '../time.ts';

export type SyntheticInfo = {
	kind: SyntheticKind;
	/** Premiere's New Item name (also the default project item name). */
	label: string;
	hasVideo: boolean;
	hasAudio: boolean;
	/**
	 * Default length of a placed clip in seconds; `null` = the project's default still duration (Premiere uses the
	 * still-image default for mattes, black/transparent video and adjustment layers).
	 */
	defaultSeconds: number | null;
	/** Content time drives the picture or the sound (the leader counts down; bars and tone are constant). */
	timeDependent: boolean;
};

export const SYNTHETIC_INFO: Readonly<Record<SyntheticKind, SyntheticInfo>> = {
	'color-matte': {
		kind: 'color-matte',
		label: 'Color Matte',
		hasVideo: true,
		hasAudio: false,
		defaultSeconds: null,
		timeDependent: false,
	},
	'black-video': {
		kind: 'black-video',
		label: 'Black Video',
		hasVideo: true,
		hasAudio: false,
		defaultSeconds: null,
		timeDependent: false,
	},
	transparent: {
		kind: 'transparent',
		label: 'Transparent Video',
		hasVideo: true,
		hasAudio: false,
		defaultSeconds: null,
		timeDependent: false,
	},
	adjustment: {
		kind: 'adjustment',
		label: 'Adjustment Layer',
		hasVideo: true,
		hasAudio: false,
		defaultSeconds: null,
		timeDependent: false,
	},
	// Adobe: "You can create a one-second clip containing color bars and a 1-kHz tone".
	'bars-and-tone': {
		kind: 'bars-and-tone',
		label: 'Bars and Tone',
		hasVideo: true,
		hasAudio: true,
		defaultSeconds: 1,
		timeDependent: false,
	},
	// Adobe: "The leader is 11 seconds long."
	'counting-leader': {
		kind: 'counting-leader',
		label: 'Universal Counting Leader',
		hasVideo: true,
		hasAudio: true,
		defaultSeconds: 11,
		timeDependent: true,
	},
};

export const SYNTHETIC_KINDS = Object.keys(SYNTHETIC_INFO) as SyntheticKind[];

/** Universal Counting Leader Setup (Premiere's dialog: colours and the three cue options). */
export type CountingLeaderStyle = {
	/** The circular one-second wipe. */
	wipeColor: RGBA;
	/** Behind the wipe. */
	backgroundColor: RGBA;
	/** The horizontal and vertical lines. */
	lineColor: RGBA;
	/** The double circle around the numeral. */
	targetColor: RGBA;
	numeralColor: RGBA;
	/** A cue circle on the leader's last frame. */
	cueBlipOnOut: boolean;
	/** A 1 kHz beep on the first frame of "2" (the two-pop). */
	cueBlipOnTwo: boolean;
	/** A beep at the start of every second of the countdown. */
	cueBlipAllSeconds: boolean;
};

export const DEFAULT_LEADER_STYLE: Readonly<CountingLeaderStyle> = {
	wipeColor: [0.55, 0.55, 0.55, 1],
	backgroundColor: [0.78, 0.78, 0.78, 1],
	lineColor: [0.1, 0.1, 0.1, 1],
	targetColor: [0.1, 0.1, 0.1, 1],
	numeralColor: [0.08, 0.08, 0.08, 1],
	cueBlipOnOut: false,
	cueBlipOnTwo: true,
	cueBlipAllSeconds: false,
};

/** Bars and Tone: SMPTE alignment level (RP 155): 1 kHz at −20 dBFS. Premiere's own default is −12 dBFS. */
export const DEFAULT_TONE_HZ = 1000;
export const DEFAULT_TONE_DB = -20;
/** The counting leader's blips: 1 kHz, one frame long, at −20 dBFS. */
export const LEADER_BLIP_HZ = 1000;
export const LEADER_BLIP_DB = -20;
export const DEFAULT_MATTE_COLOR: RGBA = [0.2, 0.2, 0.2, 1];

/** A counting leader's resolved style (stored keys over the defaults; malformed values fall back). */
export function leaderStyleOf(style: Record<string, unknown> | undefined): CountingLeaderStyle {
	const out: CountingLeaderStyle = { ...DEFAULT_LEADER_STYLE };
	const s = style ?? {};
	for (const k of ['wipeColor', 'backgroundColor', 'lineColor', 'targetColor', 'numeralColor'] as const) {
		const v = s[k];
		if (isRgba(v)) out[k] = [v[0], v[1], v[2], v[3]];
	}
	for (const k of ['cueBlipOnOut', 'cueBlipOnTwo', 'cueBlipAllSeconds'] as const) {
		if (typeof s[k] === 'boolean') out[k] = s[k] as boolean;
	}
	return out;
}

export function isRgba(v: unknown): v is RGBA {
	return (
		Array.isArray(v) &&
		v.length === 4 &&
		v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)
	);
}

export type SyntheticParamIssue = { param: string; message: string };

const LEADER_KEYS = new Set<string>(Object.keys(DEFAULT_LEADER_STYLE));

/**
 * Builds (create) or patches (update) a synthetic source from command params. Throws nothing: returns the issues
 * (unknown or malformed params), and the source to store when there are none.
 */
export function syntheticFromParams(
	kind: SyntheticKind,
	id: string,
	params: Record<string, unknown>,
	base?: SyntheticSource,
): { source: SyntheticSource | null; issues: SyntheticParamIssue[] } {
	const issues: SyntheticParamIssue[] = [];
	const unknown = (allowed: readonly string[]) => {
		for (const k of Object.keys(params))
			if (!allowed.includes(k))
				issues.push({
					param: k,
					message: allowed.length
						? `${SYNTHETIC_INFO[kind].label} has no parameter "${k}" (parameters: ${allowed.join(', ')})`
						: `${SYNTHETIC_INFO[kind].label} has no parameters`,
				});
	};
	switch (kind) {
		case 'color-matte': {
			unknown(['color']);
			const prev = base?.kind === 'color-matte' ? base.color : DEFAULT_MATTE_COLOR;
			const color = params.color ?? prev;
			if (!isRgba(color)) issues.push({ param: 'color', message: 'color must be RGBA numbers in 0..1' });
			return {
				source: issues.length ? null : { id, kind, color: [...(color as RGBA)] as RGBA },
				issues,
			};
		}
		case 'bars-and-tone': {
			unknown(['toneHz', 'toneDb']);
			const prev = base?.kind === 'bars-and-tone' ? base : { toneHz: DEFAULT_TONE_HZ, toneDb: DEFAULT_TONE_DB };
			const toneHz = params.toneHz ?? prev.toneHz;
			const toneDb = params.toneDb ?? prev.toneDb;
			if (typeof toneHz !== 'number' || !(toneHz >= 20 && toneHz <= 20000))
				issues.push({ param: 'toneHz', message: 'toneHz must be a frequency in 20..20000 Hz' });
			if (typeof toneDb !== 'number' || !(toneDb >= -96 && toneDb <= 0))
				issues.push({ param: 'toneDb', message: 'toneDb must be a level in −96..0 dBFS' });
			return {
				source: issues.length ? null : { id, kind, toneHz: toneHz as number, toneDb: toneDb as number },
				issues,
			};
		}
		case 'counting-leader': {
			unknown([...LEADER_KEYS]);
			const prev = base?.kind === 'counting-leader' ? base.style : {};
			const style: Record<string, unknown> = { ...prev };
			for (const [k, v] of Object.entries(params)) {
				if (!LEADER_KEYS.has(k)) continue;
				const def = DEFAULT_LEADER_STYLE[k as keyof CountingLeaderStyle];
				if (typeof def === 'boolean' ? typeof v !== 'boolean' : !isRgba(v))
					issues.push({
						param: k,
						message: typeof def === 'boolean' ? `${k} must be true or false` : `${k} must be RGBA in 0..1`,
					});
				else style[k] = Array.isArray(v) ? [...v] : v;
			}
			return { source: issues.length ? null : { id, kind, style }, issues };
		}
		default:
			unknown([]);
			return { source: issues.length ? null : ({ id, kind } as SyntheticSource), issues };
	}
}

/** Default placed length of a synthetic source in flicks (`stillFlicks` = the project's still default). */
export function syntheticDefaultFlicks(kind: SyntheticKind, stillFlicks: number): number {
	const s = SYNTHETIC_INFO[kind].defaultSeconds;
	return s === null ? stillFlicks : s * FLICKS_PER_SECOND;
}

/** The picture of a `solid` clip's synthetic source, as the render snapshot carries it. */
export type SyntheticPicture =
	| { color: RGBA }
	| { generator: { kind: 'bars' } }
	| { generator: { kind: 'counting-leader'; style: CountingLeaderStyle } };

export function syntheticPicture(syn: SyntheticSource | undefined): SyntheticPicture {
	switch (syn?.kind) {
		case 'color-matte':
			return { color: syn.color };
		case 'transparent':
			return { color: [0, 0, 0, 0] };
		case 'bars-and-tone':
			return { generator: { kind: 'bars' } };
		case 'counting-leader':
			return { generator: { kind: 'counting-leader', style: leaderStyleOf(syn.style) } };
		default:
			return { color: [0, 0, 0, 1] };
	}
}

/** The sound of a synthetic source (null = silent / no audio). */
export type SyntheticSound =
	| { kind: 'tone'; hz: number; db: number }
	| { kind: 'leader-blips'; style: CountingLeaderStyle };

export function syntheticSound(syn: SyntheticSource | undefined): SyntheticSound | null {
	if (syn?.kind === 'bars-and-tone') return { kind: 'tone', hz: syn.toneHz, db: syn.toneDb };
	if (syn?.kind === 'counting-leader') return { kind: 'leader-blips', style: leaderStyleOf(syn.style) };
	return null;
}
