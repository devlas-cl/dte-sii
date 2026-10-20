'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CertRunner = require('../cert/CertRunner');

// Corredor sin red: `solicitarCafs` solo habla con estos dobles. Datos inventados.
function corredor({ reob, pedir, anular, tope = null }) {
  const llamadas = [];
  const r = Object.create(CertRunner.prototype);
  // `folioHelper` y `folioService` son getters del prototipo: se pisan en la instancia.
  const fijar = (nombre, valor) => Object.defineProperty(r, nombre, { value: valor, configurable: true });
  fijar('folioHelper', { counters: new Map(), usedFolios: new Map() });
  fijar('folioService', {
    reobtenerCaf: async () => { llamadas.push('reobtener'); return reob(); },
    anularFolios: async () => { llamadas.push('anular'); return anular(); },
    listarCafs: () => [],
  });
  r._cafReusable = async () => null;
  r._consultarTopeCaf = async () => tope;
  r._pedirFolios = async () => { llamadas.push('pedir'); return pedir(); };
  r._rangoYaConsumido = () => false;
  r._folioLibreEnSii = async () => true;
  r._restringirCaf = () => {};
  r._cupoAlcanza = () => false;
  r._consultarTopeCaf = async () => tope;
  r.ambiente = 'certificacion';
  return { r, llamadas };
}

const BLOQUEO = { cafPaths: [], otorgados: 0, errorCode: 'PERSONA_CON_SITUACIONES_PENDIENTES', error: 'bloqueo', foliosDisp: null, maxAutor: null };

test('ante el bloqueo de la persona se reobtiene ANTES de anular, y si sirve no se anula', async () => {
  const { r, llamadas } = corredor({
    pedir: () => BLOQUEO,
    reob: () => ({ ok: true, cafPaths: ['/caf/33-1-3.xml'], reobtenidos: [] }),
    anular: () => ({ totalAnulados: 9 }),
  });
  const cafs = await r.solicitarCafs({ 33: 3 });
  assert.deepEqual(llamadas, ['pedir', 'reobtener']);
  assert.equal(cafs[33], '/caf/33-1-3.xml');
});

test('si la reobtención no sirve, se anula como último recurso y el error original sube', async () => {
  const { r, llamadas } = corredor({
    pedir: () => BLOQUEO,
    reob: () => ({ ok: false, motivo: 'bloqueado' }),
    anular: () => ({ totalAnulados: 0 }),
  });
  await assert.rejects(() => r.solicitarCafs({ 33: 3 }), /PERSONA_CON_SITUACIONES_PENDIENTES/);
  assert.deepEqual(llamadas, ['pedir', 'reobtener', 'anular']);
});

test('con un error que no es el bloqueo de la persona no se agrega la reobtención', async () => {
  const { r, llamadas } = corredor({
    pedir: () => ({ cafPaths: [], otorgados: 0, errorCode: 'UNKNOWN', error: 'x', foliosDisp: null }),
    reob: () => ({ ok: true, cafPaths: ['/caf/x.xml'], reobtenidos: [] }),
    anular: () => ({ totalAnulados: 0 }),
  });
  await assert.rejects(() => r.solicitarCafs({ 33: 3 }), /Folios insuficientes/);
  assert.deepEqual(llamadas, ['pedir']);
});

test('si el paso 2 ya intentó reobtener, no se repite', async () => {
  const { r, llamadas } = corredor({
    tope: { bloqueado: true, foliosDisp: null },
    pedir: () => BLOQUEO,
    reob: () => ({ ok: false, motivo: 'nada que reobtener' }),
    anular: () => ({ totalAnulados: 0 }),
  });
  await assert.rejects(() => r.solicitarCafs({ 33: 3 }), /Folios insuficientes/);
  assert.equal(llamadas.filter((x) => x === 'reobtener').length, 1);
});
