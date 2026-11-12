/**
 * Normalize an origin string by trimming whitespace, stripping trailing slashes,
 * and canonicalizing HTTP(S) scheme/host casing when valid.
 */
function normalizeOrigin(origin) {
  if (typeof origin !== 'string') return '';
  const trimmed = origin.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin;
    } catch {
      return trimmed.replace(/\/+$/, '');
    }
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Parse a comma-separated CORS_ORIGIN setting into an allowlist array,
 * or null when omitted/blank/wildcard to use the default permissive mode.
 */
function parseAllowedOrigins(corsOriginValue) {
  if (typeof corsOriginValue !== 'string') {
    return null;
  }

  const normalizedEntries = corsOriginValue
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

  if (normalizedEntries.length === 0 || normalizedEntries.includes('*')) {
    return null;
  }

  return [...new Set(normalizedEntries)];
}

/**
 * Build express/cors options supporting local development, GitHub Pages origins,
 * non-browser requests (no Origin header), and OPTIONS preflight handling.
 */
function createCorsOptions(corsOriginValue) {
  const allowedOrigins = parseAllowedOrigins(corsOriginValue);

  const originOption = allowedOrigins === null
    ? '*'
    : (requestOrigin, callback) => {
        if (!requestOrigin) {
          return callback(null, true);
        }
        const isAllowed = allowedOrigins.includes(normalizeOrigin(requestOrigin));
        return callback(null, isAllowed);
      };

  return {
    origin: originOption,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204
  };
}

module.exports = {
  normalizeOrigin,
  parseAllowedOrigins,
  createCorsOptions
};
