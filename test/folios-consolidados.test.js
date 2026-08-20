// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Verifica la invariante que hace seguro el timbrado consolidado de
 * `CertRunner.precargarCafsDeSets()`: con UN solo CAF por tipo compartido entre los
 * cuatro sets de la certificación, cada set tiene que seguir numerando donde lo dejó
 * el anterior, sin repetir ni saltear folios.
 *
 * Por qué importa: antes cada set pedía su propio CAF (rango nuevo) y por eso
 * `solicitarCafs()` podía limpiar los contadores en cada llamada. Al consolidar, la
 * clave del contador (tipo + rango) pasa a ser la MISMA en los tres sets, así que
 * limpiarla haría que el set exenta emitiera los mismos folios que el básico — y el
 * SII rechaza los duplicados.
 *
 * Se ejecuta con `node test/folios-consolidados.test.js`, sin red ni SII.
 */

const assert = require('assert');
const CertFolioHelper = require('../cert/CertFolioHelper');

// El tipo 56 es el caso real que motivó el cambio (RUT 79888999-0, 13/08/2026):
// el set básico necesita 1, exenta 2 y compra 1. Total 4, en un CAF 1-4.
const CAF_56 = { tipoDte: 56, folioDesde: 1, folioHasta: 4 };
const PLAN   = [['basico', 1], ['exenta', 2], ['compra', 1]];

function emitirSets(helper, { limpiarEntreSets }) {
  const emitidos = [];
  for (const [set, cantidad] of PLAN) {
    // Esto es lo que hacía `solicitarCafs()` al principio de cada set.
    if (limpiarEntreSets) {
      helper.counters.clear();
      helper.usedFolios.clear();
    }
    for (let i = 0; i < cantidad; i++) {
      emitidos.push({ set, folio: helper.reserveNextFolio(CAF_56) });
    }
  }
  return emitidos;
}

// ── 1. Comportamiento consolidado: folios únicos y consecutivos ────────────────
{
  const emitidos = emitirSets(new CertFolioHelper(), { limpiarEntreSets: false });
  const folios   = emitidos.map(e => e.folio);

  assert.deepStrictEqual(folios, [1, 2, 3, 4],
    'los sets deben consumir el rango completo en orden');
  assert.strictEqual(new Set(folios).size, folios.length,
    'ningún folio puede repetirse entre sets');
  assert.deepStrictEqual(
    emitidos.filter(e => e.set === 'exenta').map(e => e.folio), [2, 3],
    'exenta debe continuar donde terminó básico, no reiniciar');
  console.log('✓ CAF compartido: 4 folios únicos y consecutivos entre los 3 sets');
}

// ── 2. El bug que se evita: limpiar el contador duplica folios ─────────────────
{
  const folios = emitirSets(new CertFolioHelper(), { limpiarEntreSets: true }).map(e => e.folio);

  assert.ok(new Set(folios).size < folios.length,
    'este caso DEBE producir duplicados — si no, la invariante que protege el test ya no aplica');
  assert.deepStrictEqual(folios, [1, 1, 2, 1],
    'limpiar entre sets reinicia el contador y repite el folio 1 en cada set');
  console.log('✓ Contrastado: limpiar entre sets habría emitido', JSON.stringify(folios));
}

// ── 3. El plan no puede quedar corto ──────────────────────────────────────────
{
  const helper = new CertFolioHelper();
  const corto  = { tipoDte: 56, folioDesde: 1, folioHasta: 3 }; // 3 folios para 4 necesarios
  for (let i = 0; i < 3; i++) helper.reserveNextFolio(corto);

  assert.throws(() => helper.reserveNextFolio(corto), /No hay más folios disponibles/,
    'si el total precargado queda corto tiene que fallar fuerte, no emitir un folio inválido');
  console.log('✓ Un plan corto falla al agotarse el rango, sin emitir folios fuera de él');
}

