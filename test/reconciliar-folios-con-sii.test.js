// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * El registro local de folios usados se compara con el SII antes de reutilizar un folio.
 *
 * Caso real (14/10/2026, certificación de un comercio nuevo): un set quedó EPR (procesado)
 * con sus 8 documentos rechazados. Sus folios 61 y 56 quedaron libres en el SII, pero el
 * registro los daba por consumidos y la corrida no los reutilizó, así que el bloqueo de
 * timbraje no se levantó nunca. Además, las facturas 33 salieron con folios de un CAF
 * restaurado de la base que el SII ya había recibido (o anulado), y el set cayó entero.
 *
 * Se ejecuta con `node test/reconciliar-folios-con-sii.test.js`, sin red ni SII.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CertRunner = require('../cert/CertRunner');

const estUp = (bloques) =>
  '<SII:RESPUESTA><SII:RESP_BODY>' +
  bloques.map(([t, i, a, r]) =>
    `<TIPO_DOCTO>${t}</TIPO_DOCTO><INFORMADOS>${i}</INFORMADOS><ACEPTADOS>${a}</ACEPTADOS>` +
    `<RECHAZADOS>${r}</RECHAZADOS><REPAROS>0</REPAROS>`).join('') +
  '</SII:RESP_BODY></SII:RESPUESTA>';

const dte = (tipo, folio) =>
  `<DTE><Documento><Encabezado><IdDoc><TipoDTE>${tipo}</TipoDTE><Folio>${folio}</Folio></IdDoc></Encabezado></Documento></DTE>`;

