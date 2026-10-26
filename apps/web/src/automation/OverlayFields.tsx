// Sequence ▸ Automate ▸ Reactions… / Slide Overlays… / Music Bed… / Stingers… (spec 15 EA-023…EA-026, EA-040): the
// parameter fields of the overlay passes in the automation dialog (AutomationDialog.tsx hosts them, runs the dry run
// and proposes). Every field writes the pass's plain-data parameters (style recipes store the same objects); absent
// values keep the measured defaults. The reaction pictures and the songs are the user's own files: a project bin or a
// folder (Browse… in the desktop app), never shipped ones.
import {
	AUTOMATION_DEFAULTS,
	type ProjectDocument,
	REACTION_SLOTS,
	REACTION_WORD_LISTS,
	type Sequence,
} from '@jasper/project';
import { Button, Checkbox, Select, TextField } from '@jasper/ui';
import { useEffect, useId, useState } from 'react';
import { t, translateName } from '../i18n/runtime.ts';
import { getDesktopBridge } from '../runtime/platform.ts';
import {
	bool,
	NumberRow,
	num,
	type Params,
	Row,
	SfxFields,
	ShareSlider,
	str,
	trackOptions,
} from './fields.tsx';

type FieldsProps = { seq: Sequence; doc: ProjectDocument; params: Params; set(k: string, v: unknown): void };

/** The project's bins, depth first (name and id). */
export function projectBins(doc: ProjectDocument): { id: string; name: string }[] {
	const out: { id: string; name: string }[] = [];
	const seen = new Set<string>();
	const visit = (ids: readonly string[], depth: number) => {
		if (depth > 32) return;
		for (const id of ids) {
			const it = doc.items?.[id];
			if (it?.kind !== 'bin' || seen.has(id)) continue;
			seen.add(id);
			out.push({ id: it.id, name: it.name });
			visit(Array.isArray(it.children) ? it.children : [], depth + 1);
		}
	};
	visit(doc.rootItems ?? [], 0);
	return out;
}

/** A bin whose name suggests the role ("Reactions", "Emotes" / "Music", "Songs"), for the dialog's first source. */
export function guessBin(doc: ProjectDocument, role: 'image' | 'audio'): string | null {
	const re = role === 'image' ? /reac|emot|sticker/i : /music|m[uú]sica|song|canci/i;
	return projectBins(doc).find((b) => re.test(b.name))?.name ?? null;
}

/** Where a role's files come from: a bin (by name; its id when names repeat) or an engine folder. */
export function AssetSourceFields(p: {
	doc: ProjectDocument;
	value: Params | undefined;
	kind: 'image' | 'audio';
	onChange(v: Params | undefined): void;
}) {
	const v = p.value ?? {};
	const bins = projectBins(p.doc);
	const given =
		typeof v.folder === 'string'
			? 'folder'
			: Array.isArray(v.mediaIds) && v.bin === undefined
				? 'media'
				: 'bin';
	// the choice stays while its value is still empty (a folder not typed yet)
	const [chosen, setChosen] = useState<'bin' | 'folder' | 'media' | null>(null);
	const mode = p.value ? given : (chosen ?? given);
	const [path, setPath] = useState(typeof v.folder === 'string' ? v.folder : '');
	useEffect(() => setPath(typeof v.folder === 'string' ? v.folder : ''), [v.folder]);
	const desktop = getDesktopBridge();
	const id = useId();
	const binValue = (b: { id: string; name: string }) =>
		bins.filter((x) => x.name === b.name).length > 1 ? b.id : b.name;
	const commit = () => {
		const trimmed = path.trim();
		p.onChange(trimmed ? { folder: trimmed } : undefined);
	};
	const label = p.kind === 'image' ? t('Pictures from') : t('Songs from');
	return (
		<fieldset className="flex flex-col gap-1" data-testid="automation-assets">
			<legend className="mb-1 text-pr-muted">
				{p.kind === 'image' ? t('Your reaction pictures') : t('Your songs')}
			</legend>
			<Row label={label}>
				<Select
					label={label}
					value={mode}
					onValueChange={(m) => {
						setChosen(m as 'bin' | 'folder' | 'media');
						if (m === 'bin') {
							const first = bins[0];
							p.onChange(first ? { bin: binValue(first) } : undefined);
						} else if (m === 'folder') p.onChange(path.trim() ? { folder: path.trim() } : undefined);
					}}
					options={[
						{ value: 'bin', label: t('A bin of this project'), disabled: !bins.length },
						{ value: 'folder', label: t('A folder') },
						...(mode === 'media'
							? [{ value: 'media', label: t('{0} chosen media', (v.mediaIds as unknown[]).length) }]
							: []),
					]}
				/>
			</Row>
			{mode === 'bin' ? (
				<Row label={t('Bin')} testId="automation-assets-bin">
					<Select
						label={t('Bin')}
						value={typeof v.bin === 'string' ? v.bin : ''}
						onValueChange={(b) => p.onChange({ bin: b })}
						options={[
							...(typeof v.bin === 'string' && !bins.some((b) => binValue(b) === v.bin)
								? [{ value: v.bin, label: t('{0} (not found)', v.bin) }]
								: []),
							...(typeof v.bin !== 'string' ? [{ value: '', label: t('Choose a bin…') }] : []),
							...bins.map((b) => ({ value: binValue(b), label: b.name })),
						]}
					/>
				</Row>
			) : mode === 'folder' ? (
				<Row label={t('Folder')} testId="automation-assets-folder">
					<TextField
						id={id}
						aria-label={t('Folder')}
						className="min-w-0 flex-1"
						placeholder={p.kind === 'image' ? '/path/to/your/reactions' : '/path/to/your/music'}
						value={path}
						onChange={(e) => setPath(e.target.value)}
						onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								commit();
							}
						}}
						data-testid="automation-assets-path"
					/>
					{desktop ? (
						<Button
							variant="secondary"
							onClick={() =>
								void desktop.pickFolder().then((picked) => {
									if (picked) {
										setPath(picked);
										p.onChange({ folder: picked });
									}
								})
							}
						>
							{t('Browse…')}
						</Button>
					) : null}
				</Row>
			) : null}
			<p className="pl-[140px] text-pr-small text-pr-muted">
				{p.kind === 'image'
					? t('Only your own files are used; folder files are added to the project when you apply.')
					: t('Only your own songs are used; folder files are added to the project when you apply.')}
			</p>
		</fieldset>
	);
}