// ── 4. Tipos distintos no comparten contador ──────────────────────────────────
{
  const helper = new CertFolioHelper();
  const f56 = helper.reserveNextFolio({ tipoDte: 56, folioDesde: 1, folioHasta: 4 });
  const f61 = helper.reserveNextFolio({ tipoDte: 61, folioDesde: 1, folioHasta: 7 });

  assert.strictEqual(f56, 1);
  assert.strictEqual(f61, 1, 'cada tipo lleva su propio contador aunque el rango coincida');
  console.log('✓ Los contadores son por tipo + rango, no globales');
}

// ── 5. Un CAF de OTRO contribuyente jamás se reusa ────────────────────────────
//
// Regresión de un caso real (14/08/2026): `cafDir` (debug/auto-caf) es compartido entre
// todos los comercios del servidor, y `findLatestCaf` solo filtraba por tipo de DTE. Los
// tipos 56 y 61 del RUT 76543210-K resolvieron a CAF de 77111222-3, el timbre quedó
// firmado con la llave de otro contribuyente y el SII rechazó el envío completo con
// `RFR - Rechazado por Error en Firma`.
{
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const FolioService = require('../FolioService');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-rut-'));
  const dir  = path.join(base, 'debug', 'auto-caf', 'mezclados');
  fs.mkdirSync(dir, { recursive: true });

  const cafDe = (rut, tipo, d, h) =>
    `<AUTORIZACION><CAF><DA><RE>${rut}</RE><TD>${tipo}</TD><RNG><D>${d}</D><H>${h}</H></RNG></DA></CAF></AUTORIZACION>`;
  fs.writeFileSync(path.join(dir, 'ajeno.xml'), cafDe('77111222-3', 56, 2610, 2613));
  fs.writeFileSync(path.join(dir, 'propio.xml'), cafDe('76543210-K', 33, 72, 75));

  const svc = new FolioService({ ambiente: 'certificacion', rutEmisor: '76543210-K', baseDir: base });

  assert.strictEqual(svc.findLatestCaf(56), null,
    'un CAF de otro RUT NO puede devolverse, aunque el tipo coincida y sea el único candidato');
  assert.ok(svc.findLatestCaf(33), 'el CAF propio sí se encuentra');

  fs.rmSync(base, { recursive: true, force: true });
  console.log('✓ findLatestCaf ignora los CAF de otros contribuyentes');
}

