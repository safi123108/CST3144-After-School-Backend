const express = require('express');
const fs = require('fs');
const path = require('path');

/**
 * Resolve a safe top-level relative filename from an Express sub-router req.path.
 * Returns null for safeRelativeName when path traversal, separators, or invalid encoding occur.
 */
function resolveRequestedFilename(reqPath) {
  const rawWithoutQuery = String(reqPath || '').split('?')[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawWithoutQuery);
  } catch {
    return {
      safeRelativeName: null,
      displayName: path.posix.basename(rawWithoutQuery)
    };
  }

  const trimmed = decodedPath.replace(/^\/+/, '');
  const displayName = path.posix.basename(trimmed);

  if (
    !trimmed ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed.includes('\0')
  ) {
    return { safeRelativeName: null, displayName };
  }

  return { safeRelativeName: trimmed, displayName: trimmed };
}

/**
 * Middleware router for /images:
 * 1. Serves existing static files directly (e.g., /images/maths.svg).
 * 2. Resolves seeded .png filenames to matching existing .svg assets in imagesDir.
 * 3. Returns a 404 JSON error with clean filename extraction (ignoring query strings).
 */
function createImageMiddleware({ imagesDir }) {
  const resolvedImagesDir = path.resolve(imagesDir);
  const router = express.Router();

  router.use(express.static(resolvedImagesDir));

  // Fallback for seeded lesson .png filenames whose matching .svg asset exists locally
  router.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    const { safeRelativeName } = resolveRequestedFilename(req.path);
    if (!safeRelativeName || !/\.png$/i.test(safeRelativeName)) {
      return next();
    }

    const svgFilename = safeRelativeName.replace(/\.png$/i, '.svg');
    const candidatePath = path.resolve(resolvedImagesDir, svgFilename);

    if (!candidatePath.startsWith(resolvedImagesDir + path.sep)) {
      return next();
    }

    try {
      const stats = await fs.promises.stat(candidatePath);
      if (!stats.isFile()) {
        return next();
      }
      return res.sendFile(candidatePath, (sendErr) => {
        if (sendErr && !res.headersSent) {
          next();
        }
      });
    } catch {
      return next();
    }
  });

  // 404 fallback specifically for missing image requests under /images
  router.use((req, res) => {
    const { displayName } = resolveRequestedFilename(req.path);
    const filename = displayName || '(none)';
    res.status(404).json({
      error: 'Image not found',
      message: `The requested image file '${filename}' does not exist on this server.`
    });
  });

  return router;
}

module.exports = {
  createImageMiddleware,
  resolveRequestedFilename
};

