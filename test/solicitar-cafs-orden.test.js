/**
 * `CertRunner.solicitarCafs()`: orden de recursos al timbrar y tope fresco después de anular.
 *
 * Orden por tipo: reusar lo que hay en disco, reobtener del portal, pedir (de una o en
 * tandas) y anular solo como último recurso. Antes se anulaba primero y se decidía con el
 * tope de ANTES de anular. Caso real (2026-10-02, tipo 61, 7 folios): la limpieza dejó
 * FOLIOS_DISP en 0, la decisión siguió viendo FOLIOS_DISP=4, se pidieron los 7 de una y el
 * SII respondió MAX_AUTOR=4 < 7, cuando el mismo caso pasa en tandas.
 *
 * Se ejecuta con `node test/solicitar-cafs-orden.test.js`, sin red ni SII.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CertRunner = require('../cert/CertRunner');
const FolioService = require('../FolioService');

/**
 * Runner sin red. `topes` se consume en orden, uno por consulta; el resto se configura por
 * caso. `llamadas` registra el orden de los recursos usados.
 */
function runnerFalso({ topes = [], previo = null, reob = { ok: false, motivo: 'sin folios' }, tandas = [], exacto = null, anulados = 0, enDisco = [] }) {
  const runner = Object.create(CertRunner.prototype);
  const llamadas = [];
  const args = { tandas: [], exacto: [], anular: [] };
  let iTope = 0;
  let iTanda = 0;

  runner.ambiente = 'certificacion';
  runner._folioHelper = { counters: new Map(), usedFolios: new Map() };
  runner._cafReusable = async () => previo;
  runner._rangoYaConsumido = async () => false;
  // Las rutas falsas codifican su rango: "caf-<desde>-<hasta>".
  runner._rangoDelCaf = (p) => {
    const m = /caf-(\d+)-(\d+)/.exec(p);
    return m ? { tipo: 61, desde: Number(m[1]), hasta: Number(m[2]) } : null;
  };
  runner._folioService = {
    consultarTope: async () => { llamadas.push('tope'); return topes[Math.min(iTope++, topes.length - 1)]; },
    reobtenerCaf: async () => { llamadas.push('reobtener'); return reob; },
    solicitarCafPorTandas: async (a) => { llamadas.push('tandas'); args.tandas.push(a); return tandas[iTanda++]; },
    solicitarCafExacto: async (a) => { llamadas.push('exacto'); args.exacto.push(a); return exacto; },
    anularFolios: async (a) => { llamadas.push('anular'); args.anular.push(a); return { totalAnulados: anulados }; },
    listarCafs: () => enDisco,
  };
  return { runner, llamadas, args };
}

const ok = (desde, hasta) => ({ ok: true, cafPaths: [`caf-${desde}-${hasta}`], otorgados: hasta - desde + 1 });

