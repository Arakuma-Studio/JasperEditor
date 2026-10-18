// Essential Sound ▸ Duration ▸ Music to picture (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): for one music clip, the
// engine's analysis of the music (tempo, beats per bar, key, drop candidates — `POST /api/audio/beats`, cached), each
// drop with ▶ (the playhead to where it plays now, and play), "Land the drop on: Playhead / Hero cue / a marker"
// (Land Drop: an anchored remix, one undo step) and End on Bar. The same operations are Clip ▸ Audio Options ▸ Land
// Drop on Playhead / Land Drop on Hero Cue / End on Bar and MCP remix_audio {landDropAt}, fit_music_to_picture.
import type { BeatsResult } from '@jasper/api';
import { type AudioClip, formatTimecode, readRemixAnchors, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Select, toast } from '@jasper/ui';
import { useState } from 'react';
import { endOnBar, frameOfMusicSec, heroCueUnder, landDrop, musicAnalysis } from '../../audio-fx/ops.ts';
import { t } from '../../i18n/runtime.ts';
import { useEngineOrNull } from '../../state/engine.tsx';

type Target = 'playhead' | 'hero' | `marker:${string}`;

/** Analyses kept per clip and media range while the panel lives (the engine caches them on disk too). */
const analyses = new Map<string, BeatsResult>();

