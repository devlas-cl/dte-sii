// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Puerto StateStore y su uso en FolioService (folios anulados) y CertRunner (período de
 * libros, totales LTC y folios usados).
 *
 * Lo que se garantiza, sin red ni SII:
 *  1. El puerto se valida y los adaptadores de memoria y archivo cumplen el contrato.
 *  2. REGRESIÓN: sin configurar nada se usan los mismos archivos de siempre, y lo que ya estaba
 *     guardado (sin sangría) se sigue leyendo.
 *  3. Con un StateStore compartido, dos "procesos" (dos directorios distintos) ven el mismo estado.
 *
 * Se ejecuta con `node test/state-store.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-estado-'));
const SiiPortalAuth = require('../SiiPortalAuth');
const { MemoryStateStore, FileStateStore, validarStateStore } = require('../SiiSessionPorts');
const FolioService = require('../FolioService');
const CertRunner = require('../cert/CertRunner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-estado-t-'));

function folioService(stateDir) {
  const f = Object.create(FolioService.prototype);
  f.stateDir = stateDir;
  f.rutEmisor = '77.111.222-3';
  f._estadoExplicito = null;
  return f;
}

function certRunner(stateDir) {
  const r = Object.create(CertRunner.prototype);
  r.stateDir = stateDir;
  r.config = { emisor: { rut: '77111222-3' } };
  return r;
}

(async () => {
  // ── 1. El puerto y los adaptadores ─────────────────────────────────────────
  assert.throws(() => validarStateStore({}), /debe implementar load, save y remove/);
  assert.throws(() => SiiPortalAuth.configurarSesion({ estado: { load() {} } }), /debe implementar/);

  const mem = new MemoryStateStore();
  assert.strictEqual(await mem.load('x'), null, 'una clave sin guardar da null');
  const original = { a: [1, 2] };
  await mem.save('x', original);
  original.a.push(3);
  assert.deepStrictEqual(await mem.load('x'), { a: [1, 2] }, 'se copia al guardar: no se filtra la mutación');
  (await mem.load('x')).a.push(9);
  assert.deepStrictEqual(await mem.load('x'), { a: [1, 2] }, 'y al leer');
  await mem.remove('x');
  assert.strictEqual(await mem.load('x'), null);

  const dir = tmp();
  const arch = new FileStateStore(dir);
  await arch.save('periodo-libros', { periodo: '2026-05' });
  assert.ok(fs.existsSync(path.join(dir, 'periodo-libros.json')), 'un archivo <clave>.json por documento');
  assert.deepStrictEqual(await arch.load('periodo-libros'), { periodo: '2026-05' });
  await arch.remove('periodo-libros');
  await arch.remove('periodo-libros'); // borrar lo que no existe no falla
  assert.strictEqual(await arch.load('periodo-libros'), null);
  await assert.rejects(() => arch.save('../fuera', {}), /clave inválida/, 'una clave no puede salirse del directorio');
  console.log('✓ Puerto: validación y adaptadores de memoria y archivo');

  // ── 2. REGRESIÓN: sin configurar nada, los mismos archivos de siempre ─────
  SiiPortalAuth.restablecerSesion();
  assert.strictEqual(SiiPortalAuth.estadoConfigurado(), null);

  const dirF = tmp();
  const f = folioService(dirF);
  // Lo que escribía la versión anterior: arreglo compacto, sin sangría.
  fs.writeFileSync(path.join(dirF, 'folios-anulados-771112223-61.json'), JSON.stringify(['1-5', '6-9']));
  assert.deepStrictEqual([...await f._cargarAnulados(61)], ['1-5', '6-9'], 'lo ya guardado se sigue leyendo');
  await f._guardarAnulados(61, new Set(['1-5', '6-9', '10-12']));
  const enDisco = JSON.parse(fs.readFileSync(path.join(dirF, 'folios-anulados-771112223-61.json'), 'utf8'));
  assert.deepStrictEqual(enDisco, ['1-5', '6-9', '10-12'], 'mismo nombre de archivo y mismo contenido');
  assert.deepStrictEqual([...await f._cargarAnulados(33)], [], 'otro tipo de DTE parte de cero');

  const dirC = tmp();
  const c = certRunner(dirC);
  fs.writeFileSync(path.join(dirC, 'periodo-libros.json'), JSON.stringify({ periodo: '2026-03', lastRun: 'x' }));
  assert.strictEqual(await c._getPeriodoLibros(), '2026-03', 'el período guardado antes se sigue leyendo');
  assert.strictEqual(await c._decrementarPeriodoLibros(), '2026-02');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dirC, 'periodo-libros.json'), 'utf8')).periodo, '2026-02');
  await c._guardarLtcTotales('2026-02', 'VENTA', [{ TpoDoc: 33 }]);
  assert.deepStrictEqual(await c._leerLtcTotales('2026-02', 'VENTA'), [{ TpoDoc: 33 }]);
  assert.ok(fs.existsSync(path.join(dirC, 'ltc-totales.json')));
  console.log('✓ Regresión: sin configurar nada se usan los mismos archivos y se lee lo ya guardado');

  // ── 3. Dos "procesos" comparten estado por un StateStore ──────────────────
  const compartido = new MemoryStateStore();
  SiiPortalAuth.configurarSesion({ estado: compartido });
  assert.strictEqual(SiiPortalAuth.estadoConfigurado(), compartido);

  const fA = folioService(tmp());
  const fB = folioService(tmp()); // otro directorio: si compartieran archivo no verían nada
  await fA._guardarAnulados(61, new Set(['20-24']));
  assert.deepStrictEqual([...await fB._cargarAnulados(61)], ['20-24'], 'los anulados se ven entre réplicas');

  const cA = certRunner(tmp());
  const cB = certRunner(tmp());
  await cA.resetPeriodoLibros('2026-04');
  assert.strictEqual(await cB._getPeriodoLibros(), '2026-04', 'el período de libros se ve entre réplicas');
  await cB._decrementarPeriodoLibros();
  assert.strictEqual(await cA._getPeriodoLibros(), '2026-03', 'y el avance de una lo ve la otra');

  await cA._estado().save(cA._foliosUsadosClave(), { 33: [[100, 110]] });
  assert.strictEqual(await cB._rangoYaConsumido(33, 105, 108), true, 'folios usados: se ven entre réplicas');
  assert.strictEqual(await cB._rangoYaConsumido(33, 200, 210), false);

  // Un `estado` explícito gana sobre el configurado.
  const propio = new MemoryStateStore();
  const fC = folioService(tmp());
  fC._estadoExplicito = propio;
  await fC._guardarAnulados(61, new Set(['99-99']));
  assert.deepStrictEqual(await propio.load('folios-anulados-771112223-61'), ['99-99']);
  assert.deepStrictEqual([...await fB._cargarAnulados(61)], ['20-24'], 'sin tocar el configurado');

  SiiPortalAuth.restablecerSesion();
  assert.strictEqual(SiiPortalAuth.estadoConfigurado(), null, 'restablecerSesion vuelve a los archivos');
  console.log('✓ Dos réplicas comparten anulados, período de libros y folios usados');

  // ── 4. reobtenerCaf acepta un yaEmitido asíncrono ─────────────────────────
  const svc = Object.create(FolioService.prototype);
  const pedidos = [];
  svc.cafSolicitor = {
    listarReobtenibles: async () => ([
      { folioDesde: 1, folioHasta: 3, cantidad: 3, anulado: false },
      { folioDesde: 4, folioHasta: 6, cantidad: 3, anulado: false },
    ]),
    reobtenerCaf: async (_tipo, rango) => { pedidos.push(`${rango.folioDesde}-${rango.folioHasta}`); return { success: true, cafPath: '/tmp/x.xml', folioDesde: rango.folioDesde, folioHasta: rango.folioHasta }; },
  };
  const r = await svc.reobtenerCaf({ tipoDte: 61, cantidad: 3, yaEmitido: async ({ folioDesde }) => folioDesde === 1 });
  assert.strictEqual(r.ok, true, 'descarta el rango emitido (asíncrono) y reobtiene el otro');
  assert.deepStrictEqual(pedidos, ['4-6'], 'solo se reobtiene el que no estaba emitido');
  console.log('✓ reobtenerCaf: yaEmitido puede ser asíncrono');

  console.log('\nstate-store OK');
})().catch((e) => { console.error(e); process.exit(1); });
