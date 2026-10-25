// wp interchange dialogs: File ▸ Export ▸ <timeline format> options (Premiere's export dialogs: Final Cut Pro XML,
// AAF, OMF, EDL; plus FCPXML, OpenTimelineIO and Avid ALE), the report shown after every import and export (what
// was not carried and what was written instead), and the registration of Link Media (link-media/LinkMediaDialog.tsx).
import type {
	EngineJob,
	InterchangeExportOptions,
	InterchangeExportResult,
	InterchangeFormat,
	InterchangeMissing,
	InterchangeReportEntry,
} from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import type { Sequence } from '@jasper/project';
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
} from '@jasper/ui';
import { useEffect, useState } from 'react';
import { exportEnvelope } from '../export/settings.ts';
import { useDialogClose } from '../extensions/dialog.ts';
import { defaultPrerender, formatEntry, PRERENDER_LABELS } from './formats.ts';
import { LinkMediaDialog } from './link-media/LinkMediaDialog.tsx';

export { offlineMedia } from './link-media/LinkMediaDialog.tsx';

export const INTERCHANGE_EXPORT_DIALOG = 'interchange.export';
export const INTERCHANGE_REPORT_DIALOG = 'interchange.report';
export const LINK_MEDIA_DIALOG = 'interchange.linkMedia';

let registered = false;
export function registerInterchangeDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(INTERCHANGE_EXPORT_DIALOG, InterchangeExportDialog);
	registerDialog(INTERCHANGE_REPORT_DIALOG, InterchangeReportDialog);
	registerDialog(LINK_MEDIA_DIALOG, LinkMediaDialog);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-[150px] shrink-0 text-pr-muted">{label}</span>
			{children}
		</div>
	);
}

const errorText = (e: unknown) =>
	e instanceof EngineError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

export type ReportFile = { name: string; url: string; role: string; path?: string };

export type InterchangeReportProps = {
	title: string;
	summary: string;
	warnings: InterchangeReportEntry[];
	missing?: Pick<InterchangeMissing, 'name' | 'path' | 'reason'>[];
	files?: ReportFile[];
	/** Offers Link Media for the missing files. */
	linkMedia?: { session: EditorSession; engine: EngineClient };
};

const REASONS: Record<InterchangeMissing['reason'], string> = {
	'no-path': 'no file path in the document',
	'not-found': 'file not found',
	'offline-in-document': 'offline in the document',
	unresolved: 'not linked',
};

const entryKey = (e: InterchangeReportEntry) =>
	`${e.level}|${e.message}|${e.subject?.kind ?? ''}|${e.subject?.id ?? ''}|${e.instead ?? ''}`;

