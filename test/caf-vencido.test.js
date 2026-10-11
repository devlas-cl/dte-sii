// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Un CAF autorizado hace más de 6 meses (tipos 33, 46, 56 y 61) no se usa.
 *
 * El SII rechaza cada DTE timbrado con él al recibirlo: `(CAF-3-517) RECHAZO- CAF
 * Vencido`. Caso real (07/10/2026, certificación): al faltar 2 folios 61, la reobtención
 * trajo un rango 1-30 autorizado el 2024-12-03 y la corrida lo usó. Los 7 DTE 61 del set
 * salieron rechazados, y las notas de débito que los referencian también (REF-3-750).
 *
 * Se ejecuta con `node test/caf-vencido.test.js`, sin red ni SII.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CAF = require('../CAF');
const FolioService = require('../FolioService');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-vencido-'));
const xml = (td, d, h, fa) =>
  `<AUTORIZACION><CAF version="1.0"><DA><RE>76543210-K</RE><TD>${td}</TD>` +
  `<RNG><D>${d}</D><H>${h}</H></RNG><FA>${fa}</FA></DA></CAF></AUTORIZACION>`;

(async () => {
  const hoy = new Date('2026-10-07T18:35:00Z');

  // ── 1. Vencimiento: FA + 6 meses, solo tipos que vencen ─────────────────────
  {
    assert.strictEqual(CAF.vencidoDesdeXml(xml(61, 1, 30, '2024-12-03'), hoy), '2024-12-03');
    assert.strictEqual(CAF.vencidoDesdeXml(xml(61, 31, 31, '2026-10-07'), hoy), null);
    assert.strictEqual(CAF.vencidoDesdeXml(xml(33, 1, 4, '2026-04-07'), hoy), '2026-04-07',
      'justo 6 meses: dentro del margen de un día');
    assert.strictEqual(CAF.vencidoDesdeXml(xml(33, 1, 4, '2026-04-09'), hoy), null);
    assert.strictEqual(CAF.vencidoDesdeXml(xml(52, 1, 3, '2020-01-01'), hoy), null, 'guías no vencen');
    assert.strictEqual(CAF.vencidoDesdeXml(xml(39, 1, 3, '2020-01-01'), hoy), null, 'boletas no vencen');
    assert.strictEqual(CAF.vencidoDesdeXml('<no-es-caf/>', hoy), null);
    console.log('✓ Un CAF vence a los 6 meses de autorizado, solo en los tipos que vencen');
  }

  // ── 2. La reobtención descarta un CAF vencido y lo informa ──────────────────
  {
    const svc = Object.create(FolioService.prototype);
    const archivos = {
      '1-30': xml(61, 1, 30, '2024-12-03'),
      '31-35': xml(61, 31, 35, new Date().toISOString().slice(0, 10)),
    };
    svc.cafSolicitor = {
      listarReobtenibles: async () => [
        { folioDesde: 1, folioHasta: 30, cantidad: 30 },
        { folioDesde: 31, folioHasta: 35, cantidad: 5 },
      ],
      reobtenerCaf: async (_tipo, r) => {
        const p = path.join(raiz, `caf-${r.folioDesde}-${r.folioHasta}.xml`);
        fs.writeFileSync(p, archivos[`${r.folioDesde}-${r.folioHasta}`]);
        return { success: true, cafPath: p, folioDesde: r.folioDesde, folioHasta: r.folioHasta };
      },
    };

    const r = await svc.reobtenerCaf({ tipoDte: 61, cantidad: 7 });
    assert.strictEqual(r.ok, false, 'el rango vencido no cuenta para cubrir la corrida');
    assert.deepStrictEqual(r.vencidos, [{ folioDesde: 1, folioHasta: 30, autorizado: '2024-12-03' }]);
    assert.match(r.motivo, /1 rango\(s\) vencido\(s\) descartado\(s\)/);

    const r2 = await svc.reobtenerCaf({ tipoDte: 61, cantidad: 5 });
    assert.strictEqual(r2.ok, true, 'con el rango vigente alcanza');
    assert.deepStrictEqual(r2.reobtenidos.map(x => `${x.folioDesde}-${x.folioHasta}`), ['31-35']);
    assert.ok(!r2.cafPaths.some(p => p.includes('caf-1-30')), 'el vencido nunca vuelve en cafPaths');
    console.log('✓ La reobtención descarta el CAF vencido y lo informa en `vencidos`');
  }

  fs.rmSync(raiz, { recursive: true, force: true });
  console.log('\nOK caf-vencido');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
