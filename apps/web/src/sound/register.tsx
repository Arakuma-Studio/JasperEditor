// Sound design UI registrations (spec 12 §2.7, WP2.4b) into the M2 extension points (ARCHITECTURE §19.10):
// - the timeline clip context menu (`clipMenuExtensions`): library sounds get Swap Sound…, Next / Previous Variation,
//   Align Peak to Playhead / Nearest Cue, Set Peak at Playhead, Find Similar Sounds, Reveal in Sound Library, Add to
//   Palette, Role ▸, Add Layer…, Link / Unlink Layers, Show Licence…; other audio gets Detect Peak and Add to Sound
//   Library… (and the peak entries once it has a peak);
// - the Cue Seam menu (`cueMenuExtensions`): Fill With ▸ (the 5 best-ranked sounds, loaded when the submenu opens;
//   resting on one auditions it in context when the Sound Library's In Context toggle is on), Fill from Library…,
//   Add Layer…;
// - clip badges (`clipDecorations`): the Essential Sound type glyph (click: Essential Sound), "H" for hero, a chain
//   for layers and a warning dot for NC / ND / unknown / undeclared licences;
// - the Program overlay chip "Auditioning: <name>" (`programOverlays`);
// - the Properties "Sound" section (`clipSections`).
import type { SoundEntry } from '@jasper/api';
import type { AudioClip, Clip, Sequence } from '@jasper/project';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Link2, Mic, Music, Wind, Zap } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { getCommand, isCommandEnabled, runCommand } from '../commands/registry.ts';
import {
	type ClipDecorationProps,
	clipDecorations,
	clipMenuExtensions,
	clipSections,
	cueMenuExtensions,
	type MenuItemSpec,
	programOverlays,
} from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { createEditorEngineClient } from '../state/engine.tsx';
import { cuesOf, isFilled } from './cues/model.ts';
import {
	alignedFrameOf,
	clipProvenance,
	isLayered,
	isLibraryClip,
	layersLinked,
	layersOf,
	licenceWarns,
	paletteOf,
	sfxOf,
} from './design-model.ts';
import { cueCandidates } from './fill.ts';
import { auditionInContext, inContextStore, stopInContext } from './in-context.ts';
import { formatSeconds, typeLabel } from './model.ts';
import { soundLibraryPrefs } from './prefs.ts';
import { SoundSection } from './SoundSection.tsx';

const AUDIO_TYPE_GLYPHS = { dialogue: Mic, music: Music, sfx: Zap, ambience: Wind } as const;
const AUDIO_TYPE_NAMES: Record<keyof typeof AUDIO_TYPE_GLYPHS, string> = {
	dialogue: 'Dialogue',
	music: 'Music',
	sfx: 'SFX',
	ambience: 'Ambience',
};
type AudioTypeId = keyof typeof AUDIO_TYPE_GLYPHS;

const typeOf = (c: Clip): AudioTypeId | null => {
	const ty = (c as { essential?: { type?: unknown } }).essential?.type;
	return typeof ty === 'string' && ty in AUDIO_TYPE_GLYPHS ? (ty as AudioTypeId) : null;
};

/** Badges need this much clip width beyond the audio-type glyph (the host shows badges from 40 px). */
export const BADGE_FULL_PX = 80;

/** The badges of a clip, in order (pure; tests). */
export function clipBadges(
	seq: Sequence | null,
	clip: Clip,
	opts: { width: number; licenceWarning: boolean },
): { type: AudioTypeId | null; hero: boolean; layer: boolean; warn: boolean } {
	const full = opts.width >= BADGE_FULL_PX;
	const sfx = sfxOf(clip);
	return {
		type: typeOf(clip),
		hero: full && sfx?.role === 'hero',
		layer: full && !!seq && isLayered(seq, clip),
		warn: opts.licenceWarning,
	};
}

