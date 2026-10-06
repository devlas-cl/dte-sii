/**
 * Folios de un sobre que el SII rechazó entero vuelven a quedar disponibles.
 *
 * `_marcarCafsConsumidos` marca como consumido todo CAF que se intentó enviar. Si el SII
 * rechazó el sobre completo (carátula RCT, firma RFR, esquema RSC) no registró ningún
 * documento, y esos folios se pueden reenviar. `liberarFoliosDeSobresRechazados` consulta
 * el estado de los envíos y los quita del registro de usados. Un sobre recibido con
 * documentos rechazados (EPR) sí consume los folios y no se toca.
 *
 * Datos ficticios. Se ejecuta con `node test/liberar-folios-sobre-rechazado.test.js`,
 * sin red ni SII.
 */
const assert = require('assert');
const CertRunner = require('../cert/CertRunner');

const ted = (td, d, h) =>
  `<DTE><TED><DD><CAF version="1.0"><DA><RE>11111111-1</RE><RS>EMPRESA DE PRUEBA</RS><TD>${td}</TD><RNG><D>${d}</D><H>${h}</H></RNG></DA></CAF></DD></TED></DTE>`;

function runner(estados, registro) {
  const r = Object.create(CertRunner.prototype);
  const guardados = [];
  r.consultarEstadoEnvio = async (trackId) => (estados[trackId] ? { estado: estados[trackId] } : null);
  r._cargarFoliosUsados = async () => JSON.parse(JSON.stringify(registro));
  r._estado = () => ({ save: async (clave, valor) => guardados.push({ clave, valor }) });
  r._foliosUsadosClave = () => 'folios-usados-111111111';
  return { r, guardados };
}

async function main() {
  // ── rangosCafDelEnvio: tipo y rango, sin repetidos ────────────────────────
  assert.deepStrictEqual(
    CertRunner.rangosCafDelEnvio(ted(61, 1, 7) + ted(61, 1, 7) + ted(33, 1, 4)),
    [{ tipo: 61, desde: 1, hasta: 7 }, { tipo: 33, desde: 1, hasta: 4 }],
  );
  assert.deepStrictEqual(CertRunner.rangosCafDelEnvio(''), []);

  // ── Sobre rechazado por carátula: libera sus rangos ───────────────────────
  {
    const { r, guardados } = runner(
      { T1: 'RCT', T2: 'EPR' },
      { 61: [[1, 7], [8, 8]], 33: [[1, 4]], 52: [[1, 3]] },
    );
    const res = await r.liberarFoliosDeSobresRechazados([
      { trackId: 'T1', xml: ted(61, 1, 7) + ted(33, 1, 4) },
      { trackId: 'T2', xml: ted(52, 1, 3) },
    ]);
    assert.deepStrictEqual(res.liberados, ['61:1-7', '33:1-4']);
    assert.deepStrictEqual(res.rechazados, [{ trackId: 'T1', estado: 'RCT' }]);
    assert.deepStrictEqual(guardados, [{
      clave: 'folios-usados-111111111',
      valor: { 61: [[8, 8]], 33: [], 52: [[1, 3]] },
    }]);
  }

  // ── Firma y esquema también son rechazos de sobre ─────────────────────────
  for (const estado of ['RFR', 'RSC']) {
    const { r } = runner({ T: estado }, { 56: [[1, 4]] });
    const res = await r.liberarFoliosDeSobresRechazados([{ trackId: 'T', xml: ted(56, 1, 4) }]);
    assert.deepStrictEqual(res.liberados, ['56:1-4'], estado);
  }

  // ── Sobre recibido (EPR) o estado desconocido: no libera nada ─────────────
  {
    const { r, guardados } = runner({ T: 'EPR' }, { 61: [[1, 7]] });
    const res = await r.liberarFoliosDeSobresRechazados([{ trackId: 'T', xml: ted(61, 1, 7) }, { trackId: 'X', xml: ted(61, 1, 7) }]);
    assert.deepStrictEqual(res.liberados, []);
    assert.strictEqual(guardados.length, 0);
  }

  console.log('✓ liberar-folios-sobre-rechazado');
}

main().catch((e) => { console.error(e); process.exit(1); });