/** One phrase per line ↔ a list (empty = the built-in list). */
function PhraseList(p: {
	label: string;
	value: unknown;
	placeholder: readonly string[];
	onChange(v: string[] | undefined): void;
	testId: string;
}) {
	const id = useId();
	const list = Array.isArray(p.value) ? (p.value as string[]) : null;
	const [text, setText] = useState(list ? list.join('\n') : '');
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={id} className="text-pr-muted">
				{p.label}
			</label>
			<textarea
				id={id}
				value={text}
				placeholder={p.placeholder.join('\n')}
				onChange={(e) => setText(e.target.value)}
				onBlur={() => {
					const lines = text
						.split('\n')
						.map((x) => x.trim())
						.filter(Boolean)
						.slice(0, 500);
					p.onChange(lines.length ? lines : undefined);
				}}
				className="h-20 w-full resize-y rounded-pr-control border border-transparent bg-pr-field px-2 py-1 font-pr text-pr-ui text-pr-text hover:border-pr-border-strong focus:border-pr-focus focus:outline-none"
				data-testid={p.testId}
			/>
		</div>
	);
}

export function ReactionFields(p: FieldsProps) {
	const vertical = p.seq.settings.height > p.seq.settings.width;
	const D = AUTOMATION_DEFAULTS;
	const tr = (p.params.triggers ?? {}) as Params;
	const wob = (p.params.wobble ?? {}) as Params;
	const words = (p.params.words ?? {}) as Params;
	const scale = (p.params.scale ?? {}) as Params;
	const lang = str(words.language, 'auto');
	const builtIn =
		lang !== 'auto' && REACTION_WORD_LISTS[lang] ? REACTION_WORD_LISTS[lang]! : REACTION_WORD_LISTS.es!;
	const slots = Array.isArray(p.params.slots)
		? (p.params.slots as { name?: string }[])
		: vertical
			? REACTION_SLOTS.vertical
			: REACTION_SLOTS.landscape;
	const setIn = (k: string, cur: Params, key: string, v: unknown) => {
		const next = { ...cur, [key]: v };
		for (const x of Object.keys(next)) if (next[x] === undefined) delete next[x];
		p.set(k, Object.keys(next).length ? next : undefined);
	};
	return (
		<>
			<AssetSourceFields
				doc={p.doc}
				kind="image"
				value={p.params.assets as Params | undefined}
				onChange={(v) => p.set('assets', v)}
			/>
			<Row label={t('A-roll track')} testId="automation-track">
				<Select
					label={t('A-roll track')}
					value={str(p.params.track, 'auto')}
					onValueChange={(v) => p.set('track', v === 'auto' ? undefined : v)}
					options={trackOptions(p.seq, t('Automatic (most picture)'))}
				/>
			</Row>
			<fieldset className="flex flex-col gap-1" data-testid="automation-triggers">
				<legend className="mb-1 text-pr-muted">{t('Triggers')}</legend>
				<Checkbox
					checked={bool(tr.words, true)}
					onCheckedChange={(c) => setIn('triggers', tr, 'words', c ? undefined : false)}
					label={t('Calls to action and exclamations in the transcript')}
				/>
				<Checkbox
					checked={bool(tr.markers, true)}
					onCheckedChange={(c) => setIn('triggers', tr, 'markers', c ? undefined : false)}
					label={t(
						'Markers named “{0}” or after a picture',
						str(p.params.markerMatch, D.reactionMarkerMatch),
					)}
				/>
				<Checkbox
					checked={bool(tr.speakerNotVisible, false)}
					onCheckedChange={(c) => setIn('triggers', tr, 'speakerNotVisible', c || undefined)}
					label={t('Where face tracking sees no face on the A-roll (run Track Faces first)')}
				/>
			</fieldset>
			<Row label={t('Marker name')} testId="automation-marker-match">
				<TextField
					aria-label={t('Marker name')}
					className="min-w-0 flex-1"
					value={str(p.params.markerMatch, D.reactionMarkerMatch)}
					onChange={(e) =>
						p.set(
							'markerMatch',
							e.target.value.trim() && e.target.value.trim() !== D.reactionMarkerMatch
								? e.target.value.trim()
								: undefined,
						)
					}
				/>
			</Row>
			<Row label={t('Word lists')} testId="automation-language">
				<Select
					label={t('Word lists')}
					value={lang}
					onValueChange={(v) => setIn('words', words, 'language', v === 'auto' ? undefined : v)}
					options={[
						{ value: 'auto', label: t('The transcript’s language') },
						{ value: 'es', label: t('Spanish') },
						{ value: 'en', label: t('English') },
					]}
				/>
			</Row>
			<div className="grid grid-cols-2 gap-2 pl-[140px]">
				<PhraseList
					label={t('Calls to action (one per line)')}
					value={words.cta}
					placeholder={builtIn.cta}
					onChange={(v) => setIn('words', words, 'cta', v)}
					testId="automation-words-cta"
				/>
				<PhraseList
					label={t('Exclamations (one per line)')}
					value={words.exclamations}
					placeholder={builtIn.exclamations}
					onChange={(v) => setIn('words', words, 'exclamations', v)}
					testId="automation-words-exclamations"
				/>
			</div>
			<Row label={t('Slots')} testId="automation-slots">
				<span className="text-pr-small text-pr-muted">
					{slots.map((s, i) => (s.name ? (translateName(s.name) ?? s.name) : t('Slot {0}', i + 1))).join(' · ')}
				</span>
			</Row>
			<NumberRow
				label={t('Length')}
				unit="s"
				precision={1}
				value={num(
					p.params.durationSeconds,
					vertical ? D.reactionSecondsVertical : D.reactionSecondsLandscape,
				)}
				min={0.2}
				max={60}
				onCommit={(v) => p.set('durationSeconds', v)}
				testId="automation-duration"
			/>
			<NumberRow
				label={t('Snap to a cut within')}
				unit="s"
				precision={2}
				value={num(p.params.snapSeconds, D.reactionSnapSeconds)}
				min={0}
				max={5}
				onCommit={(v) => p.set('snapSeconds', v)}
				testId="automation-snap"
			/>
			<NumberRow
				label={t('At most per minute')}
				precision={1}
				value={num(
					p.params.maxPerMinute,
					vertical ? D.reactionMaxPerMinuteVertical : D.reactionMaxPerMinuteLandscape,
				)}
				min={0}
				max={120}
				onCommit={(v) => p.set('maxPerMinute', v)}
				testId="automation-rate"
			/>
			<NumberRow
				label={t('Scale from')}
				unit="%"
				value={num(scale.min, D.reactionScaleMin)}
				min={1}
				max={1000}
				onCommit={(v) => p.set('scale', { min: v, max: Math.max(v, num(scale.max, D.reactionScaleMax)) })}
				testId="automation-scale-min"
			/>
			<NumberRow
				label={t('Scale to')}
				unit="%"
				value={num(scale.max, D.reactionScaleMax)}
				min={1}
				max={1000}
				onCommit={(v) => p.set('scale', { min: Math.min(v, num(scale.min, D.reactionScaleMin)), max: v })}
				testId="automation-scale-max"
			/>
			<div className="flex flex-col gap-1 pl-[140px]">
				<Checkbox
					checked={bool(wob.enabled, true)}
					onCheckedChange={(c) => setIn('wobble', wob, 'enabled', c ? undefined : false)}
					label={t(
						'S_Shake wobble (Amplitude {0}, Frequency {1})',
						num(wob.amplitude, D.reactionWobbleAmplitude),
						num(wob.frequency, D.reactionWobbleFrequency),
					)}
				/>
			</div>
		</>
	);
}