function SoundBadges(p: ClipDecorationProps) {
	const session = useSessionOrNull();
	const runtime = useShellRuntimeOrNull();
	const s = session?.getState();
	const doc = session?.getCommitted();
	const seq = (s?.activeSequenceId ? doc?.sequences[s.activeSequenceId] : undefined) ?? null;
	const lib = doc ? clipProvenance(doc, p.clip) : null;
	const b = clipBadges(seq?.clips[p.clip.id] ? seq : null, p.clip, {
		width: p.w,
		licenceWarning: !!lib && licenceWarns(lib.license),
	});
	const focusEssential = (e: ReactMouseEvent | ReactPointerEvent) => {
		e.stopPropagation();
		e.preventDefault();
		if (e.type !== 'click' || !session) return;
		session.select('timeline', [p.clip.id], 'replace', { primary: p.clip.id });
		const ctx = runtime?.getCtx();
		if (ctx) void runCommand('panel.focus.essentialSound', ctx);
	};
	const layers = b.layer && seq ? layersOf(seq, p.clip) : null;
	const Glyph = b.type ? AUDIO_TYPE_GLYPHS[b.type] : null;
	return (
		<span className="flex shrink-0 items-center gap-[3px]" data-sound-badges={p.clip.id}>
			{b.warn ? (
				<span
					role="img"
					aria-label={t('Licence needs attention: {0}', lib?.license ?? '?')}
					title={t('Licence needs attention: {0}', lib?.license ?? '?')}
					className="inline-block size-[6px] rounded-full"
					style={{ background: 'var(--pr-warning)' }}
					data-sound-badge="licence"
				/>
			) : null}
			{layers ? (
				<span
					role="img"
					aria-label={t('Layer {0} of {1}', layers.index + 1, layers.clipIds.length)}
					title={t('Layer {0} of {1}', layers.index + 1, layers.clipIds.length)}
					className="inline-flex text-pr-strong opacity-90"
					data-sound-badge="layer"
				>
					<Link2 size={10} aria-hidden="true" />
				</span>
			) : null}
			{b.hero ? (
				<span
					role="img"
					aria-label={t('Hero sound')}
					title={t('Hero sound')}
					className="rounded-[2px] border border-pr-strong px-[2px] text-[9px] leading-[10px] font-semibold text-pr-strong"
					data-sound-badge="hero"
				>
					H
				</span>
			) : null}
			{Glyph && b.type ? (
				<button
					type="button"
					tabIndex={-1}
					aria-label={t('Audio type {0}: open Essential Sound', AUDIO_TYPE_NAMES[b.type])}
					title={t('{0} · click for Essential Sound', AUDIO_TYPE_NAMES[b.type])}
					className="pointer-events-auto inline-flex cursor-pointer text-pr-strong opacity-90 hover:opacity-100"
					onPointerDown={focusEssential}
					onMouseDown={(e) => e.stopPropagation()}
					onClick={focusEssential}
					onDoubleClick={(e) => e.stopPropagation()}
					data-sound-badge={`type-${b.type}`}
				>
					<Glyph size={10} aria-hidden="true" />
				</button>
			) : null}
		</span>
	);
}

/** "In context: <name>" over the Program monitor while an In Context audition (or a swap window) plays. */
function AuditionChip() {
	const st = useStoreSelector(inContextStore, (s) => s);
	if (!st.active && !st.loading) return null;
	return (
		<div className="pointer-events-none absolute top-2 left-2 z-10" data-testid="sound-audition-chip">
			<span
				className="inline-flex items-center gap-1 rounded-pr-pill border border-pr-accent bg-pr-panel px-2 py-[1px] text-pr-small text-pr-text shadow-pr-floating"
				role="status"
				aria-live="polite"
			>
				<Zap size={10} aria-hidden="true" />
				{st.loading ? t('Preparing {0}…', st.title ?? '') : t('Auditioning: {0}', st.title ?? '')}
			</span>
		</div>
	);
}

