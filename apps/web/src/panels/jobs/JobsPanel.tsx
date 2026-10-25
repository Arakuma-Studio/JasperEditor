// Jobs panel (S05:JOB-001…005, S04:JB-043, EX-030): engine jobs (GET /api/jobs + job.* events via useJobs)
// and client-side jobs (uploads), grouped, with stages, progress, ETA, Cancel / Retry / Download / Dismiss.
import { TERMINAL_JOB_STATES } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { useSessionOrNull } from '@jasper/session/react';
import { Button, cx, Icon, IconButton } from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';
import { notices } from '../../home/notices.tsx';
import { clientJobs, useClientJobs } from '../../import/client-jobs.ts';
import { useEngine, useJobs } from '../../state/engine.tsx';
import type { PanelProps } from '../types.ts';
import {
	type AnyJob,
	canCancel,
	canRetry,
	engineBadge,
	formatElapsed,
	formatEta,
	groupJobs,
	isDownloadable,
	JOB_GROUPS,
	type JobGroupId,
	statusOf,
	summarizeJobs,
	transcriptionDevice,
} from './model.ts';

/** Engine + client jobs of the current project (or all when no project is open). */
function useAllJobs(): { jobs: AnyJob[]; error: string | null } {
	const session = useSessionOrNull();
	const { jobs, error } = useJobs(session ? { projectId: session.projectId } : {});
	const client = useClientJobs();
	return useMemo(() => ({ jobs: [...jobs, ...client], error }), [jobs, client, error]);
}

/** Header badge data (running + queued count, aggregate progress, failures) — S04:JB-042. */
export function useJobsSummary() {
	const { jobs } = useAllJobs();
	return useMemo(() => summarizeJobs(jobs), [jobs]);
}

function useNow(active: boolean) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	return now;
}

