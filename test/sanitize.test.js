// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * El texto que va al DTE conserva lo que el SII pidió.
 *
 * Caso real (23/08/2026, certificación): el set de facturas exentas exige el ítem
 * "CAPACITACION USO PLC's CNC" y el documento salió con "CAPACITACION USO PLCs CNC".
 * El apóstrofe se borraba en `sanitizeSiiText`, cuyo comentario lo atribuía a "problemas
 * de firma XML" — la causa real de esa firma rota era `fixEntities()` escapando el
 * apóstrofe DENTRO de la forma canónica, y eso ya está arreglado (ver
 * c14n-apostrofe.test.js). Borrar el carácter quedó como remedio de un mal que ya no
 * existe, y ahora el texto del documento no es el que el SII comparó.
 *
 * Lo que sí hay que seguir sacando es lo que queda FUERA de Latin-1: el envío codifica
 * con `Buffer.from(xml, 'latin1')`, que trunca cada code point a su byte bajo.
 *
 * Se ejecuta con `node test/sanitize.test.js`, sin red ni SII.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSiiText, sanitizeTedText } = require('../utils/sanitize');

test('el apóstrofe del set llega intacto al documento', () => {
  assert.equal(sanitizeSiiText("CAPACITACION USO PLC's CNC"), "CAPACITACION USO PLC's CNC");
  assert.equal(sanitizeSiiText("O'Higgins"), "O'Higgins");
});

test('las comillas dobles ASCII se conservan en el contenido', () => {
  assert.equal(sanitizeSiiText('Cable de 3" marca ACME'), 'Cable de 3" marca ACME');
});

test('la puntuación tipográfica se pliega a su equivalente Latin-1, no se borra', () => {
  assert.equal(sanitizeSiiText('PLC’s CNC'), "PLC's CNC");
  assert.equal(sanitizeSiiText('“ACME”'), '"ACME"');
  assert.equal(sanitizeSiiText('rango 1—3'), 'rango 1-3');
  assert.equal(sanitizeSiiText('etc…'), 'etc...');
});

test('lo que no cabe en Latin-1 se sigue eliminando', () => {
  // `Buffer.from(xml, 'latin1')` truncaría el code point a un byte de control.
  assert.equal(sanitizeSiiText('ITEM \u{1F600} X'), 'ITEM  X');
  assert.equal(sanitizeSiiText('你好'), '');
});

test('los acentuados de Latin-1 se conservan', () => {
  assert.equal(sanitizeSiiText('CAPACITACIÓN EN MAÑANA'), 'CAPACITACIÓN EN MAÑANA');
});

test('el texto del TED sigue plegando acentos a ASCII y conserva el apóstrofe', () => {
  // El lector PDF417 del SII no devuelve los bytes >= 128 como se codificaron; el
  // apóstrofe es 0x27 y no está en ese rango.
  assert.equal(sanitizeTedText("CAPACITACIÓN PLC's"), "CAPACITACION PLC's");
});