async function casosSolicitarCafs() {
  // ── El caso real: cupo corto con FOLIOS_DISP>0 y la reobtención no sirve ──
  // Se pide en tandas antes de anular nada, con maxTandas dimensionado a la cantidad.
  {
    const { runner, llamadas, args } = runnerFalso({
      topes: [{ maxAutor: 1, foliosDisp: 4 }],
      tandas: [{ ok: true, cafPaths: ['caf-10-10', 'caf-11-11', 'caf-12-16'], otorgados: 7, maxAutor: 1, foliosDisp: 11 }],
    });
    const cafs = await runner.solicitarCafs({ 61: 7 });
    assert.deepStrictEqual(llamadas, ['tope', 'reobtener', 'tandas'], 'reobtener, después tandas, y no anula');
    assert.strictEqual(args.tandas[0].maxTandas, 7, 'maxTandas = folios que faltan, no el default 4');
    assert.strictEqual(args.tandas[0].cantidad, 7);
    assert.deepStrictEqual(cafs[61], ['caf-10-10', 'caf-11-11', 'caf-12-16']);
  }

  // ── Las tandas no alcanzan: anular es el último paso y se decide con tope fresco ──
  {
    const { runner, llamadas, args } = runnerFalso({
      topes: [{ maxAutor: 1, foliosDisp: 4 }, { maxAutor: 4, foliosDisp: 0 }],
      tandas: [
        { ok: false, cafPaths: ['caf-20-20', 'caf-21-21'], otorgados: 2, maxAutor: 0, foliosDisp: 6, errorCode: 'TOPE_SII_INSUFICIENTE' },
        ok(30, 34),
      ],
      anulados: 4,
      enDisco: ['caf-5-5'],
    });
    const cafs = await runner.solicitarCafs({ 61: 7 });
    assert.deepStrictEqual(llamadas, ['tope', 'reobtener', 'tandas', 'anular', 'tope', 'tandas']);
    assert.deepStrictEqual(
      args.anular[0].excluir.sort((a, b) => a[0] - b[0]),
      [[5, 5], [20, 20], [21, 21]],
      'no anula los CAF que están en disco ni los recién timbrados'
    );
    assert.strictEqual(args.anular[0].soloUltimosDias, 180, 'ventana de maullin');
    assert.deepStrictEqual(args.tandas[1].topeInicial, { maxAutor: 4, foliosDisp: 0 }, 'decide con el tope de DESPUÉS de anular');
    assert.strictEqual(args.tandas[1].cantidad, 5, 'pide solo lo que falta');
    assert.deepStrictEqual(cafs[61], ['caf-20-20', 'caf-21-21', 'caf-30-34']);
  }

  // ── FOLIOS_DISP=0: no hay nada que reobtener ni anular ─────────────────────
  {
    const { runner, llamadas } = runnerFalso({
      topes: [{ maxAutor: 3, foliosDisp: 0 }],
      tandas: [{ ok: false, cafPaths: [], otorgados: 0, maxAutor: 0, foliosDisp: 0, errorCode: 'TOPE_SII_INSUFICIENTE', error: 'x' }],
    });
    await assert.rejects(
      () => runner.solicitarCafs({ 33: 4 }),
      /Folios insuficientes para tipo 33: se requieren 4 y hay 0 \(MAX_AUTOR=0, FOLIOS_DISP=0\)/,
      'el mensaje conserva el formato que clasifican los consumidores'
    );
    assert.deepStrictEqual(llamadas, ['tope', 'tandas'], 'ni reobtiene ni anula');
  }

  // ── Folios sin usar que son solo los nuestros: tampoco anula ───────────────
  {
    const { runner, llamadas } = runnerFalso({
      topes: [{ maxAutor: 2, foliosDisp: 0 }],
      tandas: [{ ok: false, cafPaths: ['caf-1-2'], otorgados: 2, maxAutor: 0, foliosDisp: 2, errorCode: 'TOPE_SII_INSUFICIENTE' }],
    });
    await assert.rejects(() => runner.solicitarCafs({ 33: 4 }), /se requieren 4 y hay 2/);
    assert.ok(!llamadas.includes('anular'), 'FOLIOS_DISP solo cuenta lo que ya tenemos en mano');
  }

  // ── Cupo holgado: de una, sin permitir que FolioService anule por su cuenta ──
  {
    const { runner, llamadas, args } = runnerFalso({
      topes: [{ maxAutor: 19, foliosDisp: 2 }],
      exacto: { ok: true, cafPath: 'caf-40-46', otorgados: 7 },
    });
    const cafs = await runner.solicitarCafs({ 61: 7 });
    assert.deepStrictEqual(llamadas, ['tope', 'exacto'], 'con cupo holgado no reobtiene');
    assert.strictEqual(args.exacto[0].permitirAnular, false);
    assert.strictEqual(cafs[61], 'caf-40-46');
  }

  // ── El tope cambió entre el sondeo y el pedido: completa en tandas ─────────
  {
    const { runner, llamadas, args } = runnerFalso({
      topes: [{ maxAutor: 7, foliosDisp: 0 }],
      exacto: { ok: false, cafPath: null, otorgados: 0, maxAutor: 4, foliosDisp: 0, errorCode: 'MAX_AUTOR_INSUFICIENTE' },
      tandas: [ok(50, 56)],
    });
    await runner.solicitarCafs({ 61: 7 });
    assert.deepStrictEqual(llamadas, ['tope', 'exacto', 'tandas']);
    assert.strictEqual(args.tandas[0].topeInicial, null, 'las tandas consultan el tope del momento');
  }

  // ── CAF reusable en disco: ni siquiera consulta el tope ────────────────────
  {
    const { runner, llamadas } = runnerFalso({
      previo: { alcanza: true, path: 'caf-1-7', paths: ['caf-1-7'], desde: 1, hasta: 7, total: 7 },
    });
    const cafs = await runner.solicitarCafs({ 61: 7 });
    assert.deepStrictEqual(llamadas, []);
    assert.strictEqual(cafs[61], 'caf-1-7');
  }

  // ── Folios parciales en disco: cuentan, y se pide solo la diferencia ───────
  {
    const { runner, args } = runnerFalso({
      previo: { alcanza: false, path: 'caf-1-3', paths: ['caf-1-3'], desde: 1, hasta: 3, total: 3 },
      topes: [{ maxAutor: 3, foliosDisp: 0 }],
      exacto: { ok: true, cafPath: 'caf-9-9', otorgados: 1 },
    });
    const cafs = await runner.solicitarCafs({ 33: 4 });
    assert.strictEqual(args.exacto[0].cantidad, 1, 'con MAX_AUTOR=3 alcanza para el folio que falta');
    assert.deepStrictEqual(cafs[33], ['caf-1-3', 'caf-9-9'], 'los parciales van primero');
  }

  // ── Timbraje bloqueado: reobtener, y si no, anular y volver a mirar el tope ──
  {
    const { runner, llamadas } = runnerFalso({
      topes: [{ bloqueado: true, maxAutor: null, foliosDisp: null }, { maxAutor: 5, foliosDisp: 0 }],
      exacto: { ok: true, cafPath: 'caf-60-60', otorgados: 1 },
      anulados: 2,
    });
    const cafs = await runner.solicitarCafs({ 56: 1 });
    assert.deepStrictEqual(llamadas, ['tope', 'reobtener', 'anular', 'tope', 'exacto']);
    assert.strictEqual(cafs[56], 'caf-60-60');
  }

  // ── Anular no liberó nada: no se vuelve a pedir a ciegas ───────────────────
  {
    const { runner, llamadas } = runnerFalso({
      topes: [{ bloqueado: true, maxAutor: null, foliosDisp: null }],
      anulados: 0,
    });
    await assert.rejects(() => runner.solicitarCafs({ 56: 1 }), /\[TIMBRAJE_BLOQUEADO\]/);
    assert.deepStrictEqual(llamadas, ['tope', 'reobtener', 'anular']);
  }
}

async function casosExcluirAnulacion() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'anular-excluir-'));
  const svc = Object.create(FolioService.prototype);
  svc.debugDir = raiz;
  svc.rutEmisor = '76543210-3';
  svc._cargarAnulados = async () => new Set();
  svc._guardarAnulados = async () => {};
  svc.consultarFolios = async () => ({ ranges: [{ folioDesde: 10, folioHasta: 12, fecha: '01-10-2026' }] });
  svc.session = { getBaseHost: () => { throw new Error('TOCO_EL_SII'); } };

  // Excluido: ni se intenta.
  const r = await svc.anularFolios({ tipoDte: 61, excluir: [[11, 11]] });
  assert.strictEqual(r.totalAnulados, 0);

  // Sin excluir: sí se intenta (y el SII falso lo delata).
  await assert.rejects(() => svc.anularFolios({ tipoDte: 61 }), /TOCO_EL_SII/);
}

async function main() {
  await casosSolicitarCafs();
  await casosExcluirAnulacion();
  console.log('solicitar-cafs-orden: 12 casos OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