export function JobsPanel(_props: PanelProps) {
	const engine = useEngine();
	const { jobs, error } = useAllJobs();
	const connected = engine.status === 'connected';
	const [hidden, setHidden] = useState<Set<string>>(() => new Set());
	const [collapsed, setCollapsed] = useState<Set<JobGroupId>>(
		() => new Set(JOB_GROUPS.filter((g) => g.collapsedByDefault).map((g) => g.id)),
	);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const groups = useMemo(() => groupJobs(jobs, hidden), [jobs, hidden]);
	const summary = useMemo(() => summarizeJobs(jobs.filter((j) => !hidden.has(j.id))), [jobs, hidden]);
	const now = useNow(summary.running > 0);

	const act = async (fn: () => Promise<unknown>, what: string) => {
		try {
			await fn();
		} catch (e) {
			notices.push({
				kind: 'error',
				message: `${what} failed`,
				detail: e instanceof EngineError ? `${e.code}: ${e.message}` : String(e),
			});
		}
	};
	const cancel = (j: AnyJob) =>
		j.client ? clientJobs.cancel(j.id) : void act(() => engine.client.cancelJob(j.id), 'Cancel');
	const retry = (j: AnyJob) => void act(() => engine.client.retryJob(j.id), 'Retry');
	const dismiss = (j: AnyJob) => {
		if (j.client) clientJobs.remove(j.id);
		else setHidden((s) => new Set(s).add(j.id));
	};
	const clearFinished = () => {
		clientJobs.clearFinished();
		setHidden((s) => {
			const n = new Set(s);
			for (const j of jobs) if (TERMINAL_JOB_STATES.has(j.state)) n.add(j.id);
			return n;
		});
	};

	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel text-pr-text"
			data-testid="jobs-panel"
			data-panel-kind="jobs"
		>
			{!connected ? (
				<p
					className="shrink-0 border-b border-pr-border-subtle px-2 py-1 text-pr-small text-pr-warning"
					data-testid="jobs-disconnected"
				>
					Engine disconnected — running jobs are stalled until it reconnects.
				</p>
			) : null}
			{error && error !== 'NOT_IMPLEMENTED' ? (
				<p className="shrink-0 px-2 py-1 text-pr-small text-pr-danger">Jobs unavailable ({error})</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-auto">
				{groups.length === 0 ? (
					<div
						className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center"
						data-testid="jobs-empty"
					>
						<span className="text-pr-icon">
							<Icon id="panel.jobs" size={24} />
						</span>
						<p className="text-pr-small text-pr-muted">
							No jobs. Imports, media analysis and exports appear here.
						</p>
					</div>
				) : (
					groups.map((g) => {
						const isCollapsed = collapsed.has(g.id);
						return (
							<section key={g.id} data-testid={`jobs-group-${g.id}`}>
								<button
									type="button"
									className="flex h-[var(--pr-row-h)] w-full items-center gap-1 bg-pr-panel-alt px-2 text-left text-pr-small text-pr-muted"
									onClick={() =>
										setCollapsed((s) => {
											const n = new Set(s);
											if (n.has(g.id)) n.delete(g.id);
											else n.add(g.id);
											return n;
										})
									}
								>
									<span>{isCollapsed ? '▸' : '▾'}</span>
									<span className="text-pr-text">{g.label}</span>
									<span className="ml-auto">
										{g.active ? `${g.active} active · ` : ''}
										{g.jobs.length}
									</span>
								</button>
								{isCollapsed
									? null
									: g.jobs.map((j) => (
											<JobRow
												key={j.id}
												job={j}
												connected={connected}
												now={now}
												expanded={expanded.has(j.id)}
												onToggle={() =>
													setExpanded((s) => {
														const n = new Set(s);
														if (n.has(j.id)) n.delete(j.id);
														else n.add(j.id);
														return n;
													})
												}
												onCancel={() => cancel(j)}
												onRetry={() => retry(j)}
												onDismiss={() => dismiss(j)}
												downloadUrl={isDownloadable(j) ? engine.client.renderOutputUrl(j.id) : null}
												sidecars={
													isDownloadable(j)
														? [
																...sidecarsOf(j).map((sc) => ({
																	label: sc.name.replace(/^output\./, ''),
																	url: `${engine.client.renderCaptionFileUrl(j.id, sc.name)}?download=1`,
																})),
																...creditsOf(j).map((name) => ({
																	label: name.replace(/^output\./, ''),
																	url: `${engine.client.renderCreditsFileUrl(j.id, name)}?download=1`,
																})),
															]
														: []
												}
											/>
										))}
							</section>
						);
					})
				)}
			</div>
			<footer className="flex h-[var(--pr-row-h)] shrink-0 items-center gap-2 border-t border-pr-border-subtle px-2 text-pr-small text-pr-muted">
				<span data-testid="jobs-summary">
					{summary.running} running · {summary.queued} queued
					{summary.etaSec !== null ? ` · ${formatEta(summary.etaSec)}` : ''}
				</span>
				<Button variant="quiet" className="ml-auto" onClick={clearFinished}>
					Clear Finished
				</Button>
			</footer>
		</div>
	);
}

/** sidecar caption files listed in an export job's result. */
function sidecarsOf(j: AnyJob): { name: string }[] {
	const r = (j as { result?: unknown }).result as { captions?: { sidecars?: unknown } } | undefined;
	const list = r?.captions?.sidecars;
	return Array.isArray(list)
		? list.filter((x): x is { name: string } => !!x && typeof (x as { name?: unknown }).name === 'string')
		: [];
}

/** spec 12 §2.11: the sound credits sidecar listed in an export job's result. */
function creditsOf(j: AnyJob): string[] {
	const r = (j as { result?: unknown }).result as { credits?: { name?: unknown } } | undefined;
	const name = r?.credits?.name;
	return typeof name === 'string' && /^output\.credits\.(txt|md|csv)$/.test(name) ? [name] : [];
}

function JobRow(props: {
	job: AnyJob;
	connected: boolean;
	now: number;
	expanded: boolean;
	onToggle(): void;
	onCancel(): void;
	onRetry(): void;
	onDismiss(): void;
	downloadUrl: string | null;
	/** sidecar caption files of an export. */
	sidecars?: { label: string; url: string }[];
}) {
	const { job } = props;
	const status = statusOf(job, props.connected);
	const terminal = TERMINAL_JOB_STATES.has(job.state);
	const device = transcriptionDevice(job);
	const pct = job.progress === null ? null : Math.round(job.progress * 100);
	const statusTone =
		status === 'Failed' || status === 'Interrupted'
			? 'text-pr-danger'
			: status === 'Stalled'
				? 'text-pr-warning'
				: status === 'Done'
					? 'text-pr-success'
					: 'text-pr-muted';
	return (
		<div
			className="border-b border-pr-border-subtle px-2 py-1"
			data-testid="job-row"
			data-job-id={job.id}
			data-status={status}
		>
			<div className="flex items-center gap-2">
				<button
					type="button"
					className="w-3 text-pr-muted"
					aria-label={props.expanded ? 'Collapse' : 'Expand'}
					onClick={props.onToggle}
				>
					{props.expanded ? '▾' : '▸'}
				</button>
				<span className="min-w-0 flex-1 truncate text-pr-ui" title={job.title}>
					{job.title}
				</span>
				<span
					className="rounded-pr-control border border-pr-border px-1 text-pr-small text-pr-muted"
					title="Engine"
				>
					{engineBadge(job)}
				</span>
				{job.origin.type === 'agent' ? <span className="text-pr-small text-pr-agent">Agent</span> : null}
				<span className={cx('w-20 text-right text-pr-small', statusTone)} data-testid="job-status">
					{status}
					{pct !== null && !terminal ? ` ${pct}%` : ''}
				</span>
				<span className="flex items-center">
					{canCancel(job) && (job.client || props.connected) ? (
						<IconButton icon="app.close" label="Cancel" data-testid="job-cancel" onClick={props.onCancel} />
					) : null}
					{canRetry(job) && props.connected ? (
						<Button variant="quiet" data-testid="job-retry" onClick={props.onRetry}>
							Retry
						</Button>
					) : null}
					{props.downloadUrl ? (
						<a
							href={props.downloadUrl}
							download
							className="px-2 text-pr-small text-pr-accent underline"
							data-testid="job-download"
						>
							Download
						</a>
					) : null}
					{(props.sidecars ?? []).map((sc) => (
						<a
							key={sc.url}
							href={sc.url}
							download
							className="px-1 text-pr-small text-pr-accent underline"
							data-testid="job-download-captions"
						>
							{sc.label}
						</a>
					))}
					{terminal ? <IconButton icon="app.remove" label="Dismiss" onClick={props.onDismiss} /> : null}
				</span>
			</div>
			{!terminal || status === 'Stalled' ? (
				<div className="mt-1 h-1 w-full overflow-hidden rounded-pr-control bg-pr-field" aria-hidden="true">
					<div
						className={cx(
							'h-full',
							status === 'Stalled' ? 'bg-pr-warning' : 'bg-pr-accent',
							pct === null ? 'w-1/3 animate-pulse' : '',
						)}
						style={pct === null ? undefined : { width: `${pct}%` }}
					/>
				</div>
			) : null}
			<div className="mt-0.5 flex gap-3 pl-5 text-pr-small text-pr-dim">
				{job.stage ? <span>{job.stage}</span> : null}
				{!terminal && job.etaSec !== undefined ? <span>{formatEta(job.etaSec)}</span> : null}
				<span>{formatElapsed(job, props.now)}</span>
				{job.speed ? <span>{job.speed.toFixed(1)}×</span> : null}
				{device ? (
					<span data-testid="job-device" title={device.fallback ?? undefined}>
						{device.fallback ? `Ran on: ${device.label} (fell back: ${device.fallback})` : `Ran on: ${device.label}`}
					</span>
				) : null}
			</div>
			{props.expanded ? (
				<div className="mt-1 flex flex-col gap-1 pl-5 text-pr-small" data-testid="job-details">
					{job.error ? (
						<p className="text-pr-danger">
							{job.error.code}: {job.error.message}
							{job.error.logRef ? ` (log ${job.error.logRef})` : ''}
						</p>
					) : null}
					{job.result ? (
						<pre className="max-h-40 overflow-auto rounded-pr-control bg-pr-field-deep p-1 font-pr-mono text-pr-small text-pr-muted">
							{JSON.stringify(job.result, null, 2)}
						</pre>
					) : null}
					<p className="text-pr-dim">
						{job.kind} · {job.priority} · created {new Date(job.createdAt).toLocaleTimeString()}
					</p>
				</div>
			) : null}
		</div>
	);
}
