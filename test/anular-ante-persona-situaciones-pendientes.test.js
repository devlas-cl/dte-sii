'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CertRunner = require('../cert/CertRunner');

// `_convieneAnular` no usa estado de la instancia: se prueba directo sobre el prototipo.
const conviene = (res, enMano = 0) => CertRunner.prototype._convieneAnular.call({}, res, enMano);

test('con el bloqueo de la persona por situaciones pendientes se intenta anular (FOLIOS_DISP desconocido)', () => {
  assert.equal(conviene({ errorCode: 'PERSONA_CON_SITUACIONES_PENDIENTES', foliosDisp: null }), true);
});

test('si el SII informa que no hay folios sin utilizar que anular, no se intenta', () => {
  assert.equal(conviene({ errorCode: 'PERSONA_CON_SITUACIONES_PENDIENTES', foliosDisp: 0 }, 0), false);
});

test('si todos los folios disponibles son los que ya tenemos en mano, no se intenta', () => {
  assert.equal(conviene({ errorCode: 'PERSONA_CON_SITUACIONES_PENDIENTES', foliosDisp: 5 }, 5), false);
});

test('los códigos de tope de siempre siguen anulando y un error cualquiera no', () => {
  assert.equal(conviene({ errorCode: 'TIMBRAJE_BLOQUEADO', foliosDisp: null }), true);
  assert.equal(conviene({ errorCode: 'MAX_AUTOR_INSUFICIENTE', foliosDisp: 3 }, 0), true);
  assert.equal(conviene({ errorCode: 'UNKNOWN', foliosDisp: null }), false);
  assert.equal(conviene({ errorCode: 'USUARIO_SIN_PERMISO', foliosDisp: null }), false);
});
