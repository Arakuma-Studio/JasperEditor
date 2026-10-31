// Spec 18 AF-BRF-005 / AF-BRF-006: the editor side of the sequence brief — the form fields of Home ▸ Describe your video
// and Sequence ▸ Brief… (platform, frame shape, target length typed as "45", "45 s", "1:30" or "2 min"), the sequence
// preset a brief implies, and the command that stores a form. Pure: no React, no engine.
import {
	BRIEF_LIMITS,
	BUILTIN_PRESETS,
	DELIVERY_TARGETS,
	type DeliveryAspect,
	type DeliveryTargetId,
	isDeliveryTargetId,
	makeSequenceSettings,
	type SequenceBrief,
} from '@jasper/project';
import { t } from '../i18n/runtime.ts';

/** The preset Home's New Project starts from (ARCHITECTURE §15); also the 16:9 shape of a brief. */
export const HOME_DEFAULT_PRESET = 'hd-1080p-29.97';

export const ASPECT_NAMES: Record<DeliveryAspect, string> = {
	'16:9': 'Landscape 16:9',
	'9:16': 'Vertical 9:16',
	'1:1': 'Square 1:1',
	'4:5': 'Portrait 4:5',
};

/** The brief as the forms edit it: every field present, `null` = not stated. */
export type BriefForm = {
	text: string;
	platform: DeliveryTargetId | null;
	/** An explicit frame shape; null = the platform's. */
	aspect: DeliveryAspect | null;
	/** What the user typed for the target length ("" = none). */
	duration: string;
};

export const EMPTY_BRIEF_FORM: BriefForm = { text: '', platform: null, aspect: null, duration: '' };

export function formOfBrief(b: SequenceBrief | null): BriefForm {
	return {
		text: b?.text ?? '',
		platform: b?.platform ?? null,
		aspect: b?.aspect ?? null,
		duration: b?.targetDurationSec != null ? formatDuration(b.targetDurationSec) : '',
	};
}

/** "45" / "45s" / "45 sec" → 45; "1:30" → 90; "1:02:03" → 3723; "2m" / "2 min" → 120. Null when unreadable. */
export function parseDuration(input: string): number | null {
	const s = input.trim().toLowerCase().replace(',', '.');
	if (!s) return null;
	let sec: number | null = null;
	const clock = /^(\d{1,2}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
	if (clock) {
		const [a, b, c] = [Number(clock[1]), Number(clock[2]), clock[3] === undefined ? null : Number(clock[3])];
		sec = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
	} else {
		const unit = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)?$/.exec(s);
		if (unit) {
			const n = Number(unit[1]);
			const u = unit[2] ?? 's';
			sec = u.startsWith('h') ? n * 3600 : u.startsWith('m') ? n * 60 : n;
		}
	}
	if (sec === null || !Number.isFinite(sec)) return null;
	sec = Math.round(sec * 10) / 10;
	return sec >= BRIEF_LIMITS.minDurationSec && sec <= BRIEF_LIMITS.maxDurationSec ? sec : null;
}

/** 45 → "45 s"; 90 → "1:30"; 3723 → "1:02:03". */
export function formatDuration(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return '';
	if (sec < 60) return `${Math.round(sec * 10) / 10} s`;
	const whole = Math.round(sec);
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = String(whole % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Why the form cannot be stored, or null. */
export function briefFormProblem(f: BriefForm): string | null {
	if (f.text.length > BRIEF_LIMITS.maxText)
		return t(
			'The description is too long ({0} of at most {1} characters)',
			f.text.length,
			BRIEF_LIMITS.maxText,
		);
	if (f.duration.trim() && parseDuration(f.duration) === null)
		return t(
			'Target length: type seconds (45), minutes and seconds (1:30) or minutes (2 min), up to 10 hours',
		);
	if (f.platform !== null && !isDeliveryTargetId(f.platform)) return t('Unknown platform');
	return null;
}

/** The `sequence.setBrief` patch storing the form (every field, null clears); the form must have no problem. */
export function briefPatch(f: BriefForm) {
	return {
		text: f.text,
		platform: f.platform,
		aspect: f.aspect,
		targetDurationSec: f.duration.trim() ? parseDuration(f.duration) : null,
	};
}

/** The frame shape a form asks for: its own, else its platform's, else null. */
export function formAspect(f: Pick<BriefForm, 'platform' | 'aspect'>): DeliveryAspect | null {
	if (f.aspect) return f.aspect;
	return f.platform ? (DELIVERY_TARGETS.find((x) => x.id === f.platform)?.aspect ?? null) : null;
}

const ratio = (a: DeliveryAspect) => {
	const [w, h] = a.split(':').map(Number) as [number, number];
	return { w, h };
};

/**
 * The sequence a new project gets for a brief (AF-BRF-005): 16:9 or nothing stated → the Home default preset; another
 * shape → the built-in preset with exactly that frame shape (square pixels, 30 fps preferred), else the 1080-wide frame
 * of that shape (`makeSequenceSettings`) applied to the 30 fps HD preset.
 */
export function sequenceShapeFor(aspect: DeliveryAspect | null): {
	preset: string;
	settings: { width: number; height: number } | null;
	name: string;
} {
	const def = BUILTIN_PRESETS.find((p) => p.id === HOME_DEFAULT_PRESET)!;
	if (!aspect || aspect === '16:9') return { preset: def.id, settings: null, name: def.name };
	const { w, h } = ratio(aspect);
	const same = BUILTIN_PRESETS.filter(
		(p) =>
			p.settings.pixelAspect.num === p.settings.pixelAspect.den &&
			p.settings.width * h === p.settings.height * w,
	);
	const pick =
		same.find((p) => p.settings.frameRate.num === 30 && p.settings.frameRate.den === 1) ?? same[0] ?? null;
	if (pick) return { preset: pick.id, settings: null, name: pick.name };
	const base = BUILTIN_PRESETS.find((p) => p.id === 'hd-1080p-30') ?? def;
	const width = 1080;
	const s = makeSequenceSettings(width, Math.round((width * h) / w / 2) * 2, base.settings.frameRate);
	return {
		preset: base.id,
		settings: { width: s.width, height: s.height },
		name: t('{0} {1}×{2} 30 fps', ASPECT_NAMES[aspect], s.width, s.height),
	};
}

/** A project name from a description: its first line, at most 60 characters (cut on a word), else "Untitled Project". */
export function projectNameFrom(text: string): string {
	const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
	if (!line) return t('Untitled Project');
	if (line.length <= 60) return line;
	const cut = line.slice(0, 60);
	const space = cut.lastIndexOf(' ');
	return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/** Sequence frame shape "W:H" of a width and height (1920×1080 → "16:9"). */
export function frameAspectOf(width: number, height: number): string {
	if (!(width > 0 && height > 0)) return '?';
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const g = gcd(Math.round(width), Math.round(height)) || 1;
	return `${Math.round(width) / g}:${Math.round(height) / g}`;
}
