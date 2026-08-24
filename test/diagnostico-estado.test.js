// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Diagnóstico de "ENVIO CON ERRORES O REPAROS".
 *
 * El portal de certificación nombra el set que falló y nada más. El detalle está en la
 * consulta de estado del envío, con el TrackId que ya tenemos desde que lo subimos, pero
 * nadie preguntaba: en una corrida real del 24/08/2026 los TrackIds de los sets marcados
 * aparecían en 2 de 105 respuestas HTTP, y en ninguna se consultaba su estado.
 *
 * Se ejecuta con `node test/diagnostico-estado.test.js`, sin red ni SII.
 */

const assert = require('assert');
const os     = require('os');
const CertRunner = require('../cert/CertRunner');

/** Corre `fn` capturando lo que imprime. */
function capturando(fn) {
  const lineas = [];
  const original = console.log;
  const originalWarn = console.warn;
  console.log = (...a) => lineas.push(a.join(' '));
  console.warn = (...a) => lineas.push(a.join(' '));
  try { return { r: fn(), salida: lineas.join('\n') }; }
  finally { console.log = original; console.warn = originalWarn; }
}

async function main() {
  // ── 1. Del XML de estado sale el documento culpable ───────────────────────────
  {
    const r = Object.create(CertRunner.prototype);
    const xml =
      '<SII:RESPUESTA><SII:RESP_HDR><ESTADO>RPR</ESTADO><GLOSA>Envio Aceptado con Reparos</GLOSA></SII:RESP_HDR>' +
      '<SII:RESP_BODY><NUM_DOCS>4</NUM_DOCS><ACEPTADOS>3</ACEPTADOS><REPAROS>1</REPAROS>' +
      '<DETALLE_REP><TIPO_DOC>33</TIPO_DOC><FOLIO>12</FOLIO><ESTADO>RPR</ESTADO>' +
      '<DESCRIPCION>Monto neto no cuadra con detalle</DESCRIPCION></DETALLE_REP>' +
      '</SII:RESP_BODY></SII:RESPUESTA>';

    const { salida } = capturando(() => r._imprimirDetalleEstado(xml));

    assert.match(salida, /TIPO_DOC=33/, 'nombra el tipo de documento');
    assert.match(salida, /FOLIO=12/, 'y el folio, que es lo que hay que ir a corregir');
    assert.match(salida, /Monto neto no cuadra/, 'con la glosa del SII, no una traducción nuestra');
    assert.match(salida, /NUM_DOCS=4 \| ACEPTADOS=3 \| REPAROS=1/,
      'los contadores dicen si el problema es de un documento o de todos');
    console.log('✓ Detalle: del XML de estado sale tipo, folio y motivo');
  }

  // ── 2. Sin detalle no inventa nada ─────────────────────────────────────────────
  {
    const r = Object.create(CertRunner.prototype);
    const { salida } = capturando(() =>
      r._imprimirDetalleEstado('<SII:RESPUESTA><ESTADO>EPR</ESTADO></SII:RESPUESTA>'));
    assert.strictEqual(salida, '', 'un envío sin reparos no imprime líneas de detalle');

    const vacio = capturando(() => r._imprimirDetalleEstado(null));
    assert.strictEqual(vacio.salida, '', 'y sin XML tampoco revienta');
    console.log('✓ Detalle: sin reparos no imprime ruido');
  }

  // ── 3. El diagnóstico nunca tumba la corrida ──────────────────────────────────
  //
  // Es diagnóstico: corre justo cuando algo ya salió mal, así que un fallo suyo no puede
  // tapar el error que se estaba investigando.
  {
    const r = Object.create(CertRunner.prototype);
    r.config = { emisor: { rut: '76543210-K' } };
    r.ambiente = 'certificacion';
    r.debugDir = os.tmpdir();
    r.certificado = null;   // revienta al construir el consultor

    let salida = '';
    const original = console.log, originalWarn = console.warn;
    const push = (...a) => { salida += a.join(' ') + '\n'; };
    console.log = push; console.warn = push;
    try {
      await r._diagnosticarEnviosConError(
        { setBasico: { trackId: '111' } }, ['SET BASICO'], 'declaracion-response',
      );
    } finally { console.log = original; console.warn = originalWarn; }

    assert.match(salida, /No se pudo crear el consultor de estado/,
      'deja constancia de por qué no pudo diagnosticar');
    console.log('✓ Diagnóstico: si falla, avisa y deja seguir');
  }

  // ── 4. Sin sets marcados no molesta al SII ────────────────────────────────────
  {
    const r = Object.create(CertRunner.prototype);
    let salida = '';
    const original = console.log;
    console.log = (...a) => { salida += a.join(' ') + '\n'; };
    try {
      await r._diagnosticarEnviosConError({ setBasico: { trackId: '111' } }, [], 'x');
    } finally { console.log = original; }

    assert.strictEqual(salida, '', 'sin nombres con error no se consulta nada');
    console.log('✓ Diagnóstico: sin errores no hace consultas');
  }

  console.log('\nTodos los checks del diagnóstico de estado pasaron.');
}

main().catch((err) => { console.error(err); process.exit(1); });
