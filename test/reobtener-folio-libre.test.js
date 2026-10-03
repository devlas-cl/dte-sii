/**
 * Reobtención: no reusar folios que el SII ya recibió.
 *
 * El portal de reobtención lista rangos ya emitidos (verificado en maullin, 2026-10-02:
 * folios 1 y 2 de tipo 56 timbrados en marzo aparecían reobtenibles, se usaron de nuevo y
 * el SII rechazó los documentos). `reobtenerCaf` consulta al SII solo los folios de los
 * rangos que va a usar y descarta los ya recibidos.
 *
 * Se ejecuta con `node test/reobtener-folio-libre.test.js`, sin red ni SII.
 */
const assert = require('assert');
const FolioService = require('../FolioService');
const EnviadorSII = require('../EnviadorSII');

function servicio(rangos) {
  const svc = Object.create(FolioService.prototype);
  const reobtenidos = [];
  svc.cafSolicitor = {
    listarReobtenibles: async () => rangos.map((r) => ({ ...r, cantidad: r.folioHasta - r.folioDesde + 1 })),
    reobtenerCaf: async (_t, r) => { reobtenidos.push(`${r.folioDesde}-${r.folioHasta}`); return { success: true, cafPath: `caf-${r.folioDesde}`, folioDesde: r.folioDesde, folioHasta: r.folioHasta }; },
  };
  return { svc, reobtenidos };
}

async function main() {
  // ── Descarta los ya recibidos y consulta solo lo que va a usar ──────────────
  {
    const { svc, reobtenidos } = servicio([
      { folioDesde: 1, folioHasta: 1 }, { folioDesde: 2, folioHasta: 2 },
      { folioDesde: 7, folioHasta: 10 }, { folioDesde: 20, folioHasta: 25 },
    ]);
    const consultados = [];
    const r = await svc.reobtenerCaf({
      tipoDte: 56, cantidad: 4,
      folioLibre: async (f) => { consultados.push(f); return f >= 7; },
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(reobtenidos, ['7-10'], 'no reobtiene 1 ni 2');
    assert.deepStrictEqual(consultados, [1, 2, 7, 8, 9, 10], 'no consulta el rango 20-25, que no hace falta');
  }

  // ── No se pudo verificar: no se usa ─────────────────────────────────────────
  {
    const { svc, reobtenidos } = servicio([{ folioDesde: 1, folioHasta: 1 }]);
    const r = await svc.reobtenerCaf({ tipoDte: 56, cantidad: 1, folioLibre: async () => null });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /descartado\(s\) por ya recibidos/);
    assert.deepStrictEqual(reobtenidos, []);
  }

  // ── Sin folioLibre se comporta como antes ───────────────────────────────────
  {
    const { svc, reobtenidos } = servicio([{ folioDesde: 1, folioHasta: 2 }]);
    const r = await svc.reobtenerCaf({ tipoDte: 56, cantidad: 2 });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(reobtenidos, ['1-2']);
  }

  // ── folioRecibido: interpreta la respuesta de QueryEstDte ───────────────────
  const resp = (estado, glosa) => ({ ok: true, text: `&lt;ESTADO&gt;${estado}&lt;/ESTADO&gt;&lt;GLOSA_ESTADO&gt;${glosa}&lt;/GLOSA_ESTADO&gt;` });
  const enviador = (respuestas) => {
    const e = Object.create(EnviadorSII.prototype);
    e.ambiente = 'certificacion'; e.tokenSoap = 'T';
    let i = 0; e._siiPost = async () => respuestas[Math.min(i++, respuestas.length - 1)];
    return e;
  };
  assert.deepStrictEqual(
    (await enviador([resp('FAU', 'DTE No Recibido')]).folioRecibido('76543210-3', 56, 9)).recibido, false, 'FAU = libre');
  assert.strictEqual(
    (await enviador([resp('DNK', 'DTE Recibido')]).folioRecibido('76543210-3', 56, 1)).recibido, true, 'DNK = ya usado');
  assert.strictEqual(
    (await enviador([{ ok: false, status: 503 }]).folioRecibido('76543210-3', 56, 1, { reintentos: 0 })).recibido, null, 'sin respuesta = no se sabe');
  assert.strictEqual(
    (await enviador([{ ok: false, status: 503 }, resp('FAU', 'DTE No Recibido')]).folioRecibido('76543210-3', 56, 9, { reintentos: 1 })).recibido, false, 'reintenta un 503');

  console.log('reobtener-folio-libre: 7 casos OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
