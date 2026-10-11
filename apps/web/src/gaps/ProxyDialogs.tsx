// When reconnecting an original to a project edited from proxies alone, retain the previously linked file
// as its proxy. Existing proxy associations remain unchanged.
import type { RegisteredMedia } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { CommandInput } from '@jasper/project';
import { type MediaAsset, PROXY_PRESETS, proxyMismatch } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useState } from 'react';
import { pickFilesInBrowser } from '../import/desktop.ts';
import { errorText } from '../processing/engine-jobs.ts';
import { getDesktopBridge } from '../runtime/platform.ts';
import { attachedProxyFrom, startMediaJob } from './media-jobs.ts';

export const CREATE_PROXIES_DIALOG = 'gaps.createProxies';
export const ATTACH_PROXIES_DIALOG = 'gaps.attachProxies';
export const RECONNECT_FULL_RES_DIALOG = 'gaps.reconnectFullRes';

type Base = { session: EditorSession; engine: EngineClient; mediaIds: string[] };

function assetsOf(session: EditorSession, ids: readonly string[]): MediaAsset[] {
	const doc = session.getCommitted();
	return [...new Set(ids)].map((id) => doc.media[id]).filter((a): a is MediaAsset => !!a);
}

/** Asks for one file and registers it with the engine (desktop dialog, browser upload, or a typed path). */
export async function pickAndRegister(
	engine: EngineClient,
	projectId: string,
	path?: string | null,
): Promise<RegisteredMedia | null> {
	let p = path?.trim() || null;
	const desktop = getDesktopBridge();
	if (!p && desktop) {
		const paths = await desktop.pickMedia();
		p = paths[0] ?? null;
		if (!p) return null;
	}
	if (p) {
		const r = await engine.registerMedia({ projectId, paths: [p] });
		if (!r.items[0]) throw new Error(r.errors[0]?.message ?? 'The file could not be registered');
		return r.items[0];
	}
	const files = await pickFilesInBrowser();
	if (!files[0]) return null;
	return engine.uploadFile(files[0], { projectId });
}

