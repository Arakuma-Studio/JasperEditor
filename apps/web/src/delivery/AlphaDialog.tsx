// Spec 19 TL-114: PNG Sequence with Alpha (the In to Out range or the whole sequence) and Export Title (the selected clips
// on their own, trimmed to what they paint plus a margin, the clip's range or the frame at the playhead).
import { type AlphaDeliveryResult, DEFAULT_TRIM_MARGIN_PX, MAX_TRIM_MARGIN_PX } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useEffect, useState } from 'react';
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

export const ALPHA_DIALOG = 'delivery.alpha';

type Span = { start: number; end: number };
type Props = {
	session: EditorSession;
	engine: EngineClient;
	sequenceId: string;
	/** Export Title: these clips alone. */
	clipIds?: string[];
	baseName: string;
	range: Span;
	playhead: number;
};

function AlphaDialog(props: Props & HostedDialogProps) {
	const { session, engine, sequenceId, clipIds, baseName, range, playhead } = props;
	const isTitle = !!clipIds;
	const [what, setWhat] = useState<'sequence' | 'frame'>('sequence');
	const [trim, setTrim] = useState(isTitle);
	const [margin, setMargin] = useState(DEFAULT_TRIM_MARGIN_PX);
	const [name, setName] = useState(safeName(baseName));
	const [local, setLocal] = useState(false);
	const [folder, setFolder] = useState('');
	const [progress, setProgress] = useState<JobProgress | null>(null);
	const [error, setError] = useState<string | null>(null);

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

	const span = what === 'frame' ? { start: playhead, end: playhead + 1 } : range;
	const frames = span.end - span.start;

	const run = async () => {
		setError(null);
		setProgress({ id: '', stage: 'Queued', fraction: null });
		try {
			const clean = safeName(name);
			const started = await engine.call('alphaDelivery', {
				body: {
					envelope: envelopeOf(session),
					sequenceId,
					range: span,
					...(clipIds ? { clipIds } : {}),
					...(trim ? { trim: { marginPx: Math.round(margin) } } : {}),
					...(local && folder.trim() ? { destination: { folder: folder.trim(), name: clean } } : {}),
				},
			});
			const done = await runToEnd<AlphaDeliveryResult>(engine, started, setProgress);
			if (!done) return setProgress(null);
			if (!done.path) downloadFile(engine, done.url, `${clean}.${done.format}`);
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
			title={isTitle ? 'Export Title' : 'PNG Sequence with Alpha'}
			size="medium"
			primaryLabel={progress ? 'Exporting…' : 'Export'}
			primaryDisabled={!!progress || !(frames > 0)}
			cancelLabel={progress?.id ? 'Cancel export' : 'Cancel'}
			onCancel={() => {
				if (progress?.id) void cancelJob(engine, progress.id);
			}}
			onPrimary={() => {
				void run();
				return false;
			}}
			data-testid="alpha-dialog"
		>
			<div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2">
				<span className="text-pr-muted">Name</span>
				<TextField aria-label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
				<span className="text-pr-muted">Frames</span>
				<Select
					label="Frames"
					className="w-72"
					value={what}
					onValueChange={(v) => setWhat(v as 'sequence' | 'frame')}
					options={[
						{
							value: 'sequence',
							label: `${isTitle ? 'Clip range' : 'Sequence range'} (${range.end - range.start})`,
						},
						{ value: 'frame', label: 'Frame at the playhead' },
					]}
				/>
				<span />
				<Checkbox checked={trim} onCheckedChange={setTrim} label="Trim to content" />
				{trim ? (
					<>
						<span className="text-pr-muted">Margin</span>
						<TextField
							aria-label="Margin in pixels"
							data-testid="alpha-margin"
							type="number"
							value={String(margin)}
							min={0}
							max={MAX_TRIM_MARGIN_PX}
							onChange={(e) => {
								const v = Number(e.target.value);
								setMargin(Number.isFinite(v) ? Math.min(MAX_TRIM_MARGIN_PX, Math.max(0, v)) : 0);
							}}
						/>
					</>
				) : null}
				{local ? (
					<>
						<span className="text-pr-muted">Folder</span>
						<TextField
							aria-label="Export folder"
							value={folder}
							onChange={(e) => setFolder(e.target.value)}
						/>
					</>
				) : null}
			</div>
			<p className="mt-2 text-pr-small text-pr-muted">
				{frames === 1
					? 'One transparent PNG.'
					: `${frames} transparent PNGs, straight alpha, in a folder or a ZIP.`}
				{trim
					? ' Trimming measures every frame and renders past the sequence frame, so glows do not clip.'
					: ''}
			</p>
			{progress ? (
				<p className="mt-2 text-pr-small text-pr-muted" aria-live="polite" data-testid="alpha-progress">
					{progress.stage || 'Exporting…'}
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
export function registerAlphaDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(ALPHA_DIALOG, AlphaDialog);
}
