// imports workstream dialogs (docs/wp-notes/imports.md): the import prompts — Image Sequence (numbered stills as one
// clip, frame rate), Import Layered File (Premiere's: Merge All Layers / Merged Layers / Individual Layers / Sequence
// with the layer list), PDF / Illustrator pages — and File ▸ Export ▸ Lottie… (format, range, warnings, download).
import type { LayeredExtractResult, LayeredLayer, LottieExportResult } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import type { LayeredImportMode, Rational } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
} from '@jasper/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { exportEnvelope } from '../export/settings.ts';
import { parseFps } from './interpret-dialog.tsx';

export const IMAGE_SEQUENCE_DIALOG = 'imports.imageSequence';
export const LAYERED_IMPORT_DIALOG = 'imports.layered';
export const PDF_PAGES_DIALOG = 'imports.pdfPages';
export const LOTTIE_EXPORT_DIALOG = 'imports.lottieExport';

const errorText = (e: unknown) =>
	e instanceof EngineError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

function useFinish(close: (r?: unknown) => void) {
	const [open, setOpen] = useState(true);
	return {
		open,
		finish(r?: unknown) {
			setOpen(false);
			close(r);
		},
	};
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-[140px] shrink-0 text-pr-muted">{label}</span>
			{children}
		</div>
	);
}

// ---------------------------------------------------------------- image sequence

export type ImageSequenceGroupView = { label: string; frames: number; missing: number };
export type ImageSequenceChoice = { asSequence: boolean; frameRate: Rational };

export function ImageSequenceDialog(
	props: HostedDialogProps<{ groups: ImageSequenceGroupView[]; defaultRate: Rational }>,
) {
	const { open, finish } = useFinish(props.close);
	const [asSequence, setAsSequence] = useState(true);
	const [text, setText] = useState(String(+(props.defaultRate.num / props.defaultRate.den).toFixed(3)));
	const rate = parseFps(text);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish({ asSequence: false, frameRate: props.defaultRate })}
			title="Image Sequence"
			size="medium"
			primaryLabel="Import"
			primaryDisabled={asSequence && !rate}
			onPrimary={() => finish({ asSequence, frameRate: rate ?? props.defaultRate } satisfies ImageSequenceChoice)}
			data-testid="image-sequence-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<p className="text-pr-text">These files are numbered frames:</p>
				<ul className="flex flex-col gap-0.5" data-testid="image-sequence-groups">
					{props.groups.map((g) => (
						<li key={g.label}>
							<span className="text-pr-strong">{g.label}</span>{' '}
							<span className="text-pr-muted">
								— {g.frames} frames{g.missing ? `, ${g.missing} missing (held)` : ''}
							</span>
						</li>
					))}
				</ul>
				<Checkbox
					checked={asSequence}
					onCheckedChange={setAsSequence}
					label="Import as image sequence (one clip per sequence)"
				/>
				<Row label="Frame rate">
					<TextField
						className="w-[90px]"
						value={text}
						invalid={!rate}
						disabled={!asSequence}
						aria-label="Image sequence frame rate"
						data-testid="image-sequence-rate"
						onChange={(e) => setText(e.target.value)}
					/>
					<span className="text-pr-muted">fps</span>
				</Row>
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- layered documents

export type LayeredChoice = { mode: LayeredImportMode; selected: number[] };

const MODE_LABELS: Record<LayeredImportMode, string> = {
	'merged-all': 'Merge All Layers',
	merged: 'Merged Layers',
	individual: 'Individual Layers',
	sequence: 'Sequence',
};

function LayerRows({
	layers,
	selected,
	toggle,
	depth = 0,
}: {
	layers: LayeredLayer[];
	selected: Set<number>;
	toggle(i: number, on: boolean): void;
	depth?: number;
}) {
	// Photoshop lists the top layer first.
	return (
		<>
			{[...layers].reverse().map((l) => (
				<li key={l.index} className="flex flex-col">
					<div className="flex items-center gap-2" style={{ paddingLeft: depth * 16 }}>
						{l.kind === 'group' ? (
							<span className="text-pr-muted">▾ {l.name}</span>
						) : (
							<Checkbox
								checked={selected.has(l.index)}
								onCheckedChange={(c) => toggle(l.index, c)}
								label={l.name}
								disabled={!l.media}
							/>
						)}
						{!l.visible ? <span className="text-pr-small text-pr-dim">(hidden)</span> : null}
						{l.notes?.length ? <span className="text-pr-small text-pr-warning">{l.notes.join('; ')}</span> : null}
					</div>
					{l.children ? (
						<ul>
							<LayerRows layers={l.children} selected={selected} toggle={toggle} depth={depth + 1} />
						</ul>
					) : null}
				</li>
			))}
		</>
	);
}

