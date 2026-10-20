import { Readable } from 'node:stream';
import { createRequestHandler, RouterContextProvider } from 'react-router';
import * as build from '../build/server/index.js';

const handleRequest = createRequestHandler(build, process.env.NODE_ENV || 'production');

// Vercel should leave the incoming stream untouched so multipart and large
// request bodies can be forwarded to the React Router action without parsing.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const url = new URL(req.url || '/', `${protocol}://${host}`);
    const headers = new Headers();

    for (const [name, rawValue] of Object.entries(req.headers)) {
      if (['connection', 'content-length', 'host', 'transfer-encoding'].includes(name)) continue;
      if (rawValue !== undefined) headers.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : rawValue);
    }

    const method = req.method || 'GET';
    const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase());
    const request = new Request(url, {
      method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
    });

    const context = new RouterContextProvider();
    const waitUntil = (promise) => {
      Promise.resolve(promise).catch((error) => console.error('Background task failed:', error));
    };
    Object.assign(context, {
      cloudflare: {
        env: process.env,
        ctx: { waitUntil, passThroughOnException() {} },
      },
      clientAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim(),
    });
    const response = await handleRequest(request, context);
    res.statusCode = response.status;
    res.statusMessage = response.statusText;

    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie?.();
    if (cookies?.length) res.setHeader('set-cookie', cookies);

    if (!response.body) {
      res.end();
      return;
    }

    Readable.fromWeb(response.body).on('error', (error) => {
      console.error('Vercel SSR response stream failed:', error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }).pipe(res);
  } catch (error) {
    console.error('Vercel SSR request failed:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end('Internal Server Error');
  }
}
