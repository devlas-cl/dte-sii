// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * El .d.ts describe lo que el .js devuelve de verdad.
 *
 * `npm run types` solo comprueba que dte-sii.d.ts sea TypeScript valido. No
 * compara nada contra la implementacion, asi que un tipo puede mentir y pasar.
 *
 * Y mintio: hasta 2.19.0, `ReobtenerCafResult` declaraba
 * `{ paths, folios, descartados } | null` mientras `FolioService.reobtenerCaf`
 * devolvia `{ ok: true, cafPaths, cafPath }` o `{ ok: false, motivo }`. Ni un
 * solo campo coincidia. Un consumidor en TypeScript leia `result.paths`,
 * recibia undefined en runtime y el compilador decia que estaba bien: el CAF
 * reobtenido nunca se persistia y el log igual anunciaba exito.
 *
 * Reportado el 01/09/2026 al integrar la libreria en un consumidor nuevo.
 *
 * Se ejecuta con `node test/contrato-reobtencion.test.js`, sin red ni SII.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const FolioService = require('../FolioService');

const dts = fs.readFileSync(path.join(__dirname, '..', 'dte-sii.d.ts'), 'utf8');

// ── 1. El fallo devuelve un objeto, nunca null ───────────────────────────────
//
// Es el camino que rompio al consumidor: `if (!resultado)` no detecta el fallo
// porque `{ ok: false }` es truthy, asi que se sigue al camino de exito.
async function bloque1() {
  const fs_ = Object.create(FolioService.prototype);
  fs_.cafSolicitor = null;

  const r = await fs_.reobtenerCaf({ tipoDte: 33, cantidad: 1 });

  assert.strictEqual(typeof r, 'object', 'reobtenerCaf devuelve un objeto');
  assert.notStrictEqual(r, null, 'reobtenerCaf NUNCA devuelve null, ni al fallar');
  assert.strictEqual(r.ok, false, 'el fallo se marca con ok:false');
  assert.strictEqual(typeof r.motivo, 'string', 'el fallo trae motivo');
  console.log('✓ El fallo devuelve { ok: false, motivo }, no null');
}

// ── 2. El .d.ts nombra los campos que existen ────────────────────────────────
//
// Comparacion textual a proposito: no hace falta un compilador para detectar
// que el tipo habla de campos que la implementacion no produce.
{
  const impl = fs.readFileSync(path.join(__dirname, '..', 'FolioService.js'), 'utf8');
  const cuerpo = impl.slice(impl.indexOf('async reobtenerCaf'));
  const bloque = cuerpo.slice(0, cuerpo.indexOf('\n  }\n'));

  for (const campo of ['ok', 'cafPaths', 'cafPath', 'motivo', 'disponibles']) {
    assert.ok(bloque.includes(`${campo}`), `FolioService.reobtenerCaf produce ${campo}`);
    assert.ok(dts.includes(campo), `el .d.ts nombra ${campo}`);
  }

  // Los del tipo viejo no pueden volver: si alguien los reintroduce, mintio otra vez.
  const tipoReobtener = dts.slice(dts.indexOf('export type ReobtenerCafResult'));
  const soloEsteTipo = tipoReobtener.slice(0, tipoReobtener.indexOf('\n\n'));
  for (const inventado of ['paths:', 'folios:', 'descartados:']) {
    assert.ok(
      !soloEsteTipo.includes(inventado),
      `ReobtenerCafResult no puede declarar ${inventado}: la implementacion no lo produce`,
    );
  }
  console.log('✓ ReobtenerCafResult nombra los campos reales y ninguno inventado');
}

// ── 3. CafSolicitor.reobtenerCaf devuelve objeto, no el XML ──────────────────
{
  const impl = fs.readFileSync(path.join(__dirname, '..', 'CafSolicitor.js'), 'utf8');
  const cuerpo = impl.slice(impl.indexOf('async reobtenerCaf(tipoDte, rango)'));
  const bloque = cuerpo.slice(0, cuerpo.indexOf('\n  }\n'));

  assert.ok(bloque.includes('success:'), 'CafSolicitor.reobtenerCaf marca success');
  assert.ok(bloque.includes('errorCode:'), 'y trae errorCode al fallar');
  assert.ok(
    dts.includes('ReobtenerRangoResult') && dts.includes('errorCode'),
    'el .d.ts describe esa forma, no `Promise<string | null>`',
  );

  for (const code of ['RANGO_ANULADO', 'REOBTENCION_SIN_FORMULARIO',
                      'REOBTENCION_SIN_DESCARGA', 'REOBTENCION_SIN_CAF']) {
    assert.ok(bloque.includes(code), `la implementacion emite ${code}`);
    assert.ok(dts.includes(code), `el .d.ts lista ${code}`);
  }
  console.log('✓ ReobtenerRangoResult describe el objeto real, con sus errorCode');
}

// ── 4. listarReobtenibles: los campos del rango ──────────────────────────────
//
// El .d.ts declaraba { desde, hasta, raw? } y la implementacion produce
// { campos, folioDesde, folioHasta, cantidad, anulado }. `campos` importa: son
// los ocultos del formulario del portal, y sin ellos el rango no se puede bajar.
{
  const tipoRango = dts.slice(dts.indexOf('export interface RangoReobtenible'));
  const bloque = tipoRango.slice(0, tipoRango.indexOf('\n}\n'));

  for (const campo of ['campos', 'folioDesde', 'folioHasta', 'cantidad', 'anulado']) {
    assert.ok(bloque.includes(campo), `RangoReobtenible declara ${campo}`);
  }
  assert.ok(!/\bdesde\s*:/.test(bloque), 'no puede volver a llamarse `desde`');
  assert.ok(!/\bhasta\s*:/.test(bloque), 'no puede volver a llamarse `hasta`');
  console.log('✓ RangoReobtenible usa los nombres reales, no desde/hasta');
}




bloque1()
  .then(() => console.log('\nTodos los checks del contrato de reobtencion pasaron.'))
  .catch((e) => { console.error(e.message); process.exit(1); });
