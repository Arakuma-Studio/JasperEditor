// Export mode (S05 §15.1–15.4; S04:EX-005): destinations | preview | settings, footer Cancel / Export.
// Calls POST /api/exports/plan with the committed envelope whenever the choices or the document change,
// shows the plan (path, blockers, warnings, estimate), and POST /api/exports creates the job; then the
// view returns to Edit and the Jobs panel shows progress (completion toast with Download: ProjectLifecycle).
import type { RenderPlan } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { formatTimecode, type Sequence } from '@jasper/project';
import { useSession, useSessionState } from '@jasper/session/react';
import { Button, cx, IconButton, TimecodeText } from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';
import { notices } from '../home/notices.tsx';
import { runIfRegistered, useLocalCommandCtx } from '../home/ui-bridge.ts';
import { mediaKeyOf } from '../import/assets.ts';
import { useEngine } from '../state/engine.tsx';
import { exportMode, trackExportJob } from './mode.ts';
import { blockingForEngine, type PlanState, PlanSummary } from './PlanSummary.tsx';
import {
	buildExportSettings,
	ENGINE_OPTIONS,
	type ExportEngineChoice,
	type ExportRangeChoice,
	exportEnvelope,
	exportRange,
	hasInOut,
	loadExportChoice,
	MATCH_SEQUENCE_PRESET,
	outputDescription,
	sanitizeFileName,
	saveExportChoice,
	validateExport,
} from './settings.ts';

const PLAN_DEBOUNCE_MS = 300;

function sequenceName(
	doc: { items: Record<string, { kind: string; name: string; sequenceId?: string }> },
	id: string,
) {
	return (
		Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === id)?.name ?? 'Sequence'
	);
}

/** A poster for the preview column: the first visual media clip at the range start (else the first one). */
function usePreviewPoster(seq: Sequence | undefined, frame: number): string | null {
	const engine = useEngine();
	const media = useSessionState((s) => s.document.media);
	const runtime = useSessionState((s) => s.media);
	return useMemo(() => {
		if (!seq) return null;
		const visual = Object.values(seq.clips)
			.filter((c) => (c.kind === 'video' || c.kind === 'still') && 'mediaId' in c)
			.sort((a, b) => a.start - b.start);
		const hit = visual.find((c) => c.start <= frame && frame < c.start + c.duration) ?? visual[0];
		const mediaId = hit ? (hit as { mediaId?: string }).mediaId : undefined;
		if (!mediaId) return null;
		const rt = runtime[mediaId];
		if (rt?.posterUrl) return rt.posterUrl;
		const key = mediaKeyOf(media[mediaId]);
		return key ? engine.client.mediaUrl(key, 'poster') : null;
	}, [seq, frame, media, runtime, engine.client]);
}

