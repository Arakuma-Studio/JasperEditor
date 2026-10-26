// C3: hosts a custom template-param control (`registerTemplateParamControl`) inside a Properties / Effect Controls
// row. A control that throws while rendering is replaced by a one-line error in its row; the rest of the panel, the
// row's label, stopwatch and reset keep working (AGENTS §0). Switching to another clip or param retries it.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { TemplateParamControlDef, TemplateParamControlProps } from '../../../extensions/index.ts';

type BoundaryProps = { name: string; resetKey: string; children: ReactNode };
type BoundaryState = { error: Error | null; resetKey: string };

class ControlBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { error: null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
		return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
	}

	componentDidCatch(error: unknown, info: ErrorInfo) {
		console.warn(
			`[properties] template param control "${this.props.name}" failed`,
			error,
			info.componentStack,
		);
	}

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return (
			<span
				role="alert"
				className="truncate text-pr-small text-pr-danger"
				title={error.message}
				data-testid="template-param-control-error"
			>
				{`Control "${this.props.name}" failed: ${error.message}`}
			</span>
		);
	}
}

/** Renders `def.component` with the contract props, isolated by an error boundary. */
export function TemplateParamControlHost(
	props: TemplateParamControlProps & { def: TemplateParamControlDef },
) {
	const { def, ...control } = props;
	const Control = def.component;
	return (
		<span className="flex min-w-0 flex-1" data-template-control={def.id}>
			<ControlBoundary name={def.id} resetKey={`${control.clipId}:${control.paramName}`}>
				<Control {...control} />
			</ControlBoundary>
		</span>
	);
}
