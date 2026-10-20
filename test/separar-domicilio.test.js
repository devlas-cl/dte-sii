'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SiiPortalAuth = require('../SiiPortalAuth');

// Datos inventados (repo publico). El patron reproduce el texto que arma el portal del SII:
// cada dato lleva su etiqueta y la comuna va al final.

const DIR_LARGA = 'AVENIDA DEL EJEMPLO 1078, Villa/Pob. VILLA LOS ALAMOS DE PRUEBA, Ciudad CIUDAD EJEMPLO, Comuna COMUNA EJEMPLO';

function paginaConDireccion(dir) {
  return `<html><body><table>
    <tr><td>DATOS DEL CONTRIBUYENTE RUT</td><td>&nbsp;12345678-9</td></tr>
    <tr><td>NOMBRE O RAZ&Oacute;N SOCIAL</td><td>&nbsp;EMPRESA EJEMPLO SPA</td></tr>
    <tr><td>DIRECCI&Oacute;N DE LA EMPRESA</td><td>&nbsp;${dir}</td></tr>
    <tr><td>DIRECCI&Oacute;N REGIONAL DEL CONTRIBUYENTE</td><td>&nbsp;EJEMPLO</td></tr>
  </table></body></html>`;
}

test('separa calle, villa/poblacion, ciudad y comuna del domicilio del portal', () => {
  assert.deepEqual(SiiPortalAuth._separarDomicilio(DIR_LARGA), {
    direccion: 'AVENIDA DEL EJEMPLO 1078',
    villaPoblacion: 'VILLA LOS ALAMOS DE PRUEBA',
    ciudad: 'CIUDAD EJEMPLO',
    comuna: 'COMUNA EJEMPLO',
  });
});

test('la direccion separada cabe en DirOrigen (70) aunque el texto del portal no', () => {
  assert.ok(DIR_LARGA.length > 70, 'el caso de prueba debe superar el tope del XSD');
  assert.ok(SiiPortalAuth._separarDomicilio(DIR_LARGA).direccion.length <= 70);
});

test('un domicilio solo con comuna se separa como antes', () => {
  assert.deepEqual(SiiPortalAuth._separarDomicilio('AV. EJEMPLO 123, Comuna Santiago'), {
    direccion: 'AV. EJEMPLO 123', villaPoblacion: null, ciudad: null, comuna: 'Santiago',
  });
});

test('un domicilio sin etiquetas queda intacto', () => {
  assert.deepEqual(SiiPortalAuth._separarDomicilio('CALLE EJEMPLO 45'), {
    direccion: 'CALLE EJEMPLO 45', villaPoblacion: null, ciudad: null, comuna: null,
  });
});

test('tolera otro orden de las etiquetas y mayusculas distintas', () => {
  const r = SiiPortalAuth._separarDomicilio('CALLE EJEMPLO 45, ciudad CIUDAD EJEMPLO, VILLA/POB. POBLACION EJEMPLO, comuna COMUNA EJEMPLO');
  assert.equal(r.direccion, 'CALLE EJEMPLO 45');
  assert.equal(r.ciudad, 'CIUDAD EJEMPLO');
  assert.equal(r.villaPoblacion, 'POBLACION EJEMPLO');
  assert.equal(r.comuna, 'COMUNA EJEMPLO');
});

test('sin domicilio devuelve todo nulo, sin lanzar', () => {
  assert.deepEqual(SiiPortalAuth._separarDomicilio(null), { direccion: null, villaPoblacion: null, ciudad: null, comuna: null });
});

test('_parsearCeConsultaMuestra entrega las partes y conserva el texto original del portal', () => {
  const d = SiiPortalAuth._parsearCeConsultaMuestra(paginaConDireccion(DIR_LARGA));
  assert.equal(d.direccion, 'AVENIDA DEL EJEMPLO 1078');
  assert.equal(d.villaPoblacion, 'VILLA LOS ALAMOS DE PRUEBA');
  assert.equal(d.ciudad, 'CIUDAD EJEMPLO');
  assert.equal(d.comuna, 'COMUNA EJEMPLO');
  assert.equal(d.direccionPortal, DIR_LARGA);
});