// ── 6. Varios CAF por tipo: cada folio se firma con SU CAF ────────────────────
//
// El SII entrega los folios reobtenidos de a uno (folios 1-1 y 3-3 como CAF separados,
// visto el 14/08/2026 en el RUT 76543210-K). No alcanza con concatenar numeraciones:
// cada CAF trae su propia llave RSA y el timbre se firma con la del CAF que contiene ESE
// folio, así que devolver el folio sin su CAF produce timbres inválidos y el SII rechaza
// el envío entero con "Rechazado por Error en Firma".
{
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const SetBase = require('../cert/SetBase');
  const CertFolioHelper = require('../cert/CertFolioHelper');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-multi-'));
  // Llaves RSA de verdad: `CAF.js` valida que RSASK sea un PEM parseable, así que un
  // placeholder no sirve — y eso mismo confirma que cada CAF lleva su llave propia.
  const llave = () => require('crypto')
    .generateKeyPairSync('rsa', { modulusLength: 512,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' } }).privateKey;
  const LLAVE_A = llave(), LLAVE_B = llave();
  const cafDe = (d, h, sk) =>
    `<AUTORIZACION><CAF><DA><RE>76543210-K</RE><TD>56</TD><RNG><D>${d}</D><H>${h}</H></RNG></DA>` +
    `</CAF><RSASK>${sk}</RSASK></AUTORIZACION>`;
  const a = path.join(dir, 'caf-56-1-1.xml'); fs.writeFileSync(a, cafDe(1, 1, LLAVE_A));
  const b = path.join(dir, 'caf-56-3-3.xml'); fs.writeFileSync(b, cafDe(3, 3, LLAVE_B));

  // SetBase sin constructor: solo se ejercita _tomarFolio y sus dependencias.
  const set = Object.create(SetBase.prototype);
  set.folioHelper = new CertFolioHelper();
  set.config = { emisor: { rut: '76543210-K' }, ambiente: 'certificacion' };

  const uno = set._tomarFolio([a, b]);
  const dos = set._tomarFolio([a, b]);

  assert.strictEqual(uno.folio, 1, 'el primer documento toma el folio del primer CAF');
  assert.strictEqual(dos.folio, 3, 'agotado el primero, pasa al segundo CAF — no repite ni inventa');
  assert.ok(uno.cafXml.includes(LLAVE_A), 'el folio 1 viaja con la llave de SU CAF');
  assert.ok(dos.cafXml.includes(LLAVE_B), 'el folio 3 viaja con la llave de SU CAF, no la del primero');
  assert.strictEqual(uno.caf.privateKeyPem.trim(), LLAVE_A.trim(),
    'el objeto CAF devuelto es el que firma: su llave privada es la del rango del folio 1');
  assert.strictEqual(dos.caf.privateKeyPem.trim(), LLAVE_B.trim(),
    'y la del segundo documento es la del OTRO CAF — firmar con la llave equivocada da timbre inválido');
  assert.notStrictEqual(uno.cafXml, dos.cafXml, 'son CAF distintos, no el mismo reusado');

  assert.throws(() => set._tomarFolio([a, b]), /No hay más folios disponibles/,
    'agotados todos los CAF, falla fuerte en vez de devolver un folio fuera de rango');

  // Compatibilidad: una sola ruta sigue funcionando como antes.
  const set2 = Object.create(SetBase.prototype);
  set2.folioHelper = new CertFolioHelper();
  set2.config = set.config;
  assert.strictEqual(set2._tomarFolio(a).folio, 1, 'una ruta suelta sigue siendo válida');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ Varios CAF por tipo: cada folio viaja con la llave de su propio CAF');
}

// ─────────────────────────────────────────────────────────────────────────────
// Un CAF consumido no se reusa aunque exista otra copia del archivo
// ─────────────────────────────────────────────────────────────────────────────
{
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const CertRunner = require('../cert/CertRunner');

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'dos-arboles-'));
  const sk = require('crypto')
    .generateKeyPairSync('rsa', { modulusLength: 512,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' } }).privateKey;
  const xml =
    '<AUTORIZACION><CAF><DA><RE>77111222-3</RE><TD>33</TD>' +
    '<RNG><D>4523</D><H>4526</H></RNG></DA></CAF>' +
    `<RSASK>${sk}</RSASK></AUTORIZACION>`;

  // El mismo CAF, en los dos árboles donde la librería lo guarda de verdad.
  const dirA = path.join(raiz, 'auto-caf', '77111222-3', 'ts', '33');
  const dirB = path.join(raiz, 'caf', 'certificacion', '77111222-3', '33', 'ts');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const copiaA = path.join(dirA, 'archivo.xml');
  const copiaB = path.join(dirB, 'caf-33-4523-4526.xml');
  fs.writeFileSync(copiaA, xml);
  fs.writeFileSync(copiaB, xml);

  const runner = Object.create(CertRunner.prototype);
  runner.stateDir = raiz;
  runner.config = { emisor: { rut: '77111222-3' } };
  runner.folioHelper = { usedFolios: new Map() };

  // ENVIAR_SETS emite con la copia B.
  runner._marcarCafsConsumidos({ 33: copiaB });
  assert.ok(fs.existsSync(`${copiaB}.usado`), 'la copia usada queda marcada en disco');
  assert.ok(!fs.existsSync(`${copiaA}.usado`), 'la otra copia NO tiene marcador propio');

  // SIMULACION busca y `findLatestCaf` devuelve la copia A, la que no está marcada.
  // ⚠️ `folioService` es un getter en el prototipo: asignarlo directo no lo pisa (se
  // ignora en silencio) y el getter real revienta sin un certificado cargado, lo que
  // haría pasar este test por la excepción en vez de por la lógica que se quiere probar.
  const conFolioService = (fn) => Object.defineProperty(runner, 'folioService',
    { value: { findLatestCaf: fn, listarCafs: (t) => [fn(t)].filter(Boolean) }, configurable: true });
  conFolioService(() => copiaA);
  assert.strictEqual(runner._cafReusable(33, 1), null,
    'un CAF ya emitido no se reusa aunque la copia encontrada no tenga marcador: '
    + 'el folio se identifica por (RUT, tipo, rango), no por la ruta del archivo');

  // Y un rango que nunca se emitió sí se puede reusar.
  const otro = path.join(dirA, 'otro.xml');
  fs.writeFileSync(otro, xml.replace('<D>4523</D><H>4526</H>', '<D>9000</D><H>9003</H>'));
  conFolioService(() => otro);
  assert.ok(runner._cafReusable(33, 1), 'un rango sin emitir sigue siendo reusable');

  fs.rmSync(raiz, { recursive: true, force: true });
  console.log('✓ CAF consumido: no se reusa ni desde otra copia del mismo archivo');
}

// ── 7. Dos CAF parciales del mismo tipo se suman ────────────────────────────────
//
// Cuando el SII raciona el timbraje, un pedido de 4 folios queda repartido (3 + 1). Si
// `_cafReusable` mira solo el CAF más reciente, concluye "no alcanza" y pide folios
// nuevos: los 3 anteriores quedan timbrados sin usar y el SII los cuenta EN CONTRA del
// cupo, o sea que el reintento empeora el bloqueo. Medido el 19/08/2026 en el RUT
// 76543210-K (MAX_AUTOR=3 para 4 folios, FOLIOS_DISP=0).
{
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const CertRunner = require('../cert/CertRunner');

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-parciales-'));
  // Llave real: el constructor de CAF la parsea y revienta con una de mentira.
  const sk = require('crypto')
    .generateKeyPairSync('rsa', { modulusLength: 512,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' } }).privateKey;
  const cafXml = (d, h) =>
    '<AUTORIZACION><CAF><DA><RE>77111222-3</RE><TD>33</TD>' +
    `<RNG><D>${d}</D><H>${h}</H></RNG></DA></CAF>` +
    `<RSASK>${sk}</RSASK></AUTORIZACION>`;

  const dir = path.join(raiz, 'auto-caf', '77111222-3', 'ts', '33');
  fs.mkdirSync(dir, { recursive: true });
  const tanda1 = path.join(dir, 'caf-33-100-102.xml'); // 3 folios
  const tanda2 = path.join(dir, 'caf-33-103-103.xml'); // 1 folio
  fs.writeFileSync(tanda1, cafXml(100, 102));
  fs.writeFileSync(tanda2, cafXml(103, 103));

  const runner = Object.create(CertRunner.prototype);
  runner.stateDir = raiz;
  runner.config = { emisor: { rut: '77111222-3' } };
  runner.folioHelper = { usedFolios: new Map() };
  Object.defineProperty(runner, 'folioService', {
    // Más reciente primero, como devuelve `listarCafs` de verdad.
    value: { listarCafs: () => [tanda2, tanda1] },
    configurable: true,
  });

  const solo = runner._cafReusable(33, 3);
  assert.strictEqual(solo.paths.length, 1, 'para 3 folios alcanza con la tanda de 3');
  assert.strictEqual(solo.alcanza, true);

  const juntos = runner._cafReusable(33, 4);
  assert.strictEqual(juntos.alcanza, true, 'dos CAF parciales que suman 4 cubren un plan de 4');
  assert.strictEqual(juntos.paths.length, 2, 'se devuelven los dos CAF, no solo el último');
  assert.strictEqual(juntos.desde, 100, 'el rango arranca en el folio más bajo');
  assert.strictEqual(juntos.hasta, 103, 'y termina en el más alto');

  // Si no alcanzan, igual se devuelven: al SII se le pide solo la diferencia. Pedir el
  // total de nuevo desperdiciaría estos folios y subiría FOLIOS_DISP, que es lo que
  // aprieta el tope.
  const corto = runner._cafReusable(33, 5);
  assert.strictEqual(corto.alcanza, false, 'se avisa que no cubren el plan completo');
  assert.strictEqual(corto.total, 4, 'pero se informa cuánto aportan');

  // La misma copia en los dos árboles no puede contarse dos veces: son los mismos folios.
  const dirB = path.join(raiz, 'caf', 'certificacion', '77111222-3', '33', 'ts');
  fs.mkdirSync(dirB, { recursive: true });
  const copiaDeTanda1 = path.join(dirB, 'caf-33-100-102.xml');
  fs.writeFileSync(copiaDeTanda1, cafXml(100, 102));
  Object.defineProperty(runner, 'folioService', {
    value: { listarCafs: () => [tanda1, copiaDeTanda1] },
    configurable: true,
  });
  const duplicado = runner._cafReusable(33, 4);
  assert.strictEqual(duplicado.total, 3, 'dos copias del mismo rango son 3 folios, no 6');
  assert.strictEqual(duplicado.alcanza, false, 'y por lo tanto no cubren un plan de 4');
  assert.strictEqual(duplicado.paths.length, 1, 'se entrega una sola copia, no las dos');

  fs.rmSync(raiz, { recursive: true, force: true });
  console.log('✓ CAF parciales: se suman rangos distintos y se deduplican las copias');
}

// ── 8. La simulación también reparte folios entre varios CAF ────────────────────
//
// Los sets ya lo hacían (bloque 6), la simulación no: recibía UN objeto CAF por tipo y
// leía su rango directo. Ese era el único punto que impedía cubrir un plan con folios
// timbrados en tandas, que es la salida cuando el SII raciona el cupo (MAX_AUTOR=3 para
// un plan de 4, medido el 19/08/2026 en el RUT 76543210-K).
{
  const Simulacion = require('../cert/Simulacion');
  const CertFolioHelper = require('../cert/CertFolioHelper');

  const cafFalso = (desde, hasta) => ({
    getFolioDesde: () => desde,
    getFolioHasta: () => hasta,
  });

  const sim = Object.create(Simulacion.prototype);
  const helper = new CertFolioHelper();
  const a = cafFalso(100, 102);
  const b = cafFalso(103, 103);

  const tomados = [];
  for (let i = 0; i < 4; i++) tomados.push(sim._tomarFolio([a, b], 33, helper));

  assert.deepStrictEqual(tomados.map(t => t.folio), [100, 101, 102, 103],
    'los 4 folios del plan salen de los dos CAF, en orden y sin repetir');
  assert.deepStrictEqual(tomados.map(t => t.caf === a), [true, true, true, false],
    'cada folio vuelve con el CAF que lo contiene: el 103 con el segundo, no con el primero');

  assert.throws(() => sim._tomarFolio([a, b], 33, helper), /No hay más folios disponibles/,
    'agotados los dos rangos, falla en vez de emitir un folio fuera de rango');

  // Un solo CAF, sin lista: el comportamiento de siempre.
  const solo = sim._tomarFolio(cafFalso(500, 500), 61, new CertFolioHelper());
  assert.strictEqual(solo.folio, 500, 'un CAF suelto sigue funcionando igual');

  assert.throws(() => sim._tomarFolio(undefined, 34, helper), /No hay CAF para tipo 34/,
    'sin CAF el error nombra el tipo, como antes');

  console.log('✓ Simulación: un plan se cubre con folios repartidos en varios CAF');
}

console.log('\nTodos los checks de folios consolidados pasaron.');
