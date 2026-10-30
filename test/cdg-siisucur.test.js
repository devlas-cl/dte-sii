'use strict';

/**
 * CdgSIISucur (codigo de sucursal inscrito en el SII) en el emisor de DTE y boleta.
 * El SII lo acepta sin validarlo contra su registro (medido en certificacion el 2026-10-30), pero el esquema
 * exige un entero de hasta 9 digitos y el orden: en el DTE va tras el giro, telefono, correo y actividad y antes de
 * DirOrigen; en la boleta, tras GiroEmisor y antes de DirOrigen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmisor, buildEmisor, buildEmisorBoleta, validarEmisor } = require('../utils/emisor');

const DTE_BASE = { RUTEmisor: '76543210-3', RznSoc: 'EMPRESA EJEMPLO SPA', GiroEmis: 'Comercio', Acteco: 620100, DirOrigen: 'Calle 1', CmnaOrigen: 'Santiago' };
const BOLETA_BASE = { RUTEmisor: '76543210-3', RznSocEmisor: 'EMPRESA EJEMPLO SPA', GiroEmisor: 'Comercio', DirOrigen: 'Calle 1', CmnaOrigen: 'Santiago' };

test('DTE: CdgSIISucur se conserva y va justo antes de DirOrigen', () => {
  const e = normalizeEmisor({ ...DTE_BASE, CdgSIISucur: 91900002 }, false);
  assert.equal(e.CdgSIISucur, 91900002);
  const claves = Object.keys(e);
  assert.equal(claves.indexOf('CdgSIISucur') + 1, claves.indexOf('DirOrigen'));
});

test('boleta: CdgSIISucur va tras GiroEmisor y antes de DirOrigen', () => {
  const claves = Object.keys(normalizeEmisor({ ...BOLETA_BASE, CdgSIISucur: 91900002 }, true));
  assert.deepEqual(claves.slice(2, 5), ['GiroEmisor', 'CdgSIISucur', 'DirOrigen']);
});

test('sin codigo no se agrega el campo (comportamiento anterior)', () => {
  assert.equal('CdgSIISucur' in normalizeEmisor(DTE_BASE, false), false);
  assert.equal('CdgSIISucur' in normalizeEmisor(BOLETA_BASE, true), false);
});

test('buildEmisor y buildEmisorBoleta aceptan codigoSucursalSii', () => {
  const cfg = { rut: '76543210-3', razonSocial: 'EMPRESA EJEMPLO SPA', giro: 'Comercio', direccion: 'Calle 1', comuna: 'Santiago', codigoSucursalSii: 91900002 };
  assert.equal(buildEmisor(cfg).CdgSIISucur, 91900002);
  assert.equal(buildEmisorBoleta(cfg).CdgSIISucur, 91900002);
  assert.equal('CdgSIISucur' in buildEmisor({ ...cfg, codigoSucursalSii: undefined }), false);
});

test('validarEmisor rechaza codigos fuera de 1 a 999999999 o no enteros y acepta el codigo valido', () => {
  assert.equal(validarEmisor({ ...DTE_BASE, CdgSIISucur: 91900002 }).valid, true);
  for (const malo of [0, -5, 1.5, 1000000000, 'abc']) {
    const r = validarEmisor({ ...DTE_BASE, CdgSIISucur: malo });
    assert.equal(r.valid, false, String(malo));
    assert.match(r.errors.join(' '), /CdgSIISucur/);
  }
});
