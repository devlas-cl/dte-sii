/**
 * `SiiPortalAuth._request`: tiempo máximo de conexión y de respuesta.
 *
 * Medido el 14/10/2026 desde Railway: ~7 % de las conexiones TLS al SII quedan sin completar y,
 * sin tope, cada una colgaba la llamada ~125 s (el timeout del sistema operativo) antes de
 * llegar al reintento de `autenticar()`. Con tope, la petición falla en segundos con
 * `code: 'ETIMEDOUT'`, que el reintento ya trata como falla transitoria.
 *
 * Usa servidores locales (127.0.0.1). Sin red externa.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

process.env.DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-timeout-'));
const SiiPortalAuth = require('../SiiPortalAuth');

function instancia() {
  const a = Object.create(SiiPortalAuth.prototype);
  a._agentePlano = new https.Agent({ rejectUnauthorized: false });
  a._agenteCert = a._agentePlano;
  return a;
}

function escuchar(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function fallaCon(promesa) {
  const t0 = Date.now();
  try {
    await promesa;
  } catch (e) {
    return { err: e, ms: Date.now() - t0 };
  }
  throw new Error('la petición debía fallar y resolvió');
}

async function main() {
  // 1. Conexión que el servidor acepta pero nunca completa el handshake TLS.
  {
    const conexiones = [];
    const server = net.createServer((s) => conexiones.push(s)); // acepta y calla
    const puerto = await escuchar(server);
    process.env.SII_PORTAL_CONEXION_TIMEOUT_MS = '300';
    process.env.SII_PORTAL_RESPUESTA_TIMEOUT_MS = '60000';
    const { err, ms } = await fallaCon(instancia()._request(`https://127.0.0.1:${puerto}/x`));
    assert.strictEqual(err.code, 'ETIMEDOUT', `code=${err.code}`);
    assert.match(err.message, /\(conexión\)/);
    assert.ok(ms >= 250 && ms < 3000, `tardó ${ms} ms`);
    conexiones.forEach((s) => s.destroy());
    server.close();
    console.log('  ok: handshake TLS sin completar falla con ETIMEDOUT en la fase conexión');
  }

  // 2. Conectado, pero el servidor no responde: aplica el tope de respuesta, no el de conexión.
  {
    const server = http.createServer(() => { /* nunca responde */ });
    const puerto = await escuchar(server);
    process.env.SII_PORTAL_CONEXION_TIMEOUT_MS = '5000';
    process.env.SII_PORTAL_RESPUESTA_TIMEOUT_MS = '300';
    const { err, ms } = await fallaCon(instancia()._request(`http://127.0.0.1:${puerto}/x`));
    assert.strictEqual(err.code, 'ETIMEDOUT');
    assert.match(err.message, /\(respuesta\)/);
    assert.ok(ms >= 250 && ms < 3000, `tardó ${ms} ms`);
    server.closeAllConnections();
    server.close();
    console.log('  ok: servidor conectado que no responde falla en la fase respuesta');
  }

  // 3. Caso adversarial: respuesta lenta pero dentro del tope, no debe cortarse.
  {
    const server = http.createServer((req, res) => setTimeout(() => res.end('<html>ok</html>'), 400));
    const puerto = await escuchar(server);
    process.env.SII_PORTAL_CONEXION_TIMEOUT_MS = '300';
    process.env.SII_PORTAL_RESPUESTA_TIMEOUT_MS = '2000';
    const r = await instancia()._request(`http://127.0.0.1:${puerto}/x`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '<html>ok</html>');
    server.close();
    console.log('  ok: una respuesta lenta pero dentro del tope no se corta (el de conexión no la afecta)');
  }

  // 4. Valores inválidos en el entorno caen al valor por defecto, no desactivan el tope.
  {
    const server = http.createServer((req, res) => res.end('ok'));
    const puerto = await escuchar(server);
    process.env.SII_PORTAL_CONEXION_TIMEOUT_MS = 'abc';
    process.env.SII_PORTAL_RESPUESTA_TIMEOUT_MS = '-5';
    const r = await instancia()._request(`http://127.0.0.1:${puerto}/x`);
    assert.strictEqual(r.status, 200);
    server.close();
    console.log('  ok: valores inválidos usan el tope por defecto y la petición normal funciona');
  }

  // 5. El error es transitorio para el reintento de autenticar().
  {
    const e = new Error('SiiPortalAuth: tiempo de espera agotado (conexión) en x');
    e.code = 'ETIMEDOUT';
    const a = Object.create(SiiPortalAuth.prototype);
    a._certHash = 'timeout-test';
    a._cachedCookieJar = null;
    a._cargarSesionCache = () => null;
    let intentos = 0;
    a._autenticarNuevo = async () => {
      intentos++;
      if (intentos < 3) throw e;
      return { ok: 1 };
    };
    const jar = await a.autenticar();
    assert.deepStrictEqual(jar, { ok: 1 });
    assert.strictEqual(intentos, 3);
    console.log('  ok: el timeout se reintenta como falla transitoria y la tercera pasa');
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
