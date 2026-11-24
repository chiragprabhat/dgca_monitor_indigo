import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { serverless } from '../services/job-service.js';

function* blocks(buffer) {
  for (let i = 0; i < buffer.length; i += 64 * 1024) yield buffer.subarray(i, i + 64 * 1024);
}

// Keep existing response bodies while letting the Vercel runtime stream large responses.
export function sendPayload(res, data, type = 'json') {
  const send = () => type === 'json' ? res.json(data) : res.send(data);
  if (!serverless()) return send();
  const body = type === 'json' ? JSON.stringify(data) : data;
  if (Buffer.byteLength(body) < 3 * 1024 * 1024) return send();
  res.type(type);
  if (res.req.method === 'HEAD') return res.end();
  return pipeline(Readable.from(blocks(Buffer.from(body))), res);
}