function CreateProxiesDialog(props: HostedDialogProps<Base>) {
	const all = assetsOf(props.session, props.mediaIds);
	const videos = all.filter((a) => a.kind === 'video');
	const [preset, setPreset] = useState('proxy-720');
	const [dest, setDest] = useState<'next-to-media' | 'project' | 'folder'>('next-to-media');
	const [folder, setFolder] = useState('');
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Create Proxies"
			size="medium"
			primaryLabel="OK"
			primaryDisabled={!videos.length}
			onPrimary={async () => {
				if (dest === 'folder' && !folder.trim()) {
					setError('Choose the folder for the proxies.');
					return false;
				}
				const id = await startMediaJob(props.engine, props.session, {
					op: 'proxy',
					mediaIds: videos.map((v) => v.id),
					preset,
					destination: dest === 'folder' ? { mode: 'folder', folder: folder.trim() } : { mode: dest },
				});
				props.close(id);
				return false;
			}}
			data-testid="create-proxies-dialog"
		>
			<div className="flex flex-col gap-3">
				<p>
					{videos.length} video clip{videos.length === 1 ? '' : 's'}
					{all.length > videos.length ? ` (${all.length - videos.length} without video skipped)` : ''}. The
					proxies are made in the background and attached when ready; Toggle Proxies plays them.
				</p>
				<div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2">
					<span className="text-pr-muted">Preset</span>
					<Select
						label="Proxy preset"
						className="w-80"
						value={preset}
						onValueChange={setPreset}
						options={PROXY_PRESETS.filter((p) => p.kind === 'proxy').map((p) => ({
							value: p.id,
							label: p.label,
						}))}
					/>
					<span className="text-pr-muted">Destination</span>
					<Select
						label="Proxy destination"
						className="w-80"
						value={dest}
						onValueChange={(v) => setDest(v as typeof dest)}
						options={[
							{ value: 'next-to-media', label: 'Next to Original Media, in Proxies Folder' },
							{ value: 'project', label: 'Same as Project (Scratch Disks)' },
							{ value: 'folder', label: 'Folder…' },
						]}
					/>
					{dest === 'folder' ? (
						<>
							<span className="text-pr-muted">Folder</span>
							<TextField
								aria-label="Proxy folder"
								data-testid="proxy-folder"
								value={folder}
								placeholder="/path/to/proxies"
								onChange={(e) => setFolder(e.target.value)}
							/>
						</>
					) : null}
				</div>
				{error ? (
					<p role="alert" className="text-pr-small text-pr-danger">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

type RowState = { status: string | null; mismatch: string | null; reg: RegisteredMedia | null; path: string };

function AttachProxiesDialog(props: HostedDialogProps<Base & { localEngine?: boolean }>) {
	const videos = assetsOf(props.session, props.mediaIds).filter((a) => a.kind === 'video');
	const [rows, setRows] = useState<Record<string, RowState>>({});
	const row = (id: string): RowState => rows[id] ?? { status: null, mismatch: null, reg: null, path: '' };
	const set = (id: string, patch: Partial<RowState>) =>
		setRows((r) => ({ ...r, [id]: { ...row(id), ...patch } }));
	const attach = (asset: MediaAsset, reg: RegisteredMedia, force: boolean) => {
		const r = props.session.apply({
			label: 'Attach Proxies',
			origin: 'user',
			commands: [
				{
					type: 'media.attachProxy',
					mediaId: asset.id,
					proxy: attachedProxyFrom(reg, 'attached'),
					...(force ? { force: true } : {}),
				},
			] as never[],
		});
		set(
			asset.id,
			r.ok
				? { status: `Attached ${reg.originalName}`, mismatch: null }
				: { status: r.errors[0]?.message ?? 'Refused' },
		);
	};
	const choose = async (asset: MediaAsset) => {
		set(asset.id, { status: 'Registering…', mismatch: null });
		try {
			const reg = await pickAndRegister(props.engine, props.session.projectId, row(asset.id).path || null);
			if (!reg) {
				set(asset.id, { status: null });
				return;
			}
			const why = proxyMismatch(asset, reg.probe);
			if (why) set(asset.id, { status: null, mismatch: why, reg });
			else attach(asset, reg, false);
		} catch (e) {
			set(asset.id, { status: errorText(e) });
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Attach Proxies"
			size="large"
			data-testid="attach-proxies-dialog"
		>
			{videos.length === 0 ? (
				<p className="text-pr-muted">Select video clips or Project panel items first.</p>
			) : (
				<ul className="flex flex-col divide-y divide-pr-border-subtle rounded-pr-control border border-pr-border-subtle">
					{videos.map((a) => {
						const r = row(a.id);
						return (
							<li key={a.id} className="flex flex-col gap-1 p-2" data-testid={`attach-row-${a.id}`}>
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate">{a.originalName}</span>
									<span className="text-pr-small text-pr-dim">
										{a.proxy ? `proxy: ${a.proxy.originalName}` : 'no proxy'}
									</span>
									{props.localEngine && !getDesktopBridge() ? (
										<TextField
											aria-label={`Proxy path for ${a.originalName}`}
											className="w-64"
											value={r.path}
											placeholder="/path/to/proxy.mp4 (or choose)"
											onChange={(e) => set(a.id, { path: e.target.value })}
										/>
									) : null}
									<Button variant="secondary" onClick={() => void choose(a)}>
										{r.path ? 'Attach' : 'Choose File…'}
									</Button>
								</div>
								{r.mismatch && r.reg ? (
									<div className="flex items-center gap-2 text-pr-small">
										<span role="alert" className="text-pr-danger">
											{r.mismatch}
										</span>
										<Button variant="quiet" onClick={() => attach(a, r.reg!, true)}>
											Attach Anyway
										</Button>
									</div>
								) : null}
								{r.status ? <span className="text-pr-small text-pr-muted">{r.status}</span> : null}
							</li>
						);
					})}
				</ul>
			)}
		</Dialog>
	);
}

/** Commands that make `reg` the full-resolution file of `asset` (keeping or creating its proxy). */
export function reconnectCommands(
	asset: MediaAsset,
	reg: RegisteredMedia,
): { commands: CommandInput[] } | { error: string } {
	const why = proxyMismatch(
		{ kind: reg.kind, probe: reg.probe, originalName: reg.originalName },
		asset.proxy?.probe ?? asset.probe,
	);
	if (why) return { error: why };
	const sameBytes = reg.fingerprint === asset.fingerprint;
	// The full-resolution file first (it changes the fingerprint), then the file the clip used becomes its proxy.
	const commands: CommandInput[] = [
		{
			type: 'media.relink',
			mediaId: asset.id,
			locator: reg.locators[0]!,
			locators: reg.locators,
			probe: reg.probe,
			sizeBytes: reg.sizeBytes,
			originalName: reg.originalName,
			container: reg.container,
			...(sameBytes ? {} : { fingerprint: reg.fingerprint, replace: true }),
		},
	];
	if (!asset.proxy && !sameBytes)
		commands.push({
			type: 'media.attachProxy',
			mediaId: asset.id,
			force: true,
			proxy: {
				fingerprint: asset.fingerprint,
				originalName: asset.originalName,
				sizeBytes: asset.sizeBytes,
				container: asset.container,
				probe: asset.probe,
				locators: asset.locators,
				origin: 'attached',
			},
		});
	return { commands };
}

function ReconnectFullResDialog(props: HostedDialogProps<Base & { localEngine?: boolean }>) {
	const videos = assetsOf(props.session, props.mediaIds).filter((a) => a.kind === 'video');
	const [status, setStatus] = useState<Record<string, string>>({});
	const [paths, setPaths] = useState<Record<string, string>>({});
	const reconnect = async (asset: MediaAsset) => {
		setStatus((s) => ({ ...s, [asset.id]: 'Registering…' }));
		try {
			const reg = await pickAndRegister(props.engine, props.session.projectId, paths[asset.id] || null);
			if (!reg) return setStatus((s) => ({ ...s, [asset.id]: '' }));
			const built = reconnectCommands(props.session.getCommitted().media[asset.id] ?? asset, reg);
			if ('error' in built) return setStatus((s) => ({ ...s, [asset.id]: built.error }));
			const r = props.session.apply({
				label: 'Reconnect Full Resolution Media',
				origin: 'user',
				commands: built.commands as never[],
			});
			setStatus((s) => ({
				...s,
				[asset.id]: r.ok ? `Reconnected to ${reg.originalName}` : (r.errors[0]?.message ?? 'Refused'),
			}));
		} catch (e) {
			setStatus((s) => ({ ...s, [asset.id]: errorText(e) }));
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Reconnect Full Resolution Media"
			size="large"
			data-testid="reconnect-full-res-dialog"
		>
			<p className="mb-2 text-pr-small text-pr-muted">
				Choose the full-resolution file of each clip. A clip without a proxy keeps the file it used as its
				proxy.
			</p>
			<ul className="flex flex-col divide-y divide-pr-border-subtle rounded-pr-control border border-pr-border-subtle">
				{videos.map((a) => (
					<li key={a.id} className="flex items-center gap-2 p-2">
						<span className="min-w-0 flex-1 truncate">{a.originalName}</span>
						{props.localEngine && !getDesktopBridge() ? (
							<TextField
								aria-label={`Full resolution path for ${a.originalName}`}
								className="w-64"
								value={paths[a.id] ?? ''}
								placeholder="/path/to/full-res.mov (or choose)"
								onChange={(e) => setPaths((p) => ({ ...p, [a.id]: e.target.value }))}
							/>
						) : null}
						<Button variant="secondary" onClick={() => void reconnect(a)}>
							{paths[a.id] ? 'Reconnect' : 'Choose File…'}
						</Button>
						{status[a.id] ? <span className="text-pr-small text-pr-muted">{status[a.id]}</span> : null}
					</li>
				))}
			</ul>
		</Dialog>
	);
}

let registered = false;
export function registerProxyDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(CREATE_PROXIES_DIALOG, CreateProxiesDialog);
	registerDialog(ATTACH_PROXIES_DIALOG, AttachProxiesDialog);
	registerDialog(RECONNECT_FULL_RES_DIALOG, ReconnectFullResDialog);
}
