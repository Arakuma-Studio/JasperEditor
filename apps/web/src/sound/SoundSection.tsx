// Properties "Sound" and "Cue" sections (spec 12 §2.7 "Properties", P2-R7).
// - Sound (an audio clip): its library sound's descriptors (types, length, peak, onset, centroid, loudness), where the
//   peak plays, the cue it fills (select it), the licence and the credit line exactly as the Sound Credits export prints
//   it (`creditLine`), Show Licence…; for project audio, Detect Peak.
// - Cue (one selected cue, nothing else selected): timecode, role, kind, align, pan, pitch, build, stop-before, reason
//   and the clips that fill it; every field is an edit through `soundCue.update` (one undo step).
import {
	type Command,
	CUE_ALIGNS,
	CUE_KINDS,
	CUE_WEIGHTS,
	creditLine,
	FLICKS_PER_SECOND,
	licenseClass,
	licenseUrlOf,
	type Rational,
	requiresAttribution,
	type Sequence,
	type SoundCue,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { Button, toast } from '@jasper/ui';
import type { ReactNode } from 'react';
import { runCommand } from '../commands/registry.ts';
import type { ClipSectionProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { CheckboxField, SelectField, TextField } from '../panels/properties/controls/fields.tsx';
import { Section } from '../panels/properties/controls/Section.tsx';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { CUE_ALIGN_LABELS, CUE_WEIGHT_LABELS, cuesOf, kindLabel, placedClips } from './cues/model.ts';
import { STOP_BEFORE_DEFAULT } from './cues/seam.ts';
import {
	alignedFrameOf,
	clipProvenance,
	cueLabel,
	cueOfClip,
	layersOf,
	licenceWarns,
	seqTimecode,
	sfxOf,
	trackLabelOf,
} from './design-model.ts';
import { formatSeconds, LICENSE_BADGE_TITLES, typeLabel } from './model.ts';

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-h-[20px] items-start gap-2 px-3 text-pr-ui">
			<span className="w-[92px] shrink-0 pt-[2px] text-pr-muted">{label}</span>
			<div className="min-w-0 flex-1 break-words text-pr-text">{children}</div>
		</div>
	);
}

function useRun() {
	const runtime = useShellRuntimeOrNull();
	return (id: string, args?: unknown) => {
		const ctx = runtime?.getCtx();
		if (ctx) void runCommand(id, ctx, args);
	};
}

/** The credit line of a provenance, exactly as File ▸ Export ▸ Sound Credits prints it. */
export function provenanceCredit(p: NonNullable<ReturnType<typeof clipProvenance>>): string {
	return creditLine({
		mediaId: '',
		soundId: p.soundId,
		title: p.title,
		author: p.author,
		license: p.license,
		licenseUrl: p.licenseUrl ?? licenseUrlOf(p.license),
		sourceUrl: p.sourceUrl ?? null,
		attribution: p.attribution,
		requiresAttribution: requiresAttribution(p.license),
		usedIn: [],
		sequenceIds: [],
	});
}

