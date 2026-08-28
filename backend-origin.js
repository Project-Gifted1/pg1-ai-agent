(function (root, factory) {
  const config = factory(root, root && root.document ? root.document : undefined);

  if (typeof module === 'object' && module.exports) {
    module.exports = config;
  }

  if (root && root.window === root) {
    root.PG1FrontendConfig = config;
    root.PG1_BACKEND_ORIGIN = config.backendOrigin;
    root.PG1_CHAT_API_URL = config.buildApiUrl('/api/chat');
    root.PG1_BUILD_BACKEND_URL = config.buildApiUrl;
  }
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
    const globalOverride = normalizeOrigin(root && root.PG1_BACKEND_ORIGIN);
    if (globalOverride) return globalOverride;

    const metaOverride = document && typeof document.querySelector === 'function'
      ? normalizeOrigin((document.querySelector('meta[name="pg1-backend-origin"]') || {}).content)
      : '';
    if (metaOverride) return metaOverride;

    return DEFAULT_BACKEND_ORIGIN;
  }

  function buildApiUrl(path) {
    const rawPath = String(path || '/');
    const normalizedPath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
    return new URL(normalizedPath, getConfiguredBackendOrigin() + '/').toString();
  }

  return Object.freeze({
    defaultBackendOrigin: DEFAULT_BACKEND_ORIGIN,
    get backendOrigin() {
      return getConfiguredBackendOrigin();
    },
    buildApiUrl
  });
});