function allPictureLayers(layers: LayeredLayer[], out: LayeredLayer[] = []): LayeredLayer[] {
	for (const l of layers) {
		if (l.media) out.push(l);
		if (l.children) allPictureLayers(l.children, out);
	}
	return out;
}

export function LayeredImportDialog(props: HostedDialogProps<{ name: string; result: LayeredExtractResult }>) {
	const { open, finish } = useFinish(props.close);
	const [mode, setMode] = useState<LayeredImportMode>('sequence');
	const pictures = useMemo(() => allPictureLayers(props.result.layers), [props.result]);
	const [selected, setSelected] = useState(() => new Set(pictures.filter((l) => l.visible).map((l) => l.index)));
	const toggle = (i: number, on: boolean) =>
		setSelected((s) => {
			const n = new Set(s);
			if (on) n.add(i);
			else n.delete(i);
			return n;
		});
	const needsLayers = mode !== 'merged-all';
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish({ mode: 'merged-all', selected: [] } satisfies LayeredChoice)}
			title={`Import Layered File: ${props.name}`}
			size="large"
			primaryLabel="OK"
			primaryDisabled={needsLayers && selected.size === 0}
			onPrimary={() => finish({ mode, selected: [...selected] } satisfies LayeredChoice)}
			data-testid="layered-import-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<Row label="Import As">
					<Select
						value={mode}
						onValueChange={(v) => setMode(v as LayeredImportMode)}
						options={(Object.keys(MODE_LABELS) as LayeredImportMode[]).map((m) => ({ value: m, label: MODE_LABELS[m] }))}
						label="Import as"
						className="w-[220px]"
					/>
				</Row>
				<p className="text-pr-small text-pr-muted">
					{mode === 'merged-all'
						? 'One picture: the whole document flattened.'
						: mode === 'merged'
							? 'One picture: the selected layers flattened.'
							: mode === 'individual'
								? 'One item per selected layer, in a bin.'
								: 'A sequence with the selected layers stacked on tracks (positions, opacity, blend modes, groups and clipping masks), and the layers in a bin.'}
				</p>
				{needsLayers ? (
					<div className="flex flex-col gap-1">
						<div className="flex gap-3">
							<button
								type="button"
								className="text-pr-small text-pr-accent underline"
								onClick={() => setSelected(new Set(pictures.map((l) => l.index)))}
							>
								Select all
							</button>
							<button
								type="button"
								className="text-pr-small text-pr-accent underline"
								onClick={() => setSelected(new Set())}
							>
								Select none
							</button>
						</div>
						<ul className="max-h-[40vh] overflow-auto rounded-pr-control bg-pr-raised p-2" data-testid="layered-layers">
							<LayerRows layers={props.result.layers} selected={selected} toggle={toggle} />
						</ul>
					</div>
				) : null}
				{props.result.warnings.length ? (
					<ul className="text-pr-small text-pr-warning">
						{props.result.warnings.map((w) => (
							<li key={w}>{w}</li>
						))}
					</ul>
				) : null}
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- PDF pages

export function PdfPagesDialog(
	props: HostedDialogProps<{ name: string; pages: { page: number; width: number; height: number }[] }>,
) {
	const { open, finish } = useFinish(props.close);
	const [selected, setSelected] = useState(() => new Set([1]));
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish([1])}
			title={`Pages of ${props.name}`}
			size="medium"
			primaryLabel="Import"
			primaryDisabled={selected.size === 0}
			onPrimary={() => finish([...selected].sort((a, b) => a - b))}
			data-testid="pdf-pages-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<p className="text-pr-muted">Each page becomes an item (drawn as vectors at any size).</p>
				<div className="flex gap-3">
					<button
						type="button"
						className="text-pr-small text-pr-accent underline"
						onClick={() => setSelected(new Set(props.pages.map((p) => p.page)))}
					>
						All pages
					</button>
				</div>
				<ul className="max-h-[40vh] overflow-auto" data-testid="pdf-pages">
					{props.pages.map((p) => (
						<li key={p.page}>
							<Checkbox
								checked={selected.has(p.page)}
								onCheckedChange={(c) =>
									setSelected((s) => {
										const n = new Set(s);
										if (c) n.add(p.page);
										else n.delete(p.page);
										return n;
									})
								}
								label={`Page ${p.page} — ${Math.round(p.width)} × ${Math.round(p.height)} pt`}
							/>
						</li>
					))}
				</ul>
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- Lottie export

