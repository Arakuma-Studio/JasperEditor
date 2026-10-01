import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { EditorSession } from '../src/index.ts';
import { SessionProvider, useDocument, useSessionState, useStoreSelector } from '../src/react/index.ts';

function ClipCount() {
	const n = useDocument((d) => Object.values(Object.values(d.sequences)[0]!.clips).length);
	const rev = useSessionState((s) => s.revision);
	return (
		<p>
			clips:{n} rev:{rev}
		</p>
	);
}

describe('@jasper/session/react', () => {
	it('reselects when props change without a store update', () => {
		const store = createStore(() => ({ first: 'A', second: 'B' }));
		const { result, rerender } = renderHook(
			({ key }: { key: 'first' | 'second' }) => useStoreSelector(store, (state) => state[key]),
			{ initialProps: { key: 'first' } },
		);
		expect(result.current).toBe('A');
		rerender({ key: 'second' });
		expect(result.current).toBe('B');
	});

	it('applies a changed equality function to the current selection', () => {
		const store = createStore(() => ({ value: 1 }));
		const selector = (state: { value: number }) => ({ value: state.value });
		const { result, rerender } = renderHook(({ equality }) => useStoreSelector(store, selector, equality), {
			initialProps: { equality: (_a: { value: number }, _b: { value: number }) => true },
		});
		act(() => store.setState({ value: 2 }));
		expect(result.current.value).toBe(1);
		rerender({ equality: Object.is });
		expect(result.current.value).toBe(2);
	});

	it('re-renders selectors on document changes', () => {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'R' });
		const s = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			ctx: { ids, now: () => 't', registries: defaultRegistries() },
		});
		render(
			<SessionProvider session={s}>
				<ClipCount />
			</SessionProvider>,
		);
		expect(screen.getByText('clips:0 rev:0')).toBeTruthy();
		act(() => {
			s.apply({
				label: 'Add',
				origin: 'user',
				commands: [{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 1, 1, 1] }],
			});
		});
		expect(screen.getByText('clips:1 rev:1')).toBeTruthy();
	});
});
