// File ▸ Export ▸ Frame and the camera button of the Program / Source monitors (workstream gaps, docs/wp-notes/gaps.md
// §EX-3), as Premiere's Export Frame dialog: Name, Format (PNG, JPEG, TIFF, DPX, OpenEXR, BMP, Targa), Path and
// "Import into project". The frame is rendered by the engine's still path (the export's own renderer: native, layer
// bake or Remotion), at full resolution — never from proxies. The Source monitor exports the source's frame at the
// source playhead (a scratch sequence holding the source, like the Source monitor draws it).
import { STILL_FORMAT_EXTENSIONS, STILL_FORMATS, type StillFormat } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	type Command,
	createRandomIdSource,
	defaultRegistries,
	FLICKS_PER_SECOND,
	makeEnvelope,
	type ProjectDocument,
	projectSettingsOf,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { errorText, followJob } from '../processing/engine-jobs.ts';
import { getImportService } from '../state/services.ts';
import { formatTimecode } from './time-display.ts';

export const EXPORT_FRAME_DIALOG = 'gaps.exportFrame';

export const STILL_FORMAT_LABELS: Record<StillFormat, string> = {
	png: 'PNG',
	jpeg: 'JPEG',
	tiff: 'TIFF',
	dpx: 'DPX (10-bit)',
	exr: 'OpenEXR (linear, half float)',
	bmp: 'BMP',
	tga: 'Targa',
};

/** What to render: a sequence frame (Program) or the open source's frame (Source). */
export type FrameSource =
	| { kind: 'sequence'; sequenceId: string; frame: number }
	| { kind: 'source'; itemId: string; frame: number };

