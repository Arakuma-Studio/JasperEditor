// File ▸ Import Remotion Project… (M2, S08:MGU-001). Local engines (desktop / dev): a project folder on this
// computer — bundled with the project's own `remotion bundle`, optionally watched and rebuilt on save — or a
// built bundle folder; everywhere: a zip of a built bundle (`npx remotion bundle` output) uploaded to the
// engine. Errors carry the engine's hint (e.g. the exact Remotion version to pin).
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { Button, Dialog, type HostedDialogProps, registerDialog, toast } from '@jasper/ui';
import { useRef, useState } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';
import { type BundleImportResult, bundleErrorText, importBundleFolder, importBundleZip } from './import.ts';

export const MG_IMPORT_DIALOG = 'mg.importRemotionProject';

type DesktopFolderBridge = { pickFolder?(opts?: { title?: string }): Promise<string | null> };

function desktopFolderPicker(): DesktopFolderBridge['pickFolder'] | null {
	const b = (globalThis as { jasperDesktop?: DesktopFolderBridge }).jasperDesktop;
	return typeof b?.pickFolder === 'function' ? b.pickFolder.bind(b) : null;
}

function ImportRemotionDialog(
	props: HostedDialogProps<{ session?: EditorSession | null; engine?: EngineClient | null; path?: string }>,
) {
	const engineState = useEngineOrNull();
	const session = props.session ?? null;
	const engine = props.engine ?? engineState?.client ?? session?.engine ?? null;
	const projectImport = engineState?.capabilities?.features?.mgBundles?.projectImport ?? true;
	const ready = engineState?.capabilities?.features?.mgBundles?.status !== 'unavailable';
	const reason = engineState?.capabilities?.features?.mgBundles?.reason;
	const [path, setPath] = useState(props.path ?? '');
	const [watch, setWatch] = useState(true);
	const [busy, setBusy] = useState<null | 'folder' | 'zip'>(null);
	const [progress, setProgress] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement | null>(null);
	const picker = desktopFolderPicker();

	const done = (r: BundleImportResult) => {
		const n = r.media.mgBundle?.compositions.length ?? 0;
		toast({
			kind: 'success',
			title: r.reused ? 'Remotion project updated' : 'Remotion project imported',
			detail: `${r.media.mgBundle?.source.name ?? r.media.originalName}: ${n} composition${n === 1 ? '' : 's'} in Motion Templates ▸ Remotion`,
		});
		props.close(r);
	};

	const importFolder = async () => {
		if (!session || !engine || !path.trim()) return;
		setBusy('folder');
		setError(null);
		setProgress('Bundling the project with its own Remotion CLI… (progress in the Jobs panel)');
		try {
			done(await importBundleFolder(session, engine, path.trim(), { watch }));
		} catch (e) {
			setError(bundleErrorText(e));
		} finally {
			setBusy(null);
			setProgress(null);
		}
	};

	const importZip = async (file: File) => {
		if (!session || !engine) return;
		setBusy('zip');
		setError(null);
		try {
			done(
				await importBundleZip(session, engine, file, {
					onProgress: (loaded, total) =>
						setProgress(`Uploading ${file.name}: ${total ? Math.round((loaded / total) * 100) : 100} %`),
				}),
			);
		} catch (e) {
			setError(bundleErrorText(e));
		} finally {
			setBusy(null);
			setProgress(null);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && !busy && props.close()}
			title="Import Remotion Project"
			size="medium"
			primaryLabel={projectImport ? 'Import Folder' : undefined}
			onPrimary={projectImport ? () => void importFolder() : undefined}
			primaryDisabled={!ready || !session || !path.trim() || busy !== null}
			data-testid="mg-import-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui text-pr-text">
				{!ready ? (
					<p className="text-pr-warning" role="status">
						Composition clips are unavailable on this engine{reason ? `: ${reason}` : ''}.
					</p>
				) : null}
				<p className="text-pr-muted">
					Each composition of a Remotion <strong className="text-pr-text">4.0.499</strong> project becomes a
					clip you can place on the timeline and edit in Properties; exports pre-render them once to ProRes
					4444.
				</p>
				{projectImport ? (
					<section className="flex flex-col gap-1">
						<label className="text-pr-strong" htmlFor="mg-import-path">
							Project folder on this computer
						</label>
						<div className="flex gap-1">
							<input
								id="mg-import-path"
								className="h-[var(--pr-control-h)] min-w-0 flex-1 rounded-pr-control border border-pr-border-strong bg-pr-field px-2 font-pr text-pr-ui text-pr-text focus:outline focus:outline-1 focus:outline-pr-focus"
								placeholder="/path/to/remotion-project"
								value={path}
								spellCheck={false}
								onChange={(e) => setPath(e.target.value)}
								onKeyDown={(e) => e.key === 'Enter' && void importFolder()}
								data-testid="mg-import-path"
							/>
							{picker ? (
								<Button
									variant="secondary"
									onClick={() =>
										void picker({ title: 'Remotion project folder' }).then((p) => p && setPath(p))
									}
								>
									Browse…
								</Button>
							) : null}
						</div>
						<label className="inline-flex items-center gap-1 text-pr-muted">
							<input
								type="checkbox"
								checked={watch}
								onChange={(e) => setWatch(e.target.checked)}
								className="size-[12px] accent-[var(--pr-text-primary)]"
								data-testid="mg-import-watch"
							/>
							Watch for changes and rebuild on save
						</label>
						<p className="text-pr-small text-pr-dim">
							The folder needs a package.json with remotion pinned to 4.0.499 and installed node_modules. Its
							remotion.config.ts (Tailwind, webpack overrides) applies. A folder with a built bundle
							(index.html + bundle.js) works too.
						</p>
					</section>
				) : null}
				<section className="flex flex-col gap-1">
					<span className="text-pr-strong">{projectImport ? 'Or a built bundle' : 'Built bundle'}</span>
					<div className="flex items-center gap-2">
						<Button
							variant="secondary"
							disabled={!ready || !session || busy !== null}
							onClick={() => fileInput.current?.click()}
							data-testid="mg-import-zip"
						>
							Upload .zip…
						</Button>
						<span className="text-pr-small text-pr-dim">a zip of the output of `npx remotion bundle`</span>
					</div>
					<input
						ref={fileInput}
						type="file"
						accept=".zip,application/zip"
						className="hidden"
						onChange={(e) => {
							const f = e.target.files?.[0];
							e.target.value = '';
							if (f) void importZip(f);
						}}
						data-testid="mg-import-zip-input"
					/>
				</section>
				{progress ? (
					<p className="text-pr-muted" role="status" data-testid="mg-import-progress">
						{progress}
					</p>
				) : null}
				{error ? (
					<p className="whitespace-pre-wrap text-pr-danger" role="alert" data-testid="mg-import-error">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

let registered = false;
/** Registers the dialog with the dialog host (idempotent). */
export function registerImportRemotionDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(MG_IMPORT_DIALOG, ImportRemotionDialog);
}
