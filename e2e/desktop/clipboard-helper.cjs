// "Another application" for the desktop clipboard check (e2e/desktop/clipboard.desktop.ts): a bare Electron main
// process that puts external content on the OS clipboard and keeps owning it (X11 drops a selection when its
// owner exits) until it is terminated.
//   JASPER_HELPER_KIND=text   JASPER_HELPER_DATA=<text>
//   JASPER_HELPER_KIND=image  JASPER_HELPER_DATA=<png file>       (image data, like "Copy image")
//   JASPER_HELPER_KIND=files  JASPER_HELPER_DATA=<path>[\n<path>]  (files, like a file manager's Copy)
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, clipboard, ClipboardItem } = require('electron');

app.setName('jasper-clipboard-helper');
app.whenReady().then(async () => {
	const kind = process.env.JASPER_HELPER_KIND;
	const data = process.env.JASPER_HELPER_DATA ?? '';
	try {
		if (kind === 'text') await clipboard.writeText(data);
		else if (kind === 'image')
			await clipboard.write([
				new ClipboardItem({ 'image/png': new Blob([readFileSync(data)], { type: 'image/png' }) }),
			]);
		else if (kind === 'files') {
			// What GNOME Files offers: x-special/gnome-copied-files ("copy" + file URLs) and the paths as text. (A
			// Chromium `text/uri-list` write goes through the XDG file-transfer portal, which xvfb hosts lack.)
			const paths = data.split('\n');
			const urls = paths.map((p) => pathToFileURL(p).href);
			await clipboard.write([
				new ClipboardItem({
					'text/plain': paths.join('\n'),
					'electron application/osclipboard;format="x-special/gnome-copied-files"': new Blob([
						['copy', ...urls].join('\n'),
					]),
				}),
			]);
		} else throw new Error(`unknown JASPER_HELPER_KIND ${kind}`);
		const types = (await clipboard.read()).flatMap((it) => it.types);
		console.log(`[helper] ready ${kind} ${JSON.stringify(types)}`);
	} catch (e) {
		console.log(`[helper] failed ${e instanceof Error ? e.message : String(e)}`);
		app.exit(1);
	}
});
// Stay alive (no window): the test terminates the helper after the paste.
app.on('window-all-closed', () => undefined);
