import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useStoreSelector } from '../src/react/index.ts';

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
});
