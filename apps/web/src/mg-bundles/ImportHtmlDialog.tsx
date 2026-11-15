// File ▸ Import HTML Composition… (docs/wp-notes/html-compositions.md): a self-contained HTML page on the engine's
// computer that defines window.__duration (seconds), window.__ready (a Promise) and window.__seek(t) becomes one
// composition, rendered at the given size and rate by seeking it frame by frame (transparent where the page paints
// nothing). Local engines only (the page is read by path). Errors carry the engine's hint (the missing contract
// globals and how to define them).
import { HTML_COMPOSITION_MAX_SIDE } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { Dialog, type HostedDialogProps, registerDialog, toast } from '@jasper/ui';
import { useState } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';
import { bundleErrorText, importHtmlPage } from './import.ts';

export const MG_IMPORT_HTML_DIALOG = 'mg.importHtmlComposition';

const FIELD =
	'h-[var(--pr-control-h)] min-w-0 rounded-pr-control border border-pr-border-strong bg-pr-field px-2 font-pr text-pr-ui text-pr-text focus:outline focus:outline-1 focus:outline-pr-focus';

function ImportHtmlDialog(
	props: HostedDialogProps<{ session?: EditorSession | null; engine?: EngineClient | null }>,
) {
	const engineState = useEngineOrNull();
	const session = props.session ?? null;
	const engine = props.engine ?? engineState?.client ?? session?.engine ?? null;
	const features = engineState?.capabilities?.features?.mgBundles;
	const local = features?.projectImport ?? true;
	const ready = features?.status !== 'unavailable';
	// Defaults: the active sequence's frame size and rate.
	const seq = (() => {
		const s = session?.store.getState();
		return s?.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
	})();
	const [path, setPath] = useState('');
	const [width, setWidth] = useState(String(seq?.settings.width ?? 1920));
	const [height, setHeight] = useState(String(seq?.settings.height ?? 1080));
	const [fps, setFps] = useState(
		String(seq ? +(seq.settings.frameRate.num / seq.settings.frameRate.den).toFixed(3) : 30),
	);
	const [query, setQuery] = useState('');
	const [watch, setWatch] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const size = (v: string) => {
		const n = Number(v);
		return Number.isInteger(n) && n >= 16 && n <= HTML_COMPOSITION_MAX_SIDE ? n : null;
	};
	const rate = Number(fps);
	const valid =
		!!path.trim() &&
		size(width) !== null &&
		size(height) !== null &&
		rate >= 1 &&
		rate <= 240 &&
		!query.includes('#');

	const submit = async (): Promise<false> => {
		if (!session || !engine || !valid) return false;
		setBusy(true);
		setError(null);
		try {
			const r = await importHtmlPage(session, engine, {
				path: path.trim(),
				width: size(width)!,
				height: size(height)!,
				fps: rate,
				...(query.trim() ? { query: query.trim().replace(/^\?/, '') } : {}),
				...(watch ? { watch: true } : {}),
			});
			const c = r.media.mgBundle?.compositions[0];
			toast({
				kind: 'success',
				title: r.reused ? 'HTML composition updated' : 'HTML composition imported',
				detail: `${r.media.mgBundle?.source.name ?? r.media.originalName}${c ? `: ${(c.durationInFrames / c.fps).toFixed(1)} s` : ''} in Motion Templates ▸ Remotion`,
			});
			props.close(r);
		} catch (e) {
			setError(bundleErrorText(e));
		} finally {
			setBusy(false);
		}
		return false;
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && !busy && props.close()}
			title="Import HTML Composition"
			size="medium"
			primaryLabel="Import"
			onPrimary={submit}
			primaryDisabled={!ready || !local || !session || !valid || busy}
			data-testid="mg-import-html-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui text-pr-text">
				{!ready ? (
					<p className="text-pr-warning" role="status">
						Composition clips are unavailable on this engine{features?.reason ? `: ${features.reason}` : ''}.
					</p>
				) : !local ? (
					<p className="text-pr-warning" role="status">
						HTML pages are read from the engine's computer: this engine is not local.
					</p>
				) : null}
				<p className="text-pr-muted">
					A self-contained HTML page (GSAP or anything else) that defines{' '}
					<code className="text-pr-text">window.__duration</code> (seconds),{' '}
					<code className="text-pr-text">window.__ready</code> (a Promise: fonts and images loaded) and{' '}
					<code className="text-pr-text">window.__seek(t)</code> becomes a clip. Where the page paints
					nothing, the clip is transparent.
				</p>
				<label className="flex flex-col gap-1">
					<span className="text-pr-strong">Page file on this computer</span>
					<input
						className={FIELD}
						placeholder="/path/to/page.html"
						value={path}
						disabled={busy}
						spellCheck={false}
						onChange={(e) => setPath(e.target.value)}
						data-testid="mg-import-html-path"
					/>
				</label>
				<div className="flex gap-2">
					<label className="flex w-[90px] flex-col gap-1">
						<span className="text-pr-strong">Width</span>
						<input
							className={FIELD}
							inputMode="numeric"
							value={width}
							disabled={busy}
							onChange={(e) => setWidth(e.target.value)}
						/>
					</label>
					<label className="flex w-[90px] flex-col gap-1">
						<span className="text-pr-strong">Height</span>
						<input
							className={FIELD}
							inputMode="numeric"
							value={height}
							disabled={busy}
							onChange={(e) => setHeight(e.target.value)}
						/>
					</label>
					<label className="flex w-[90px] flex-col gap-1">
						<span className="text-pr-strong">Frame rate</span>
						<input
							className={FIELD}
							inputMode="decimal"
							value={fps}
							disabled={busy}
							onChange={(e) => setFps(e.target.value)}
						/>
					</label>
				</div>
				<label className="flex flex-col gap-1">
					<span className="text-pr-strong">Query string (optional)</span>
					<input
						className={FIELD}
						placeholder="s=2"
						value={query}
						disabled={busy}
						spellCheck={false}
						onChange={(e) => setQuery(e.target.value)}
						data-testid="mg-import-html-query"
					/>
					<span className="text-pr-small text-pr-dim">The page reads it as location.search.</span>
				</label>
				<label className="inline-flex items-center gap-1 text-pr-muted">
					<input
						type="checkbox"
						checked={watch}
						onChange={(e) => setWatch(e.target.checked)}
						className="size-[12px] accent-[var(--pr-text-primary)]"
					/>
					Reload when the page or a file it loads is saved
				</label>
				{busy ? (
					<p className="text-pr-muted" role="status">
						Loading the page and checking it… (progress in the Jobs panel)
					</p>
				) : null}
				{error ? (
					<p className="whitespace-pre-wrap text-pr-danger" role="alert" data-testid="mg-import-html-error">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

let registered = false;
/** Registers the dialog with the dialog host (idempotent). */
export function registerImportHtmlDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(MG_IMPORT_HTML_DIALOG, ImportHtmlDialog);
}
