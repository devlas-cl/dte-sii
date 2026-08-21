// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Smoke test de las referencias de certificación (utils/referencia.js) sin
 * dependencias de un test runner — se ejecuta con `node test/referencia-cert.test.js`.
 *
 * Cubre los dos defectos corregidos en 3.0.0, ambos causa de rechazo del SII
 * según sii-chile-cert/docs/02-set-pruebas-facturas.md:
 *
 *   1. FolioRef de la referencia al SET debe ser el folio del DTE propio.
 *   2. CodRef=2 exige los literales "Dice:" y "debe decir:" en la RazonRef.
 */

const assert = require('assert');
const { buildSetReferencia, buildRazonCorreccion, buildReferenciasNcNd } = require('../utils/referencia');

let fallos = 0;
function prueba(nombre, fn) {
  try { fn(); console.log(`  ok  ${nombre}`); }
  catch (error) { fallos += 1; console.error(`  FALLA  ${nombre}\n         ${error.message}`); }
}

console.log('referencias de certificación');

prueba('la referencia al SET lleva el folio del DTE propio', () => {
  // Folios de un set básico real: T33 1-4, T61 1-3, T56 1.
  for (const folio of [1, 2, 3, 4]) {
    const ref = buildSetReferencia('5016766-1', '2026-08-21', { folio });
    assert.strictEqual(ref.FolioRef, folio, `FolioRef debe ser ${folio}`);
    assert.strictEqual(ref.TpoDocRef, 'SET');
    assert.strictEqual(ref.NroLinRef, 1);
  }
});

prueba('la razón de la referencia al SET nombra el caso con el id del set', () => {
  const ref = buildSetReferencia('5016766-5', '2026-08-21', { folio: 1 });
  assert.strictEqual(ref.RazonRef, 'CASO 5016766-5');
});

prueba('la forma de llamada anterior lanza en vez de emitir un FolioRef plausible', () => {
  // Antes la firma era (casoId, fecha, nroLinRef) y FolioRef quedaba fijo en 1.
  assert.throws(() => buildSetReferencia('5016766-1', '2026-08-21'), /folio/);
  assert.throws(() => buildSetReferencia('5016766-1', '2026-08-21', 1), /folio/);
  assert.throws(() => buildSetReferencia('5016766-1', '2026-08-21', { folio: 0 }), /folio/);
});

prueba('una corrección de texto compone los literales que el SII exige', () => {
  const razon = buildRazonCorreccion({
    codRef: 2,
    razonRef: 'CORRIGE GIRO DEL RECEPTOR',
    receptor: { giro: 'GIRO CLIENTE' },
  });
  assert.ok(/Dice:/.test(razon), 'debe contener "Dice:"');
  assert.ok(/debe decir:/.test(razon), 'debe contener "debe decir:"');
  assert.ok(razon.includes('GIRO CLIENTE'), 'debe derivar del giro del receptor');
});

prueba('las anulaciones y las correcciones de monto conservan su razón cruda', () => {
  const receptor = { giro: 'GIRO CLIENTE' };
  assert.strictEqual(
    buildRazonCorreccion({ codRef: 1, razonRef: 'ANULA NOTA DE CREDITO ELECTRONICA', receptor }),
    'ANULA NOTA DE CREDITO ELECTRONICA',
  );
  assert.strictEqual(
    buildRazonCorreccion({ codRef: 3, razonRef: 'DEVOLUCION DE MERCADERIAS', receptor }),
    'DEVOLUCION DE MERCADERIAS',
  );
});

prueba('una razón que ya cumple la forma no se reescribe', () => {
  const original = 'Dice: GIRO PRUEBAS y debe decir: NUEVO GIRO PRUEBAS';
  assert.strictEqual(
    buildRazonCorreccion({ codRef: 2, razonRef: original, receptor: { giro: 'OTRO' } }),
    original,
  );
});

prueba('una corrección de texto sin giro del receptor lanza', () => {
  assert.throws(
    () => buildRazonCorreccion({ codRef: 2, razonRef: 'CORRIGE GIRO DEL RECEPTOR', receptor: {} }),
    /giro del receptor/,
  );
});

prueba('buildReferenciasNcNd propaga el folio a la referencia al SET', () => {
  const [setRef, docRef] = buildReferenciasNcNd(
    '5016766-5', '2026-08-21',
    { TpoDocRef: 33, FolioRef: 1, FchRef: '2026-08-21', CodRef: 2, RazonRef: 'Dice: A y debe decir: B' },
    { folio: 2 },
  );
  assert.strictEqual(setRef.FolioRef, 2, 'la referencia al SET lleva el folio propio');
  assert.strictEqual(setRef.NroLinRef, 1);
  assert.strictEqual(docRef.NroLinRef, 2);
});

if (fallos > 0) {
  console.error(`\n${fallos} prueba(s) fallaron`);
  process.exitCode = 1;
} else {
  console.log('\ntodas las pruebas pasaron');
}
