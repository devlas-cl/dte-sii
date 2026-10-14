// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Una reobtención que cubre solo una parte devuelve igual lo que descargó.
 *
 * Caso real (14/10/2026, tipo 61): el set necesita 7 folios y el SII solo tenía 6
 * autorizados sin usar. La reobtención los descargó, dijo "no alcanza" y devolvió solo el
 * motivo; el llamador pidió los 7 de nuevo con el timbraje bloqueado. Ahora devuelve
 * `cafPaths` y `reobtenidos` para que el llamador los conserve y pida solo la diferencia.
 *
 * Se ejecuta con `node test/reobtener-parcial-conserva.test.js`, sin red ni SII.
 */

const assert = require('assert');
const FolioService = require('../FolioService');

(async () => {
  const fs_ = Object.create(FolioService.prototype);
  fs_.cafSolicitor = {
    listarReobtenibles: async () =>
      [1, 2, 3, 5, 9, 10, 11, 12, 13, 14].map((f) => ({ folioDesde: f, folioHasta: f, cantidad: 1 })),
    reobtenerCaf: async (_tipo, r) => ({
      success: true, cafPath: `/tmp/caf-${r.folioDesde}.xml`,
      folioDesde: r.folioDesde, folioHasta: r.folioHasta,
    }),
  };

  const r = await fs_.reobtenerCaf({
    tipoDte: 61, cantidad: 7,
    // El SII ya recibió 1, 2, 3 y 5: el portal los lista igual.
    folioLibre: async (f) => ![1, 2, 3, 5].includes(f),
  });
  assert.strictEqual(r.ok, false, 'con 6 de 7 no alcanza');
  assert.strictEqual(r.disponibles, 6);
  assert.strictEqual(r.cafPaths.length, 6, 'devuelve los 6 CAF descargados');
  assert.strictEqual(r.reobtenidos.length, 6);
  assert.deepStrictEqual(r.reobtenidos.flatMap((x) => x.libres), [9, 10, 11, 12, 13, 14]);
  assert.match(r.motivo, /se necesitan 7, hay 6/);
  console.log('✓ La reobtención parcial devuelve los CAF que sí descargó');

  // Sin nada que recuperar: listas vacías, sin romper al llamador.
  fs_.cafSolicitor.listarReobtenibles = async () => [];
  const vacio = await fs_.reobtenerCaf({ tipoDte: 61, cantidad: 7 });
  assert.strictEqual(vacio.ok, false);
  assert.ok(!vacio.cafPaths || vacio.cafPaths.length === 0);
  console.log('✓ Sin rangos reobtenibles no devuelve CAF');
})().catch((e) => { console.error(e); process.exit(1); });