const DIRECTION_LABELS: Record<string, string> = { down: 'Down', up: 'Up', left: 'Left', right: 'Right' };

export function SlideFields(p: FieldsProps) {
	const D = AUTOMATION_DEFAULTS;
	const dirs = (p.params.directions ?? {}) as Record<string, number>;
	const given = Object.keys(dirs).length > 0;
	const weight = (d: keyof typeof D.slideDirections) => (given ? (dirs[d] ?? 0) : D.slideDirections[d]);
	const total = (['down', 'up', 'left', 'right'] as const).reduce((a, d) => a + weight(d), 0) || 1;
	return (
		<>
			<Row label={t('A-roll track')} testId="automation-track">
				<Select
					label={t('A-roll track')}
					value={str(p.params.track, 'auto')}
					onValueChange={(v) => p.set('track', v === 'auto' ? undefined : v)}
					options={trackOptions(p.seq, t('Automatic (most picture)'))}
				/>
			</Row>
			<ShareSlider
				label={t('Heads that slide in')}
				value={num(p.params.heads, D.slideHeads)}
				defaultValue={D.slideHeads}
				onChange={(v) => p.set('heads', v)}
				testId="automation-heads"
			/>
			<ShareSlider
				label={t('Tails that slide out')}
				value={num(p.params.tails, D.slideTails)}
				defaultValue={D.slideTails}
				onChange={(v) => p.set('tails', v)}
				testId="automation-tails"
			/>
			<NumberRow
				label={t('Length')}
				unit={t('frames')}
				value={num(p.params.frames, D.slideFrames)}
				min={2}
				max={600}
				onCommit={(v) => p.set('frames', v)}
				testId="automation-slide-frames"
			/>
			<fieldset className="flex flex-col gap-1" data-testid="automation-directions">
				<legend className="mb-1 text-pr-muted">{t('Directions')}</legend>
				{(['down', 'up', 'left', 'right'] as const).map((d) => (
					<ShareSlider
						key={d}
						label={DIRECTION_LABELS[d]!}
						value={weight(d) / total}
						defaultValue={D.slideDirections[d] / 101}
						onChange={(v) => {
							const next: Record<string, number> = {};
							for (const x of ['down', 'up', 'left', 'right'] as const)
								next[x] = x === d ? Math.round(v * 100) : Math.round((weight(x) / total) * 100);
							p.set('directions', next);
						}}
						testId={`automation-direction-${d}`}
					/>
				))}
			</fieldset>
			<Row label={t('Motion blur')} testId="automation-motion-blur">
				<Select
					label={t('Motion blur')}
					value={str(p.params.motionBlur, D.slideMotionBlur)}
					onValueChange={(v) => p.set('motionBlur', v === D.slideMotionBlur ? undefined : v)}
					options={[
						{ value: 'off', label: t('Off') },
						{ value: 'low', label: t('Low') },
						{ value: 'medium', label: t('Medium') },
						{ value: 'high', label: t('High') },
					]}
				/>
			</Row>
		</>
	);
}