/** A name safe as a file name: `<Sequence> HH_MM_SS_FF` (Premiere names exported frames after the sequence). */
export function defaultFrameName(base: string, tc: string): string {
	const clean = `${base} ${tc}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
	return clean.slice(0, 120) || 'Frame';
}

/**
 * The document and sequence the engine renders for a frame source: the project itself for a sequence; for a Source
 * monitor item a scratch sequence matching the media (size and rate) with the source placed at 0.
 */
export function frameRenderDoc(
	doc: ProjectDocument,
	src: FrameSource,
): { doc: ProjectDocument; sequenceId: string; frame: number } | { error: string } {
	if (src.kind === 'sequence') {
		if (!doc.sequences[src.sequenceId]) return { error: 'The sequence is gone' };
		return { doc, sequenceId: src.sequenceId, frame: Math.max(0, Math.round(src.frame)) };
	}
	const it = doc.items[src.itemId];
	if (!it) return { error: 'The source item is gone' };
	if (it.kind === 'sequence')
		return { doc, sequenceId: it.sequenceId, frame: Math.max(0, Math.round(src.frame)) };
	const ids = createRandomIdSource();
	const commands: Command[] = [];
	let frame = Math.max(0, Math.round(src.frame));
	if (it.kind === 'media' || it.kind === 'subclip') {
		const asset = doc.media[it.mediaId];
		if (!asset || (asset.kind !== 'video' && asset.kind !== 'image' && asset.kind !== 'animated-image'))
			return { error: 'Only pictures can be exported as a frame' };
		commands.push({
			type: 'sequence.create',
			name: 'Export Frame',
			fromMediaId: it.mediaId,
			ref: '$seq',
		} as Command);
		// sequence.create from the media places it at 0 (New Sequence From Clip).
		if (it.kind === 'subclip') {
			const vs = asset.probe.streams.find((s) => s.type === 'video');
			const fps = vs?.type === 'video' && vs.frameRate.den > 0 ? vs.frameRate.num / vs.frameRate.den : 30;
			frame += Math.floor((it.range.in / FLICKS_PER_SECOND) * fps + 1e-6);
		}
	} else if (it.kind === 'synthetic') {
		const settings = Object.values(doc.sequences)[0]?.settings as Sequence['settings'] | undefined;
		commands.push({
			type: 'sequence.create',
			name: 'Export Frame',
			ref: '$seq',
			...(settings
				? { settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate } }
				: {}),
		} as Command);
		commands.push({
			type: 'clip.place',
			sequenceId: '$seq',
			source: { syntheticId: it.syntheticId },
			at: 0,
		} as Command);
	} else return { error: 'This item has no picture' };
	const { document, result } = applyTransaction(
		doc,
		{ label: 'Export Frame', origin: 'system', commands },
		{ ids, now: () => new Date().toISOString(), revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) return { error: result.errors[0]?.message ?? 'The frame cannot be prepared' };
	const sequenceId = (result.results[0] as { sequenceId?: string } | undefined)?.sequenceId;
	if (!sequenceId) return { error: 'The frame cannot be prepared' };
	return { doc: document, sequenceId, frame };
}

type Props = {
	session: EditorSession;
	engine: EngineClient;
	source: FrameSource;
	/** Default name (sequence or source name). */
	baseName: string;
};

let lastFormat: StillFormat = 'png';
let lastFolder: string | null = null;
let lastImport = false;

function ExportFrameDialog(props: HostedDialogProps<Props>) {
	const { session, engine } = props;
	const doc0 = session.getCommitted();
	const seq0 =
		props.source.kind === 'sequence'
			? doc0.sequences[props.source.sequenceId]
			: Object.values(doc0.sequences)[0];
	const rate = seq0?.settings.frameRate ?? { num: 30, den: 1 };
	const [name, setName] = useState(() =>
		defaultFrameName(props.baseName, formatTimecode(props.source.frame, rate).replace(/[:;]/g, '_')),
	);
	const [format, setFormat] = useState<StillFormat>(lastFormat);
	const [folder, setFolder] = useState<string>(lastFolder ?? '');
	const [importIt, setImportIt] = useState(lastImport);
	const [local, setLocal] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let off = false;
		engine
			.call('projectScratch', { params: { projectId: session.projectId } })
			.then((i) => {
				if (off) return;
				setLocal(i.local);
				if (!lastFolder) {
					const base = projectSettingsOf(session.getCommitted()).scratch.media ?? i.projectMedia.path;
					if (base) setFolder(`${base.replace(/[\\/]+$/, '')}/Exported Frames`);
				}
			})
			.catch(() => !off && setLocal(false));
		return () => {
			off = true;
		};
	}, [engine, session]);

	const run = async () => {
		setError(null);
		const built = frameRenderDoc(session.getCommitted(), props.source);
		if ('error' in built) {
			setError(built.error);
			return;
		}
		const toFolder = local && folder.trim();
		if (local && !toFolder) {
			setError('Choose the folder for the frame.');
			return;
		}
		setBusy(true);
		lastFormat = format;
		lastImport = importIt;
		if (toFolder) lastFolder = folder.trim();
		try {
			const envelope = makeEnvelope(built.doc, {
				revision: session.getState().revision ?? 0,
				savedAt: new Date().toISOString(),
				platform: 'web',
			}) as never;
			const job = await engine.requestStill({
				envelope,
				sequenceId: built.sequenceId,
				frame: built.frame,
				format,
				...(toFolder ? { destination: { folder: folder.trim(), name: name.trim() || 'Frame' } } : {}),
			});
			const done = await followJob(engine, job.id, { intervalMs: 300 });
			if (done.state !== 'succeeded') {
				setError(done.error?.message ?? `The frame ${done.state}`);
				setBusy(false);
				return;
			}
			const result = done.result as { url: string; path?: string };
			if (result.path && importIt) {
				const svc = getImportService();
				if (svc) await svc.importFiles({ paths: [result.path] }, { kind: 'bin', binId: null });
			}
			if (!result.path) {
				// A remote engine: the browser downloads the file.
				const a = document.createElement('a');
				a.href = engine.url(result.url);
				a.download = `${name.trim() || 'Frame'}.${STILL_FORMAT_EXTENSIONS[format]}`;
				document.body.appendChild(a);
				a.click();
				a.remove();
			}
			props.close(result.path ?? result.url);
		} catch (e) {
			setError(errorText(e));
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Export Frame"
			size="medium"
			primaryLabel={busy ? 'Exporting…' : 'OK'}
			primaryDisabled={busy || local === null}
			onPrimary={() => {
				void run();
				return false;
			}}
			data-testid="export-frame-dialog"
		>
			<div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2">
				<span className="text-pr-muted">Name</span>
				<TextField
					aria-label="Frame name"
					data-testid="export-frame-name"
					value={name}
					maxLength={120}
					onChange={(e) => setName(e.target.value)}
				/>
				<span className="text-pr-muted">Format</span>
				<Select
					label="Frame format"
					className="w-72"
					value={format}
					onValueChange={(v) => setFormat(v as StillFormat)}
					options={STILL_FORMATS.map((f) => ({ value: f, label: STILL_FORMAT_LABELS[f] }))}
				/>
				{local ? (
					<>
						<span className="text-pr-muted">Path</span>
						<TextField
							aria-label="Frame folder"
							data-testid="export-frame-folder"
							value={folder}
							onChange={(e) => setFolder(e.target.value)}
						/>
						<span />
						<Checkbox checked={importIt} onCheckedChange={setImportIt} label="Import into project" />
					</>
				) : local === false ? (
					<>
						<span />
						<span className="text-pr-small text-pr-muted">
							The engine is remote: the frame is downloaded.
						</span>
					</>
				) : null}
			</div>
			{error ? (
				<p role="alert" className="mt-2 text-pr-small text-pr-danger">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}

let registered = false;
export function registerExportFrameDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(EXPORT_FRAME_DIALOG, ExportFrameDialog);
}
