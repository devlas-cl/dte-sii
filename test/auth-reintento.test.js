/**
 * Autenticación de `SiiPortalAuth`: reintento ante fallas de red/TLS y camino real de login.
 *
 * ⚠️ Medido contra el SII el 18/08/2026: devuelve **`EPROTO` de forma intermitente** al abrir
 * la conexión TLS con certificado (`rsa_pss ... last octet invalid`), y reintentando con el
 * MISMO certificado funciona. Sin reintento, un error transitorio se lee como "el certificado
 * del cliente está roto" y se marca como caído un comercio sano.
 *
 * Lo inverso también se protege: el **límite de sesiones del SII NO se reintenta**, porque cada
 * intento empeora el bloqueo.
 *
 * 🔴 **Por qué hay dos niveles de doble.** La primera versión de este archivo sustituía
 * `_autenticarNuevo()` completo para probar los reintentos — o sea, reemplazaba justo el código
 * que se acababa de refactorizar. Pasó en verde mientras producción tiraba
 * `ReferenceError: TARGET is not defined`. Por eso ahora el grueso de los casos sustituye solo
 * `_request()` y ejecuta el método real.
 *
 * Sin red.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-auth-'));
const SiiPortalAuth = require('../SiiPortalAuth');

/** Respuesta de herculesr que el SII devuelve en un login correcto. */
const LOGIN_OK = { status: 200, body: '<html>ok</html>' };

/**
 * Instancia que ejecuta **el `_autenticarNuevo()` real**; solo se sustituye `_request`.
 *
 * @param {Array<Error|object>} respuestas - una por llamada a `_request`, en orden.
 * @param {boolean} cookies - si el segundo request debe dejar la cookie de sesión.
 */
let _seq = 0;
function authConRequestFalso(respuestas, cookies = true) {
  const a = Object.create(SiiPortalAuth.prototype);
  // Hash único por instancia: `SiiSessionStore` es un store en memoria compartido por
  // certHash, así que dos dobles con el mismo hash harían que el segundo reutilice la sesión
  // del primero y nunca llegue a autenticar. Cuesta un rato darse cuenta.
  a._certHash = `t${++_seq}`;
  a._cachedCookieJar = null;
  a.urls = [];
  a.llamadas = 0;
  a._cargarSesionCache = () => null;
  a._request = async (url, opts = {}) => {
    a.urls.push(url);
    const paso = respuestas[a.llamadas++];
    if (paso instanceof Error) throw paso;
    // El segundo request (herculesr) es el que autentica y deja la cookie.
    if (cookies && url.includes('herculesr')) opts.cookieJar['NETSCAPE_LIVEWIRE.hola'] = '1';
    return paso ?? LOGIN_OK;
  };
  return a;
}

/** Instancia que sustituye `_autenticarNuevo`. Solo para casos que el doble anterior no cubre. */
function authFalso(secuencia) {
  const a = Object.create(SiiPortalAuth.prototype);
  a._certHash = `f${++_seq}`;
  a._cachedCookieJar = null;
  a.intentos = 0;
  a._cargarSesionCache = () => null;
  a._autenticarNuevo = async () => {
    const paso = secuencia[a.intentos++];
    if (paso instanceof Error) throw paso;
    return paso;
  };
  return a;
}

function err(code, message = 'falla simulada') {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

async function main() {
  // ── El login real funciona de punta a punta ────────────────────────────────
  // Este es el caso que faltaba: ejecuta `_autenticarNuevo()` de verdad. Si el refactor
  // pierde una variable (pasó con TARGET), acá revienta en vez de en producción.
  {
    const a = authConRequestFalso([LOGIN_OK, LOGIN_OK]);
    const jar = await a.autenticar();
    assert.ok(jar['NETSCAPE_LIVEWIRE.hola'], 'devuelve el cookieJar con la sesión');
    assert.strictEqual(a.llamadas, 2, 'son dos requests: zeusr y herculesr');
    assert.ok(a.urls[0].includes('zeusr.sii.cl'), 'primero zeusr');
    assert.ok(a.urls[1].includes('herculesr.sii.cl'), 'después herculesr');
    // El TARGET va en la query de ambas: sin él el SII no sabe a dónde redirigir.
    for (const u of a.urls) {
      assert.ok(/misiir\.sii\.cl/.test(u), `falta el TARGET en la URL: ${u}`);
      assert.ok(!/undefined/.test(u), `la URL quedó con "undefined": ${u}`);
    }
  }

  // ── EPROTO en el primer request: se reintenta el login completo ────────────
  {
    const a = authConRequestFalso([err('EPROTO', 'write EPROTO ... rsa_pss last octet invalid'), LOGIN_OK, LOGIN_OK]);
    const jar = await a.autenticar();
    assert.ok(jar['NETSCAPE_LIVEWIRE.hola'], 'tras un EPROTO transitorio la autenticación funciona');
    assert.strictEqual(a.llamadas, 3, 'el reintento rehace el login desde el primer request');
  }

  // ── 🔴 El límite de sesiones NO se reintenta ───────────────────────────────
  {
    const a = authConRequestFalso([LOGIN_OK, { status: 200, body: 'Ha superado el maximo de sesiones abiertas' }]);
    await assert.rejects(() => a.autenticar(),
      (e) => e.code === 'SII_LIMITE_SESIONES' && /límite de sesiones/.test(e.message),
      'reintentar el límite de sesiones solo empeora el bloqueo');
    assert.strictEqual(a.llamadas, 2, 'no puede haber un segundo intento de login');
  }

  // ── Sin cookies de sesión: falla clara y sin reintento ─────────────────────
  {
    const a = authConRequestFalso([LOGIN_OK, LOGIN_OK], false);
    await assert.rejects(() => a.autenticar(), /NETSCAPE_LIVEWIRE/);
    assert.strictEqual(a.llamadas, 2, 'un fallo de credenciales no se reintenta');
  }

  // ── Otros errores de transporte también se reintentan ──────────────────────
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']) {
    const a = authFalso([err(code), { TOKEN: code }]);
    assert.deepStrictEqual(await a.autenticar(), { TOKEN: code }, `${code} tiene que reintentarse`);
  }

  // ── "socket hang up" sin code también ──────────────────────────────────────
  {
    const a = authFalso([err(null, 'socket hang up'), { TOKEN: 'hangup' }]);
    assert.deepStrictEqual(await a.autenticar(), { TOKEN: 'hangup' });
  }

  // ── Se rinde tras agotar los intentos, con el error real ───────────────────
  {
    const a = authFalso([err('EPROTO'), err('EPROTO'), err('EPROTO'), { TOKEN: 'tarde' }]);
    await assert.rejects(() => a.autenticar(), (e) => e.code === 'EPROTO',
      'agotados los intentos propaga el error original, no uno genérico');
    assert.strictEqual(a.intentos, 3, 'son 3 intentos en total, no infinitos');
  }

  fs.rmSync(process.env.DATADIR, { recursive: true, force: true });
  console.log('auth-reintento: 12 casos OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