export function MusicFields(p: FieldsProps) {
	const vertical = p.seq.settings.height > p.seq.settings.width;
	const D = AUTOMATION_DEFAULTS;
	const intro = (p.params.intro ?? {}) as Params;
	const duck = (p.params.duck ?? {}) as Params;
	const bed =
		p.params.bedSeconds === undefined
			? vertical
				? null
				: D.musicBedSeconds
			: (p.params.bedSeconds as number | null);
	return (
		<>
			<AssetSourceFields
				doc={p.doc}
				kind="audio"
				value={p.params.assets as Params | undefined}
				onChange={(v) => p.set('assets', v)}
			/>
			<Row label={t('Order')} testId="automation-order">
				<Select
					label={t('Order')}
					value={str(p.params.order, 'playlist')}
					onValueChange={(v) => p.set('order', v === 'playlist' ? undefined : v)}
					options={[
						{ value: 'playlist', label: t('As listed') },
						{ value: 'shuffle', label: t('Shuffled (by the seed)') },
					]}
				/>
			</Row>
			<div className="flex flex-col gap-1 pl-[140px]">
				<Checkbox
					checked={bed === null}
					onCheckedChange={(c) => p.set('bedSeconds', c ? null : D.musicBedSeconds)}
					label={t('One bed per song (no switching)')}
				/>
			</div>
			{bed !== null ? (
				<NumberRow
					label={t('Switch at the first cut after')}
					unit="s"
					value={bed}
					min={5}
					max={3600}
					onCommit={(v) => p.set('bedSeconds', v)}
					testId="automation-bed-seconds"
				/>
			) : null}
			<Row label={t('Cuts on')} testId="automation-track">
				<Select
					label={t('Cuts on')}
					value={str(p.params.track, 'auto')}
					onValueChange={(v) => p.set('track', v === 'auto' ? undefined : v)}
					options={trackOptions(p.seq, t('Every picture cut'))}
				/>
			</Row>
			<NumberRow
				label={t('Clip gain')}
				unit="dB"
				precision={1}
				value={num(p.params.gainDb, D.musicGainDb)}
				min={-60}
				max={12}
				onCommit={(v) => p.set('gainDb', v)}
				testId="automation-music-gain"
			/>
			<div className="flex flex-col gap-1 pl-[140px]">
				<Checkbox
					checked={bool(intro.enabled, vertical)}
					onCheckedChange={(c) => p.set('intro', { ...intro, enabled: c })}
					label={t('Intro at {0} dB until the first cut', num(intro.gainDb, D.musicIntroGainDb))}
				/>
				<Checkbox
					checked={bool(duck.enabled, false)}
					onCheckedChange={(c) => p.set('duck', { ...duck, enabled: c })}
					label={t('Duck {0} dB under dialogue', num(duck.amountDb, D.musicDuckDb))}
				/>
			</div>
		</>
	);
}

