// Service worker registration — no-op stub in WP-00. WP-2H registers /sw.js when
// `import.meta.env.PROD && !window.jasperDesktop` (ARCHITECTURE §12).
export function registerServiceWorker(): void {}