export function SoundSection({ session, clips, sequenceId }: ClipSectionProps) {
	const run = useRun();
	const doc = useSessionState((s) => s.document);
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	const clip = clips[0];
	if (!seq || !clip || clip.kind !== 'audio') return null;
	const live = seq.clips[clip.id] ?? clip;
	const prov = clipProvenance(doc, live);
	const sfx = sfxOf(live);
	const at = alignedFrameOf(doc, seq, live);
	const cue = cueOfClip(seq, live);
	const layers = layersOf(seq, live);
	const d = prov?.descriptors;
	const lead = prov?.leadSilenceSec ?? 0;
	const sec = (x: number) => `${Math.max(0, x - lead).toFixed(3)} s`;
	return (
		<div className="flex flex-col gap-1 pb-2" data-testid="properties-sound-section">
			{prov ? (
				<>
					<Row label={t('Sound')}>
						<span data-testid="sound-section-title">{prov.title || prov.soundId}</span>
						<span className="block text-pr-small text-pr-dim">
							{prov.types.map(typeLabel).join(', ') || t('Untyped')}
						</span>
					</Row>
					{d ? (
						<Row label={t('Descriptors')}>
							<span className="block text-pr-small" data-testid="sound-section-descriptors">
								{t(
									'{0} long · onset {1} · peak {2} into the sound',
									formatSeconds(d.durationSec - lead),
									sec(d.onsetSec),
									sec(d.peakSec),
								)}
							</span>
							<span className="block text-pr-small text-pr-dim">
								{t('Centroid {0} Hz', Math.round(d.centroidHz))}
								{d.maxMomentaryLufs !== null ? ` · ${t('max {0} LUFS', d.maxMomentaryLufs.toFixed(1))}` : ''}
							</span>
						</Row>
					) : null}
				</>
			) : (
				<Row label={t('Sound')}>
					<span className="text-pr-muted">{t('Project audio (not a library sound)')}</span>
				</Row>
			)}
			<Row label={t('Peak')}>
				{at !== null ? (
					<span data-testid="sound-section-peak">
						{t(
							'{0} · {1} {2}',
							seqTimecode(seq, at),
							sfx?.placement.align ? CUE_ALIGN_LABELS[sfx.placement.align] : t('Peak'),
							sfx && sfx.placement.errorFlicks > 0
								? t('({0} ms late)', ((sfx.placement.errorFlicks / FLICKS_PER_SECOND) * 1000).toFixed(1))
								: '',
						)}
					</span>
				) : (
					<span className="text-pr-muted">{t('Unknown')}</span>
				)}
				{!prov ? (
					<Button
						variant="quiet"
						className="ml-2"
						onClick={() => run('sound.detectPeak', { clipId: live.id })}
					>
						Detect Peak
					</Button>
				) : null}
			</Row>
			{sfx ? (
				<Row label={t('Role')}>
					{sfx.role === 'hero' ? t('Hero') : sfx.role === 'support' ? t('Support') : t('Layer')}
					{layers.clipIds.length > 1
						? ` · ${t('Layer {0} of {1}', layers.index + 1, layers.clipIds.length)}`
						: ''}
				</Row>
			) : null}
			<Row label={t('Cue')}>
				{cue ? (
					<button
						type="button"
						className="text-left text-pr-accent underline"
						onClick={() => {
							session.select('cues', [cue.id], 'replace');
							session.transport.seek(cue.frame);
						}}
						data-testid="sound-section-cue"
					>
						{cueLabel(seq, cue)}
					</button>
				) : (
					<span className="text-pr-muted">{t('Not linked to a cue')}</span>
				)}
			</Row>
			{prov ? (
				<>
					<Row label={t('Licence')}>
						<span
							className={licenceWarns(prov.license) ? 'text-pr-warning' : undefined}
							data-testid="sound-section-license"
						>
							{prov.license}
						</span>
						<span className="block text-pr-small text-pr-dim">
							{LICENSE_BADGE_TITLES[licenseClass(prov.license)]}
						</span>
					</Row>
					<Row label={t('Credit')}>
						<span className="text-pr-small" data-testid="sound-section-credit">
							{provenanceCredit(prov)}
						</span>
					</Row>
					<div className="flex gap-1 px-3 pt-1">
						<Button variant="secondary" onClick={() => run('sound.showLicense', { clipId: live.id })}>
							Show Licence…
						</Button>
						<Button variant="quiet" onClick={() => run('sound.swap', { clipId: live.id })}>
							Swap…
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Cue

function cueUpdate(
	session: EditorSession,
	cue: SoundCue,
	label: string,
	patch: Record<string, unknown>,
): void {
	const r = session.apply({
		label,
		origin: 'user',
		commands: [{ type: 'soundCue.update', cueId: cue.id, ...patch } as Command],
	});
	if (!r.ok) toast({ kind: 'warning', title: r.errors[0]?.message ?? t('Edit failed') });
}

const PAN_AUTO = 'auto';

export function CueProperties({ session, sequenceId }: { session: EditorSession; sequenceId: string }) {
	const doc = useSessionState((s) => s.document);
	const ids = useSessionState((s) => s.selection.cues ?? []);
	const readOnly = useSessionState((s) => s.readOnly);
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	const cues = seq ? cuesOf(seq).filter((c) => ids.includes(c.id)) : [];
	if (!seq || !cues.length) return null;
	if (cues.length > 1)
		return (
			<Section id="properties.cue" title={t('Cues')}>
				<p className="px-3 pb-2 text-pr-small text-pr-muted">{t('{0} cues selected', cues.length)}</p>
			</Section>
		);
	const cue = cues[0]!;
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.den > 0 ? rate.num / rate.den : 30;
	const clips = placedClips(seq, cue);
	const set = (label: string, patch: Record<string, unknown>) => cueUpdate(session, cue, label, patch);
	const num = (v: string, min: number, max: number): number | null => {
		const n = Number(v.replace(',', '.'));
		return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
	};
	return (
		<Section id="properties.cue" title={t('Cue')}>
			<div className="flex flex-col gap-1 pb-2" data-testid="properties-cue-section">
				<Row label={t('Timecode')}>
					<span data-testid="cue-section-timecode">{seqTimecode(seq, cue.frame)}</span>
					<span className="ml-2 text-pr-small text-pr-dim">{t('frame {0}', cue.frame)}</span>
				</Row>
				<Row label={t('Frame')}>
					<TextField
						label={t('Cue frame')}
						value={String(cue.frame)}
						disabled={readOnly}
						onCommit={(v) => {
							const f = num(v, 0, 1e9);
							if (f !== null && Math.round(f) !== cue.frame) set(t('Move Cue'), { frame: Math.round(f) });
						}}
						data-testid="cue-section-frame"
					/>
				</Row>
				<Row label={t('Role')}>
					<SelectField
						label={t('Cue role')}
						value={cue.weight}
						options={CUE_WEIGHTS}
						labels={CUE_WEIGHTS.map((w) => CUE_WEIGHT_LABELS[w])}
						disabled={readOnly}
						onChange={(w) => set(t('Cue Role'), { weight: w })}
						data-testid="cue-section-role"
					/>
				</Row>
				<Row label={t('Kind')}>
					<SelectField
						label={t('Cue kind')}
						value={cue.kind}
						options={CUE_KINDS}
						labels={CUE_KINDS.map((k) => kindLabel(k))}
						disabled={readOnly}
						onChange={(k) => set(t('Cue Visual Tag'), { kind: k })}
						data-testid="cue-section-kind"
					/>
				</Row>
				<Row label={t('Align')}>
					<SelectField
						label={t('Cue align')}
						value={cue.align ?? 'peak'}
						options={CUE_ALIGNS}
						labels={CUE_ALIGNS.map((a) => CUE_ALIGN_LABELS[a])}
						disabled={readOnly}
						onChange={(a) => set(t('Cue Align'), { align: a })}
					/>
				</Row>
				<Row label={t('Pan')}>
					<TextField
						label={t('Cue pan (−100 … 100, or auto)')}
						value={cue.pan === undefined ? '' : String(cue.pan)}
						disabled={readOnly}
						onCommit={(v) => {
							const s = v.trim().toLowerCase();
							if (!s) set(t('Cue Pan'), { pan: null });
							else if (s === PAN_AUTO) set(t('Cue Pan'), { pan: 'auto' });
							else {
								const n = num(s, -100, 100);
								if (n !== null) set(t('Cue Pan'), { pan: Math.round(n) });
							}
						}}
						data-testid="cue-section-pan"
					/>
					{cue.panSweep ? (
						<span className="block text-pr-small text-pr-dim">
							{t('Sweep {0} → {1}', cue.panSweep.from, cue.panSweep.to)}
						</span>
					) : null}
				</Row>
				<Row label={t('Pitch (st)')}>
					<TextField
						label={t('Cue pitch in semitones')}
						value={cue.pitchSt === undefined ? '' : String(cue.pitchSt)}
						disabled={readOnly}
						onCommit={(v) => {
							const n = v.trim() ? num(v, -12, 12) : null;
							set(t('Cue Pitch'), { pitchSt: n });
						}}
					/>
				</Row>
				<Row label={t('Build')}>
					<CheckboxField
						label={t('Build (a high-pass rise before the cue)')}
						value={!!cue.build}
						disabled={readOnly}
						onChange={(on) =>
							set(t('Cue Build'), { build: on ? { seconds: 1, fromHz: 200, toHz: 2000 } : null })
						}
					>
						{cue.build
							? t('{0} s, {1} → {2} Hz', cue.build.seconds, cue.build.fromHz, cue.build.toHz)
							: t('Off')}
					</CheckboxField>
				</Row>
				<Row label={t('Stop before')}>
					<CheckboxField
						label={t('Stop Before Next')}
						value={!!cue.stopBefore}
						disabled={readOnly}
						onChange={(on) =>
							set(t('Stop Before Next'), { stopBefore: on ? { ...STOP_BEFORE_DEFAULT } : null })
						}
					>
						{cue.stopBefore ? t('{0} s, {1} dB', cue.stopBefore.seconds, cue.stopBefore.depthDb) : t('Off')}
					</CheckboxField>
				</Row>
				<Row label={t('Reason')}>
					<TextField
						label={t('Cue reason')}
						value={cue.reason ?? ''}
						multiline
						disabled={readOnly}
						onCommit={(v) => set(t('Cue Reason'), { reason: v.trim() ? v.slice(0, 2000) : null })}
						data-testid="cue-section-reason"
					/>
				</Row>
				<Row label={t('Filled by')}>
					{clips.length ? (
						<ul className="flex flex-col gap-[2px]" data-testid="cue-section-clips">
							{clips.map((id) => {
								const c = seq.clips[id]!;
								return (
									<li key={id}>
										<button
											type="button"
											className="text-left text-pr-accent underline"
											onClick={() =>
												session.select('timeline', [id], 'replace', { primary: id, linked: false })
											}
										>
											{`${trackLabelOf(seq, c.trackId)} · ${clipProvenance(doc, c)?.title || c.name}`}
										</button>
									</li>
								);
							})}
						</ul>
					) : (
						<span className="text-pr-muted">{t('Unfilled')}</span>
					)}
				</Row>
				<p className="px-3 text-pr-small text-pr-dim">
					{t('{0} s into the sequence', (cue.frame / fps).toFixed(3))}
				</p>
			</div>
		</Section>
	);
}
