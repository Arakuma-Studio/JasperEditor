import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRepo, findViolations, isExempt } from './check-tokens.mjs';

describe('check-tokens matcher', () => {
	it('accepts token-only code', () => {
		expect(findViolations("<div className='bg-pr-panel text-pr-muted border-pr-border-subtle' />")).toEqual([]);
		expect(findViolations('color: var(--pr-text-primary);')).toEqual([]);
		expect(findViolations("const id = '#root'; const n = 120;")).toEqual([]);
	});

	it('catches hex literals', () => {
		const v = findViolations("const c = '#1d1d1d';\nconst d = '#FFF';");
		expect(v.map((x) => x.match)).toEqual(['#1d1d1d', '#FFF']);
		expect(v[1].line).toBe(2);
	});

	it('catches rgb/hsl functions', () => {
		expect(findViolations('box-shadow: 0 0 1px rgba(0,0,0,.5)').map((x) => x.rule)).toEqual(['color-function']);
		expect(findViolations("style={{color: 'hsl(10 20% 30%)'}}")).toHaveLength(1);
	});

	it('catches raw Tailwind palette classes', () => {
		const rules = findViolations("<p className='bg-neutral-800 text-gray-400 border-zinc-700 ring-slate-50' />").map(
			(x) => x.match,
		);
		expect(rules).toContain('bg-neutral-800');
		expect(rules).toContain('text-gray-400');
		expect(rules).toContain('border-zinc-700');
		expect(rules).toContain('ring-slate-50');
		expect(findViolations("className='text-white bg-black/50 hover:bg-white/10'").length).toBeGreaterThanOrEqual(3);
	});

	it('honours the per-line opt-out marker', () => {
		expect(findViolations("const fill = [1, 1, 1, 1]; const css = '#fff'; // tokens-allow")).toEqual([]);
	});

	it('exempts theme dirs and *.tokens.ts', () => {
		expect(isExempt('packages/ui/src/theme/tokens.css')).toBe(true);
		expect(isExempt('packages/ui/src/labels.tokens.ts')).toBe(true);
		expect(isExempt('apps/web/src/shell/Header.tsx')).toBe(false);
	});

	it('scans a planted literal in a fake repo', () => {
		const root = mkdtempSync(join(tmpdir(), 'tokens-'));
		mkdirSync(join(root, 'packages/ui/src/theme'), { recursive: true });
		mkdirSync(join(root, 'apps/web/src/shell'), { recursive: true });
		writeFileSync(join(root, 'packages/ui/src/theme/tokens.css'), ':root { --pr-bg-app: #000000; }');
		writeFileSync(join(root, 'apps/web/src/shell/Bad.tsx'), "export const x = <div style={{ color: '#ff0000' }} />;");
		const problems = checkRepo(root);
		expect(problems).toHaveLength(1);
		expect(problems[0].file).toBe('apps/web/src/shell/Bad.tsx');
		expect(problems[0].match).toBe('#ff0000');
	});
});