export function MusicFit({ session, seq, clip }: { session: EditorSession; seq: Sequence; clip: AudioClip }) {
	const engine = useEngineOrNull();
	const key = `${clip.mediaId}|${(clip.remix?.original ?? clip).sourceIn}|${(clip.remix?.original ?? clip).duration}`;
	const [analysis, setAnalysis] = useState<BeatsResult | null>(analyses.get(key) ?? null);
	const [busy, setBusy] = useState<string | null>(null);
	const [target, setTarget] = useState<Target>('playhead');
	const [dropIndex, setDropIndex] = useState(0);
	const rate = seq.settings.frameRate;
	const tc = (f: number) => formatTimecode(f, rate, { dropFrame: seq.settings.dropFrame });
	const hero = heroCueUnder(seq, clip);
	const markers = [...(seq.markers ?? [])].sort((a, b) => a.frame - b.frame);
	const landed = readRemixAnchors(clip.remix);
	const run = async (what: string, f: () => Promise<string>) => {
		if (!engine) return toast({ kind: 'error', title: t('The engine is not connected') });
		setBusy(what);
		try {
			toast({ kind: 'success', title: (await f()).slice(0, 120) });
		} catch (e) {
			toast({ kind: 'error', title: (e as Error).message.slice(0, 120) });
		} finally {
			setBusy(null);
		}
	};
	const analyse = () =>
		run('analyse', async () => {
			const a = await musicAnalysis(session, engine!.client, seq.id, clip.id);
			analyses.set(key, a);
			setAnalysis(a);
			setDropIndex(0);
			return a.bpm === null
				? t('No steady beat in this music')
				: t('{0} drop candidates found', a.drops.length);
		});
	const frameOf = (): number | null => {
		if (target === 'playhead') return session.transport.getState().frame;
		if (target === 'hero') return hero?.frame ?? null;
		const m = markers.find((x) => `marker:${x.id}` === target);
		return m ? m.frame : null;
	};
	const drops = analysis?.drops ?? [];
	const options = [
		{ value: 'playhead', label: t('Playhead') },
		...(hero ? [{ value: 'hero', label: t('Hero cue ({0})', tc(hero.frame)) }] : []),
		...markers.map((m) => ({ value: `marker:${m.id}`, label: `${m.name || t('Marker')} (${tc(m.frame)})` })),
	];
	return (
		<div
			className="flex flex-col gap-1.5 border-t border-pr-border-subtle pt-2"
			data-testid="essential-music-fit"
		>
			<span className="text-pr-small text-pr-muted">{t('Music to picture')}</span>
			{analysis ? (
				<p className="text-pr-small text-pr-text" data-testid="essential-music-info">
					{[
						analysis.bpm === null ? t('No steady beat') : t('{0} BPM', Math.round(analysis.bpm)),
						analysis.beatsPerBar ? t('{0} beats per bar', analysis.beatsPerBar) : null,
						analysis.key
							? analysis.key.mode === 'major'
								? t(
										'{0} major ({1} %)',
										analysis.key.name.split(' ')[0] ?? '',
										Math.round(analysis.key.confidence * 100),
									)
								: t(
										'{0} minor ({1} %)',
										analysis.key.name.split(' ')[0] ?? '',
										Math.round(analysis.key.confidence * 100),
									)
							: t('No clear key'),
					]
						.filter(Boolean)
						.join(' · ')}
				</p>
			) : (
				<Button
					data-testid="essential-music-analyse"
					busy={busy === 'analyse'}
					disabled={!engine}
					disabledReason={t('The engine is not connected')}
					onClick={analyse}
				>
					{t('Analyze Music')}
				</Button>
			)}
			{analysis && drops.length ? (
				<ul
					className="flex flex-col gap-0.5"
					aria-label={t('Drop candidates')}
					data-testid="essential-music-drops"
				>
					{drops.slice(0, 4).map((d, i) => {
						const f = frameOfMusicSec(seq, clip, d.sourceSeconds);
						return (
							<li key={`${d.bar}:${d.sourceSeconds}`} className="flex items-center gap-1.5 text-pr-small">
								<input
									type="radio"
									name={`drop-${clip.id}`}
									aria-label={t('Land bar {0}', d.bar)}
									checked={dropIndex === i}
									onChange={() => setDropIndex(i)}
								/>
								<Button
									variant="quiet"
									aria-label={t('Play the drop at bar {0}', d.bar)}
									disabled={f === null}
									disabledReason={t('The clip does not play this bar')}
									onClick={() => {
										if (f === null) return;
										session.transport.seek(f);
										session.transport.play();
									}}
								>
									▶
								</Button>
								<span className="flex-1 truncate">
									{t('Bar {0}', d.bar)}
									{f === null ? ` · ${t('not played')}` : ` · ${tc(f)}`}
								</span>
								<span className="text-pr-muted pr-tabular">{d.score.toFixed(1)}</span>
							</li>
						);
					})}
				</ul>
			) : analysis ? (
				<p className="text-pr-small text-pr-muted">{t('No drop: no bar lifts into a loud section')}</p>
			) : null}
			{landed.length ? (
				<p className="text-pr-small text-pr-muted" data-testid="essential-music-landed">
					{t('The drop lands at {0}', landed.map((a) => tc(a.frame)).join(', '))}
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<span className="w-24 shrink-0 text-pr-small text-pr-muted">{t('Land the drop on')}</span>
				<Select
					label={t('Land the drop on')}
					value={target}
					options={options}
					onValueChange={(v) => setTarget(v as Target)}
				/>
			</div>
			<div className="flex gap-2">
				<Button
					data-testid="essential-land-drop"
					busy={busy === 'land'}
					disabled={!engine}
					disabledReason={t('The engine is not connected')}
					onClick={() =>
						run('land', async () => {
							const frame = frameOf();
							if (frame === null) throw new Error(t('Choose where the drop lands'));
							const d = drops[dropIndex];
							const r = await landDrop(session, engine!.client, seq.id, clip.id, frame, {
								...(d ? { dropSec: d.sourceSeconds } : {}),
							});
							return t(
								'The drop lands at {0} ({1} segments, {2} s)',
								tc(frame),
								r.pieces,
								r.lengthSeconds.toFixed(2),
							);
						})
					}
				>
					{t('Land Drop')}
				</Button>
				<Button
					data-testid="essential-end-on-bar"
					busy={busy === 'end'}
					disabled={!engine}
					disabledReason={t('The engine is not connected')}
					onClick={() =>
						run('end', async () => {
							const r = await endOnBar(session, engine!.client, seq.id, clip.id);
							return t('The music ends on the bar line at {0}', tc(r.endFrame));
						})
					}
				>
					{t('End on Bar')}
				</Button>
			</div>
		</div>
	);
}
