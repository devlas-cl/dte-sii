// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const SiiSession = require('../SiiSession');

// got 11 reintenta por su cuenta ante un timeout y ese reintento lanza una
// excepcion no capturada desde un timer. El servidor acepta la conexion y no
// responde nunca, asi que la peticion vence por tiempo.
test('SiiSession: un timeout no deja un reintento interno de got ni excepcion no capturada', async () => {
  const conexiones = [];
  const server = net.createServer((sock) => { conexiones.push(sock); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const caidas = [];
  const alCaer = (e) => caidas.push(e);
  process.on('uncaughtException', alCaer);
  try {
    const s = Object.create(SiiSession.prototype);
    s.baseHost = '127.0.0.1';
    s.cookieJar = '';
    await assert.rejects(
      s._doRequest(`http://127.0.0.1:${port}/`, { method: 'GET', timeoutMs: 300 }, false),
      (err) => err.code === 'ETIMEDOUT' || err.name === 'TimeoutError'
    );
    // Margen para que dispare cualquier reintento interno pendiente.
    await new Promise((r) => setTimeout(r, 2500));
    assert.strictEqual(conexiones.length, 1, 'got no debe reabrir la conexion por su cuenta');
    assert.deepStrictEqual(caidas, [], 'no debe haber excepciones no capturadas');
  } finally {
    process.removeListener('uncaughtException', alCaer);
    conexiones.forEach((c) => c.destroy());
    server.close();
  }
});
