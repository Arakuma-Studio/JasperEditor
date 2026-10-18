// The cue grammar and personality controls (spec 12 P6-E10; wp-note "Phase 6 → WP-E6"), shared by Auto Sound Pass…,
// Suggest Cues… and Preferences ▸ Sound Library ▸ Sound design style: a Personality select with its one-line
// description, Runs (climb / flat), Typing (auto / keys / words / silent), "Music carries the cuts" and "Duck the music
// under typing". The values are a `ResolvedSoundStyle`; the dialogs start from the sequence's
// `soundDesign.settings.style` (`resolveSoundStyle`), Preferences writes it with `soundDesign.setSettings {style}`.
import {
	type ResolvedSoundStyle,
	SOUND_PERSONALITIES,
	SOUND_RUN_MODES,
	SOUND_TYPING_MODES,
	type SoundPersonality,
	type SoundRunMode,
	type SoundTypingMode,
} from '@jasper/project';
import { Checkbox, Select } from '@jasper/ui';
import { useMemo } from 'react';
import { t } from '../i18n/runtime.ts';

export const PERSONALITY_LABELS: Record<SoundPersonality | 'none', string> = {
	none: 'No personality',
	calm: 'Calm',
	energetic: 'Energetic',
	bright: 'Bright',
	precise: 'Precise',
	mechanical: 'Mechanical',
	warm: 'Warm',
};

/** One line per personality (the table is `SOUND_PERSONALITY_PROFILES` in @jasper/project). */
export const PERSONALITY_DESCRIPTIONS: Record<SoundPersonality | 'none', string> = {
	none: 'Sounds are ranked by fit alone; the density is yours.',
	calm: 'Soft, dark and sparse: no booms or hits, gentle attacks, wood and paper.',
	energetic: 'Punchy, bright and rich: whooshes, hits and risers, metal and air.',
	bright: 'Light and sparkling: chimes, pops and UI blips, glass and metal, no low booms.',
	precise: 'Tight and clean interface sounds: clicks, ticks and taps, no swells.',
	mechanical: 'Hard, gritty mechanisms: keys, clicks and thumps, metal and plastic.',
	warm: 'Round, soft and full: thumps, taps and paper, wood and cloth.',
};

export const RUN_MODE_LABELS: Record<SoundRunMode, string> = {
	climb: 'Climb (+1 semitone per step, up to +4)',
	flat: 'Flat (same pitch)',
};

export const TYPING_MODE_LABELS: Record<SoundTypingMode, string> = {
	auto: 'Auto (one key per word above 25 typed per second)',
	keys: 'One key per typed character',
	words: 'One key per word',
	silent: 'Silent (no typing sounds)',
};

export type StyleField = 'personality' | 'runs' | 'typing' | 'musicCarriesCuts' | 'duckUnderTyping';

export function SoundStyleFields(props: {
	value: ResolvedSoundStyle;
	onChange(next: ResolvedSoundStyle, field: StyleField): void;
	/** Fields to show (default all). */
	fields?: readonly StyleField[];
	disabled?: boolean;
	testId?: string;
}) {
	const { value, onChange, disabled } = props;
	const show = (f: StyleField) => !props.fields || props.fields.includes(f);
	const personalityOptions = useMemo(
		() =>
			(['none', ...SOUND_PERSONALITIES] as const).map((p) => ({ value: p, label: PERSONALITY_LABELS[p] })),
		[],
	);
	const runOptions = useMemo(() => SOUND_RUN_MODES.map((m) => ({ value: m, label: RUN_MODE_LABELS[m] })), []);
	const typingOptions = useMemo(
		() => SOUND_TYPING_MODES.map((m) => ({ value: m, label: TYPING_MODE_LABELS[m] })),
		[],
	);
	const set = <K extends StyleField>(k: K, v: ResolvedSoundStyle[K]) => onChange({ ...value, [k]: v }, k);
	const current = value.personality ?? 'none';
	return (
		<fieldset className="flex flex-col gap-1" data-testid={props.testId ?? 'sound-style'}>
			<legend className="mb-1 text-pr-muted">{t('Sound design style')}</legend>
			{show('personality') ? (
				<div className="flex flex-col gap-0.5" data-testid="sound-style-personality">
					<div className="flex items-center gap-2">
						<span className="w-[120px] shrink-0 text-pr-muted">{t('Personality')}</span>
						<Select
							label={t('Personality')}
							value={current}
							disabled={disabled}
							onValueChange={(v) => set('personality', v === 'none' ? null : (v as SoundPersonality))}
							options={personalityOptions}
						/>
					</div>
					<p className="pl-[128px] text-pr-small text-pr-muted" data-testid="sound-style-personality-description">
						{PERSONALITY_DESCRIPTIONS[current]}
					</p>
				</div>
			) : null}
			{show('runs') ? (
				<div className="flex items-center gap-2" data-testid="sound-style-runs">
					<span className="w-[120px] shrink-0 text-pr-muted">{t('Runs')}</span>
					<Select
						label={t('Runs of staggered cues')}
						value={value.runs}
						disabled={disabled}
						onValueChange={(v) => set('runs', v as SoundRunMode)}
						options={runOptions}
					/>
				</div>
			) : null}
			{show('typing') ? (
				<div className="flex items-center gap-2" data-testid="sound-style-typing">
					<span className="w-[120px] shrink-0 text-pr-muted">{t('Typing')}</span>
					<Select
						label={t('Typing sounds')}
						value={value.typing}
						disabled={disabled}
						onValueChange={(v) => set('typing', v as SoundTypingMode)}
						options={typingOptions}
					/>
				</div>
			) : null}
			{show('musicCarriesCuts') ? (
				<Checkbox
					checked={value.musicCarriesCuts}
					disabled={disabled}
					onCheckedChange={(on) => set('musicCarriesCuts', on)}
					label={t('Music carries the cuts (fewer cut sounds under music)')}
				/>
			) : null}
			{show('duckUnderTyping') ? (
				<Checkbox
					checked={value.duckUnderTyping}
					disabled={disabled}
					onCheckedChange={(on) => set('duckUnderTyping', on)}
					label={t('Duck the music 6 dB under typing')}
				/>
			) : null}
		</fieldset>
	);
}
