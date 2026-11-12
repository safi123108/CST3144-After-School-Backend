const http = require('node:http');

/**
 * Send an HTTP request to an Express app via an ephemeral localhost port (0).
 * Always closes the server when finished so no handles leak after tests.
 */
async function sendAppRequest(app, method, requestPath, options = {}) {
  const { headers = {}, rawBody = null, jsonBody = undefined } = options;

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => {
      s.removeListener('error', reject);
      resolve(s);
    });
    s.once('error', reject);
  });

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : address;

    return await new Promise((resolve, reject) => {
      const reqHeaders = { ...headers };
      let payload = rawBody;

      if (jsonBody !== undefined) {
        payload = JSON.stringify(jsonBody);
        if (!reqHeaders['content-type'] && !reqHeaders['Content-Type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      }

      if (payload !== null && !reqHeaders['content-length'] && !reqHeaders['Content-Length']) {
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: requestPath,
          method,
          headers: reqHeaders
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const text = buffer.toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              json,
              buffer
            });
          });
        }
      );

      req.on('error', reject);
      if (payload !== null) {
        req.write(payload);
      }
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

module.exports = {
  sendAppRequest
};