export function ExportMode(props: { sequenceId?: string | null; onClose?: () => void }) {
	const session = useSession();
	const engine = useEngine();
	const ctx = useLocalCommandCtx();
	const doc = useSessionState((s) => s.document);
	const revision = useSessionState((s) => s.revision);
	const activeSequenceId = useSessionState((s) => s.activeSequenceId);
	const sequenceIds = Object.keys(doc.sequences);
	const [sequenceId, setSequenceId] = useState<string | null>(
		props.sequenceId && doc.sequences[props.sequenceId]
			? props.sequenceId
			: (activeSequenceId ?? sequenceIds[0] ?? null),
	);
	const seq = sequenceId ? doc.sequences[sequenceId] : undefined;
	const remembered = sequenceId ? loadExportChoice(session.projectId, sequenceId) : null;
	const [range, setRange] = useState<ExportRangeChoice>(remembered?.range ?? 'entire');
	const [engineChoice, setEngineChoice] = useState<ExportEngineChoice>(remembered?.engine ?? 'auto');
	const [fileName, setFileName] = useState(
		() => remembered?.fileName ?? (sequenceId ? sequenceName(doc, sequenceId) : 'Export'),
	);
	const [plan, setPlan] = useState<PlanState>({ status: 'idle' });
	const [starting, setStarting] = useState(false);
	const close = props.onClose ?? (() => exportMode.close());

	useEffect(() => {
		if (!sequenceId) return;
		const r = loadExportChoice(session.projectId, sequenceId);
		setRange(r?.range ?? 'entire');
		setEngineChoice(r?.engine ?? 'auto');
		setFileName(r?.fileName ?? sequenceName(session.getCommitted(), sequenceId));
	}, [sequenceId, session]);

	const effectiveRange: ExportRangeChoice = range === 'in-out' && seq && hasInOut(seq) ? 'in-out' : 'entire';
	const frames = seq ? exportRange(seq, effectiveRange) : { start: 0, end: 0 };
	const validation = seq ? validateExport(seq, frames) : ['No sequence to export.'];
	const settings = useMemo(
		() => (seq ? buildExportSettings(seq, { range: effectiveRange, engine: engineChoice }) : null),
		[seq, effectiveRange, engineChoice],
	);

	// Plan on every relevant change (debounced); the plan embeds the revision it was computed for (RP-011).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` re-plans when the committed document changes
	useEffect(() => {
		if (!seq || !settings || validation.length) {
			setPlan({ status: 'idle' });
			return;
		}
		let cancelled = false;
		setPlan({ status: 'planning' });
		const t = setTimeout(() => {
			engine.client
				.planExport({
					envelope: exportEnvelope(session.getCommitted(), session.revision),
					sequenceId: seq.id,
					settings,
				})
				.then((p: RenderPlan) => !cancelled && setPlan({ status: 'ok', plan: p }))
				.catch((e) => {
					if (cancelled) return;
					const blockers =
						e instanceof EngineError && e.code === 'PATH_NOT_ELIGIBLE'
							? ((e.detail as { blockers?: RenderPlan['blockers'] } | undefined)?.blockers ?? [])
							: undefined;
					setPlan({
						status: 'error',
						code: e instanceof EngineError ? e.code : 'ERROR',
						message: e instanceof Error ? e.message : String(e),
						blockers,
					});
				});
		}, PLAN_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [engine.client, session, seq, settings, validation.length, revision]);

	const poster = usePreviewPoster(seq, frames.start);
	const blocking =
		plan.status === 'ok'
			? blockingForEngine(plan.plan, engineChoice)
			: plan.status === 'error'
				? ['plan']
				: [];
	const canExport =
		!!seq &&
		!!settings &&
		!validation.length &&
		plan.status === 'ok' &&
		!blocking.length &&
		engine.status === 'connected' &&
		!starting;

	const startExport = async () => {
		if (!seq || !settings || plan.status !== 'ok') return;
		setStarting(true);
		const name = sanitizeFileName(fileName);
		try {
			const job = await engine.client.startExport({
				envelope: exportEnvelope(session.getCommitted(), session.revision),
				sequenceId: seq.id,
				settings,
				...(plan.plan.planId && plan.plan.documentRevision === session.revision
					? { planId: plan.plan.planId }
					: {}),
			});
			trackExportJob(job, `${name}.mp4`);
			saveExportChoice(session.projectId, seq.id, {
				range: effectiveRange,
				engine: engineChoice,
				fileName: name,
			});
			close();
			const focused = await runIfRegistered('panel.open.jobs', ctx);
			notices.push({
				kind: 'info',
				message: `Export started: ${name}.mp4`,
				detail: focused ? undefined : 'Progress is shown in the Jobs panel.',
			});
		} catch (e) {
			notices.push({
				kind: 'error',
				message: 'Export could not start',
				detail: e instanceof EngineError ? `${e.code}: ${e.message}` : String(e),
			});
		} finally {
			setStarting(false);
		}
	};

	const rate = seq?.settings.frameRate ?? { num: 30, den: 1 };
	const tc = (f: number) => formatTimecode(f, rate, { dropFrame: seq?.settings.dropFrame });

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Esc leaves Export mode from anywhere inside it
		<div
			className="flex h-full min-h-0 flex-col bg-pr-app text-pr-text"
			data-testid="export-mode"
			onKeyDown={(e) => {
				if (e.key === 'Escape') close();
			}}
		>
			<header className="flex h-[var(--pr-tab-h)] shrink-0 items-center gap-2 border-b border-pr-border-subtle bg-pr-header px-3">
				<h2 className="text-pr-ui text-pr-strong">Export</h2>
				<span className="text-pr-small text-pr-muted">{seq ? sequenceName(doc, seq.id) : ''}</span>
				<IconButton className="ml-auto" icon="app.close" label="Back to Edit" onClick={close} />
			</header>
			<div
				className="grid min-h-0 flex-1 gap-[var(--pr-gutter)] p-[var(--pr-gutter)]"
				style={{ gridTemplateColumns: '240px minmax(320px, 1fr) 380px' }}
			>
				{/* Destinations (S05:EX-010) */}
				<section className="flex flex-col gap-1 rounded-pr-frame bg-pr-panel p-2" aria-label="Destinations">
					<h3 className="px-2 py-1 text-pr-small text-pr-muted">DESTINATIONS</h3>
					<button
						type="button"
						className="flex items-center gap-2 rounded-pr-control bg-pr-selected px-2 py-1 text-left text-pr-strong"
					>
						Media File <span className="ml-auto text-pr-accent">●</span>
					</button>
					{['Frame', 'Audio Only', 'Social presets', 'Interchange'].map((d) => (
						<button
							key={d}
							type="button"
							disabled
							title="Coming after M1"
							className="px-2 py-1 text-left text-pr-dim"
						>
							{d}
						</button>
					))}
				</section>

				{/* Preview (S05:EX-011) */}
				<section
					className="flex min-h-0 flex-col gap-2 rounded-pr-frame bg-pr-panel p-3"
					aria-label="Preview"
				>
					<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-pr-field-deep">
						{poster ? (
							// The poster derivative is 320 px wide: show it at up to 2× so it reads as a preview frame
							// without turning into a blur (a true export-frame render is a later item).
							<img
								src={poster}
								alt="Export preview"
								className="max-h-full w-[640px] max-w-full object-contain"
							/>
						) : (
							<span className="text-pr-small text-pr-dim">No preview frame</span>
						)}
					</div>
					<div className="flex items-center gap-3 text-pr-small">
						<TimecodeText value={tc(frames.start)} />
						<div className="h-1 flex-1 rounded-pr-control bg-pr-accent-fill" />
						<TimecodeText value={tc(frames.end)} tone="primary" />
					</div>
					<label className="flex items-center gap-2 text-pr-small">
						<span className="w-16 text-pr-muted">Range</span>
						<select
							data-testid="export-range"
							className="h-[var(--pr-control-h)] rounded-pr-control bg-pr-field px-2 text-pr-text"
							value={effectiveRange}
							onChange={(e) => setRange(e.target.value as ExportRangeChoice)}
						>
							<option value="entire">Entire Sequence</option>
							<option value="in-out" disabled={!seq || !hasInOut(seq)}>
								Sequence In/Out
							</option>
						</select>
						<span className="text-pr-dim">Duration {tc(frames.end - frames.start)}</span>
					</label>
				</section>

				{/* Settings (S05:EX-012) */}
				<section
					className="flex min-h-0 flex-col gap-3 overflow-auto rounded-pr-frame bg-pr-panel p-3"
					aria-label="Settings"
				>
					<Field label="Source">
						<select
							data-testid="export-source"
							className="h-[var(--pr-control-h)] w-full rounded-pr-control bg-pr-field px-2 text-pr-text"
							value={sequenceId ?? ''}
							onChange={(e) => setSequenceId(e.target.value)}
						>
							{sequenceIds.map((id) => (
								<option key={id} value={id}>
									{sequenceName(doc, id)}
								</option>
							))}
						</select>
					</Field>
					<Field label="File name">
						<input
							data-testid="export-filename"
							className="h-[var(--pr-control-h)] w-full rounded-pr-control bg-pr-field px-2 text-pr-text"
							value={fileName}
							onChange={(e) => setFileName(e.target.value)}
						/>
					</Field>
					<Field label="Location">
						<span className="text-pr-muted">Download from the engine</span>
					</Field>
					<Field label="Preset">
						<span>{MATCH_SEQUENCE_PRESET.label}</span>
					</Field>
					<Field label="Format">
						<span>H.264 (MP4)</span>
					</Field>
					<Field label="Engine">
						<select
							data-testid="export-engine"
							className="h-[var(--pr-control-h)] w-full rounded-pr-control bg-pr-field px-2 text-pr-text"
							value={engineChoice}
							onChange={(e) => setEngineChoice(e.target.value as ExportEngineChoice)}
						>
							{ENGINE_OPTIONS.map((o) => (
								<option key={o.value} value={o.value} title={o.hint}>
									{o.label}
								</option>
							))}
						</select>
					</Field>
					<div className="border-t border-pr-border-subtle pt-2">
						<h3 className="mb-1 text-pr-small text-pr-muted">SUMMARY</h3>
						<p className="mb-2 text-pr-small">
							{seq ? outputDescription(seq, frames.end - frames.start) : ''}
						</p>
						<PlanSummary state={plan} engine={engineChoice} sequence={seq} />
					</div>
				</section>
			</div>
			<footer className="flex shrink-0 items-center gap-2 border-t border-pr-border-subtle bg-pr-header px-3 py-2">
				<div className="min-w-0 flex-1 text-pr-small text-pr-danger" data-testid="export-errors">
					{validation.join(' ')}
					{engine.status !== 'connected' ? ' The engine is not connected.' : ''}
				</div>
				<Button onClick={close}>Cancel</Button>
				<Button
					variant="primary"
					pill
					data-testid="export-start"
					disabled={!canExport}
					className={cx(starting ? 'opacity-60' : '')}
					onClick={() => void startExport()}
				>
					Export
				</Button>
			</footer>
		</div>
	);
}

function Field(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2 text-pr-ui">
			<span className="w-20 shrink-0 text-pr-small text-pr-muted">{props.label}</span>
			<div className="min-w-0 flex-1">{props.children}</div>
		</div>
	);
}
