'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { determinarIndTraslado } = require('../cert/SetParser');
const MuestrasImpresas = require('../cert/MuestrasImpresas');

// Tabla oficial (Manual de Muestras Impresas del SII, sección "Guía de Despacho
// Electrónica"): 1 Venta, 2 Ventas por efectuar, 3 Consignaciones, 4 Entrega gratuita,
// 5 Traslados internos, 6 Otros traslados no venta, 7 Devolución de mercaderías,
// 8 Traslado para exportación, 9 Venta para exportación.
//
// Antes `determinarIndTraslado` usaba otra numeración (consignación=2, entrega
// gratuita=3, devolución=6) que coincidía por casualidad con un comentario desactualizado
// de SetGuia.js, y solo no se había detectado porque en los sets reales observados el SII
// únicamente manda los motivos "VENTA" y "TRASLADO ... ENTRE BODEGAS" (códigos 1 y 5, que
// caían bien en cualquiera de las dos numeraciones).
test('determinarIndTraslado usa la tabla oficial del SII, no la vieja', () => {
  assert.equal(determinarIndTraslado('VENTA'), 1);
  assert.equal(determinarIndTraslado('VENTAS POR EFECTUAR'), 2);
  assert.equal(determinarIndTraslado('CONSIGNACION'), 3);
  assert.equal(determinarIndTraslado('ENTREGA GRATUITA'), 4);
  assert.equal(determinarIndTraslado('TRASLADO DE MATERIALES ENTRE BODEGAS DE LA EMPRESA'), 5);
  assert.equal(determinarIndTraslado('OTROS TRASLADOS QUE NO SON VENTA'), 6);
  assert.equal(determinarIndTraslado('DEVOLUCION DE MERCADERIAS'), 7);
  assert.equal(determinarIndTraslado('TRASLADO PARA EXPORTACION'), 8);
  assert.equal(determinarIndTraslado('VENTA PARA EXPORTACION'), 9);
});

test('determinarIndTraslado sin motivo cae en Venta (1), no en un código al azar', () => {
  assert.equal(determinarIndTraslado(null), 1);
  assert.equal(determinarIndTraslado(''), 1);
});

// Fixture sintética (repo público): documento de guía con el único campo que
// `_guiaEsVenta`/`_requiereCedible` miran.
const guia = (indTraslado) => ({ tipoDte: 52, indTraslado });
const factura = () => ({ tipoDte: 33 });
const nota = () => ({ tipoDte: 61 });

const muestras = new MuestrasImpresas({ emisor: { rut: '76543210-K', razonSocial: 'EMPRESA EJEMPLO SPA' } });

test('una guía solo lleva cedible si de verdad es venta (código 1 o 9)', () => {
  assert.equal(muestras._requiereCedible(guia(1)), true, 'Venta');
  assert.equal(muestras._requiereCedible(guia(9)), true, 'Venta para exportación');
  assert.equal(muestras._requiereCedible(guia(2)), false, 'Ventas por efectuar: la venta no ocurrió aún');
  assert.equal(muestras._requiereCedible(guia(3)), false, 'Consignación');
  assert.equal(muestras._requiereCedible(guia(4)), false, 'Entrega gratuita');
  assert.equal(muestras._requiereCedible(guia(5)), false, 'Traslado interno');
  assert.equal(muestras._requiereCedible(guia(6)), false, 'Otros traslados no venta');
  assert.equal(muestras._requiereCedible(guia(7)), false, 'Devolución');
  assert.equal(muestras._requiereCedible(guia(8)), false, 'Traslado para exportación (no venta)');
});

test('una guía sin indTraslado se trata como Venta, igual que hace SetGuia.js al construirla', () => {
  assert.equal(muestras._requiereCedible(guia(undefined)), true);
});

test('facturas y demás tipos cedibles no dependen de indTraslado', () => {
  assert.equal(muestras._requiereCedible(factura()), true);
});

test('_pdfNecesitaAcuse respeta la misma regla en el tipo que no es venta', () => {
  assert.equal(muestras._pdfNecesitaAcuse(guia(1), true), true);
  assert.equal(muestras._pdfNecesitaAcuse(guia(5), true), false);
  assert.equal(muestras._pdfNecesitaAcuse(nota(), true), false, 'nota de crédito nunca lleva acuse');
});
