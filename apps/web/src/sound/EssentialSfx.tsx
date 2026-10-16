// Essential Sound ▸ SFX additions (spec 12 §2.7 "Essential Sound SFX additions", WP2.4b part): the Sound row (name,
// source, licence badge, Swap…, ◀ ▶ variation, Find Similar), Role (Hero / Support / Layer: `soundDesign.setRole`),
// Align (Peak / Start / End: `soundDesign.swap` with the same media re-aligns the clip on the frame its point played
// at), Pitch ± semitones (`soundDesign.swap {pitchSt}`: varispeed up to ±3 st keeping the seeded variation, the Pitch
// Shifter beyond) and the layer position ("Layer 1 of 2"); then the Phase 4 rows (`EssentialSfxMix`: Auto gain with
// its reason and Rebalance, Room send, Stop before next and Build of the linked cue). Each control is one undoable
// command for every selected clip it applies to.
import type { AudioClip, Command, Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, cx, toast } from '@jasper/ui';
import { runCommand } from '../commands/registry.ts';
import { t } from '../i18n/runtime.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import {
	alignOf,
	clipPitchSt,
	clipProvenance,
	clipSoundTitle,
	layersOf,
	licenceWarns,
	sfxOf,
} from './design-model.ts';
import { EssentialSfxMix } from './EssentialSfxMix.tsx';
import { licenseBadge, typeLabel } from './model.ts';

const ROLES = [
	['hero', 'Hero'],
	['support', 'Support'],
	['layer', 'Layer'],
] as const;
const ALIGNS = [
	['peak', 'Peak'],
	['start', 'Start'],
	['end', 'End'],
] as const;

function Segmented<T extends string>(props: {
	label: string;
	value: T | null;
	options: readonly (readonly [T, string])[];
	disabled?: boolean;
	onChange(v: T): void;
	testId: string;
}) {
	return (
		<div role="radiogroup" aria-label={props.label} className="flex gap-[2px]" data-testid={props.testId}>
			{props.options.map(([v, label]) => {
				const on = props.value === v;
				return (
					// biome-ignore lint/a11y/useSemanticElements: segmented control button
					<button
						key={v}
						type="button"
						role="radio"
						aria-checked={on}
						disabled={props.disabled}
						onClick={() => props.onChange(v)}
						className={cx(
							'h-[20px] rounded-pr-control border px-2 text-pr-small disabled:opacity-40',
							on
								? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
								: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
						)}
						data-value={v}
					>
						{on ? '✓ ' : ''}
						{t(label)}
					</button>
				);
			})}
		</div>
	);
}

