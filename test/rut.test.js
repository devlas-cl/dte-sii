const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanRut, formatRutSii } = require('../utils/rut');

test('RUT formatting removes padding without touching the check digit', () => {
  assert.equal(formatRutSii('07654321-6'), '7654321-6');
  assert.equal(formatRutSii('00000010-0'), '10-0');
  assert.equal(formatRutSii('00000010-k'), '10-K');
});

test('canonical and punctuated RUTs retain their established shape', () => {
  assert.equal(formatRutSii('7654321-6'), '7654321-6');
  assert.equal(formatRutSii('7.654.321-6'), '7654321-6');
});

test('degenerate RUT input never becomes empty', () => {
  assert.equal(cleanRut('00000000-0'), '00');
  assert.throws(() => formatRutSii('0'), /demasiado corto/);
  assert.equal(formatRutSii('00000000-0'), '0-0');
});