/** Runs a UI command from a menu (the host's runner when it has one, else the shell's context). */
function runFrom(
	ctxRun: ((id: string, args?: unknown) => void) | undefined,
	id: string,
	args?: unknown,
): void {
	if (ctxRun) ctxRun(id, args);
}

const hoverTimers = new Set<ReturnType<typeof setTimeout>>();
function clearHover(): void {
	for (const h of hoverTimers) clearTimeout(h);
	hoverTimers.clear();
}

let registered = false;

export function registerSoundDesignUi(): void {
	if (registered) return;
	registered = true;

	programOverlays.register({
		id: 'sound.auditionChip',
		active: () => true,
		component: AuditionChip,
		order: 90,
	});

	clipDecorations.register({
		id: 'sound.badges',
		order: 30,
		appliesTo: (c) => c.kind === 'audio' && (typeOf(c) !== null || !!(c as { sfx?: unknown }).sfx),
		badge: SoundBadges,
	});

	clipSections.register({
		id: 'sound',
		title: 'Sound',
		order: 15,
		defaultOpen: true,
		appliesTo: (clips) => clips.length === 1 && clips[0]!.kind === 'audio',
		component: SoundSection,
	});

	clipMenuExtensions.register({
		id: 'sound-design',
		order: 45,
		items: ({ session, clip, runCommand: run }) => {
			if (clip.kind !== 'audio' || !run) return [];
			const s = session.getState();
			const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
			if (!seq?.clips[clip.id]) return [];
			const doc = s.document;
			const readOnly = s.readOnly;
			const args = { clipId: clip.id };
			const item = (
				label: string,
				id: string,
				extra: Partial<Extract<MenuItemSpec, { kind: 'item' }>> = {},
			) =>
				({
					kind: 'item',
					label,
					disabled: readOnly,
					run: () => runFrom(run, id, args),
					...extra,
				}) as MenuItemSpec;
			const library = isLibraryClip(doc, clip);
			const hasPeak = alignedFrameOf(doc, seq, clip) !== null;
			const playhead = session.transport.getState().frame;
			const overPlayhead = playhead >= clip.start && playhead < clip.start + clip.duration;
			const peakItems: MenuItemSpec[] = hasPeak
				? [
						item(t('Swap Sound…'), 'sound.swap', { shortcut: 'Alt+Shift+S' }),
						...(library
							? [
									item(t('Next Variation'), 'sound.nextVariation', { shortcut: 'Ctrl+Alt+.' }),
									item(t('Previous Variation'), 'sound.prevVariation', { shortcut: 'Ctrl+Alt+,' }),
								]
							: []),
						item(t('Align Peak to Playhead'), 'sound.alignPeakToPlayhead', { shortcut: 'Ctrl+Alt+P' }),
						item(t('Align Peak to Nearest Cue'), 'sound.alignPeakToNearestCue', {
							disabled: readOnly || cuesOf(seq).length === 0,
						}),
					]
				: [];
			const layers = layersOf(seq, clip).clipIds;
			if (library) {
				const sfx = sfxOf(clip);
				const soundId = clipProvenance(doc, clip)?.soundId ?? null;
				return [
					...peakItems,
					item(t('Set Peak at Playhead'), 'sound.setPeakAtPlayhead', { disabled: readOnly || !overPlayhead }),
					{ kind: 'separator' },
					item(t('Find Similar Sounds'), 'sound.findSimilar', { disabled: false }),
					item(t('Reveal in Sound Library'), 'sound.revealInLibrary', { disabled: false }),
					item(t('Add to Palette'), 'sound.addToPalette', {
						checked: !!soundId && paletteOf(seq).includes(soundId),
					}),
					{
						kind: 'submenu',
						label: t('Role'),
						items: (['hero', 'support', 'layer'] as const).map((r) =>
							item(t(r === 'hero' ? 'Hero' : r === 'support' ? 'Support' : 'Layer'), `sound.setRole.${r}`, {
								checked: sfx?.role === r,
							}),
						),
					},
					item(t('Add Layer…'), 'sound.addLayer'),
					...(layers.length > 1
						? [
								item(
									layersLinked(seq, layers) ? t('Unlink Layers') : t('Link Layers'),
									'sound.toggleLinkLayers',
								),
							]
						: []),
					item(t('Show Licence…'), 'sound.showLicense', { disabled: false }),
				];
			}
			return [
				item(t('Detect Peak'), 'sound.detectPeak'),
				...(hasPeak
					? [
							...peakItems,
							item(t('Set Peak at Playhead'), 'sound.setPeakAtPlayhead', {
								disabled: readOnly || !overPlayhead,
							}),
							item(t('Add Layer…'), 'sound.addLayer'),
						]
					: []),
				item(t('Add to Sound Library…'), 'sound.addToLibrary', { disabled: false }),
			];
		},
	});

	cueMenuExtensions.register({
		id: 'sound-fill',
		order: 10,
		items: ({ session, sequenceId, cueId, runCommand: run }) => {
			const s = session.getState();
			const seq = s.document.sequences[sequenceId];
			const cue = seq ? cuesOf(seq).find((c) => c.id === cueId) : undefined;
			if (!seq || !cue) return [];
			const readOnly = s.readOnly;
			const filled = isFilled(cue, seq.clips);
			const fillWith: MenuItemSpec = {
				kind: 'submenu',
				label: t('Fill With'),
				items: [{ kind: 'item', label: t('Searching sounds…'), disabled: true, run: () => undefined }],
				load: async () => {
					let ranked: SoundEntry[] = [];
					try {
						ranked = await cueCandidates(createEditorEngineClient(), session, seq, cue, 8);
					} catch (e) {
						return [
							{
								kind: 'item',
								label: t('The search failed: {0}', e instanceof Error ? e.message : String(e)),
								disabled: true,
								run: () => undefined,
							},
						];
					}
					if (!ranked.length)
						return [
							{ kind: 'item', label: t('No sound matches this cue'), disabled: true, run: () => undefined },
						];
					return ranked.slice(0, 5).map(
						(e): MenuItemSpec => ({
							kind: 'item',
							label: `${e.title || e.id} · ${e.types.slice(0, 2).map(typeLabel).join(', ')} · ${formatSeconds(e.format.durationSec)}`,
							disabled: readOnly,
							run: () => {
								clearHover();
								stopInContext({ returnToAnchor: false });
								runFrom(run, 'sound.fillCue', {
									cueId: cue.id,
									soundId: e.id,
									...(filled ? { layer: false } : {}),
								});
							},
							onHighlight: () => {
								if (!soundLibraryPrefs.get().inContext) return;
								clearHover();
								const h = setTimeout(() => {
									hoverTimers.delete(h);
									void auditionInContext(session, createEditorEngineClient(), e);
								}, 350);
								hoverTimers.add(h);
							},
							onUnhighlight: () => {
								clearHover();
								if (inContextStore.getState().soundId === e.id) stopInContext();
							},
						}),
					);
				},
			};
			return [
				fillWith,
				{
					kind: 'item',
					label: t('Fill from Library…'),
					disabled: readOnly,
					run: () => runFrom(run, 'soundLibrary.fillCue', { cueId: cue.id }),
				},
				{
					kind: 'item',
					label: t('Add Layer…'),
					disabled: readOnly || !filled,
					run: () => runFrom(run, 'sound.addCueLayer', { cueId: cue.id }),
				},
			];
		},
	});
}

/** Whether a UI command is enabled for the shell's context (badges and sections use it for buttons). */
export function commandEnabled(
	id: string,
	ctx: Parameters<typeof isCommandEnabled>[1] | null | undefined,
): boolean {
	const cmd = getCommand(id);
	return !!cmd && !!ctx && isCommandEnabled(cmd, ctx);
}

export type { AudioClip };