/** The entries of a report: what was not carried (warnings, with what was written instead), then notes. */
export function ReportEntries({ entries }: { entries: InterchangeReportEntry[] }) {
	const warnings = entries.filter((e) => e.level === 'warning');
	const notes = entries.filter((e) => e.level === 'info');
	if (!entries.length) return <p className="text-pr-muted">Everything was carried.</p>;
	return (
		<div className="flex flex-col gap-2">
			{warnings.length ? (
				<ul
					className="flex flex-col gap-1"
					aria-label="Not carried"
					data-testid="interchange-report-warnings"
				>
					{warnings.map((e) => (
						<li key={entryKey(e)} className="rounded-pr-control bg-pr-raised px-2 py-1">
							<span className="text-pr-warning">{e.message}</span>
							{e.count > 1 ? <span className="text-pr-muted"> ×{e.count}</span> : null}
							{e.instead ? (
								<span className="block text-pr-small text-pr-muted">Instead: {e.instead}</span>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			{notes.length ? (
				<details className="text-pr-small">
					<summary className="cursor-pointer text-pr-muted">Notes ({notes.length})</summary>
					<ul className="mt-1 flex flex-col gap-0.5">
						{notes.map((e) => (
							<li key={entryKey(e)} className="text-pr-text">
								{e.message}
								{e.count > 1 ? ` ×${e.count}` : ''}
							</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}

export function InterchangeReportDialog(props: HostedDialogProps<InterchangeReportProps>) {
	const { open, finish } = useDialogClose(props.close);
	const missing = props.missing ?? [];
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title={props.title}
			size="medium"
			primaryLabel="OK"
			onPrimary={() => finish()}
			footerExtra={
				missing.length && props.linkMedia ? (
					<Button
						variant="secondary"
						onClick={() => {
							finish();
							openDialog(LINK_MEDIA_DIALOG, { ...props.linkMedia! });
						}}
						data-testid="interchange-report-link-media"
					>
						Link Media…
					</Button>
				) : undefined
			}
			data-testid="interchange-report"
		>
			<div className="flex max-h-[60vh] flex-col gap-3 overflow-auto text-pr-ui">
				<p className="text-pr-text">{props.summary}</p>
				{props.files?.length ? (
					<ul className="flex flex-col gap-0.5" aria-label="Files">
						{props.files.map((f) => (
							<li key={f.name} className="flex items-center gap-2">
								<a className="text-pr-accent underline" href={f.url} download={f.name}>
									{f.name}
								</a>
								{f.path ? <span className="truncate text-pr-small text-pr-muted">{f.path}</span> : null}
							</li>
						))}
					</ul>
				) : null}
				{missing.length ? (
					<div className="flex flex-col gap-1" data-testid="interchange-report-missing">
						<span className="text-pr-warning">
							{missing.length === 1
								? '1 media file is offline:'
								: `${missing.length} media files are offline:`}
						</span>
						<ul className="flex flex-col gap-0.5 text-pr-small">
							{missing.map((m) => (
								<li key={`${m.name}|${m.path ?? ''}|${m.reason}`}>
									{m.name}{' '}
									<span className="text-pr-muted">
										— {REASONS[m.reason]}
										{m.path ? ` (${m.path})` : ''}
									</span>
								</li>
							))}
						</ul>
					</div>
				) : null}
				<ReportEntries entries={props.warnings} />
			</div>
		</Dialog>
	);
}

type ExportProps = {
	session: EditorSession;
	engine: EngineClient;
	sequenceId: string;
	format: InterchangeFormat;
};

type AudioMode = 'link' | 'embed' | 'separate';

function sequenceItemName(session: EditorSession, sequenceId: string): string {
	const doc = session.getCommitted();
	return (
		Object.values(doc.items).find(
			(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === sequenceId,
		)?.name ?? 'Sequence'
	);
}

async function waitForJob(
	engine: EngineClient,
	id: string,
	onUpdate: (j: EngineJob) => void,
): Promise<EngineJob> {
	for (;;) {
		const j = await engine.getJob(id);
		onUpdate(j);
		if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state)) return j;
		await new Promise((r) => setTimeout(r, 400));
	}
}

export function InterchangeExportDialog(props: HostedDialogProps<ExportProps>) {
	const { session, engine, sequenceId, format } = props;
	const { open, finish } = useDialogClose(props.close);
	const entry = formatEntry(format);
	const seq = session.getCommitted().sequences[sequenceId] as Sequence;
	const [name, setName] = useState(() => sequenceItemName(session, sequenceId));
	const [prerender, setPrerender] = useState(() => defaultPrerender(format));
	const [plan, setPlan] = useState<{ count: number; reasons: string[] } | null>(null);
	const [xmeml, setXmeml] = useState<'4' | '5'>('4');
	const [fcpxml, setFcpxml] = useState<'1.9' | '1.10' | '1.11'>('1.10');
	const [edlVideo, setEdlVideo] = useState('0');
	const [edlAudio, setEdlAudio] = useState<number[]>(() => seq.audioTracks.slice(0, 4).map((_, i) => i));
	const [reelMode, setReelMode] = useState<'file-name' | 'clip-name' | 'ax'>('file-name');
	const [longReels, setLongReels] = useState(false);
	const [edlComments, setEdlComments] = useState(true);
	const [perTrack, setPerTrack] = useState(false);
	const [audioMode, setAudioMode] = useState<AudioMode>(format === 'omf' ? 'embed' : 'link');
	// Premiere's defaults: one second of handles; OMF "Separate Audio" writes mono files.
	const [handles, setHandles] = useState(() =>
		String(Math.round(seq.settings.frameRate.num / seq.settings.frameRate.den)),
	);
	const [copyComplete, setCopyComplete] = useState(false);
	const [breakout, setBreakout] = useState(format === 'omf');
	const [bitDepth, setBitDepth] = useState<'16' | '24'>('24');
	const [fileFormat, setFileFormat] = useState<'wav' | 'aiff'>(format === 'omf' ? 'aiff' : 'wav');
	const [smallSectors, setSmallSectors] = useState(false);
	const [aleScope, setAleScope] = useState<'sequence' | 'project'>('sequence');
	const [destMode, setDestMode] = useState<'download' | 'path'>('download');
	const [destPath, setDestPath] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [job, setJob] = useState<EngineJob | null>(null);

	useEffect(() => {
		if (!entry.video) return;
		let stop = false;
		engine
			.interchangePrerenderPlan({
				envelope: exportEnvelope(session.getCommitted(), session.revision) as never,
				sequenceId,
				format,
				prerender,
			})
			.then((r) => {
				if (!stop) setPlan({ count: r.clips.length, reasons: [...new Set(r.clips.map((c) => c.reason))] });
			})
			.catch(() => !stop && setPlan(null));
		return () => {
			stop = true;
		};
	}, [engine, session, sequenceId, format, prerender, entry.video]);

	const options = (): InterchangeExportOptions => {
		const o: InterchangeExportOptions = { name, prerender };
		if (format === 'fcp7') o.xmemlVersion = Number(xmeml) as 4 | 5;
		if (format === 'fcpxml') o.fcpxmlVersion = fcpxml;
		if (format === 'edl')
			o.edl = {
				videoTrack: edlVideo === 'none' ? null : Number(edlVideo),
				audioTracks: edlAudio,
				reelMode,
				reelLength: longReels ? 32 : 8,
				clipNames: edlComments,
				sourceFiles: edlComments,
				effectNames: edlComments,
				markers: edlComments,
				perTrack,
			};
		if (format === 'aaf' || format === 'omf')
			o.audio = {
				mode: audioMode,
				handlesFrames: Math.max(0, Math.round(Number(handles) || 0)),
				breakoutToMono: breakout,
				bitDepth: Number(bitDepth) as 16 | 24,
				fileFormat: format === 'aaf' ? 'wav' : fileFormat,
				copyComplete,
			};
		if (format === 'aaf' && smallSectors) o.aafSmallSectors = true;
		if (format === 'ale') o.ale = { scope: aleScope };
		if (destMode === 'path') o.relativePaths = false;
		return o;
	};

	const run = async () => {
		setError(null);
		if (destMode === 'path' && !/^([A-Za-z]:[\\/]|\/)/.test(destPath.trim())) {
			setError('Enter an absolute file path for the destination');
			return false;
		}
		let started: EngineJob;
		try {
			started = await engine.exportTimeline({
				envelope: exportEnvelope(session.getCommitted(), session.revision) as never,
				sequenceId,
				format,
				options: options(),
				...(destMode === 'path' ? { destination: { type: 'path', path: destPath.trim() } } : {}),
			});
		} catch (e) {
			setError(errorText(e));
			return false;
		}
		setJob(started);
		const end = await waitForJob(engine, started.id, setJob).catch((e) => {
			setError(errorText(e));
			return null;
		});
		if (!end) return false;
		if (end.state !== 'succeeded') {
			setError(end.error?.message ?? `The export ${end.state}`);
			setJob(null);
			return false;
		}
		const res = end.result as InterchangeExportResult;
		finish(res);
		openDialog(INTERCHANGE_REPORT_DIALOG, {
			title: `Export ${entry.title}`,
			summary: `${res.files.filter((f) => f.role === 'document').length} document(s) written${
				res.prerendered.length ? `, ${res.prerendered.length} clip(s) pre-rendered` : ''
			}${res.files.some((f) => f.role === 'audio') ? `, ${res.files.filter((f) => f.role === 'audio').length} audio file(s)` : ''}.`,
			warnings: res.warnings,
			files: res.files.map((f) => ({
				name: f.name,
				url: engine.interchangeOutputUrl(end.id, f.name, true),
				role: f.role,
				...(f.path ? { path: f.path } : {}),
			})),
		} satisfies InterchangeReportProps);
		return true;
	};

	const busy = !!job;
	const audioTracks = seq.audioTracks.slice(0, 8);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && !busy && finish()}
			title={`Export ${entry.title}`}
			size="medium"
			primaryLabel={busy ? `${job?.stage ?? 'Exporting'}…` : 'Export'}
			primaryDisabled={busy}
			onPrimary={run}
			data-testid="interchange-export-dialog"
		>
			<div className="flex flex-col gap-2.5 text-pr-ui">
				<Row label="Name">
					<TextField value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
				</Row>
				{format === 'fcp7' ? (
					<Row label="XML version">
						<Select
							value={xmeml}
							onValueChange={(v) => setXmeml(v as '4' | '5')}
							options={[
								{ value: '4', label: 'Version 4 (Premiere Pro, DaVinci Resolve)' },
								{ value: '5', label: 'Version 5 (Final Cut Pro 7)' },
							]}
							label="XML version"
							id="ix-xmeml"
						/>
					</Row>
				) : null}
				{format === 'fcpxml' ? (
					<Row label="FCPXML version">
						<Select
							value={fcpxml}
							onValueChange={(v) => setFcpxml(v as '1.9' | '1.10' | '1.11')}
							options={[
								{ value: '1.9', label: '1.9 (Final Cut Pro 10.4.7)' },
								{ value: '1.10', label: '1.10 (Final Cut Pro 10.6)' },
								{ value: '1.11', label: '1.11 (Final Cut Pro 10.6.6)' },
							]}
							label="FCPXML version"
							id="ix-fcpxml"
						/>
					</Row>
				) : null}
				{format === 'edl' ? (
					<>
						<Row label="Video track">
							<Select
								value={edlVideo}
								onValueChange={setEdlVideo}
								options={[
									...seq.videoTracks.map((_, i) => ({ value: String(i), label: `V${i + 1}` })),
									{ value: 'none', label: 'None (audio only)' },
								]}
								label="Video track"
								id="ix-edl-video"
							/>
						</Row>
						<Row label="Audio tracks">
							<div className="flex flex-wrap gap-2">
								{audioTracks.map((t, i) => (
									<Checkbox
										key={t.id}
										id={`ix-edl-a${i + 1}`}
										label={`A${i + 1}`}
										checked={edlAudio.includes(i)}
										disabled={!edlAudio.includes(i) && edlAudio.length >= 4}
										onCheckedChange={(v) =>
											setEdlAudio((l) => (v ? [...l, i].sort((a, b) => a - b) : l.filter((x) => x !== i)))
										}
									/>
								))}
							</div>
						</Row>
						<Row label="Reel names">
							<Select
								value={reelMode}
								onValueChange={(v) => setReelMode(v as typeof reelMode)}
								options={[
									{ value: 'file-name', label: 'From file names' },
									{ value: 'clip-name', label: 'From clip names' },
									{ value: 'ax', label: 'AX (all reels)' },
								]}
								label="Reel names"
								id="ix-edl-reels"
							/>
						</Row>
						<Checkbox
							id="ix-edl-long"
							label="32-character reel names"
							checked={longReels}
							onCheckedChange={setLongReels}
						/>
						<Checkbox
							id="ix-edl-comments"
							label="Include clip names, source files, effects and markers as comments"
							checked={edlComments}
							onCheckedChange={setEdlComments}
						/>
						<Checkbox
							id="ix-edl-pertrack"
							label="One EDL per video track"
							checked={perTrack}
							onCheckedChange={setPerTrack}
						/>
					</>
				) : null}
				{format === 'aaf' || format === 'omf' ? (
					<>
						<Row label="Audio">
							<Select
								value={audioMode}
								onValueChange={(v) => setAudioMode(v as AudioMode)}
								options={[
									{ value: 'link', label: 'Link to the source files' },
									{ value: 'embed', label: format === 'omf' ? 'Encapsulate' : 'Embed audio' },
									{ value: 'separate', label: 'Separate audio files' },
								]}
								label="Audio"
								id="ix-audio-mode"
							/>
						</Row>
						{audioMode !== 'link' ? (
							<>
								<Row label="Audio files">
									<Select
										value={copyComplete ? 'complete' : 'trim'}
										onValueChange={(v) => setCopyComplete(v === 'complete')}
										options={[
											{ value: 'trim', label: 'Trim Audio Files' },
											{ value: 'complete', label: 'Copy Complete Audio Files' },
										]}
										label="Audio files"
										id="ix-audio-files"
									/>
								</Row>
								<Row label="Handle frames">
									<TextField
										value={handles}
										onChange={(e) => setHandles(e.target.value.replace(/[^0-9]/g, ''))}
										aria-label="Handle frames"
										className="w-[80px]"
									/>
								</Row>
								<Row label="Bit depth">
									<Select
										value={bitDepth}
										onValueChange={(v) => setBitDepth(v as '16' | '24')}
										options={[
											{ value: '16', label: '16-bit' },
											{ value: '24', label: '24-bit' },
										]}
										label="Bit depth"
										id="ix-bits"
									/>
								</Row>
								{audioMode === 'separate' && format === 'omf' ? (
									<Row label="Audio file format">
										<Select
											value={fileFormat}
											onValueChange={(v) => setFileFormat(v as 'wav' | 'aiff')}
											options={[
												{ value: 'aiff', label: 'AIFF' },
												{ value: 'wav', label: 'Broadcast WAVE' },
											]}
											label="Audio file format"
											id="ix-file-format"
										/>
									</Row>
								) : null}
							</>
						) : null}
						<Checkbox
							id="ix-breakout"
							label="Breakout to mono"
							checked={breakout}
							onCheckedChange={setBreakout}
						/>
						{format === 'aaf' ? (
							<Checkbox
								id="ix-sectors"
								label="512-byte sectors (older Avid and Pro Tools versions)"
								checked={smallSectors}
								onCheckedChange={setSmallSectors}
							/>
						) : null}
					</>
				) : null}
				{format === 'ale' ? (
					<Row label="Clips">
						<Select
							value={aleScope}
							onValueChange={(v) => setAleScope(v as 'sequence' | 'project')}
							options={[
								{ value: 'sequence', label: 'Media used by the sequence' },
								{ value: 'project', label: 'All media in the project' },
							]}
							label="Clips"
							id="ix-ale-scope"
						/>
					</Row>
				) : null}
				{entry.video ? (
					<Row label="Pre-render">
						<div className="flex flex-col gap-1">
							<Select
								value={prerender}
								onValueChange={(v) => setPrerender(v as typeof prerender)}
								options={(['unsupported', 'all', 'none'] as const).map((m) => ({
									value: m,
									label: PRERENDER_LABELS[m],
								}))}
								label="Pre-render"
								id="ix-prerender"
							/>
							{plan ? (
								<span className="text-pr-small text-pr-muted" data-testid="ix-prerender-plan">
									{plan.count
										? `${plan.count} clip(s) rendered to ProRes 4444 with alpha (${plan.reasons.join(', ')})`
										: 'No clips need a pre-render'}
								</span>
							) : null}
						</div>
					</Row>
				) : null}
				<Row label="Destination">
					<Select
						value={destMode}
						onValueChange={(v) => setDestMode(v as 'download' | 'path')}
						options={[
							{ value: 'download', label: 'Download' },
							{ value: 'path', label: 'Save to a file path (local engine)' },
						]}
						label="Destination"
						id="ix-dest"
					/>
				</Row>
				{destMode === 'path' ? (
					<Row label="File">
						<TextField
							value={destPath}
							onChange={(e) => setDestPath(e.target.value)}
							placeholder={`/path/to/${name}.${entry.extension}`}
							aria-label="Destination file"
						/>
					</Row>
				) : null}
				{job ? (
					<p className="text-pr-small text-pr-muted" role="status">
						{job.stage ?? job.state}
						{typeof job.progress === 'number' ? ` — ${Math.round(job.progress * 100)}%` : ''}
					</p>
				) : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

/** The report after File ▸ Import of timeline documents (one dialog for all of them). */
export function showImportReports(
	session: EditorSession,
	engine: EngineClient,
	reports: {
		name: string;
		format: InterchangeFormat;
		warnings: InterchangeReportEntry[];
		missing: InterchangeMissing[];
		sequenceIds: string[];
	}[],
): void {
	const seqs = reports.reduce((n, r) => n + r.sequenceIds.length, 0);
	const names = reports.map((r) => `${r.name} (${formatEntry(r.format).title})`).join(', ');
	void openDialog(INTERCHANGE_REPORT_DIALOG, {
		title: reports.length === 1 ? `Import ${formatEntry(reports[0]!.format).title}` : 'Import Timelines',
		summary: `${names}: ${seqs} sequence${seqs === 1 ? '' : 's'} imported.`,
		warnings: reports.flatMap((r) => r.warnings),
		missing: reports.flatMap((r) => r.missing),
		linkMedia: { session, engine },
	} satisfies InterchangeReportProps);
}