export function EssentialSfxSection(props: { session: EditorSession; seq: Sequence; clips: AudioClip[] }) {
	const { session, seq, clips } = props;
	const runtime = useShellRuntimeOrNull();
	const doc = session.getCommitted();
	const readOnly = session.getState().readOnly;
	const placed = clips.filter((c) => !!sfxOf(c) || !!clipProvenance(doc, c));
	if (!placed.length) return null;
	const first = placed[0]!;
	const prov = clipProvenance(doc, first);
	const run = (id: string, args?: unknown) => {
		const ctx = runtime?.getCtx();
		if (ctx) void runCommand(id, ctx, args);
	};
	const apply = (label: string, commands: Command[]) => {
		const r = session.apply({ label, origin: 'user', sequenceId: seq.id, commands });
		if (!r.ok) toast({ kind: 'warning', title: r.errors[0]?.message ?? t('Edit failed') });
	};
	const roles = new Set(placed.map((c) => sfxOf(c)?.role ?? null));
	const role = roles.size === 1 ? [...roles][0]! : null;
	const aligns = new Set(placed.map(alignOf));
	const align = aligns.size === 1 ? [...aligns][0]! : null;
	const pitches = new Set(placed.map(clipPitchSt));
	const pitch = pitches.size === 1 ? [...pitches][0]! : null;
	const setPitch = (st: number) => {
		const v = Math.max(-12, Math.min(12, Math.round(st * 100) / 100));
		apply(
			t('Sound Pitch'),
			placed.map(
				(c) => ({ type: 'soundDesign.swap', clipId: c.id, mediaId: c.mediaId, pitchSt: v }) as Command,
			),
		);
	};
	const layers = layersOf(seq, first);
	const badge = prov ? licenseBadge(prov) : null;
	return (
		<section className="border-b border-pr-border-subtle" data-testid="essential-section-sound-design">
			<div className="flex h-7 items-center gap-2 px-2 text-pr-ui text-pr-text">
				▾ {t('Sound Design')}
				{layers.clipIds.length > 1 ? (
					<span className="text-pr-small text-pr-muted" data-testid="essential-layer-position">
						{t('Layer {0} of {1}', layers.index + 1, layers.clipIds.length)}
					</span>
				) : null}
			</div>
			<div className="flex flex-col gap-2 px-3 pb-2">
				<div className="flex flex-col gap-1" data-testid="essential-sound-row">
					<div className="flex items-center gap-1">
						<span className="min-w-0 flex-1 truncate font-semibold" title={clipSoundTitle(doc, first)}>
							{clipSoundTitle(doc, first)}
							{placed.length > 1 ? ` +${placed.length - 1}` : ''}
						</span>
						{badge ? (
							<span
								className={cx(
									'shrink-0 rounded-[2px] border px-1 text-pr-small leading-[14px]',
									prov && licenceWarns(prov.license)
										? 'border-pr-warning text-pr-warning'
										: 'border-pr-border-strong text-pr-muted',
								)}
								title={badge.title}
								data-license-badge={badge.text}
							>
								{badge.text}
							</span>
						) : null}
					</div>
					{prov ? (
						<span className="truncate text-pr-small text-pr-dim">
							{prov.types.map(typeLabel).join(', ') || t('Untyped')}
							{prov.author ? ` · ${prov.author}` : ''}
						</span>
					) : (
						<span className="text-pr-small text-pr-dim">{t('Project audio with a detected peak')}</span>
					)}
					<div className="flex flex-wrap items-center gap-1">
						<Button
							variant="secondary"
							disabled={readOnly}
							onClick={() => run('sound.swap', { clipId: first.id })}
							data-testid="essential-swap"
						>
							Swap…
						</Button>
						<Button
							variant="quiet"
							aria-label={t('Previous Variation')}
							title={t('Previous Variation (Ctrl+Alt+,)')}
							disabled={readOnly || !prov}
							onClick={() => run('sound.prevVariation')}
							data-testid="essential-prev-variation"
						>
							◀
						</Button>
						<Button
							variant="quiet"
							aria-label={t('Next Variation')}
							title={t('Next Variation (Ctrl+Alt+.)')}
							disabled={readOnly || !prov}
							onClick={() => run('sound.nextVariation')}
							data-testid="essential-next-variation"
						>
							▶
						</Button>
						<Button
							variant="quiet"
							disabled={!prov}
							onClick={() => run('sound.findSimilar', { clipId: first.id })}
						>
							Find Similar
						</Button>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-16 shrink-0 text-pr-small text-pr-muted">{t('Role')}</span>
					<Segmented
						label={t('Role')}
						value={role}
						options={ROLES}
						disabled={readOnly}
						testId="essential-role"
						onChange={(r) =>
							apply(t('Sound Role'), [
								{ type: 'soundDesign.setRole', clipIds: placed.map((c) => c.id), role: r } as Command,
							])
						}
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-16 shrink-0 text-pr-small text-pr-muted">{t('Align')}</span>
					<Segmented
						label={t('Align')}
						value={align}
						options={ALIGNS}
						disabled={readOnly}
						testId="essential-align"
						onChange={(a) =>
							apply(
								t('Sound Align'),
								placed.map(
									(c) =>
										({ type: 'soundDesign.swap', clipId: c.id, mediaId: c.mediaId, align: a }) as Command,
								),
							)
						}
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-16 shrink-0 text-pr-small text-pr-muted">{t('Pitch')}</span>
					<Button
						variant="quiet"
						aria-label={t('Pitch down a semitone')}
						disabled={readOnly || (pitch ?? 0) <= -12}
						onClick={() => setPitch((pitch ?? 0) - 1)}
						data-testid="essential-pitch-down"
					>
						−
					</Button>
					<span className="w-14 text-center text-pr-small pr-tabular" data-testid="essential-pitch">
						{pitch === null ? '–' : `${pitch > 0 ? '+' : ''}${pitch} st`}
					</span>
					<Button
						variant="quiet"
						aria-label={t('Pitch up a semitone')}
						disabled={readOnly || (pitch ?? 0) >= 12}
						onClick={() => setPitch((pitch ?? 0) + 1)}
						data-testid="essential-pitch-up"
					>
						+
					</Button>
					{pitch ? (
						<Button variant="quiet" disabled={readOnly} onClick={() => setPitch(0)}>
							Reset
						</Button>
					) : null}
				</div>
				<p className="text-pr-small text-pr-dim">
					{t('Swaps, variations, align and pitch keep the sound on its cue: the peak frame stays.')}
				</p>
				<EssentialSfxMix session={session} seq={seq} clips={placed} />
			</div>
		</section>
	);
}
