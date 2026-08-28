(function () {
  const DEFAULT_BACKEND_ORIGIN = 'https://pg1-ai-agent.vercel.app';
  const metaOrigin = document.querySelector('meta[name="pg1-backend-origin"]');
  const configuredOrigin = [
    window.PG1_BACKEND_ORIGIN,
    metaOrigin && metaOrigin.content,
    DEFAULT_BACKEND_ORIGIN
  ].find((value) => typeof value === 'string' && value.trim());

  const normalizedOrigin = configuredOrigin.replace(/\/+$/, '');

  function resolveBackendUrl(path) {
    return new URL(path, normalizedOrigin + '/').toString();
  }

  window.PG1_BACKEND_ORIGIN = normalizedOrigin;
  window.PG1_CHAT_API_URL = resolveBackendUrl('/api/chat');
  window.resolveBackendUrl = resolveBackendUrl;
})();