export type LottieExportProps = { session: EditorSession; engine: EngineClient; sequenceId: string };

function base64Blob(b64: string, type: string): Blob {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type });
}

export function LottieExportDialog(props: HostedDialogProps<LottieExportProps>) {
	const { session, engine, sequenceId } = props;
	const { open, finish } = useFinish(props.close);
	const seq = session.getCommitted().sequences[sequenceId];
	const hasInOut = seq?.inPoint !== null && seq?.inPoint !== undefined && seq?.outPoint !== null && seq?.outPoint !== undefined;
	const [format, setFormat] = useState<'json' | 'dotlottie'>('json');
	const [range, setRange] = useState<'entire' | 'inout'>('entire');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<(LottieExportResult & { url?: string }) | null>(null);
	const run = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await engine.exportLottie({
				envelope: exportEnvelope(session.getCommitted(), session.revision) as never,
				sequenceId,
				format,
				...(range === 'inout' && seq && hasInOut ? { range: { start: seq.inPoint!, end: seq.outPoint! + 1 } } : {}),
			});
			const url = r.contentBase64
				? URL.createObjectURL(base64Blob(r.contentBase64, format === 'json' ? 'application/json' : 'application/zip'))
				: undefined;
			setResult({ ...r, ...(url ? { url } : {}) });
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
		return false;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Export Lottie"
			size="medium"
			primaryLabel={result ? 'Done' : busy ? 'Exporting…' : 'Export'}
			primaryDisabled={busy}
			onPrimary={() => (result ? finish(result) : run())}
			data-testid="lottie-export-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				{!result ? (
					<>
						<Row label="Format">
							<Select
								value={format}
								onValueChange={(v) => setFormat(v as 'json' | 'dotlottie')}
								options={[
									{ value: 'json', label: 'Lottie JSON (.json)' },
									{ value: 'dotlottie', label: 'dotLottie (.lottie)' },
								]}
								label="Format"
								className="w-[220px]"
							/>
						</Row>
						<Row label="Range">
							<Select
								value={range}
								onValueChange={(v) => setRange(v as 'entire' | 'inout')}
								options={[
									{ value: 'entire', label: 'Entire Sequence' },
									{ value: 'inout', label: 'Sequence In/Out', disabled: !hasInOut },
								]}
								label="Range"
								className="w-[220px]"
							/>
						</Row>
						<p className="text-pr-small text-pr-muted">
							Shapes, text, colour mattes, stills, nested sequences and Lottie clips are exported as Lottie layers with
							their keyframes; anything Lottie cannot carry is listed after the export.
						</p>
					</>
				) : (
					<div className="flex flex-col gap-2" data-testid="lottie-export-result">
						<p className="text-pr-text">
							{result.layers} layer{result.layers === 1 ? '' : 's'}, {(result.bytes / 1024).toFixed(1)} KB.
						</p>
						{result.url ? (
							<a className="text-pr-accent underline" href={result.url} download={result.fileName} data-testid="lottie-export-download">
								Download {result.fileName}
							</a>
						) : (
							<span className="text-pr-muted">{result.outputPath}</span>
						)}
						{result.warnings.length ? (
							<ul className="flex max-h-[40vh] flex-col gap-1 overflow-auto" aria-label="Not carried" data-testid="lottie-export-warnings">
								{result.warnings.map((w) => (
									<li key={w} className="rounded-pr-control bg-pr-raised px-2 py-1 text-pr-warning">
										{w}
									</li>
								))}
							</ul>
						) : (
							<p className="text-pr-muted">Everything was carried.</p>
						)}
					</div>
				)}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerImportsDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(IMAGE_SEQUENCE_DIALOG, ImageSequenceDialog);
	registerDialog(LAYERED_IMPORT_DIALOG, LayeredImportDialog);
	registerDialog(PDF_PAGES_DIALOG, PdfPagesDialog);
	registerDialog(LOTTIE_EXPORT_DIALOG, LottieExportDialog);
}
