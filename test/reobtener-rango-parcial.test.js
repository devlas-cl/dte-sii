// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Un rango reobtenible con folios ya recibidos se usa igual, saltando esos folios.
 *
 * Antes, un solo folio recibido descartaba el rango entero. El contribuyente que viene
 * de otro software tiene justamente eso: un rango viejo grande con los primeros folios
 * emitidos. Se botaba completo, la corrida pedía folios de a uno (el SII raciona porque
 * ve el rango viejo disponible) y terminaba con el timbraje bloqueado.
 *
 * Se ejecuta con `node test/reobtener-rango-parcial.test.js`, sin red ni SII.
 */

const assert = require('assert');
const FolioService = require('../FolioService');
const CertFolioHelper = require('../cert/CertFolioHelper');

async function reobtenerCon({ rangos, recibidos, cantidad }) {
  const fs_ = Object.create(FolioService.prototype);
  const descargados = [];
  fs_.cafSolicitor = {
    listarReobtenibles: async () => rangos,
    reobtenerCaf: async (_tipo, r) => {
      descargados.push(r);
      return { success: true, cafPath: `/tmp/caf-${r.folioDesde}-${r.folioHasta}.xml`,
        folioDesde: r.folioDesde, folioHasta: r.folioHasta };
    },
  };
  const consultados = [];
  const r = await fs_.reobtenerCaf({
    tipoDte: 61,
    cantidad,
    folioLibre: async (f) => { consultados.push(f); return !recibidos.includes(f); },
  });
  return { r, descargados, consultados };
}

(async () => {
  // ── 1. Folios recibidos dentro del rango se saltan, el rango sirve ──────────
  {
    const { r, descargados, consultados } = await reobtenerCon({
      rangos: [{ folioDesde: 1, folioHasta: 100, cantidad: 100 }],
      recibidos: [4],
      cantidad: 7,
    });
    assert.strictEqual(r.ok, true, 'el rango con un folio recibido igual alcanza');
    assert.deepStrictEqual(r.reobtenidos[0].libres, [1, 2, 3, 5, 6, 7, 8], 'se salta el 4');
    assert.strictEqual(descargados.length, 1, 'se reobtiene una sola vez');
    assert.deepStrictEqual(consultados, [1, 2, 3, 4, 5, 6, 7, 8], 'solo se consulta hasta cubrir');
    console.log('✓ Un rango con folios recibidos se usa saltando esos folios');
  }

  // ── 2. Tope de consultas: un rango casi todo usado no se recorre entero ─────
  {
    const recibidos = Array.from({ length: 100 }, (_, i) => i + 1);
    const { r, consultados } = await reobtenerCon({
      rangos: [{ folioDesde: 1, folioHasta: 100, cantidad: 100 }],
      recibidos,
      cantidad: 3,
    });
    assert.strictEqual(r.ok, false, 'sin folios libres no hay reobtención');
    assert.ok(consultados.length <= 30, `consultas acotadas (${consultados.length})`);
    console.log('✓ El tope de consultas evita recorrer un rango viejo entero');
  }

  // ── 3. El helper solo entrega los folios permitidos de un CAF restringido ───
  {
    const h = new CertFolioHelper();
    h.restringirFolios({ tipoDte: 61, folioDesde: 1, folioHasta: 100, folios: [1, 2, 3, 5, 6] });
    const tomados = [];
    for (let i = 0; i < 5; i++) tomados.push(h.reserveNextFolio({ tipoDte: 61, folioDesde: 1, folioHasta: 100 }));
    assert.deepStrictEqual(tomados, [1, 2, 3, 5, 6], 'nunca entrega el 4');
    assert.throws(
      () => h.reserveNextFolio({ tipoDte: 61, folioDesde: 1, folioHasta: 100 }),
      /No hay más folios disponibles/,
      'agotados los permitidos, el CAF se da por agotado',
    );
    // Un CAF sin restricción sigue igual.
    assert.strictEqual(h.reserveNextFolio({ tipoDte: 33, folioDesde: 10, folioHasta: 12 }), 10);
    console.log('✓ CertFolioHelper respeta los folios permitidos de un CAF');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
