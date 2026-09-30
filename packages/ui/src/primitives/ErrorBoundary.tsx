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

type State = { error: unknown; componentStack: string; key: number };

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, State> {
	state: State = { error: null, componentStack: '', key: 0 };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error: error ?? new Error('Unknown error') };
	}

	componentDidCatch(error: unknown, info: ErrorInfo) {
		this.setState({ componentStack: info.componentStack ?? '' });
		this.props.onError?.(error, info);
	}

	private details(): string {
		const e = this.state.error;
		const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
		return `Panel: ${this.props.name}\n${msg}\n${this.state.componentStack}`;
	}

	render() {
		if (!this.state.error) return <ErrorKey k={this.state.key}>{this.props.children}</ErrorKey>;
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
				<p className="max-w-[320px] truncate text-pr-small text-pr-muted">
					{this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}
				</p>
				<div className="flex gap-2">
					<Button
						variant="primary"
						onClick={() => this.setState((s) => ({ error: null, componentStack: '', key: s.key + 1 }))}
					>
						Reload Panel
					</Button>
					<Button
						onClick={() => {
							void navigator.clipboard?.writeText(this.details()).catch(() => {});
						}}
					>
						Copy Details
					</Button>
				</div>
			</div>
		);
	}
}

/** Remounts children on reload by changing the key. */
function ErrorKey({ k, children }: { k: number; children?: ReactNode }) {
	return <ErrorKeyInner key={k}>{children}</ErrorKeyInner>;
}
function ErrorKeyInner({ children }: { children?: ReactNode }) {
	return <>{children}</>;
}
