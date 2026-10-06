/**
 * `getSemilla()` (REST, boletas) reintenta ante 5xx/429 y errores de red, y entrega el 5xx
 * final con el mismo mensaje de siempre (`Error obteniendo semilla: <status>`), porque la API
 * de Devlas lo reconoce por ese texto para diferir el envio en vez de marcar error.
 *
 * Medido el 05/10/2026: la API de boletas de produccion respondio 500 durante horas.
 * Sin red: se sustituye `_fetchRest`.
 */
const assert = require('assert');
const EnviadorSII = require('../EnviadorSII');

const SEMILLA_OK = '<?xml version="1.0"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_BODY><SEMILLA>123</SEMILLA></SII:RESP_BODY></SII:RESPUESTA>';

function enviadorCon(respuestas) {
  const e = Object.create(EnviadorSII.prototype);
  e.ambiente = 'produccion';
  e.urls = { produccion: { semilla: 'http://sii.test/semilla' } };
  e.esperaReintentoMs = 1;
  e.llamadas = 0;
  e._fetchRest = async () => {
    const r = respuestas[Math.min(e.llamadas++, respuestas.length - 1)];
    if (r instanceof Error) throw r;
    return { response: { ok: r.status === 200, status: r.status }, text: r.body || '' };
  };
  return e;
}

(async () => {
  // 500 transitorio y luego OK: se recupera solo
  let e = enviadorCon([{ status: 500 }, { status: 500 }, { status: 200, body: SEMILLA_OK }]);
  assert.strictEqual(await e.getSemilla(), '123');
  assert.strictEqual(e.llamadas, 3);

  // Caida larga: agota los intentos y conserva el mensaje original
  e = enviadorCon([{ status: 500 }]);
  await assert.rejects(() => e.getSemilla(), /^Error: Error obteniendo semilla: 500$/);
  assert.strictEqual(e.llamadas, 4);

  // 4xx no se reintenta
  e = enviadorCon([{ status: 403 }]);
  await assert.rejects(() => e.getSemilla(), /Error obteniendo semilla: 403/);
  assert.strictEqual(e.llamadas, 1);

  // Error de red retryable se reintenta
  const red = Object.assign(new Error('socket'), { code: 'ECONNRESET' });
  e = enviadorCon([red, { status: 200, body: SEMILLA_OK }]);
  assert.strictEqual(await e.getSemilla(), '123');
  assert.strictEqual(e.llamadas, 2);

  console.log('OK semilla-rest-reintentos');
})().catch((err) => { console.error(err); process.exit(1); });
