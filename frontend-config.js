(function (root, factory) {
  const config = factory(root, root.document);

  if (typeof module === 'object' && module.exports) {
    module.exports = config;
  }

  root.PG1FrontendConfig = config;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, document) {
  const DEFAULT_BACKEND_ORIGIN = 'https://pg1-ai-agent.vercel.app';

  function normalizeOrigin(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';

    try {
      return new URL(trimmed).origin;
    } catch (_) {
      return '';
    }
  }

  function getConfiguredBackendOrigin() {
    const globalOverride = normalizeOrigin(root.PG1_BACKEND_ORIGIN);
    if (globalOverride) return globalOverride;

    const metaOverride = document && typeof document.querySelector === 'function'
      ? normalizeOrigin((document.querySelector('meta[name="pg1-backend-origin"]') || {}).content)
      : '';
    if (metaOverride) return metaOverride;

    return DEFAULT_BACKEND_ORIGIN;
  }

  const backendOrigin = getConfiguredBackendOrigin();

  return Object.freeze({
    backendOrigin,
    defaultBackendOrigin: DEFAULT_BACKEND_ORIGIN,
    buildApiUrl: function (path) {
      return new URL(path, backendOrigin + '/').toString();
    }
  });
});
