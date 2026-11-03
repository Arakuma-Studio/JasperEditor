import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from '../icons/Icon.tsx';
import { Button } from './Button.tsx';

export type PanelErrorBoundaryProps = {
	/** Shown in the message and the copied details. */
	name: string;
	children?: ReactNode;
	onError?(error: unknown, info: ErrorInfo): void;
	/** A one-line notice with Retry instead of the panel-sized message: a section, a tab, an overlay. */
	inline?: boolean;
	/** Shown instead of either message (a dialog draws its own frame); `reset` renders the children again. */
	fallback?(error: Error, reset: () => void): ReactNode;
	/** A new value clears a caught error: what failed for one selection may work for the next. */
	resetKey?: unknown;
};

type State = { error: Error | null; componentStack: string; copyError: string | null; resetKey?: unknown };

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, State> {
	state: State = { error: null, componentStack: '', copyError: null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	static getDerivedStateFromProps(props: PanelErrorBoundaryProps, state: State): Partial<State> | null {
		return Object.is(props.resetKey, state.resetKey)
			? null
			: { error: null, componentStack: '', copyError: null, resetKey: props.resetKey };
	}

	private readonly reset = () => this.setState({ error: null, componentStack: '', copyError: null });

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
		const { error } = this.state;
		if (!error) return this.props.children;
		if (this.props.fallback) return this.props.fallback(error, this.reset);
		if (this.props.inline)
			return (
				<div
					role="alert"
					className="flex min-w-0 items-center gap-2 px-2 py-1 text-pr-small"
					data-testid="section-crashed"
					data-boundary={this.props.name}
				>
					<span className="shrink-0 text-pr-danger">
						<Icon id="status.error" size={12} />
					</span>
					<span className="min-w-0 flex-1 truncate text-pr-danger" title={error.message}>
						{`${this.props.name} stopped working: ${error.message}`}
					</span>
					<Button variant="quiet" onClick={this.reset}>
						Retry
					</Button>
				</div>
			);
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
				<p className="max-w-[320px] truncate text-pr-small text-pr-muted">{error.message}</p>
				{this.state.copyError ? <p className="text-pr-small text-pr-danger">{this.state.copyError}</p> : null}
				<div className="flex gap-2">
					<Button
						variant="primary"
						onClick={this.reset}
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