export function StingerFields(p: FieldsProps) {
	const D = AUTOMATION_DEFAULTS;
	const sound = str(p.params.sound, 'generated');
	return (
		<>
			<Row label={t('Punchlines are')} testId="automation-match">
				<Select
					label={t('Punchlines are')}
					value={str(p.params.match, 'both')}
					onValueChange={(v) => p.set('match', v === 'both' ? undefined : v)}
					options={[
						{ value: 'both', label: t('Loud and written with “!”') },
						{ value: 'either', label: t('Loud or written with “!”') },
						{ value: 'loudness', label: t('Loud (a loudness peak)') },
						{ value: 'exclamation', label: t('Written with “!”') },
					]}
				/>
			</Row>
			<NumberRow
				label={t('Louder than around by')}
				unit="LU"
				precision={1}
				value={num(p.params.thresholdLu, D.stingerThresholdLu)}
				min={1}
				max={40}
				onCommit={(v) => p.set('thresholdLu', v)}
				testId="automation-threshold"
			/>
			<NumberRow
				label={t('Length')}
				unit={t('frames')}
				value={num(p.params.frames, D.stingerFrames)}
				min={1}
				max={600}
				onCommit={(v) => p.set('frames', v)}
				testId="automation-stinger-frames"
			/>
			<NumberRow
				label={t('At most per minute')}
				precision={1}
				value={num(p.params.maxPerMinute, D.stingerMaxPerMinute)}
				min={0}
				max={60}
				onCommit={(v) => p.set('maxPerMinute', v)}
				testId="automation-rate"
			/>
			<NumberRow
				label={t('At least apart')}
				unit="s"
				value={num(p.params.minGapSeconds, D.stingerMinGapSeconds)}
				min={0}
				max={600}
				onCommit={(v) => p.set('minGapSeconds', v)}
				testId="automation-gap"
			/>
			<Row label={t('Noise sound')} testId="automation-stinger-sound">
				<Select
					label={t('Noise sound')}
					value={sound}
					onValueChange={(v) => p.set('sound', v === 'generated' ? undefined : v)}
					options={[
						{ value: 'generated', label: t('Generated TV static') },
						{ value: 'library', label: t('A library sound') },
						{ value: 'none', label: t('None') },
					]}
				/>
			</Row>
			{sound !== 'none' ? (
				<NumberRow
					label={t('Sound gain')}
					unit="dB"
					precision={1}
					value={num(p.params.gainDb, D.stingerGainDb)}
					min={-60}
					max={12}
					onCommit={(v) => p.set('gainDb', v)}
					testId="automation-stinger-gain"
				/>
			) : null}
			{sound === 'library' ? (
				<SfxFields
					value={p.params.sfx as Params | undefined}
					label={t('Library sounds of the sound type below')}
					onChange={(v) => p.set('sfx', Object.keys(v).length ? v : undefined)}
				/>
			) : null}
		</>
	);
}
