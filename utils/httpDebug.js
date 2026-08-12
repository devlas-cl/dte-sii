// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * httpDebug.js — Registro de TODAS las llamadas HTTP al portal del SII.
 *
 * Motivación real: depurando una certificación hubo cinco minutos de pantalla
 * congelada sin ninguna forma de saber qué estaba pasando. La causa era una
 * consulta que dispara cuatro requests secuenciales al portal, ninguno de los
 * cuales dejaba rastro. De 26 llamadas en `SiiCertificacion` solo 5 se guardaban,
 * y de las 14 de `SiiPortalAuth`, ninguna.
 *
 * Este módulo es el único punto donde se decide qué se guarda y cómo. Se engancha
 * en los dos clientes HTTP de la librería (son independientes: `SiiSession` usa
 * `got` y `SiiPortalAuth` usa `https` nativo, sin código en común).
 *
 * ── Está apagado por defecto ──────────────────────────────────────────────────
 * Solo actúa si el consumidor define `SII_HTTP_DEBUG_DIR`. Sin esa variable, el
 * costo es una comparación por request y nada más.
 *
 * ── Nunca rompe la operación real ─────────────────────────────────────────────
 * Todo va dentro de try/catch. Un fallo al escribir el diagnóstico jamás puede
 * tumbar un envío al SII.
 *
 * @module dte-sii/utils/httpDebug
 */

const fs = require('fs');
const path = require('path');

/** Tope por archivo. Una respuesta del portal ronda los 50 KB; 512 KB cubre casos raros sin llenar el disco. */
const MAX_BYTES = 512 * 1024;

/** Contador por directorio: numera las llamadas para que el orden cronológico se lea en el nombre. */
const _contadores = new Map();

/**
 * Cabeceras que nunca se escriben en claro.
 * `set-cookie` y `cookie` llevan la sesión viva del SII (~90 min de validez): quedaría
 * una credencial usable en disco. `authorization` por el mismo motivo.
 */
const HEADERS_SENSIBLES = new Set(['set-cookie', 'cookie', 'authorization', 'proxy-authorization']);

/** Marcador único, para poder grepear qué se redactó. */
const REDACTADO = '[REDACTADO-POR-httpDebug]';

/**
 * Redacta secretos del cuerpo de una respuesta.
 *
 * `<RSASK>` es la llave privada RSA que el SII entrega dentro del CAF: si se guarda
 * en claro, cualquiera con acceso al disco puede timbrar documentos con esos folios.
 * Hoy se escribe sin protección en varios puntos de la librería; acá al menos no se
 * amplifica el problema.
 */
function redactarCuerpo(texto) {
  if (!texto) return texto;
  return String(texto)
    .replace(/<RSASK>[\s\S]*?<\/RSASK>/gi, `<RSASK>${REDACTADO}</RSASK>`)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, REDACTADO);
}

/** Devuelve una copia de los headers con los sensibles redactados. */
function redactarHeaders(headers) {
  const salida = {};
  for (const [k, v] of Object.entries(headers || {})) {
    salida[k] = HEADERS_SENSIBLES.has(k.toLowerCase()) ? REDACTADO : v;
  }
  return salida;
}

/** Convierte una URL en un fragmento corto y legible para el nombre de archivo. */
function _slugDesdeUrl(urlStr) {
  try {
    const { pathname } = new URL(urlStr);
    const ultimo = pathname.split('/').filter(Boolean).pop() || 'raiz';
    return ultimo.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  } catch {
    return 'url-invalida';
  }
}

function _siguienteNumero(dir) {
  const n = (_contadores.get(dir) || 0) + 1;
  _contadores.set(dir, n);
  return String(n).padStart(3, '0');
}

/**
 * ¿Está activa la captura? Se lee en cada llamada a propósito: el consumidor puede
 * definir la variable por corrida (un directorio distinto por etapa).
 * @returns {string|null} Directorio destino, o null si está apagada.
 */
function dirActivo() {
  return process.env.SII_HTTP_DEBUG_DIR || null;
}

/**
 * Registra una llamada HTTP. Best-effort: nunca lanza.
 *
 * Escribe dos cosas:
 *  - `NNN-METODO-recurso-STATUS.html` con el cuerpo de la respuesta.
 *  - Una línea en `index.jsonl` con los metadatos, para poder revisar una corrida
 *    entera de un vistazo (`jq`, `grep`) sin abrir cada archivo.
 *
 * @param {Object} info
 * @param {string} info.url
 * @param {string} [info.method='GET']
 * @param {number} [info.status]
 * @param {Object} [info.headers] - Cabeceras de respuesta (se redactan).
 * @param {string} [info.body] - Cuerpo de respuesta (se redacta).
 * @param {string} [info.reqBody] - Cuerpo enviado (form POST). Se redacta igual.
 * @param {number} [info.ms] - Duración.
 * @param {string} [info.cliente] - Qué cliente HTTP lo emitió, para saber de dónde vino.
 */
