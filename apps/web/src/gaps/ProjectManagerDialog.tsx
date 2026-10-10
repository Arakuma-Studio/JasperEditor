// File ▸ Project Manager… (workstream gaps, docs/wp-notes/gaps.md §PRJ-6), as Premiere's dialog: the sequences to
// keep, Resulting Project (Collect Files and Copy to New Location / Consolidate and Transcode), Options (Exclude
// Unused Clips, Include Handles, Include Preview Files, Include Proxies), Destination Path and Disk Space (Calculate).
// OK runs the engine job; the Jobs panel shows its progress and a report dialog lists what was written.
import type { ProjectManagerEstimate, ProjectManagerResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { makeEnvelope } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	openDialog,
	registerDialog,
	Select,
	TextField,
	toast,
} from '@jasper/ui';
import { useEffect, useState } from 'react';
import { errorText, followJob, formatBytes } from '../processing/engine-jobs.ts';

export const PROJECT_MANAGER_DIALOG = 'gaps.projectManager';
export const PROJECT_MANAGER_REPORT = 'gaps.projectManagerReport';

type Props = { session: EditorSession; engine: EngineClient };

function ProjectManagerDialog(props: HostedDialogProps<Props>) {
	const { session, engine } = props;
	const doc = session.getCommitted();
	const seqItems = Object.values(doc.items).filter((i) => i.kind === 'sequence') as {
		id: string;
		name: string;
		sequenceId: string;
	}[];
	const [chosen, setChosen] = useState<Set<string>>(() => new Set(seqItems.map((s) => s.sequenceId)));
	const [mode, setMode] = useState<'collect' | 'consolidate'>('collect');
	const [excludeUnused, setExcludeUnused] = useState(true);
	const [handles, setHandles] = useState(30);
	const [includePreviews, setIncludePreviews] = useState(false);
	const [includeProxies, setIncludeProxies] = useState(true);
	const [destination, setDestination] = useState('');
	const [name, setName] = useState(`${doc.name} Copy`);
	const [estimate, setEstimate] = useState<ProjectManagerEstimate | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		engine
			.call('projectScratch', { params: { projectId: session.projectId } })
			.then((i) => {
				if (i.home) setDestination((d) => d || `${i.home}/${doc.name} Copy`);
			})
			.catch(() => undefined);
	}, [engine, session.projectId, doc.name]);

	const request = () => ({
		envelope: makeEnvelope(session.getCommitted(), {
			revision: session.getState().revision,
			savedAt: new Date().toISOString(),
			platform: 'web',
		}) as never,
		options: {
			destination: destination.trim(),
			mode,
			sequenceIds: [...chosen],
			excludeUnused,
			handlesFrames: handles,
			includePreviews,
			includeProxies: mode === 'collect' && includeProxies,
			projectName: name.trim() || `${doc.name} Copy`,
		},
	});
	const valid = () => {
		if (!chosen.size) return 'Choose at least one sequence.';
		if (!destination.trim().startsWith('/') && !/^[A-Za-z]:[\\/]/.test(destination.trim()))
			return 'The destination must be an absolute folder.';
		return null;
	};
	const calculate = async () => {
		const v = valid();
		if (v) return setError(v);
		try {
			setEstimate(await engine.call('projectManagerPlan', { body: request() }));
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Project Manager"
			size="large"
			primaryLabel={busy ? 'Starting…' : 'OK'}
			primaryDisabled={busy}
			onPrimary={async () => {
				const v = valid();
				if (v) {
					setError(v);
					return false;
				}
				setBusy(true);
				try {
					const job = await engine.call('projectManagerStart', { body: request() });
					toast({
						kind: 'info',
						title: `Project Manager: ${name}`,
						detail: 'Progress is shown in the Jobs panel.',
					});
					void followJob(engine, job.id).then((done) => {
						if (done.state === 'succeeded') {
							registerProjectManagerDialog();
							void openDialog(PROJECT_MANAGER_REPORT, { result: done.result as ProjectManagerResult });
						} else if (done.state !== 'cancelled')
							toast({
								kind: 'error',
								title: 'Project Manager failed',
								detail: done.error?.message ?? done.state,
							});
					});
					props.close(job.id);
				} catch (e) {
					setError(errorText(e));
					setBusy(false);
				}
				return false;
			}}
			data-testid="project-manager-dialog"
		>
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
				<section className="flex flex-col gap-1">
					<h3 className="font-semibold text-pr-strong">Sequence</h3>
					<ul className="max-h-64 overflow-auto rounded-pr-control border border-pr-border-subtle p-1">
						{seqItems.map((s) => (
							<li key={s.id}>
								<Checkbox
									checked={chosen.has(s.sequenceId)}
									onCheckedChange={(c) =>
										setChosen((x) => {
											const n = new Set(x);
											if (c) n.add(s.sequenceId);
											else n.delete(s.sequenceId);
											return n;
										})
									}
									label={s.name}
								/>
							</li>
						))}
					</ul>
					<p className="text-pr-small text-pr-dim">Sequences nested in a chosen one are kept too.</p>
				</section>
				<section className="flex flex-col gap-2">
					<h3 className="font-semibold text-pr-strong">Resulting Project</h3>
					<Select
						label="Resulting project"
						value={mode}
						onValueChange={(v) => setMode(v as 'collect' | 'consolidate')}
						options={[
							{ value: 'collect', label: 'Collect Files and Copy to New Location' },
							{ value: 'consolidate', label: 'Consolidate and Transcode (ProRes 422 HQ / WAV)' },
						]}
					/>
					<h3 className="mt-2 font-semibold text-pr-strong">Options</h3>
					<Checkbox checked={excludeUnused} onCheckedChange={setExcludeUnused} label="Exclude Unused Clips" />
					<div className="flex items-center gap-2">
						<span className={mode === 'consolidate' ? '' : 'text-pr-dim'}>Include Handles</span>
						<TextField
							aria-label="Handles (frames)"
							type="number"
							min={0}
							max={10000}
							className="w-20"
							disabled={mode !== 'consolidate'}
							value={handles}
							onChange={(e) =>
								setHandles(Math.max(0, Math.min(10000, Number.parseInt(e.target.value, 10) || 0)))
							}
						/>
						<span className="text-pr-muted">frames</span>
					</div>
					<Checkbox
						checked={includePreviews}
						onCheckedChange={setIncludePreviews}
						label="Include Preview Files"
					/>
					<Checkbox
						checked={mode === 'collect' && includeProxies}
						disabled={mode !== 'collect'}
						onCheckedChange={setIncludeProxies}
						label="Include Proxies"
					/>
					<h3 className="mt-2 font-semibold text-pr-strong">Destination</h3>
					<TextField
						aria-label="Destination folder"
						data-testid="pm-destination"
						value={destination}
						onChange={(e) => setDestination(e.target.value)}
					/>
					<TextField
						aria-label="New project name"
						data-testid="pm-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<div className="mt-2 flex items-center gap-3">
						<Button variant="secondary" onClick={() => void calculate()}>
							Calculate
						</Button>
						{estimate ? (
							<span className="text-pr-small" data-testid="pm-estimate">
								Original {formatBytes(estimate.originalBytes)} → resulting ≈{' '}
								{formatBytes(estimate.resultBytes)}
								{estimate.destinationFreeBytes !== null
									? ` (${formatBytes(estimate.destinationFreeBytes)} free)`
									: ''}
							</span>
						) : null}
					</div>
				</section>
			</div>
			{error ? (
				<p role="alert" className="mt-2 text-pr-small text-pr-danger">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}

function ReportDialog(props: HostedDialogProps<{ result: ProjectManagerResult }>) {
	const r = props.result;
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Project Manager Report"
			size="large"
			data-testid="project-manager-report"
		>
			<p>
				Wrote <b>{r.projectFile}</b> ({formatBytes(r.bytes)}): {r.files.filter((f) => f.to).length} media
				files
				{r.previews ? `, ${r.previews} preview files` : ''}; {r.droppedSequences} sequences and{' '}
				{r.droppedItems} unused items left out. The copy is also on Home.
			</p>
			<ul className="mt-2 max-h-72 overflow-auto text-pr-small">
				{r.files.map((f) => (
					<li key={f.mediaId}>
						{f.action === 'trim' ? 'Consolidated' : f.action === 'copy' ? 'Copied' : 'Offline'}:{' '}
						{f.to ?? f.from ?? f.mediaId}
					</li>
				))}
			</ul>
			{r.skipped.length ? (
				<ul className="mt-2 text-pr-small text-pr-danger">
					{r.skipped.map((s) => (
						<li key={s.mediaId}>{s.reason}</li>
					))}
				</ul>
			) : null}
		</Dialog>
	);
}

let registered = false;
export function registerProjectManagerDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(PROJECT_MANAGER_DIALOG, ProjectManagerDialog);
	registerDialog(PROJECT_MANAGER_REPORT, ReportDialog);
}
