// Spec 19 TL-112: Send to Photoshop. The plan comes first: the dialog lists the layers and everything baked, with blockers
// shown before anything is written. Writing is an engine job with a Cancel, and the file is complete or absent.
import type { PsdPlan, PsdResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, TextField } from '@jasper/ui';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../processing/engine-jobs.ts';
import {
	cancelJob,
	downloadFile,
	envelopeOf,
	type JobProgress,
	localFolder,
	runToEnd,
	safeName,
} from './shared.ts';

export const PSD_DIALOG = 'delivery.psd';

type Props = {
	session: EditorSession;
	engine: EngineClient;
	sequenceId: string;
	frame: number;
	baseName: string;
};

function PsdDialog(props: Props & HostedDialogProps) {
	const { session, engine, sequenceId, frame, baseName } = props;
	const [split, setSplit] = useState(false);
	const [plan, setPlan] = useState<PsdPlan | null>(null);
	const [local, setLocal] = useState(false);
	const [folder, setFolder] = useState('');
	const [progress, setProgress] = useState<JobProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const asked = useRef(0);

	useEffect(() => {
		const ask = ++asked.current;
		setPlan(null);
		setError(null);
		engine
			.call('psdPlan', { body: { envelope: envelopeOf(session), sequenceId, frame, splitTitles: split } })
			.then((p) => ask === asked.current && setPlan(p))
			.catch((e) => ask === asked.current && setError(errorText(e)));
	}, [engine, session, sequenceId, frame, split]);

	useEffect(() => {
		let off = false;
		void localFolder(engine, session).then((l) => {
			if (off) return;
			setLocal(l.local);
			setFolder(l.folder);
		});
		return () => {
			off = true;
		};
	}, [engine, session]);

	const blocked = !plan || plan.blockers.length > 0;
	const name = safeName(`${baseName} frame ${frame}`);

	const write = async () => {
		setError(null);
		setProgress({ id: '', stage: 'Queued', fraction: null });
		try {
			const started = await engine.call('psdExport', {
				body: {
					envelope: envelopeOf(session),
					sequenceId,
					frame,
					splitTitles: split,
					...(local && folder.trim() ? { destination: { folder: folder.trim(), name } } : {}),
				},
			});
			const done = await runToEnd<PsdResult>(engine, started, setProgress);
			if (!done) return setProgress(null);
			if (!done.path) downloadFile(engine, done.url, `${name}.psd`);
			props.close(done.path ?? done.url);
		} catch (e) {
			setProgress(null);
			setError(errorText(e));
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && !progress && props.close()}
			title="Send to Photoshop"
			size="medium"
			primaryLabel={progress ? 'Writing…' : 'Write PSD'}
			primaryDisabled={blocked || !!progress}
			{...(progress?.id
				? {
						secondaryLabel: 'Cancel writing',
						onSecondary: () => {
							void cancelJob(engine, progress.id);
							return false;
						},
					}
				: {})}
			onPrimary={() => {
				void write();
				return false;
			}}
			data-testid="psd-dialog"
		>
			<p className="mb-2 text-pr-small text-pr-muted">
				The frame at the playhead as a layered 8-bit PSD. Every layer is rasterised and registered to the
				frame: text becomes pixels, not editable type.
			</p>
			<Checkbox
				checked={split}
				onCheckedChange={setSplit}
				label="Split titles into rims, face and fx"
				data-testid="psd-split"
			/>
			{local ? (
				<div className="mt-2 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2">
					<span className="text-pr-muted">Folder</span>
					<TextField aria-label="PSD folder" value={folder} onChange={(e) => setFolder(e.target.value)} />
				</div>
			) : null}
			{!plan && !error ? <p className="mt-2 text-pr-small text-pr-muted">Reading the frame…</p> : null}
			{plan?.blockers.length ? (
				<div role="alert" className="mt-2 text-pr-small text-pr-danger" data-testid="psd-blockers">
					<p className="font-semibold">This frame cannot be written:</p>
					<ul className="list-disc pl-4">
						{plan.blockers.map((b) => (
							<li key={b.code}>{b.message}</li>
						))}
					</ul>
				</div>
			) : null}
			{plan?.layers.length ? (
				<div className="mt-2">
					<p className="font-semibold">Layers, top first</p>
					<ul className="max-h-32 overflow-auto text-pr-small" data-testid="psd-layers">
						{[...plan.layers].reverse().map((l) => (
							<li key={plan.layers.indexOf(l)} className={l.hidden ? 'text-pr-muted' : ''}>
								{l.name}
								{l.kind === 'group' ? ' (group)' : ''}
								{l.hidden ? ' (hidden)' : ''}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{plan?.baked.length ? (
				<div className="mt-2">
					<p className="font-semibold">Baked into pixels</p>
					<ul className="max-h-32 list-disc overflow-auto pl-4 text-pr-small" data-testid="psd-baked">
						{plan.baked.map((b) => (
							<li key={b}>{b}</li>
						))}
					</ul>
				</div>
			) : null}
			{plan?.warnings.length ? (
				<ul className="mt-2 list-disc pl-4 text-pr-small text-pr-muted" data-testid="psd-warnings">
					{plan.warnings.map((w) => (
						<li key={w.code}>{w.message}</li>
					))}
				</ul>
			) : null}
			{progress ? (
				<p className="mt-2 text-pr-small text-pr-muted" aria-live="polite" data-testid="psd-progress">
					{progress.stage}
					{progress.fraction !== null ? ` · ${Math.round(progress.fraction * 100)} %` : ''}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="mt-2 text-pr-small text-pr-danger">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}

let registered = false;
export function registerPsdDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(PSD_DIALOG, PsdDialog);
}
