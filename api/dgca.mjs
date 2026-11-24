import app from '../backend/node_api/src/index.js';

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // Routed requests can reach the handler with either the source or the rewritten URL.
  if (url.pathname === '/api/dgca') {
    const route = url.searchParams.getAll('__dgca_route');
    if (route.length !== 1 || !route[0] || /[?#\\]|(?:^|\/)\.{1,2}(?:\/|$)/.test(route[0])) {
      res.statusCode = 404;
      return res.end();
    }
    url.pathname = `/api/${route[0]}`;
  }
  url.searchParams.delete('__dgca_route');
  req.url = url.pathname + url.search;
  return app(req, res);
}
