// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * assertLargoMaximo + su uso en NmbItem (DTE.js).
 *
 * Caso real medido el 2026-09-01: un producto con una sola presentación nombrada igual a
 * él mismo terminó con "NmbItem" de 83 caracteres — el XSD admite 80 — y el SII rechazó
 * el sobre completo, arrastrando 2 boletas válidas. Este test verifica que la librería
 * ahora lanza ANTES de firmar, con el campo y el valor, en vez de dejar que el SII lo
 * descubra tres pasos después.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLargoMaximo } = require('../utils/sanitize');
const DTE = require('../DTE');

const NOMBRE_83 = 'MARMITA PORTACOLACION PLUMAVIT TERMO ECO - MARMITA PORTACOLACION PLUMAVIT TERMO ECO';
assert.equal(NOMBRE_83.length, 83);

test('assertLargoMaximo no lanza dentro del límite', () => {
  assert.doesNotThrow(() => assertLargoMaximo('x'.repeat(80), 80, 'NmbItem'));
});

test('assertLargoMaximo lanza al superar el límite, con campo y valor en el mensaje', () => {
  assert.throws(
    () => assertLargoMaximo(NOMBRE_83, 80, 'NmbItem'),
    (err) => {
      assert.match(err.message, /NmbItem/);
      assert.match(err.message, /80/);
      assert.match(err.message, /83/);
      assert.match(err.message, /MARMITA/);
      return true;
    },
  );
});

test('DTE con NmbItem de 83 caracteres lanza al construir, no llega a firmar', () => {
  const datos = {
    tipo: 39,
    folio: 1,
    fechaEmision: '2026-09-01',
    emisor: { rut: '76543210-3', razonSocial: 'EMPRESA EJEMPLO SPA', giro: 'Comercio', direccion: 'Calle Falsa 123', comuna: 'Santiago' },
    receptor: { RUTRecep: '66666666-6' },
    items: [{ NmbItem: NOMBRE_83, QtyItem: 1, PrcItem: 1000 }],
  };
  assert.throws(() => new DTE(datos), /NmbItem/);
});

test('DTE con NmbItem de 80 caracteres exactos no lanza por largo', () => {
  const datos = {
    tipo: 39,
    folio: 1,
    fechaEmision: '2026-09-01',
    emisor: { rut: '76543210-3', razonSocial: 'EMPRESA EJEMPLO SPA', giro: 'Comercio', direccion: 'Calle Falsa 123', comuna: 'Santiago' },
    receptor: { RUTRecep: '66666666-6' },
    items: [{ NmbItem: 'x'.repeat(80), QtyItem: 1, PrcItem: 1000 }],
  };
  assert.doesNotThrow(() => new DTE(datos));
});
