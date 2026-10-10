import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
const port = '49621';
const child = spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, E2E_PORT: port }, stdio: 'ignore' });
process.on('exit', () => child.kill('SIGTERM'));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
for (const rate of [1, 8, 20]) {
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	await page.addInitScript(() => {
		const w = window as any;
		w.__media = { created: 0 };
		const orig = document.createElement.bind(document);
		document.createElement = ((tag: string, opts?: any) => {
			if (/^(audio|video)$/i.test(tag)) w.__media.created++;
			return orig(tag, opts);
		}) as any;
		localStorage.setItem('jasper:agent-bridge', '1');
	});
	const cdp = await page.context().newCDPSession(page);
	await page.goto(base + '/');
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill(`media probe ${rate}`);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate });
	const t0 = Date.now();
	await page.getByTestId('new-project-create').click();
	await page.getByTestId('timeline-track-area').waitFor({ timeout: 120000 });
	const shell = Date.now() - t0;
	const rows: string[] = [];
	for (let i = 0; i < 8; i++) {
		await page.waitForTimeout(3000);
		const r = await page.evaluate(() => ({ created: (window as any).__media.created, loading: document.querySelectorAll('[data-testid="panel-loading"]').length, project: !!document.querySelector('[data-testid="project-panel"]') }));
		rows.push(`${Math.round((Date.now() - t0) / 1000)}s:${r.created}/${r.loading}/${r.project ? 'P' : '-'}`);
	}
	console.log(`throttle x${rate}: shell ${shell} ms; created/loading/project → ${rows.join('  ')}`);
	await page.close();
}
await browser.close();
child.kill('SIGTERM');
process.exit(0);
