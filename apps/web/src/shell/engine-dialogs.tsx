// File ▸ Engine ▸ Connect… / Engine Status and Help ▸ Third-Party Notices (workstream polish).
//
// - Engine Status: what the engine is and can do, read live from `GET /health` and `GET /api/capabilities`
//   (address, version, API, FFmpeg build and licence, encoders, render paths, feature blocks, limits, running
//   jobs), with Reconnect and Copy Details for bug reports.
// - Connect to Engine: the engine of this window is the one that serves it (the editor only talks to its own
//   origin, ARCHITECTURE §4.2), so "connect" means two things: retry the connection to that engine (after it was
//   restarted) and, on the web, open the editor served by another engine by its address. The desktop app starts
//   its own engine and cannot leave it.
// - Third-Party Notices: the licence screen of About, on its own.
import type { EngineCapabilities, Health } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import { Button, Dialog, type HostedDialogProps, registerDialog, TextField, toast } from '@jasper/ui';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { ThirdPartyLicenses } from './licenses.tsx';

export const ENGINE_DIALOGS = {
	status: 'shell.engineStatus',
	connect: 'shell.engineConnect',
	notices: 'shell.notices',
} as const;

const RECENT_KEY = 'jasper:recent-engines';
const RECENT_MAX = 6;

