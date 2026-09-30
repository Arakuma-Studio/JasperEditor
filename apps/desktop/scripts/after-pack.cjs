// electron-builder afterPack hook (ARCHITECTURE D-13): the packed app must ship our LGPL FFmpeg directory
// and nothing GPL/nonfree — no Remotion compositor package, no GPL FFmpeg binary or library, no x264/x265/
// fdk-aac. Throws (failing the build) otherwise. Same check as `pnpm ffmpeg:check --packaged <appOutDir>`.
// It also checks that the engine's runtime packages were copied (electron-builder skips a root-level
// node_modules of an extraResources source, hence the separate `engine/node_modules` entry in package.json).
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { pathToFileURL } = require('node:url');

/** The app's resources directory: `<appOutDir>/resources`, or `<App>.app/Contents/Resources` on macOS. */
function resourcesDir(appOutDir) {
	const plain = join(appOutDir, 'resources');
	if (existsSync(plain)) return plain;
	for (const n of readdirSync(appOutDir)) {
		const mac = join(appOutDir, n, 'Contents', 'Resources');
		if (n.endsWith('.app') && existsSync(mac) && statSync(mac).isDirectory()) return mac;
	}
	return plain;
}

exports.default = async function afterPack(context) {
	const res = resourcesDir(context.appOutDir);
	for (const f of [
		'engine/engine.mjs',
		'engine/remotion-bundle/index.html',
		'engine/node_modules/@remotion/renderer/package.json',
		'web/index.html',
	]) {
		if (!existsSync(join(res, f)))
			throw new Error(`packaged app is incomplete: ${join(res, f)} is missing (use scripts/package.mjs)`);
	}
	// The LGPL directory must be the one built for the TARGET platform (cross-packaging).
	const archName = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch];
	const target = `${context.electronPlatformName}-${archName}`;
	const infoFile = join(res, 'ffmpeg-lgpl', 'BUILDINFO.json');
	if (!existsSync(infoFile))
		throw new Error(`packaged app has no LGPL FFmpeg: ${infoFile} is missing (use scripts/package.mjs)`);
	const info = JSON.parse(readFileSync(infoFile, 'utf8'));
	if (info.platform !== target)
		throw new Error(`the packaged LGPL FFmpeg is for ${info.platform}, but the app is built for ${target}`);
	const guard = join(__dirname, '..', '..', '..', 'scripts', 'ffmpeg', 'check-lgpl.mjs');
	const { checkPackagedApp } = await import(pathToFileURL(guard).href);
	const { results, problems } = checkPackagedApp(context.appOutDir);
	const failures = [...problems];
	for (const r of results) {
		const rel = relative(context.appOutDir, r.file);
		if (r.problems.length) failures.push(`${rel}: ${r.problems.join('; ')}`);
		else console.log(`  • ffmpeg:check ok  ${rel} (${r.method})`);
	}
	if (failures.length) {
		throw new Error(
			`GPL/nonfree FFmpeg guard failed for ${context.appOutDir}:\n  ${failures.join('\n  ')}\n` +
				'Package with `pnpm --filter @jasper/desktop dist` (scripts/package.mjs), which stages the LGPL build.',
		);
	}
	console.log(`  • ffmpeg:check ${results.length} FFmpeg artifacts, all LGPL`);
};
