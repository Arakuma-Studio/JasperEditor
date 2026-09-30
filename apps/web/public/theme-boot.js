// Applies stored UI preferences before the bundle loads (S05:DT-003). WP-2A owns this file.
(() => {
	const el = document.documentElement;
	let prefs = {};
	try {
		prefs = JSON.parse(localStorage.getItem('jasper:ui-prefs') || '{}') || {};
	} catch {
		prefs = {};
	}
	el.setAttribute('data-pr-theme', prefs.theme === 'dark' ? 'dark' : 'darkest');
	el.setAttribute('data-pr-contrast', prefs.contrast === 'high' ? 'high' : 'normal');
	el.setAttribute('data-pr-density', prefs.density === 'touch' ? 'touch' : 'normal');
	el.setAttribute('data-pr-labels', prefs.labels === 'classic' || prefs.labels === 'vibrant' ? prefs.labels : 'default');
})();
