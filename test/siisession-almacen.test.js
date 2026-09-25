// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiSession con un store de sesión compartido (por ejemplo Redis) configurado.
 *
 * Lo que se garantiza, sin red ni SII:
 *  1. SiiSession y SiiPortalAuth identifican el certificado con la MISMA huella, así que
 *     comparten una sola sesión por certificado.
 *  2. Sin store compartido configurado, ensureSession se comporta como siempre y no toca ningún store.
 *  3. Con store compartido, una segunda instancia (otra réplica) reutiliza la sesión de la
 *     primera sin volver a autenticarse.
 *  4. Dos instancias del mismo certificado no ejecutan ensureSession a la vez.
 *
 * Se ejecuta con `node test/siisession-almacen.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

process.env.DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-siisession-'));
const SiiPortalAuth = require('../SiiPortalAuth');
const SiiSession = require('../SiiSession');
const Certificado = require('../Certificado');
const { MemorySessionStore } = require('../SiiSessionPorts');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function pfxDePrueba(password) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'Prueba' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

/** SiiSession cuyo "login" es un contador: no toca el portal. */
function sesionSimulada(pfx, password, contador) {
  const s = new SiiSession({ ambiente: 'certificacion', pfxBuffer: pfx, pfxPassword: password });
  s._ensureSessionInterno = async () => {
    if (!s.cookieJar) { contador.logins++; s.cookieJar = `TS=login${contador.logins}; NETSCAPE_LIVEWIRE.rut=1`; }
    return { body: 'ok' };
  };
  return s;
}

(async () => {
  const PASS = 'clave-de-prueba';
  const pfx = pfxDePrueba(PASS);

  // ── 1. Misma huella que SiiPortalAuth ──────────────────────────────────────
  const { certPem } = SiiPortalAuth._extractPems(pfx, PASS);
  const esperada = SiiPortalAuth.huellaDeCertPem(certPem);
  const contador = { logins: 0 };
  const a = sesionSimulada(pfx, PASS, contador);
  assert.strictEqual(a._almacenClave, esperada, 'SiiSession usa la misma huella que SiiPortalAuth');
  const viaCertificado = new SiiSession({ ambiente: 'certificacion', certificado: new Certificado(pfx, PASS) });
  assert.strictEqual(viaCertificado._almacenClave, esperada, 'y también cuando se le pasa una instancia de Certificado');
  const sinClave = new SiiSession({ ambiente: 'certificacion' });
  assert.strictEqual(sinClave._almacenClave, null, 'sin certificado no hay huella y no se usa el store');
  console.log('✓ SiiSession y SiiPortalAuth comparten la huella del certificado');

  // ── 2. Sin store compartido: comportamiento de siempre ─────────────────────
  SiiPortalAuth.restablecerSesion();
  assert.strictEqual(a._almacenActivo(), false);
  await a.ensureSession('/x');
  assert.strictEqual(contador.logins, 1);
  assert.strictEqual(await a.cargarDeAlmacen(), false, 'sin store compartido no carga nada');
  console.log('✓ Sin store compartido no se toca ningún store');

  // ── 3. Con store compartido: la otra réplica reutiliza la sesión ───────────
  const compartido = new MemorySessionStore();
  SiiPortalAuth.configurarSesion({ store: compartido });
  const c = { logins: 0 };
  const podA = sesionSimulada(pfx, PASS, c);
  const podB = sesionSimulada(pfx, PASS, c);
  assert.strictEqual(podA._almacenActivo(), true);

  await podA.ensureSession('/x');
  assert.strictEqual(c.logins, 1, 'la primera réplica se autentica');
  const guardada = await compartido.load(esperada);
  assert.ok(guardada && guardada.cookies.TS === 'login1', 'y deja la sesión en el store, con la huella del certificado');

  await podB.ensureSession('/x');
  assert.strictEqual(c.logins, 1, 'la segunda réplica NO abre otra sesión con el SII');
  assert.strictEqual(podB.cookieJar, podA.cookieJar, 'usa la misma sesión');

  // El store también lo ve SiiPortalAuth: es una sola sesión por certificado.
  assert.strictEqual((await SiiPortalAuth.cargarCookieString(esperada)).includes('TS=login1'), true);

  await podB.borrarDeAlmacen();
  assert.strictEqual(await compartido.load(esperada), null, 'borrar la sesión la quita del store');
  console.log('✓ Una segunda réplica reutiliza la sesión sin autenticarse otra vez');

  // ── 4. Un solo ensureSession a la vez por certificado ──────────────────────
  let enCurso = 0; let maximo = 0;
  const lenta = (nombre) => {
    const s = sesionSimulada(pfx, PASS, { logins: 0 });
    s._ensureSessionInterno = async () => {
      enCurso++; maximo = Math.max(maximo, enCurso);
      await dormir(30);
      enCurso--;
      s.cookieJar = `TS=${nombre}`;
      return {};
    };
    return s;
  };
  await Promise.all([lenta('a').ensureSession('/x'), lenta('b').ensureSession('/x'), lenta('c').ensureSession('/x')]);
  assert.strictEqual(maximo, 1, 'nunca dos ensureSession en paralelo para el mismo certificado');
  console.log('✓ Se serializa el acceso por certificado');

  SiiPortalAuth.restablecerSesion();
  console.log('\nsiisession-almacen OK');
})().catch((e) => { console.error(e); process.exit(1); });