/** The origin this window's engine answers on (the page origin when the client is same-origin). */
export function engineAddress(client: EngineClient | null | undefined): string {
	const base = client?.url('') ?? '';
	if (/^https?:\/\//.test(base)) return base.replace(/\/+$/, '');
	return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * Normalises what the user typed into an engine origin: `host:port` gets `http://`, paths and queries are dropped.
 * Null when it is not an http(s) address.
 */
export function normalizeEngineAddress(input: string): string | null {
	const raw = input.trim();
	if (!raw) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	try {
		const u = new URL(withScheme);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		if (!u.hostname || u.username || u.password) return null;
		return u.origin;
	} catch {
		return null;
	}
}

export function loadRecentEngines(): string[] {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
	} catch {
		return [];
	}
}

export function rememberEngine(origin: string): void {
	try {
		const next = [origin, ...loadRecentEngines().filter((x) => x !== origin)].slice(0, RECENT_MAX);
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// storage unavailable: no recent list
	}
}

const isDesktop = () =>
	typeof window !== 'undefined' && !!(window as { jasperDesktop?: unknown }).jasperDesktop;

function formatBytes(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = n;
	let u = 0;
	while (v >= 1000 && u < units.length - 1) {
		v /= 1000;
		u++;
	}
	return `${u === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** One line per feature block of the capabilities (its `status`, else what it reports). */
export function featureRows(features: EngineCapabilities['features']): [string, string][] {
	const out: [string, string][] = [];
	for (const [key, value] of Object.entries(features ?? {})) {
		if (!value || typeof value !== 'object') continue;
		const v = value as Record<string, unknown>;
		let text: string;
		if (typeof v.status === 'string') text = v.status;
		else {
			const parts = Object.entries(v)
				.filter(([, x]) => typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number')
				.slice(0, 4)
				.map(([k, x]) => `${k}: ${String(x)}`);
			text = parts.length ? parts.join(', ') : 'available';
		}
		if (typeof v.reason === 'string' && v.reason) text += ` (${v.reason})`;
		out.push([key, text]);
	}
	return out.sort((a, b) => a[0].localeCompare(b[0]));
}

type Snapshot = {
	address: string;
	health: Health | null;
	latencyMs: number | null;
	capabilities: EngineCapabilities | null;
	jobs: { running: number; queued: number } | null;
	error: string | null;
	at: string;
};

/** Reads the engine's health, capabilities and active jobs (never throws: failures are in `error`). */
export async function readEngineSnapshot(client: EngineClient): Promise<Snapshot> {
	const snap: Snapshot = {
		address: engineAddress(client),
		health: null,
		latencyMs: null,
		capabilities: null,
		jobs: null,
		error: null,
		at: new Date().toISOString(),
	};
	const describe = (e: unknown) =>
		e instanceof EngineError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
	try {
		const t0 = performance.now();
		snap.health = await client.health();
		snap.latencyMs = Math.round(performance.now() - t0);
	} catch (e) {
		snap.error = describe(e);
		return snap;
	}
	try {
		snap.capabilities = await client.capabilities();
	} catch (e) {
		snap.error = describe(e);
	}
	try {
		const { jobs } = await client.listJobs({ active: '1' });
		snap.jobs = {
			running: jobs.filter((j) => j.state === 'running').length,
			queued: jobs.filter((j) => j.state === 'queued').length,
		};
	} catch {
		snap.jobs = null;
	}
	return snap;
}

type Row = { label: string; value: ReactNode };

function Rows(props: { title: string; rows: Row[]; testId?: string }) {
	if (!props.rows.length) return null;
	return (
		<section className="flex flex-col gap-1" data-testid={props.testId}>
			<h3 className="text-pr-strong">{props.title}</h3>
			<dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-0.5 text-pr-small">
				{props.rows.map((r) => (
					<div key={r.label} className="contents">
						<dt className="text-pr-muted">{r.label}</dt>
						<dd className="min-w-0 break-words pr-tabular select-text">{r.value}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------ Engine Status

function EngineStatusDialog(props: HostedDialogProps<{ engine?: EngineClient | null }>) {
	const live = useEngineOrNull();
	const client = props.engine ?? live?.client ?? null;
	const [snap, setSnap] = useState<Snapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const load = useCallback(() => {
		if (!client) return;
		setBusy(true);
		void readEngineSnapshot(client)
			.then(setSnap)
			.finally(() => setBusy(false));
	}, [client]);
	useEffect(load, [load]);

	const caps = snap?.capabilities ?? null;
	const enc = caps?.media.encoding;
	const connected = !!snap?.health;
	const none = t('None');
	const dash = '—';
	const connection: Row[] = [
		{
			label: 'Status',
			value: (
				<span data-testid="engine-status-state">
					{snap ? (connected ? 'Connected' : 'Not connected') : 'Checking…'}
				</span>
			),
		},
		{
			label: 'Address',
			value: <span data-no-i18n="">{snap?.address || engineAddress(client) || dash}</span>,
		},
		{ label: 'Engine version', value: snap?.health?.version ?? dash },
		{ label: 'API version', value: snap?.health ? String(snap.health.apiVersion) : dash },
		{ label: 'Mode', value: caps?.engine.mode ?? dash },
		{
			label: 'Response time',
			value: snap?.latencyMs !== null && snap?.latencyMs !== undefined ? `${snap.latencyMs} ms` : dash,
		},
		{ label: 'Event stream', value: live?.events ?? dash },
		{
			label: 'Jobs',
			value: snap?.jobs ? t('{0} running, {1} queued', snap.jobs.running, snap.jobs.queued) : dash,
		},
	];
	const media: Row[] = caps
		? [
				{ label: 'FFmpeg', value: caps.media.ffmpegVersion ?? t('Not found') },
				{ label: 'FFmpeg source', value: caps.media.ffmpegSource ?? dash },
				{
					label: 'FFmpeg licence',
					value: enc ? `${enc.license.toUpperCase()}${enc.lgplOnly ? ` (${t('LGPL only')})` : ''}` : dash,
				},
				{ label: 'Export encoder', value: enc?.export?.label ?? none },
				{ label: 'Proxy encoder', value: enc?.proxy?.label ?? none },
				{
					label: 'Hardware encoders',
					value: enc?.hardware.length
						? enc.hardware.map((h) => `${h.encoder}${h.usable ? '' : ` (${t('Not usable')})`}`).join(', ')
						: none,
				},
				{ label: 'Hardware decoding', value: enc?.hwaccels.length ? enc.hwaccels.join(', ') : none },
			]
		: [];
	const ready = (ok: boolean) => (ok ? t('Ready') : t('Unavailable'));
	const render: Row[] = caps
		? [
				{ label: 'Native export', value: ready(caps.render.native) },
				{
					label: 'Remotion render',
					value:
						caps.render.remotionLocal === 'needs-browser-download'
							? t('Needs a browser download')
							: ready(caps.render.remotionLocal === 'ready'),
				},
				{
					label: 'fframes',
					value: `${ready(caps.render.fframes === 'ready')}${caps.render.fframesReason ? ` (${caps.render.fframesReason})` : ''}`,
				},
				{ label: 'Import by path', value: caps.engine.pathRegistration ? t('Allowed') : t('Not allowed') },
			]
		: [];
	const limits: Row[] = caps
		? [
				{ label: 'CPU threads', value: String(caps.limits.cpuCount) },
				{ label: 'Free disk space', value: formatBytes(caps.limits.freeDiskBytes) },
				{
					label: 'Largest upload',
					value:
						caps.limits.maxUploadBytes === null ? t('No limit') : formatBytes(caps.limits.maxUploadBytes),
				},
			]
		: [];
	const features: Row[] = featureRows(caps?.features).map(([k, v]) => ({
		label: k,
		value: <span data-no-i18n="">{v}</span>,
	}));
	const warning = enc?.message ?? caps?.render.remotionBinaries?.message;

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Engine Status"
			size="large"
			cancelLabel="Close"
			footerExtra={
				<div className="flex gap-2">
					<Button
						disabled={busy}
						onClick={() => {
							live?.refresh();
							load();
						}}
						data-testid="engine-status-reconnect"
					>
						Reconnect
					</Button>
					<Button
						disabled={!snap}
						onClick={() =>
							void copyText(JSON.stringify(snap, null, 2)).then((ok) =>
								toast(
									ok
										? { kind: 'success', title: 'Engine details copied' }
										: { kind: 'warning', title: 'Could not copy the engine details' },
								),
							)
						}
						data-testid="engine-status-copy"
					>
						Copy Details
					</Button>
				</div>
			}
			data-testid="engine-status-dialog"
		>
			<div className="flex max-h-[60vh] flex-col gap-3 overflow-auto pr-1">
				<Rows title="Connection" rows={connection} testId="engine-status-connection" />
				{snap?.error ? (
					<p className="text-pr-small text-pr-warning" role="alert" data-testid="engine-status-error">
						{snap.error}
					</p>
				) : null}
				{snap && !connected ? (
					<p className="text-pr-small text-pr-muted">
						{isDesktop()
							? 'The app starts its engine itself: restart JasperEditor if it does not come back.'
							: 'Start the engine (for example “pnpm dev:engine”), then choose Reconnect.'}
					</p>
				) : null}
				<Rows title="Media" rows={media} testId="engine-status-media" />
				<Rows title="Rendering" rows={render} testId="engine-status-render" />
				<Rows title="Features" rows={features} testId="engine-status-features" />
				<Rows title="Limits" rows={limits} />
				{warning ? (
					<p className="text-pr-small text-pr-warning" role="alert">
						{warning}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

// ------------------------------------------------------------------ Connect to Engine

function EngineConnectDialog(
	props: HostedDialogProps<{
		engine?: EngineClient | null;
		/** Saves the open project before the window leaves for another engine. */
		beforeLeave?: () => Promise<void>;
	}>,
) {
	const live = useEngineOrNull();
	const client = props.engine ?? live?.client ?? null;
	const current = engineAddress(client);
	const desktop = isDesktop();
	const [address, setAddress] = useState(current);
	const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'failed'>('idle');
	const [message, setMessage] = useState<string | null>(null);
	const fieldId = useId();
	const recent = loadRecentEngines().filter((x) => x !== current);
	const target = normalizeEngineAddress(address);
	const same = target === current;

	const connect = async (): Promise<false> => {
		if (!target) {
			setState('failed');
			setMessage('Enter an address like http://127.0.0.1:47900');
			return false;
		}
		if (same) {
			if (!client) return false;
			setState('checking');
			setMessage(null);
			const snap = await readEngineSnapshot(client);
			live?.refresh();
			if (snap.health) {
				setState('ok');
				setMessage(`Connected to engine ${snap.health.version}`);
			} else {
				setState('failed');
				setMessage(snap.error ?? 'The engine did not answer');
			}
			return false;
		}
		// Another engine serves its own editor: check that something answers there, then open it.
		setState('checking');
		setMessage(null);
		try {
			await fetch(`${target}/health`, {
				mode: 'no-cors',
				cache: 'no-store',
				signal: AbortSignal.timeout(5000),
			});
		} catch {
			setState('failed');
			setMessage(`Nothing answers at ${target}`);
			return false;
		}
		rememberEngine(target);
		if (current) rememberEngine(current);
		await props.beforeLeave?.().catch(() => undefined);
		props.close();
		window.location.assign(`${target}/`);
		return false;
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Connect to Engine"
			size="medium"
			primaryLabel={same || desktop ? 'Reconnect' : 'Connect'}
			primaryDisabled={state === 'checking'}
			onPrimary={connect}
			cancelLabel="Close"
			data-testid="engine-connect-dialog"
		>
			<div className="flex flex-col gap-2">
				<p className="text-pr-small text-pr-muted">
					{desktop
						? 'The desktop app runs its own engine. Reconnect checks it again after it was busy or restarted.'
						: 'Each engine serves its own editor. Reconnect to this engine, or enter the address of another engine to open its editor in this window; unsaved changes are saved first.'}
				</p>
				<label htmlFor={fieldId} className="text-pr-small text-pr-muted">
					Engine address
				</label>
				<TextField
					id={fieldId}
					value={address}
					onChange={(e) => {
						setAddress(e.currentTarget.value);
						setState('idle');
						setMessage(null);
					}}
					readOnly={desktop}
					spellCheck={false}
					invalid={state === 'failed'}
					className="font-pr-mono"
					data-testid="engine-connect-address"
					data-no-i18n=""
				/>
				{!desktop && recent.length ? (
					<div className="flex flex-wrap items-center gap-1 text-pr-small">
						<span className="text-pr-muted">Recent:</span>
						{recent.map((r) => (
							<button
								key={r}
								type="button"
								className="rounded-pr-control border border-pr-border-strong px-1.5 font-pr-mono hover:bg-pr-hover"
								onClick={() => setAddress(r)}
								data-no-i18n=""
							>
								{r}
							</button>
						))}
					</div>
				) : null}
				<p
					className={
						state === 'failed'
							? 'text-pr-small text-pr-danger'
							: state === 'ok'
								? 'text-pr-small text-pr-success'
								: 'text-pr-small text-pr-muted'
					}
					role="status"
					data-testid="engine-connect-result"
				>
					{state === 'checking'
						? 'Checking…'
						: (message ??
							`This window is ${live?.status === 'connected' ? 'connected' : 'not connected'} to ${current || 'its engine'}.`)}
				</p>
			</div>
		</Dialog>
	);
}

// ------------------------------------------------------------------ Third-Party Notices

function NoticesDialog(props: HostedDialogProps<Record<string, never>>) {
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Third-Party Notices"
			size="large"
			cancelLabel="Close"
			data-testid="notices-dialog"
		>
			<div className="flex max-h-[60vh] flex-col gap-2 overflow-auto pr-1">
				<p className="text-pr-small text-pr-muted">
					JasperEditor is built on open-source software. The licences of the programs it runs (FFmpeg and its
					libraries), of the packages shipped in this build and of the source code ported from other projects
					are listed here.
				</p>
				<ThirdPartyLicenses expanded />
			</div>
		</Dialog>
	);
}

let registered = false;
/** Registers the engine and notices dialogs with the dialog host (idempotent). */
export function registerEngineDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(ENGINE_DIALOGS.status, EngineStatusDialog);
	registerDialog(ENGINE_DIALOGS.connect, EngineConnectDialog);
	registerDialog(ENGINE_DIALOGS.notices, NoticesDialog);
}