async function main() {
  // ── Contadores del envío: suma todos los tipos, con o sin escapar ─────────
  {
    const x = estUp([[33, 4, 0, 4], [56, 1, 0, 1], [61, 3, 0, 3]]);
    assert.deepStrictEqual(CertRunner.resultadoDeEnvio(x), { informados: 8, aceptados: 0, rechazados: 8, reparos: 0 });
    const escapado = x.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.strictEqual(CertRunner.resultadoDeEnvio(escapado).rechazados, 8);
    assert.deepStrictEqual(CertRunner.resultadoDeEnvio(''), { informados: 0, aceptados: 0, rechazados: 0, reparos: 0 });
    assert.deepStrictEqual(
      CertRunner.resultadoDeEnvio(estUp([[52, 3, 3, 0]])),
      { informados: 3, aceptados: 3, rechazados: 0, reparos: 0 },
    );
  }

  // ── Folios de un sobre y quitar folios de rangos ──────────────────────────
  assert.deepStrictEqual(
    CertRunner.foliosDelEnvio(dte(61, 9) + dte(61, 9) + dte(33, 77)),
    [{ tipo: 61, folio: 9 }, { tipo: 33, folio: 77 }],
  );
  assert.deepStrictEqual(CertRunner.quitarFolios([[9, 14]], [9, 10, 11]), [[12, 14]]);
  assert.deepStrictEqual(CertRunner.quitarFolios([[77, 82]], [78, 79]), [[77, 77], [80, 82]]);
  assert.deepStrictEqual(CertRunner.quitarFolios([[7, 8], [9, 9]], [7]), [[8, 8], [9, 9]]);
  assert.deepStrictEqual(CertRunner.quitarFolios([[5, 5]], [5]), []);

  // ── Un sobre EPR con documentos rechazados libera solo los folios que el SII no recibió ──
  {
    const r = Object.create(CertRunner.prototype);
    const guardados = [];
    r.consultarEstadoEnvio = async () => ({ estado: 'EPR', xmlRaw: estUp([[61, 3, 0, 3], [33, 2, 0, 2]]) });
    r._cargarFoliosUsados = async () => ({ 61: [[9, 14]], 33: [[77, 82]], 52: [[62, 64]] });
    r._estado = () => ({ save: async (clave, valor) => guardados.push({ clave, valor }) });
    r._foliosUsadosClave = () => 'folios-usados-777777776';
    // SII: 61 folios 9 y 10 libres (FAU), el 11 sin poder saberse; 33 folio 77 recibido, 80 libre.
    const sii = { '61:9': false, '61:10': false, '61:11': null, '33:77': true, '33:80': false };
    r._folioRecibidoEnSii = async (tipo, folio) => sii[`${tipo}:${folio}`] ?? null;

    const res = await r.liberarFoliosDeSobresRechazados([
      { trackId: 'T', xml: dte(61, 9) + dte(61, 10) + dte(61, 11) + dte(33, 77) + dte(33, 80) },
    ]);
    assert.deepStrictEqual(res.liberados.sort(), ['33:80', '61:10', '61:9']);
    assert.deepStrictEqual(res.rechazados, [{ trackId: 'T', estado: 'EPR', documentos: 5 }]);
    assert.deepStrictEqual(guardados[0].valor, {
      61: [[11, 14]],
      33: [[77, 79], [81, 82]],
      52: [[62, 64]],
    }, 'solo sale del registro lo que el SII confirmó libre; "recibido" y "no sé" se quedan');
  }

  // ── Un sobre EPR sin documentos rechazados no toca nada ───────────────────
  {
    const r = Object.create(CertRunner.prototype);
    let consultas = 0;
    r.consultarEstadoEnvio = async () => ({ estado: 'EPR', xmlRaw: estUp([[52, 3, 3, 0]]) });
    r._cargarFoliosUsados = async () => ({ 52: [[62, 64]] });
    r._estado = () => ({ save: async () => { throw new Error('no debe guardar'); } });
    r._folioRecibidoEnSii = async () => { consultas++; return false; };
    const res = await r.liberarFoliosDeSobresRechazados([{ trackId: 'T', xml: dte(52, 62) }]);
    assert.deepStrictEqual(res.liberados, []);
    assert.strictEqual(consultas, 0, 'ni siquiera consulta al SII');
  }

  // ── CAF en disco: se saltan los folios que el SII ya recibió ──────────────
  {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciliar-'));
    const sk = crypto.generateKeyPairSync('rsa', {
      modulusLength: 512,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
    const cafXml = (d, h) =>
      '<AUTORIZACION><CAF><DA><RE>77111222-3</RE><TD>33</TD>' +
      `<RNG><D>${d}</D><H>${h}</H></RNG></DA></CAF><RSASK>${sk}</RSASK></AUTORIZACION>`;
    const dir = path.join(raiz, 'auto-caf', '77111222-3', 'ts', '33');
    fs.mkdirSync(dir, { recursive: true });
    const viejo = path.join(dir, 'caf-33-77-82.xml');
    const nuevo = path.join(dir, 'caf-33-88-97.xml');
    fs.writeFileSync(viejo, cafXml(77, 82));
    fs.writeFileSync(nuevo, cafXml(88, 97));

    const armar = (sii) => {
      const runner = Object.create(CertRunner.prototype);
      runner.stateDir = raiz;
      runner.config = { emisor: { rut: '77111222-3' } };
      runner.folioHelper = { usedFolios: new Map(), restringirFolios: () => {} };
      Object.defineProperty(runner, 'folioService', {
        value: { listarCafs: () => [nuevo, viejo] },
        configurable: true,
      });
      runner._folioRecibidoEnSii = async (_tipo, folio) => sii(folio);
      return runner;
    };

    // Caso real: 77 a 79 recibidos, 80 a 82 anulados (el SII los reporta como no libres).
    const r1 = armar((f) => (f >= 77 && f <= 79 ? true : f >= 80 && f <= 87 ? true : f === 88 || (f >= 90 && f <= 94) ? true : false));
    const uso = await r1._cafReusable(33, 4);
    assert.ok(uso, 'el CAF 88-97 aporta sus folios libres');
    assert.deepStrictEqual(r1._foliosLibresDeCaf(nuevo), [89, 95, 96, 97], 'solo los que el SII no recibió');
    assert.strictEqual(uso.alcanza, true);
    assert.deepStrictEqual(uso.paths, [nuevo], 'el CAF viejo, sin folios libres, no se usa');

    // Si no se puede saber (null), se conserva el comportamiento anterior: se usan todos.
    fs.rmSync(`${nuevo}.libres.json`, { force: true });
    fs.rmSync(`${viejo}.libres.json`, { force: true });
    const r2 = armar(() => null);
    const sinDato = await r2._cafReusable(33, 4);
    assert.strictEqual(sinDato.alcanza, true);
    assert.strictEqual(r2._foliosLibresDeCaf(viejo), null, 'sin dato del SII no se restringe nada');

    fs.rmSync(raiz, { recursive: true, force: true });
  }

  console.log('✓ reconciliar-folios-con-sii');
}

main().catch((e) => { console.error(e); process.exit(1); });
