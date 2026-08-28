(function (global) {
  var DEFAULT_ORIGIN = 'https://pg1-ai-agent.vercel.app';

  function normalizeOrigin(value) {
    if (typeof value !== 'string') return DEFAULT_ORIGIN;
    var trimmed = value.trim();
    if (!trimmed) return DEFAULT_ORIGIN;

    try {
      return new URL(trimmed).origin;
    } catch (error) {
      try {
        return new URL(trimmed, global.location && global.location.href ? global.location.href : DEFAULT_ORIGIN).origin;
      } catch (nestedError) {
        return DEFAULT_ORIGIN;
      }
    }
  }

  function readMetaOrigin() {
    if (!global.document || !global.document.querySelector) return '';
    var meta = global.document.querySelector('meta[name="pg1-backend-origin"]');
    return meta && typeof meta.content === 'string' ? meta.content : '';
  }

  var resolvedOrigin = normalizeOrigin(global.PG1_BACKEND_ORIGIN || readMetaOrigin() || DEFAULT_ORIGIN);

  global.PG1_BACKEND_ORIGIN = resolvedOrigin;
  global.PG1_BUILD_BACKEND_URL = function (pathname) {
    var safePath = String(pathname || '').replace(/^\/+/, '');
    return safePath ? new URL(safePath, resolvedOrigin.replace(/\/?$/, '/')).toString() : resolvedOrigin;
  };
  global.PG1_CHAT_API_URL = global.PG1_BUILD_BACKEND_URL('/api/chat');
})(window);
