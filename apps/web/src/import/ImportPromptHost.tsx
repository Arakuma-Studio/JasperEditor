// Renders the first pending import prompt as a modal dialog (S05 §14.1: Enter = primary, Esc = cancel).
import { Button, Z } from '@jasper/ui';
import { useEffect, useRef } from 'react';
import { importPrompts, type PendingPrompt, type PromptQueue, usePromptQueue } from './prompts.ts';

export function Dialog(props: {
	title: string;
	children: React.ReactNode;
	footer: React.ReactNode;
	onEscape?: () => void;
	testId?: string;
	width?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
	}, []);
	return (
		<div
			className="fixed inset-0 flex items-center justify-center bg-[var(--pr-overlay-scrim)]"
			style={{ zIndex: Z.dialog }}
			role="presentation"
		>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={props.title}
				data-testid={props.testId}
				className="flex max-h-[80vh] flex-col gap-3 rounded-pr-menu border border-pr-menu-border bg-pr-menu p-4 text-pr-text shadow-pr-overlay"
				style={{ width: props.width ?? 420 }}
				onKeyDown={(e) => {
					if (e.key === 'Escape' && props.onEscape) {
						e.stopPropagation();
						props.onEscape();
					}
				}}
			>
				<h2 className="text-pr-ui font-semibold text-pr-strong">{props.title}</h2>
				<div className="min-h-0 overflow-auto text-pr-ui">{props.children}</div>
				<div className="flex justify-end gap-2">{props.footer}</div>
			</div>
		</div>
	);
}

function PromptView({ p, queue }: { p: PendingPrompt; queue: PromptQueue }) {
	const settle = () => queue.settle(p.id);
	if (p.kind === 'duplicates') {
		const choose = (c: 'use-existing' | 'import-again') => {
			settle();
			p.resolve(c);
		};
		return (
			<Dialog
				title="Already in project"
				testId="prompt-duplicates"
				onEscape={() => choose('use-existing')}
				footer={
					<>
						<Button onClick={() => choose('import-again')}>Import again</Button>
						<Button variant="primary" data-autofocus onClick={() => choose('use-existing')}>
							Use existing
						</Button>
					</>
				}
			>
				<p className="mb-2 text-pr-muted">
					{p.names.length === 1 ? 'This file is' : `These ${p.names.length} files are`} already in the project
					(same content fingerprint):
				</p>
				<ul className="mb-2 list-disc pl-5">
					{p.names.slice(0, 8).map((n) => (
						<li key={n}>{n}</li>
					))}
					{p.names.length > 8 ? <li>… and {p.names.length - 8} more</li> : null}
				</ul>
				<p className="text-pr-small text-pr-dim">The choice applies to the whole batch.</p>
			</Dialog>
		);
	}
	if (p.kind === 'mismatch') {
		const choose = (c: 'change' | 'keep') => {
			settle();
			p.resolve(c);
		};
		const { info } = p;
		return (
			<Dialog
				title="Clip Mismatch Warning"
				testId="prompt-mismatch"
				onEscape={() => choose('keep')}
				footer={
					<>
						<Button onClick={() => choose('keep')}>Keep existing settings</Button>
						<Button variant="primary" data-autofocus onClick={() => choose('change')}>
							Change sequence settings
						</Button>
					</>
				}
			>
				<p className="mb-2">
					“{info.clipName}” does not match the settings of “{info.sequence.name}”.
				</p>
				<table className="w-full text-pr-small">
					<tbody>
						<tr>
							<td className="text-pr-muted">Clip</td>
							<td>
								{info.clip.width} × {info.clip.height} · {info.clip.fps} fps
							</td>
						</tr>
						<tr>
							<td className="text-pr-muted">Sequence</td>
							<td>
								{info.sequence.width} × {info.sequence.height} · {info.sequence.fps} fps
							</td>
						</tr>
					</tbody>
				</table>
			</Dialog>
		);
	}
	return (
		<Dialog
			title={`Import finished with ${p.failed.length} ${p.failed.length === 1 ? 'error' : 'errors'}`}
			testId="prompt-failures"
			onEscape={settle}
			footer={
				<Button variant="primary" data-autofocus onClick={settle}>
					OK
				</Button>
			}
		>
			<p className="mb-2 text-pr-muted">
				{p.committed} {p.committed === 1 ? 'file was' : 'files were'} imported. These files could not be
				imported:
			</p>
			<ul className="flex flex-col gap-1">
				{p.failed.map((f) => (
					<li key={`${f.name}|${f.code}|${f.message}`} className="flex flex-col">
						<span className="text-pr-strong">{f.name}</span>
						<span className="text-pr-small text-pr-danger">
							{f.code}: {f.message}
						</span>
					</li>
				))}
			</ul>
		</Dialog>
	);
}

/** Mount once near the root of the editor (ProjectLifecycle does). */
export function ImportPromptHost({ queue = importPrompts }: { queue?: PromptQueue }) {
	const pending = usePromptQueue(queue);
	const first = pending[0];
	if (!first) return null;
	return <PromptView key={first.id} p={first} queue={queue} />;
}
