// Inline panel notices: transient hints and the stopwatch-off confirmation (S03:KF-041) with a
// "Don't ask again" preference kept in localStorage.
import { Button } from '@jasper/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

const SKIP_KEY = 'jasper.inspector.skipStopwatchConfirm';

function skipConfirm(): boolean {
	try {
		return globalThis.localStorage?.getItem(SKIP_KEY) === '1';
	} catch {
		return false;
	}
}

export type Notices = {
	hint(message: string): void;
	confirmStopwatchOff(label: string, onConfirm: () => void): void;
	/** Generic confirmation (Clear History, sequence resize…). */
	confirm(request: ConfirmRequest): void;
	element: ReactNode;
};

export type ConfirmRequest = {
	message: string;
	actions: { label: string; primary?: boolean; run(): void }[];
	dontAskAgainKey?: string;
};

export function useNotices(): Notices {
	const [hint, setHint] = useState<string | null>(null);
	const [pending, setPending] = useState<ConfirmRequest | null>(null);
	const [dontAsk, setDontAsk] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

	const showHint = useCallback((message: string) => {
		setHint(message);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setHint(null), 3000);
	}, []);
	const confirm = useCallback((r: ConfirmRequest) => {
		setDontAsk(false);
		setPending(r);
	}, []);
	const confirmStopwatchOff = useCallback(
		(label: string, onConfirm: () => void) => {
			if (skipConfirm()) {
				onConfirm();
				return;
			}
			confirm({
				message: `Turning off animation for ${label} will delete all existing keyframes. Continue?`,
				dontAskAgainKey: SKIP_KEY,
				actions: [
					{ label: 'Cancel', run: () => {} },
					{ label: 'OK', primary: true, run: onConfirm },
				],
			});
		},
		[confirm],
	);

	const element = (
		<>
			{pending ? (
				<div
					role="alertdialog"
					aria-label="Confirm"
					className="m-1 rounded-pr-menu border border-pr-menu-border bg-pr-raised p-2 text-pr-ui text-pr-text shadow-pr-floating"
					data-testid="inspector-confirm"
				>
					<p className="mb-2">{pending.message}</p>
					<div className="flex items-center gap-2">
						{pending.dontAskAgainKey ? (
							<label className="mr-auto flex items-center gap-1 text-pr-small text-pr-muted">
								<input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
								Don't ask again
							</label>
						) : (
							<span className="mr-auto" />
						)}
						{pending.actions.map((a) => (
							<Button
								key={a.label}
								variant={a.primary ? 'primary' : 'secondary'}
								onClick={() => {
									if (a.primary && dontAsk && pending.dontAskAgainKey) {
										try {
											globalThis.localStorage?.setItem(pending.dontAskAgainKey, '1');
										} catch {
											// ignore
										}
									}
									setPending(null);
									a.run();
								}}
							>
								{a.label}
							</Button>
						))}
					</div>
				</div>
			) : null}
			{hint ? (
				<p className="mx-2 my-1 text-pr-small text-pr-warning" role="status">
					{hint}
				</p>
			) : null}
		</>
	);
	return { hint: showHint, confirmStopwatchOff, confirm, element };
}
