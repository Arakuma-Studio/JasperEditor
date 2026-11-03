// Spec 19 TL-093: the run toolbar's Finish control. The look draws a run's finish on its letters (the planner's
// `letterFinish`), so the control is enabled on a clip with a look, and absent without one.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunState, RunToolbar } from '../src/text-edit/RunToolbar.tsx';

const state: RunState = {
	bold: false,
	italic: false,
	sizePx: 48,
	fill: [1, 1, 1, 1],
	finish: '',
	styled: false,
};

afterEach(cleanup);

describe('run toolbar: Finish', () => {
	const toolbar = (look: boolean, onPatch = vi.fn(), onDone = vi.fn()) =>
		render(
			<RunToolbar
				at={[100, 100]}
				state={state}
				look={look}
				uiAttr="data-run-ui"
				onPatch={onPatch}
				onDone={onDone}
				onLeave={() => {}}
			/>,
		);

	it('is enabled on a clip with a look and sets the finish of the selected letters', () => {
		const onPatch = vi.fn();
		const onDone = vi.fn();
		const { container } = toolbar(true, onPatch, onDone);
		const select = container.querySelector<HTMLSelectElement>('select[data-run-action="finish"]')!;
		expect(select).not.toBeNull();
		expect(select.disabled).toBe(false);
		fireEvent.change(select, { target: { value: 'metal' } });
		expect(onPatch).toHaveBeenCalledWith({ finish: 'metal' });
		expect(onDone).toHaveBeenCalled();
		// Back to the look's own finish clears the run's.
		fireEvent.change(select, { target: { value: '' } });
		expect(onPatch).toHaveBeenLastCalledWith({ finish: null });
	});

	it('is not offered without a look', () => {
		const { container } = toolbar(false);
		expect(container.querySelector('select[data-run-action="finish"]')).toBeNull();
	});
});