function registrarHttpDebug(info = {}) {
  const dir = dirActivo();
  if (!dir) return;

  try {
    fs.mkdirSync(dir, { recursive: true });

    const { url = '', method = 'GET', status = 0, headers, body, reqBody, ms, cliente } = info;
    const n = _siguienteNumero(dir);
    const nombre = `${n}-${method.toUpperCase()}-${_slugDesdeUrl(url)}-${status}.html`;

    let cuerpo = redactarCuerpo(body) ?? '';
    let truncado = false;
    if (Buffer.byteLength(cuerpo, 'utf-8') > MAX_BYTES) {
      cuerpo = cuerpo.slice(0, MAX_BYTES) + `\n\n${REDACTADO} — truncado en ${MAX_BYTES} bytes`;
      truncado = true;
    }

    // El cuerpo enviado importa tanto como la respuesta: cuando el SII rechaza un
    // envío, la causa está en el XML que se le mandó. Si es corto va inline en el
    // comentario; si no, a un archivo aparte para no volver ilegible el principal.
    const reqTexto = reqBody ? redactarCuerpo(String(reqBody)) : '';
    let archivoReq = null;
    if (reqTexto.length > 2000) {
      archivoReq = nombre.replace(/\.html$/, '-request.txt');
      const recortado = Buffer.byteLength(reqTexto, 'utf-8') > MAX_BYTES
        ? reqTexto.slice(0, MAX_BYTES) + `\n\n${REDACTADO} — truncado en ${MAX_BYTES} bytes`
        : reqTexto;
      fs.writeFileSync(path.join(dir, archivoReq), recortado, 'utf-8');
    }

    // Encabezado legible dentro del propio archivo: al abrir uno suelto se entiende
    // a qué llamada corresponde sin tener que cruzarlo con el índice.
    const cabecera = [
      '<!--',
      `  ${method.toUpperCase()} ${url}`,
      `  status: ${status}${ms != null ? `  |  ${ms} ms` : ''}${cliente ? `  |  cliente: ${cliente}` : ''}`,
      `  fecha: ${new Date().toISOString()}`,
      archivoReq ? `  request body: ${archivoReq}` : null,
      reqTexto && !archivoReq ? `  request body: ${reqTexto}` : null,
      '-->',
      '',
    ].filter(Boolean).join('\n');

    fs.writeFileSync(path.join(dir, nombre), cabecera + cuerpo, 'utf-8');

    fs.appendFileSync(
      path.join(dir, 'index.jsonl'),
      JSON.stringify({
        n,
        ts: new Date().toISOString(),
        method: method.toUpperCase(),
        url,
        status,
        ms: ms ?? null,
        cliente: cliente ?? null,
        bytes: Buffer.byteLength(String(body ?? ''), 'utf-8'),
        truncado,
        archivo: nombre,
        archivoRequest: archivoReq,
        headers: redactarHeaders(headers),
      }) + '\n',
      'utf-8',
    );
  } catch (_e) {
    // El diagnóstico jamás puede romper la operación real contra el SII.
  }
}

/**
 * `fetch` que ademas deja el intercambio en el debug HTTP.
 *
 * Devuelve el texto ya leido porque el cuerpo de un Response se consume una sola vez:
 * si el debug lo leyera por su cuenta, el llamador se quedaria sin cuerpo.
 *
 * @param {string} url
 * @param {Object} [opciones] - Igual que las de `fetch`.
 * @param {string} [cliente] - Quien hizo la llamada, para ubicarla en el indice.
 * @returns {Promise<{ response: Response, text: string }>}
 */
async function fetchRegistrado(url, opciones = {}, cliente = undefined) {
  const t0 = Date.now();
  const response = await fetch(url, opciones);
  const text = await response.text();
  // Con el debug apagado se sale acá, ANTES de tocar nada de la respuesta. Estas llamadas
  // están en el camino de emisión real (EnviadorSII, WsReclamo): recorrer los headers para
  // después descartarlos sería trabajo y superficie de fallo en producción a cambio de nada.
  if (!dirActivo()) return { response, text };
  registrarHttpDebug({
    url,
    method: opciones.method || 'GET',
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text,
    reqBody: opciones.body,
    ms: Date.now() - t0,
    cliente,
  });
  return { response, text };
}

module.exports = {
  registrarHttpDebug,
  fetchRegistrado,
  redactarCuerpo,
  redactarHeaders,
  dirActivo,
  REDACTADO,
  MAX_BYTES,
};
