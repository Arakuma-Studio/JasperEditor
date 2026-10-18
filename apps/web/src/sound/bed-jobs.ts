// The editor's runs of the bed jobs (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): Lay Ambience Bed… and Fill Room
// Tone, `sound-design` jobs in apply mode (the editor's request carries the editor key: the ONE transaction is the
// user's own History entry) or propose mode (a proposal the Review panel opens). The jobs show in the Jobs panel.
import {
	type SoundBedsPlan,
	type SoundBedsRequest,
	type SoundBedsResult,
	SoundBedsResultSchema,
	type SoundRoomTonePlan,
	type SoundRoomToneRequest,
	type SoundRoomToneResult,
	SoundRoomToneResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { t } from '../i18n/runtime.ts';
import { runSoundJob, type SoundJobOptions } from './mix-jobs.ts';

export function runBeds(
	engine: Pick<EngineClient, 'layAmbienceBeds' | 'getJob' | 'cancelJob'>,
	req: SoundBedsRequest,
	opts: SoundJobOptions = {},
): Promise<SoundBedsResult> {
	return runSoundJob(engine, (signal) => engine.layAmbienceBeds(req, signal), SoundBedsResultSchema, {
		...opts,
		failure: t('Laying the ambience beds failed'),
	});
}

export function runRoomTone(
	engine: Pick<EngineClient, 'fillRoomTone' | 'getJob' | 'cancelJob'>,
	req: SoundRoomToneRequest,
	opts: SoundJobOptions = {},
): Promise<SoundRoomToneResult> {
	return runSoundJob(engine, (signal) => engine.fillRoomTone(req, signal), SoundRoomToneResultSchema, {
		...opts,
		failure: t('Filling room tone failed'),
	});
}

const sec = (x: number) => (Math.round(x * 100) / 100).toFixed(2);

/** One line per scene of a bed plan: what was measured (window, loop, crossfade, gain). */
export function bedSceneLine(s: SoundBedsPlan['scenes'][number]): string {
	const w = s.sound.window;
	const l = s.sound.loop;
	return t(
		'Loop {0}–{1} s of the clean window {2}–{3} s (±{4} dB) · {5} s crossfade · {6} dB',
		sec(l.inSec),
		sec(l.outSec),
		sec(w.startSec),
		sec(w.endSec),
		w.levelStdDb.toFixed(1),
		l.crossfadeSec.toFixed(1),
		(Math.round(s.gainDb * 10) / 10).toFixed(1),
	);
}

/** Why a scene starts where it does, in words. */
export function bedSceneReason(r: SoundBedsPlan['scenes'][number]['reason']): string {
	switch (r) {
		case 'start':
			return t('Start');
		case 'edit':
			return t('Cut to other footage');
		case 'marker':
			return t('Scene marker');
		case 'shot':
			return t('Shot change');
		default:
			return t('Your scene');
	}
}

/** The toast after a bed job. */
export function bedsSummary(r: SoundBedsResult): { title: string; detail: string } {
	const n = r.plan.scenes.length;
	const titles = [...new Set(r.plan.scenes.map((s) => s.sound.title))].join(', ');
	return {
		title: r.applied
			? n === 1
				? t('Laid an ambience bed under 1 scene')
				: t('Laid ambience beds under {0} scenes', n)
			: r.proposalId
				? t('Proposed ambience beds for {0} scenes', n)
				: t('No bed was laid'),
		detail: titles,
	};
}

/** The toast after a room-tone job. */
export function roomToneSummary(
	r: SoundRoomToneResult | { plan: SoundRoomTonePlan; applied: boolean; proposalId: string | null },
): {
	title: string;
	detail: string;
} {
	const p = r.plan;
	const c = p.chosen;
	if (!c) return { title: t('No room tone was laid'), detail: p.warnings.map((w) => w.message).join(' ') };
	const n = p.gaps.length;
	return {
		title: r.applied
			? n === 1
				? t('Filled 1 dialogue gap with room tone')
				: t('Filled {0} dialogue gaps with room tone', n)
			: t('Proposed room tone for {0} dialogue gaps', n),
		detail:
			c.distanceDb === null
				? t('"{0}" at {1} dB', c.sound.title, c.gainDb.toFixed(1))
				: t(
						'"{0}", {1} dB from the dialogue’s noise floor, at {2} dB',
						c.sound.title,
						c.distanceDb.toFixed(1),
						c.gainDb.toFixed(1),
					),
	};
}
