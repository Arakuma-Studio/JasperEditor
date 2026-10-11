// Panel error boundary (S05:PC-032): if a panel throws, only that panel shows "This panel crashed" with
// Reload Panel and Copy Details; the rest of the workspace keeps working.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from '../icons/Icon.tsx';
import { Button } from './Button.tsx';

export type PanelErrorBoundaryProps = {
	/** Shown in the message and the copied details. */
	name: string;
	children?: ReactNode;
	onError?(error: unknown, info: ErrorInfo): void;
};

type State = { error: Error | null; componentStack: string; copyError: string | null };

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, State> {
	state: State = { error: null, componentStack: '', copyError: null };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	componentDidCatch(error: unknown, info: ErrorInfo) {
		this.setState({ componentStack: info.componentStack ?? '' });
		this.props.onError?.(error, info);
	}

	private details(): string {
		const e = this.state.error;
		const msg = e ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : '';
		return `Panel: ${this.props.name}\n${msg}\n${this.state.componentStack}`;
	}

	private async copyDetails(): Promise<void> {
		try {
			if (!navigator.clipboard) throw new Error('Clipboard access is unavailable');
			await navigator.clipboard.writeText(this.details());
			this.setState({ copyError: null });
		} catch (error) {
			this.setState({ copyError: error instanceof Error ? error.message : String(error) });
		}
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div
				role="alert"
				className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
				data-testid="panel-crashed"
			>
				<span className="text-pr-danger">
					<Icon id="status.error" size={24} />
				</span>
				<p className="text-pr-ui text-pr-text">This panel crashed</p>
				<p className="max-w-[320px] truncate text-pr-small text-pr-muted">{this.state.error.message}</p>
				{this.state.copyError ? <p className="text-pr-small text-pr-danger">{this.state.copyError}</p> : null}
				<div className="flex gap-2">
					<Button
						variant="primary"
						onClick={() => this.setState({ error: null, componentStack: '', copyError: null })}
					>
						Reload Panel
					</Button>
					<Button
						onClick={() => {
							void this.copyDetails();
						}}
					>
						Copy Details
					</Button>
				</div>
			</div>
		);
	}
}
