// Third-party licenses in the About dialog (ARCHITECTURE D-13): FFmpeg's license text and a link to the
// source of the exact build that ships with the app, from the engine's `GET /api/licenses`. Without an
// engine the static LGPL notice is shown. M2 (S11:FIX-010): the notices of the JavaScript packages shipped in
// this web build and the Remotion bundle (THIRD_PARTY_NOTICES.md, emitted by the Vite build) are linked and
// shown on demand; anime.js is named in the static notice too.
import type { LicenseComponent } from '@jasper/api';
import { useEffect, useRef, useState } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';

const FFMPEG_HOME = 'https://ffmpeg.org/';
const LGPL_HOME = 'https://www.gnu.org/licenses/lgpl.html';
const ANIME_HOME = 'https://animejs.com/';
const MIT_HOME = 'https://opensource.org/license/mit';
/** Served next to index.html (vite.config.ts `thirdPartyNotices`). */
const NOTICES_URL = `${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.md`;

function ExternalLink(props: { href: string; children: string }) {
	return (
		<a
			href={props.href}
			target="_blank"
			rel="noreferrer"
			className="text-pr-accent underline underline-offset-2"
		>
			{props.children}
		</a>
	);
}

function Component({ c }: { c: LicenseComponent }) {
	return (
		<div className="flex flex-col gap-1" data-testid={`license-${c.id}`}>
			<p className="text-pr-text">
				{c.name}
				{c.version ? ` ${c.version}` : ''} — <span data-testid={`license-${c.id}-name`}>{c.license}</span>
			</p>
			<p className="flex flex-wrap gap-x-3 text-pr-small">
				<ExternalLink href={c.sourceUrl}>Source code</ExternalLink>
				{c.buildUrl ? <ExternalLink href={c.buildUrl}>Build</ExternalLink> : null}
			</p>
			{c.notice ? <p className="whitespace-pre-wrap text-pr-small text-pr-muted">{c.notice}</p> : null}
			{c.texts.map((t) => (
				<details key={t.title} className="text-pr-small">
					<summary className="cursor-pointer text-pr-muted">{t.title}</summary>
					<pre
						className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-pr-control bg-pr-field p-2 font-pr-mono text-pr-small text-pr-muted"
						data-testid={`license-${c.id}-text`}
					>
						{t.text}
					</pre>
				</details>
			))}
		</div>
	);
}

export function ThirdPartyLicenses() {
	const engine = useEngineOrNull();
	const client = engine?.client;
	const connected = engine?.status === 'connected';
	const [components, setComponents] = useState<LicenseComponent[] | null>(null);
	useEffect(() => {
		if (!client || !connected) return;
		let cancelled = false;
		client
			.licenses()
			.then((r) => !cancelled && setComponents(r.components))
			.catch(() => !cancelled && setComponents(null));
		return () => {
			cancelled = true;
		};
	}, [client, connected]);

	const warning = engine?.capabilities?.render.remotionBinaries?.message;
	return (
		<section className="flex flex-col gap-2" aria-label="Third-party licenses" data-testid="licenses">
			<p className="text-pr-strong">Licenses</p>
			{components?.length ? (
				components.map((c) => <Component key={c.id} c={c} />)
			) : (
				<p className="text-pr-small text-pr-muted">
					This software uses <ExternalLink href={FFMPEG_HOME}>FFmpeg</ExternalLink>, licensed under the{' '}
					<ExternalLink href={LGPL_HOME}>GNU Lesser General Public License</ExternalLink>. Connect the engine
					to see the license text and the source of the build in use. Animated titles and templates use{' '}
					<ExternalLink href={ANIME_HOME}>anime.js</ExternalLink> (
					<ExternalLink href={MIT_HOME}>MIT License</ExternalLink>, Copyright (c) Julian Garnier).
				</p>
			)}
			<ThirdPartyNotices />
			{warning ? (
				<p className="text-pr-small text-pr-warning" role="alert" data-testid="licenses-warning">
					{warning}
				</p>
			) : null}
		</section>
	);
}

/** The JavaScript third-party notices (S11:FIX-010): a link to the file and its text, fetched when opened. */
function ThirdPartyNotices() {
	const [text, setText] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const requested = useRef(false);
	const load = (open: boolean) => {
		if (!open || requested.current) return;
		requested.current = true;
		fetch(NOTICES_URL)
			.then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
			.then(setText, () => setFailed(true));
	};
	return (
		<details
			className="text-pr-small"
			data-testid="third-party-notices"
			onToggle={(e) => load((e.currentTarget as HTMLDetailsElement).open)}
		>
			<summary className="cursor-pointer text-pr-muted">JavaScript packages (third-party notices)</summary>
			<p className="mt-1">
				<a
					href={NOTICES_URL}
					target="_blank"
					rel="noreferrer"
					className="text-pr-accent underline underline-offset-2"
				>
					THIRD_PARTY_NOTICES.md
				</a>
			</p>
			{failed ? (
				<p className="text-pr-muted">The notices file is not available in this build.</p>
			) : (
				<pre
					className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-pr-control bg-pr-field p-2 font-pr-mono text-pr-small text-pr-muted"
					data-testid="third-party-notices-text"
				>
					{text ?? 'Loading…'}
				</pre>
			)}
		</details>
	);
}
