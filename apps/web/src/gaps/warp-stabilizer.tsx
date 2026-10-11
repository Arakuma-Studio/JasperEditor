// Analysis is invalidated by media, Detailed Analysis, or visible-range changes. Store completed
// analysis with origin system so background computation does not create an undo step.
import type { WarpAnalysisResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	evaluate,
	pendingWarpRequests,
	WARP_STABILIZER_EFFECT_ID,
	type WarpAnalysisData,
	type WarpRequest,
	warpAnalysisFps,
	warpFrameCount,
	warpPlanFor,
	warpRequestFor,
	warpRequestSignature,
	warpSettingsOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { toast } from '@jasper/ui';
import { RefreshCw, Square } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
	type EffectEditorProps,
	effectEditors,
	type ProgramOverlayHostProps,
	programOverlays,
} from '../extensions/index.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { errorText, followJob } from '../processing/engine-jobs.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { SmallButton } from '../tracking/controls.tsx';

type FxInst = {
	id: string;
	effectId: string;
	enabled: boolean;
	params: Record<string, unknown>;
	warpAnalysis?: WarpAnalysisData;
};

export type WarpStatus =
	| { state: 'analyzing'; jobId: string | null; progress: number; signature: string }
	| { state: 'failed'; error: string; signature: string };

let statuses = new Map<string, WarpStatus>();
const listeners = new Set<() => void>();
const setStatus = (fxId: string, s: WarpStatus | null) => {
	statuses = new Map(statuses);
	if (s) statuses.set(fxId, s);
	else statuses.delete(fxId);
	for (const l of listeners) l();
};
export const warpStatus = {
	get: (fxId: string) => statuses.get(fxId) ?? null,
	subscribe(l: () => void) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};
const useWarpStatus = (fxId: string) =>
	useSyncExternalStore(warpStatus.subscribe, () => statuses.get(fxId) ?? null);

const signatureOf = warpRequestSignature;
const paramValue = (fx: FxInst, k: string): unknown => {
	const a = fx.params[k] as { value?: unknown } | undefined;
	return a && typeof a === 'object' && 'value' in a ? a.value : undefined;
};

/** Completed analyses by request signature (an undo that drops a stored analysis gets it back at once). */
const results = new Map<string, WarpAnalysisResult>();

function store(session: EditorSession, r: WarpRequest, res: WarpAnalysisResult): boolean {
	const { analysedFrames: _a, framesPerSec: _f, ...analysis } = res;
	const tx = session.apply({
		label: 'Analyze (Warp Stabilizer)',
		origin: 'system',
		commands: [{ type: 'effect.setWarpAnalysis', effectInstanceId: r.fxId, analysis } as never],
	});
	return tx.ok;
}

async function analyse(engine: EngineClient, session: EditorSession, r: WarpRequest): Promise<void> {
	const signature = signatureOf(r);
	const cached = results.get(signature);
	if (cached) {
		setStatus(r.fxId, null);
		store(session, r, cached);
		return;
	}
	setStatus(r.fxId, { state: 'analyzing', jobId: null, progress: 0, signature });
	try {
		const job = await engine.call('warpAnalysis', {
			body: {
				projectId: session.projectId,
				mediaKey: r.mediaKey,
				mediaId: r.mediaId,
				startFrame: r.startFrame,
				frameCount: r.frameCount,
				detailed: r.detailed,
			},
		});
		setStatus(r.fxId, { state: 'analyzing', jobId: job.id, progress: 0, signature });
		const done = await followJob(engine, job.id, {
			intervalMs: 500,
			onUpdate: (j) => {
				const cur = statuses.get(r.fxId);
				if (cur?.state === 'analyzing' && cur.signature === signature)
					setStatus(r.fxId, { ...cur, progress: j.progress ?? 0 });
			},
		});
		const cur = statuses.get(r.fxId);
		if (!cur || cur.signature !== signature) return; // superseded or cancelled
		if (done.state === 'succeeded') {
			const res = done.result as WarpAnalysisResult;
			results.set(signature, res);
			setStatus(r.fxId, null);
			// Store only when the instance still wants this very analysis.
			const doc = session.getCommitted();
			const again = pendingWarpRequests(doc).find((x) => x.fxId === r.fxId);
			if (again && signatureOf(again) === signature) store(session, r, res);
		} else if (done.state === 'cancelled')
			setStatus(r.fxId, { state: 'failed', error: 'Analysis cancelled', signature });
		else setStatus(r.fxId, { state: 'failed', error: done.error?.message ?? done.state, signature });
	} catch (e) {
		setStatus(r.fxId, { state: 'failed', error: errorText(e), signature });
	}
}

/** Watches the session and analyses Warp Stabilizers in the background. Returns the uninstaller. */
export function installWarpWatcher(session: EditorSession, engine: EngineClient): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const scan = () => {
		timer = null;
		if (session.getState().readOnly) return;
		for (const r of pendingWarpRequests(session.getCommitted())) {
			const cur = statuses.get(r.fxId);
			const sig = signatureOf(r);
			// Running for this request, or failed for it (Analyze retries): leave it.
			if (cur && cur.signature === sig) continue;
			void analyse(engine, session, r);
		}
	};
	const off = session.on('doc.changed', () => {
		if (timer === null) timer = setTimeout(scan, 400);
	});
	timer = setTimeout(scan, 400);
	return () => {
		off();
		if (timer !== null) clearTimeout(timer);
	};
}

