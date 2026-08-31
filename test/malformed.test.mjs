// A request must not be able to stop the server.
//
// A GET of `//` did. Node reads it as a protocol-relative URL with an empty
// host, `new URL` throws, and that parse sat outside the handler's try — so
// the throw escaped an async method as a rejected promise, went unhandled,
// and ended the process. Any client could have done it, by accident: it came
// out of a shell loop that built a URL with one slash too many.
//
// Two things are checked here. That the parse itself is defended, and that
// nothing thrown anywhere in a request can take the process with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

/**
 * The shape of the fix, exercised against a stand-in server.
 *
 * The real one needs a store, a feed and a GTFS cache to construct, which is
 * far more than this is about; what matters is the two properties, and they
 * live in a handful of lines that are reproduced here. `test/server` covers
 * the routing itself.
 */
function build({ crashOn = null } = {}) {
  const handle = async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"bad request"}');
      return;
    }
    if (url.pathname === crashOn) throw new Error('boom');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: url.pathname }));
  };

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal"}');
      } else {
        res.end();
      }
    });
  });
}

async function serve(server) {
  server.listen(0);
  await once(server, 'listening');
  return server.address().port;
}

/** A raw request, because `fetch` will not send a path this malformed. */
async function raw(port, line) {
  const { connect } = await import('node:net');
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`GET ${line} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  let body = '';
  socket.setEncoding('utf8');
  for await (const chunk of socket) body += chunk;
  return body;
}

test('a request path that will not parse is answered, not fatal', async () => {
  const server = build();
  const port = await serve(server);
  try {
    const res = await raw(port, '//');
    assert.match(res, /^HTTP\/1\.1 400/, res.split('\r\n')[0]);
    // Still up: that is the whole point.
    const after = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(after.status, 200);
  } finally {
    server.close();
  }
});

test('the server survives a whole run of malformed paths', async () => {
  // Anything a scanner, a proxy or a careless shell loop might send.
  const server = build();
  const port = await serve(server);
  try {
    for (const line of ['//', '///', '//evil.example', 'http://', '//?x=1', '//#f']) {
      const res = await raw(port, line);
      assert.match(res, /^HTTP\/1\.1 [0-9]{3}/, `${line}: no answer`);
    }
    const after = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(after.status, 200, 'still serving');
  } finally {
    server.close();
  }
});

test('an ordinary path is unaffected by the guard', async () => {
  const server = build();
  const port = await serve(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/train/8540/path`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).path, '/api/train/8540/path');
  } finally {
    server.close();
  }
});

test('a handler that throws answers 500 rather than ending the process', async () => {
  // The parse is one way in; the guard has to hold for any of them, or the
  // next unlucky line in a route becomes a way to stop the server.
  const server = build({ crashOn: '/boom' });
  const port = await serve(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    assert.equal(res.status, 500);
    const after = await fetch(`http://127.0.0.1:${port}/fine`);
    assert.equal(after.status, 200, 'still serving after a handler threw');
  } finally {
    server.close();
  }
});

test('the real server guards both, not just the one that bit', async () => {
  // The stand-in above is only a model of the fix; these check the source
  // itself still has both halves.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = await readFile(path.join(root, 'src/server/Server.ts'), 'utf8');

  assert.match(src, /this\.handle\(req, res\)\.catch\(/, 'the rejection must be caught');
  assert.ok(!/void this\.handle\(/.test(src), 'a discarded rejection ends the process');
  // The parse must be inside a try, not above one.
  const handler = src.slice(src.indexOf('private async handle('));
  const parse = handler.indexOf('new URL(');
  const guard = handler.indexOf('try {');
  assert.ok(guard >= 0 && guard < parse, 'the URL parse should sit inside a try');
});
