'use strict';

/**
 * La tabla "DIRECCION SUCURSALES" de ce_consulta_muestra_e: codigo (hasta 9 digitos), tipo y direccion. Son las sucursales
 * inscritas en Mi SII; el codigo es el que va en CdgSIISucur. Los codigos de actividad economica tambien son filas de tres
 * celdas y no deben contarse como sucursales.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const SiiPortalAuth = require('../SiiPortalAuth');

const pagina = (sucursales) => `
<table><tr><td>DATOS DEL CONTRIBUYENTE RUT</td><td>12345678-9</td></tr>
<tr><td>NOMBRE O RAZ&Oacute;N SOCIAL</td><td>EMPRESA EJEMPLO SPA</td></tr>
<tr><td>DIRECCI&Oacute;N DE LA EMPRESA</td><td>CALLE FALSA 123, Comuna Santiago</td></tr></table>
<table><tr><td>DIRECCI&Oacute;N SUCURSALES:</td></tr></table>
<table><tr><td>C&oacute;digo</td><td>Tipo de Direcci&oacute;n</td><td>Direcci&oacute;n</td></tr>${sucursales}</table>
<table><tr><td>ACTIVIDADES ECON&Oacute;MICAS</td></tr>
<tr><td>620100</td><td>ACTIVIDADES DE PROGRAMACION</td><td>SI</td></tr></table>`;

test('lee las sucursales con codigo entero, sin contar las actividades', () => {
  const d = SiiPortalAuth._parsearCeConsultaMuestra(pagina(`
    <tr><td>000000123</td><td>Sucursal</td><td>AVENIDA EJEMPLO 456, Depto. 12, Comuna Providencia</td></tr>
    <tr><td>091900007</td><td>Sucursal</td><td>CALLE MUESTRA 88, Comuna Nunoa</td></tr>`));
  assert.deepEqual(d.sucursales, [
    { codigo: 123, tipo: 'Sucursal', direccion: 'AVENIDA EJEMPLO 456, Depto. 12, Comuna Providencia' },
    { codigo: 91900007, tipo: 'Sucursal', direccion: 'CALLE MUESTRA 88, Comuna Nunoa' },
  ]);
  assert.equal(d.acteco, '620100');
});

test('sin sucursales inscritas devuelve una lista vacia', () => {
  assert.deepEqual(SiiPortalAuth._parsearCeConsultaMuestra(pagina('')).sucursales, []);
});

test('una pagina sin la seccion de sucursales tambien devuelve lista vacia', () => {
  assert.deepEqual(SiiPortalAuth._parsearCeConsultaMuestra('<table><tr><td>DATOS DEL CONTRIBUYENTE RUT</td><td>1-9</td></tr></table>').sucursales, []);
});
