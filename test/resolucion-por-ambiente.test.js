'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SiiPortalAuth = require('../SiiPortalAuth');

// La resolución del SII (fecha y número) es POR AMBIENTE: maullin (certificación) y palena
// (producción) devuelven valores distintos para el mismo RUT. Leer siempre maullin dejaba a
// producción con la resolución de certificación y el SII rechazaba el sobre con "Error en Carátula".

const pagina = (fecha, nro) => `
  <html><body><table>
    <tr><td>DATOS DEL CONTRIBUYENTE RUT</td><td>&nbsp;12345678-9</td></tr>
    <tr><td>NOMBRE O RAZ&Oacute;N SOCIAL</td><td>&nbsp;EMPRESA EJEMPLO SPA</td></tr>
    <tr><td>FECHA RESOLUCION</td><td>&nbsp;${fecha}</td></tr>
    <tr><td>RESOLUCION</td><td>&nbsp;${nro}</td></tr>
  </table></body></html>`;

function authFalso() {
  const auth = Object.create(SiiPortalAuth.prototype);
  const urls = [];
  auth._request = async (url) => {
    urls.push(url);
    if (url.includes('palena.sii.cl') && url.endsWith('ad_empresa2')) return { status: 200, body: pagina('22-08-2014', '80') };
    if (url.includes('maullin.sii.cl') && url.endsWith('ad_empresa2')) return { status: 200, body: pagina('21-09-2026', '0') };
    return { status: 200, body: '' };
  };
  return { auth, urls };
}

test('sin ambiente lee maullin (comportamiento de siempre)', async () => {
  const { auth, urls } = authFalso();
  const r = await auth.obtenerDatosEmpresa('12345678', '9', {});
  assert.ok(urls.every((u) => u.includes('maullin.sii.cl')));
  assert.equal(r.fch_resol, '2026-09-21');
  assert.equal(r.nro_resol, 0);
});

test('certificacion lee maullin', async () => {
  const { auth, urls } = authFalso();
  await auth.obtenerDatosEmpresa('12345678', '9', {}, 'certificacion');
  assert.ok(urls.every((u) => u.includes('maullin.sii.cl')));
});

test('produccion lee palena y devuelve SU resolución, distinta de la de certificación', async () => {
  const { auth, urls } = authFalso();
  const r = await auth.obtenerDatosEmpresa('12345678', '9', {}, 'produccion');
  assert.ok(urls.length === 2 && urls.every((u) => u.includes('palena.sii.cl')));
  assert.equal(r.fch_resol, '2014-08-22');
  assert.equal(r.nro_resol, 80);
});

test('un ambiente desconocido lanza en vez de leer el equivocado', async () => {
  const { auth } = authFalso();
  await assert.rejects(() => auth.obtenerDatosEmpresa('12345678', '9', {}, 'produccion-x'), /ambiente inválido/);
});