/** Analyze: (re)runs the analysis of one instance now. */
export async function analyzeNow(engine: EngineClient, session: EditorSession, fxId: string): Promise<void> {
	const doc = session.getCommitted();
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips))
			for (const fx of ((clip as { effects?: FxInst[] }).effects ?? []) as FxInst[]) {
				if (fx.id !== fxId) continue;
				const r = warpRequestFor(doc, seq, clip, { ...fx, warpAnalysis: undefined } as FxInst);
				if (!r) {
					toast({
						kind: 'warning',
						title: 'Warp Stabilizer',
						detail: 'Only video clips of engine media can be analysed.',
					});
					return;
				}
				results.delete(signatureOf(r));
				setStatus(fxId, null);
				await analyse(engine, session, r);
				return;
			}
}

/** Cancel: stops a running analysis (the effect keeps its previous analysis, if any). */
export async function cancelAnalysis(engine: EngineClient, fxId: string): Promise<void> {
	const cur = statuses.get(fxId);
	if (cur?.state !== 'analyzing') return;
	setStatus(fxId, { state: 'failed', error: 'Analysis cancelled', signature: cur.signature });
	if (cur.jobId) await engine.cancelJob(cur.jobId).catch(() => undefined);
}

function WarpStabilizerEditor(props: EffectEditorProps) {
	const { session, fx } = props;
	const engine = useEngineOrNull();
	const status = useWarpStatus(fx.id);
	const readOnly = useSessionState((s) => s.readOnly);
	const inst = fx as unknown as FxInst;
	const a = inst.warpAnalysis;
	const params = useMemo(
		() => Object.fromEntries(Object.entries(inst.params).map(([k, v]) => [k, evaluate(v as never, 0)])),
		[inst.params],
	);
	const summary = useMemo(() => {
		if (!a) return null;
		try {
			const plan = warpPlanFor(a, warpSettingsOf(params, warpAnalysisFps(a)));
			return { frames: warpFrameCount(a), autoScale: plan.autoScale, relaxed: plan.relaxedFrames };
		} catch {
			return null;
		}
	}, [a, params]);
	const text =
		status?.state === 'analyzing'
			? `Analyzing in background (step 1 of 2): ${Math.round(status.progress * 100)}%`
			: status?.state === 'failed'
				? `Analysis failed: ${status.error}`
				: summary
					? `Analysed ${summary.frames} frames${a?.confidence !== undefined ? `, ${Math.round(a.confidence * 100)}% tracked` : ''}${
							params.framing === 'stabilizeCropAutoScale'
								? ` · Auto-scale ${Math.round(summary.autoScale * 100)}%`
								: ''
						}${summary.relaxed ? ` · ${summary.relaxed} frames limited by Maximum Scale` : ''}`
					: inst.enabled
						? 'Waiting for the analysis'
						: 'Not analysed (the effect is off)';
	return (
		<div className="flex flex-col gap-1 py-1" data-testid="warp-stabilizer-editor">
			<div className="flex items-center gap-2">
				<SmallButton
					icon={RefreshCw}
					disabled={readOnly || !engine || status?.state === 'analyzing'}
					onClick={() => engine && void analyzeNow(engine.client, session, fx.id)}
					data-testid="warp-analyze"
				>
					Analyze
				</SmallButton>
				<SmallButton
					icon={Square}
					disabled={!engine || status?.state !== 'analyzing'}
					onClick={() => engine && void cancelAnalysis(engine.client, fx.id)}
					data-testid="warp-cancel"
				>
					Cancel
				</SmallButton>
			</div>
			<p className="text-pr-small text-pr-muted" role="status" aria-live="polite" data-testid="warp-status">
				{text}
			</p>
		</div>
	);
}

function WarpBanner(props: ProgramOverlayHostProps) {
	const session = props.session;
	const { frame } = useOverlayFrame(session.transport);
	const doc = useSessionState((s) => s.document);
	const seqId = useSessionState((s) => s.activeSequenceId);
	const all = useSyncExternalStore(warpStatus.subscribe, () => statuses);
	const banner = useMemo(() => {
		const seq = seqId ? doc.sequences[seqId] : undefined;
		if (!seq) return null;
		for (const clip of Object.values(seq.clips)) {
			if (frame < clip.start || frame >= clip.start + clip.duration) continue;
			for (const fx of ((clip as { effects?: FxInst[] }).effects ?? []) as FxInst[]) {
				if (fx.effectId !== WARP_STABILIZER_EFFECT_ID || !fx.enabled) continue;
				if (paramValue(fx, 'hideWarningBanner') === true) continue;
				const st = all.get(fx.id);
				if (st?.state === 'analyzing')
					return `Analyzing in background (step 1 of 2) ${Math.round(st.progress * 100)}%`;
				if (st?.state === 'failed') return `Warp Stabilizer: ${st.error}`;
				if (warpRequestFor(doc, seq, clip, fx)) return 'Analyzing in background (step 1 of 2)';
			}
		}
		return null;
	}, [doc, seqId, frame, all]);
	if (!banner) return null;
	return (
		<div
			className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center"
			data-testid="warp-banner"
		>
			<span
				className="rounded-pr-control bg-pr-tooltip px-3 py-1 text-pr-small text-pr-strong shadow"
				role="status"
			>
				{banner}
			</span>
		</div>
	);
}

let registered = false;
export function registerWarpStabilizerUi(): void {
	if (registered) return;
	registered = true;
	effectEditors.register({
		id: 'gaps.warp-stabilizer',
		effectId: WARP_STABILIZER_EFFECT_ID,
		component: WarpStabilizerEditor,
	});
	programOverlays.register({
		id: 'gaps.warp-banner',
		active: (session) => !!session.getState().activeSequenceId,
		component: WarpBanner,
		order: 90,
	});
}

/** Hook for the shell: installs the background analysis for the open session. */
export function useWarpWatcher(session: EditorSession | null): void {
	const client = useEngineOrNull()?.client ?? null;
	useEffect(() => (session && client ? installWarpWatcher(session, client) : undefined), [session, client]);
}
