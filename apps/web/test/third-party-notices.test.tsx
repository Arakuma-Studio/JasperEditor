import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portedSection, ThirdPartyLicenses } from '../src/shell/licenses.tsx';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function open(el: HTMLElement) {
	(el as HTMLDetailsElement).open = true;
	fireEvent(el, new Event('toggle'));
}

describe('About ▸ third-party notices (S11:FIX-010)', () => {
	it('without an engine, the About notice identifies anime.js and its MIT license', () => {
		render(<ThirdPartyLicenses />);
		const section = screen.getByRole('region', { name: 'Third-party licenses' });
		expect(section.textContent).toContain('anime.js');
		expect(section.textContent).toContain('MIT License');
	});

	it('links THIRD_PARTY_NOTICES.md and shows it when opened', async () => {
		const fetchMock = vi.fn(async () => new Response('# Third-party notices\n\n| animejs | 4.5.0 | MIT |'));
		vi.stubGlobal('fetch', fetchMock);
		render(<ThirdPartyLicenses />);
		const details = screen.getByTestId('third-party-notices');
		const link = screen.getByRole('link', { name: 'THIRD_PARTY_NOTICES.md' });
		expect(link.getAttribute('href')).toBe('/THIRD_PARTY_NOTICES.md');
		expect(fetchMock).not.toHaveBeenCalled();
		open(details);
		await waitFor(() =>
			expect(screen.getByTestId('third-party-notices-text').textContent).toMatch(/animejs/),
		);
		expect(fetchMock).toHaveBeenCalledWith('/THIRD_PARTY_NOTICES.md');
	});

	it('says so when the file is missing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 404 })),
		);
		render(<ThirdPartyLicenses />);
		open(screen.getByTestId('third-party-notices'));
		await waitFor(() => expect(screen.getByText(/not available in this build/)).toBeTruthy());
	});

	it('shows the ported source records on their own (licenses/ported, D-36)', async () => {
		const file = [
			'# Third-party notices',
			'| animejs | 4.5.0 | MIT |',
			'<!-- ported-source:start -->',
			'# Ported source code',
			'| Blur kernels | https://github.com/storytold/effectcraft | MIT OR Apache-2.0 |',
			'<!-- ported-source:end -->',
		].join('\n');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(file)),
		);
		render(<ThirdPartyLicenses />);
		open(screen.getByTestId('ported-source-notices'));
		await waitFor(() =>
			expect(screen.getByTestId('ported-source-notices-text').textContent).toContain('Blur kernels'),
		);
		expect(screen.getByTestId('ported-source-notices-text').textContent).not.toContain('animejs');
		expect(portedSection('# no records')).toBeNull();
	});
});
