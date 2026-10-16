// The editor's runs of the Phase 4 mixing jobs (spec 12 §2.4, P4-R2 / P4-R4; wp-note "Phase 4 → WP4.2b"):
// Rebalance SFX Levels (`POST /api/sound-design/rebalance`) and Delivery Target (`POST /api/sound-design/delivery`),
// both `sound-design` jobs in apply mode. The editor's request carries the editor key, so the engine relays the ONE
// transaction it makes into this session as the user's own edit (History "Rebalance SFX Levels" / "Apply Delivery
// Preset: web"): the toast offers Undo while that entry is still the latest. The jobs show in the Jobs panel; this
// follows them (progress, cancel) and reads their typed result.
import {
	type EngineJob,
	type SfxRebalanceRequest,
	type SfxRebalanceResult,
	SfxRebalanceResultSchema,
	type SoundDeliveryRequest,
	type SoundDeliveryResult,
	SoundDeliveryResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { DELIVERY_PRESETS } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { ZodType } from 'zod';
import { t } from '../i18n/runtime.ts';
import { deliveryOptionLabel, fmtDb } from './mix-model.ts';

export class SoundJobError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 400;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type SoundJobOptions = {
	signal?: AbortSignal;
	onJob?(job: EngineJob): void;
	/** Test hook: how to wait between polls. */
	sleep?(ms: number): Promise<void>;
};

const errOf = (e: unknown) => {
	const err = e as { code?: string; message?: string };
	return new SoundJobError(err?.code ?? 'E_ENGINE', err?.message ?? String(e));
};

/**
 * Starts a job (`start`) and waits for it: its result parsed with `schema`, or a `SoundJobError` (`E_CANCELLED` when
 * `signal` aborted it — the job is cancelled too).
 */
export async function runSoundJob<T>(
	engine: Pick<EngineClient, 'getJob' | 'cancelJob'>,
	start: (signal?: AbortSignal) => Promise<unknown>,
	schema: ZodType<T>,
	opts: SoundJobOptions & { failure: string },
): Promise<T> {
	const sleep = opts.sleep ?? defaultSleep;
	let job: EngineJob;
	try {
		job = (await start(opts.signal)) as EngineJob;
	} catch (e) {
		if (opts.signal?.aborted) throw new SoundJobError('E_CANCELLED', t('Cancelled'));
		throw errOf(e);
	}
	opts.onJob?.(job);
	while (!TERMINAL.has(job.state)) {
		if (opts.signal?.aborted) {
			try {
				await engine.cancelJob(job.id);
			} catch {
				// it may have just finished: the result is ignored
			}
			throw new SoundJobError('E_CANCELLED', t('Cancelled'));
		}
		await sleep(POLL_MS);
		try {
			job = (await engine.getJob(job.id)) as EngineJob;
		} catch (e) {
			throw errOf(e);
		}
		opts.onJob?.(job);
	}
	if (job.state !== 'succeeded') {
		if (job.state === 'cancelled') throw new SoundJobError('E_CANCELLED', t('Cancelled'));
		throw new SoundJobError(job.error?.code ?? 'E_JOB_FAILED', job.error?.message ?? opts.failure);
	}
	const parsed = schema.safeParse(job.result);
	if (!parsed.success) throw new SoundJobError('E_BAD_RESULT', t('The engine returned an unreadable result'));
	return parsed.data;
}

/** Rebalance SFX Levels for the user (apply mode: one transaction, the user's own). */
export function runRebalance(
	engine: Pick<EngineClient, 'rebalanceSfx' | 'getJob' | 'cancelJob'>,
	req: Omit<SfxRebalanceRequest, 'mode'>,
	opts: SoundJobOptions = {},
): Promise<SfxRebalanceResult> {
	return runSoundJob(
		engine,
		(signal) => engine.rebalanceSfx({ ...req, mode: 'apply' }, signal),
		SfxRebalanceResultSchema,
		{ ...opts, failure: t('Rebalancing the sound effects failed') },
	);
}

/** Apply a delivery preset for the user (apply mode: one transaction, the user's own). */
export function runDelivery(
	engine: Pick<EngineClient, 'applyDelivery' | 'getJob' | 'cancelJob'>,
	req: Omit<SoundDeliveryRequest, 'mode'>,
	opts: SoundJobOptions = {},
): Promise<SoundDeliveryResult> {
	return runSoundJob(
		engine,
		(signal) => engine.applyDelivery({ ...req, mode: 'apply' }, signal),
		SoundDeliveryResultSchema,
		{ ...opts, failure: t('Applying the delivery target failed') },
	);
}

/** The History entry an engine-applied transaction became in this session (the user's), by its revision. */
export function entryOfRevision(session: EditorSession, revision: number | null): number | null {
	if (revision === null) return null;
	const e = session
		.getState()
		.history.entries.find((x) => x.revisionAfter === revision && x.origin === 'user');
	return e ? e.id : null;
}

/** Undo the entry if it is still the latest; false when newer edits came after it. */
export function undoIfTop(session: EditorSession, entryId: number | null): boolean {
	const h = session.getState().history;
	const top = h.index > 0 ? h.entries[h.index - 1] : undefined;
	if (entryId === null || top?.id !== entryId) return false;
	session.undo();
	return true;
}

/** "Rebalanced 12 sound effects" / detail "3 limited · 2 kept (your gains)". */
export function rebalanceSummary(r: SfxRebalanceResult): { title: string; detail: string } {
	const c = r.report.counts;
	const title = !r.applied
		? t('Nothing to change: the sound effects are at their solved levels')
		: c.changed === 1
			? t('Rebalanced 1 sound effect')
			: t('Rebalanced {0} sound effects', c.changed);
	const users = r.report.skipped.filter((s) => s.code === 'USER_GAIN').length;
	const parts = [
		t('{0} solved', c.solved),
		t('{0} limited', c.limited),
		...(users ? [t('{0} kept (your gains)', users)] : []),
		...(c.skipped - users > 0 ? [t('{0} skipped', c.skipped - users)] : []),
	];
	return { title, detail: parts.join(' · ') };
}

/** "Measured −14.0 LUFS · −1.6 dBTP · music 23.3 LU under the voice". */
export function deliverySummary(r: SoundDeliveryResult): { title: string; detail: string } {
	const m = r.report.measure;
	const parts: string[] = [];
	if (m) {
		if (m.expectedLufs !== null) parts.push(t('{0} LUFS', fmtDb(m.expectedLufs)));
		if (m.expectedTruePeakDb !== null) parts.push(t('{0} dBTP', fmtDb(m.expectedTruePeakDb)));
		if (m.musicUnderVoiceLu !== null)
			parts.push(t('music {0} LU under the voice', m.musicUnderVoiceLu.toFixed(1)));
		if (m.ambienceUnderVoiceLu !== null)
			parts.push(t('ambience {0} LU under the voice', m.ambienceUnderVoiceLu.toFixed(1)));
	}
	if (r.report.sfx) parts.push(t('{0} sound effects re-solved', r.report.sfx.changed));
	const preset = DELIVERY_PRESETS[r.report.delivery];
	const name = preset ? deliveryOptionLabel(preset) : r.report.preset.label;
	return {
		title: r.applied ? t('Applied {0}', name) : t('Nothing to change for {0}', name),
		detail: parts.join(' · '),
	};
}
