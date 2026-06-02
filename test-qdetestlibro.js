'use strict';
/**
 * test-qdetestlibro.js
 *
 * Prueba los endpoints del portal SII para consultar libros electrónicos:
 *   1. QEstLibro  — lista todos los libros del año y extrae los Códigos
 *   2. QDetEstLibro — detalle de cada envío (TrackId, estado, etc.)
 *
 * Uso:
 *   node test-qdetestlibro.js [year=2026] [periodo=2026-04]
 *
 * Requiere que la sesión exista o la crea automáticamente.
 */

const path    = require('path');
const fs      = require('fs');
const SiiCertificacion = require('./SiiCertificacion.js');

// ─── Configuración ────────────────────────────────────────────────────────────
const PFX_PATH     = path.resolve(__dirname, '../devlas-cloud-api-node/secret/19925444-8.pfx');
const PFX_PASS     = 'Lsr12345';
const RUT_EMPRESA  = '78206276';
const DV_EMPRESA   = 'K';
const SESSION_PATH = path.resolve(__dirname, '../devlas-cloud-api-node/debug/cert-v2/session.json');

const YEAR    = process.argv.find(a => a.startsWith('year='))?.split('=')[1]    || '2026';
const PERIODO = process.argv.find(a => a.startsWith('periodo='))?.split('=')[1] || null; // null = todos

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== test-qdetestlibro.js ===');
  console.log('PFX:', PFX_PATH);
  console.log('RUT:', `${RUT_EMPRESA}-${DV_EMPRESA}`);
  console.log('Year:', YEAR, '| Filtro período:', PERIODO || '(todos)');

  const cert = new SiiCertificacion({
    pfxPath:     PFX_PATH,
    pfxPassword: PFX_PASS,
    rutEmpresa:  RUT_EMPRESA,
    dvEmpresa:   DV_EMPRESA,
    sessionPath: SESSION_PATH,
  });

  // ── 1. Asegurar sesión portal en subsistema /cgi_dte/UPL/ ─────────────────
  // DTEauth?7 es la página del formulario de búsqueda de libros.
  // CSESSIONID es el token de sesión del portal SII. Lo necesitamos válido.
  console.log('\n[1] Autenticando en /cgi_dte/UPL/DTEauth?7...');
  // Parchar request para capturar Set-Cookie crudos de DTEauth?7
  const origRequest = cert.session.request.bind(cert.session);
  let lastRawHeaders = null;
  cert.session.request = async function(url, opts) {
    const resp = await origRequest(url, opts);
    if (url.includes('DTEauth')) {
      lastRawHeaders = resp.headers;
    }
    return resp;
  };
  const authResp = await cert.session.ensureSession('/cgi_dte/UPL/DTEauth?7');
  cert.session.request = origRequest; // restaurar
  console.log('    Status DTEauth:', authResp?.status);
  if (lastRawHeaders) {
    const sc = lastRawHeaders['set-cookie'];
    console.log('    Set-Cookie DTEauth?7:', JSON.stringify(sc));
  }
  console.log('    CSESSIONID en jar:', cert.session.cookieJar?.match(/CSESSIONID=[^;]+/)?.[0] || '(none)');
  fs.writeFileSync(path.join(__dirname, 'test-output', 'dteauth7.html'), authResp?.body || '', 'latin1');

  // ── TEST DIRECTO: llamar QDetEstLibro sin QEstLibro de por medio ──────────
  console.log('\n[TEST DIRECTO] QDetEstLibro sin pasar por QEstLibro...');
  const urlDetDirect = `https://maullin.sii.cl/cgi_dte/UPL/QDetEstLibro` +
    `?Codigo=COMPRA-772220&rutC=78206276&dvC=K&periodo=2026-04`;
  const directResp = await cert.session.request(urlDetDirect);
  console.log('    Status:', directResp.status);
  const directBody = directResp.body;
  if (directBody.includes('SESION HA EXPIRADO')) {
    console.warn('    [WARN] TAMBIÉN falla sin QEstLibro — es el CSESSIONID o la sesión');
  } else if (directBody.includes('AUTORIZADO')) {
    console.warn('    [WARN] Error de autorización');
    console.log(directBody.slice(0, 500));
  } else {
    console.log('    OK! Funciona directamente');
    console.log(directBody.slice(0, 1000));
  }
  fs.writeFileSync(path.join(__dirname, 'test-output', 'qdetestlibro-direct.html'), directBody, 'latin1');

  // ── 2. Llamar QEstLibro ────────────────────────────────────────────────────
  const urlLista = `https://maullin.sii.cl/cgi_dte/UPL/QEstLibro` +
    `?rutCompany=${RUT_EMPRESA}&dvCompany=${DV_EMPRESA}&TrackId=&year=${YEAR}&month=00&tipo=TODOS`;

  console.log('\n[2] GET', urlLista);
  const listaResp = await cert.session.request(urlLista);
  console.log('    Status:', listaResp.status);
  console.log('    Set-Cookie headers:', listaResp.headers?.['set-cookie'] || '(none)');
  console.log('    Cookies post-QEstLibro:', cert.session.cookieJar?.slice(0, 250) + '...');

  if (listaResp.body.includes('SESION HA EXPIRADO')) {
    console.error('    [ERR] Sesión expirada en QEstLibro — revisar ensureSession');
    process.exit(1);
  }

  // Guardar HTML para inspección
  const htmlListaPath = path.join(__dirname, 'test-output', 'qestlibro.html');
  fs.mkdirSync(path.dirname(htmlListaPath), { recursive: true });
  fs.writeFileSync(htmlListaPath, listaResp.body, 'latin1');
  console.log('    HTML guardado en:', htmlListaPath);

  // ── 3. Parsear la tabla: extraer Código → periodo → operación ──────────────
  // El HTML tiene links tipo: QDetEstLibro?Codigo=VENTA-772219&rutC=...&periodo=2026-04
  // href sin comillas: href=QDetEstLibro?Codigo=X&rutC=Y&dvC=Z&periodo=PPPP>Ver
  // el > cierra el atributo, por eso lo excluimos del grupo de captura
  const linkRegex = /QDetEstLibro\?Codigo=([^&"'\s>]+)&rutC=[^&"'\s>]+&dvC=[^&"'\s>]+&periodo=([^&"'\s>]+)/gi;
  const codigos = {}; // { '2026-04': { VENTA: 'VENTA-772219', COMPRA: 'COMPRA-XXXXX' } }
  let m;
  while ((m = linkRegex.exec(listaResp.body)) !== null) {
    const codigo  = m[1];
    const periodo = m[2];
    if (PERIODO && periodo !== PERIODO) continue;
    codigos[periodo] = codigos[periodo] || {};
    const tipoMatch = /^(VENTA|COMPRA|GUIAS?)/i.exec(codigo);
    const tipo = tipoMatch ? tipoMatch[1].toUpperCase() : codigo;
    codigos[periodo][tipo] = codigo;
  }

  console.log('\n    Códigos encontrados:');
  if (Object.keys(codigos).length === 0) {
    console.log('    (ninguno — revisar HTML en test-output/qestlibro.html)');
  }
  for (const [p, ops] of Object.entries(codigos)) {
    for (const [op, cod] of Object.entries(ops)) {
      console.log(`      ${p} / ${op} → ${cod}`);
    }
  }

  // ── 4. Llamar QDetEstLibro para cada código ────────────────────────────────
  // Usamos las MISMAS cookies que obtuvimos de DTEauth?7 (paso 1).
  // NO re-autenticamos: si DTEauth?7 usa tokens one-shot, un segundo call
  // lo consumiría sin beneficio. Las cookies NETSCAPE_LIVEWIRE persisten.
  for (const [periodo, ops] of Object.entries(codigos)) {
    for (const [operacion, codigo] of Object.entries(ops)) {
      const urlDet = `https://maullin.sii.cl/cgi_dte/UPL/QDetEstLibro` +
        `?Codigo=${encodeURIComponent(codigo)}&rutC=${RUT_EMPRESA}&dvC=${DV_EMPRESA}&periodo=${periodo}`;

      const refererQEstLibro = `https://maullin.sii.cl/cgi_dte/UPL/QEstLibro` +
        `?rutCompany=${RUT_EMPRESA}&dvCompany=${DV_EMPRESA}&TrackId=&year=${YEAR}&month=00&tipo=TODOS`;

      console.log(`\n[3] QDetEstLibro ${periodo} ${operacion} (${codigo})`);
      console.log('    GET', urlDet);

      const detResp = await cert.session.request(urlDet, {
        headers: { Referer: refererQEstLibro },
      });
      console.log('    Status:', detResp.status);

      const outPath = path.join(__dirname, 'test-output', `qdetestlibro-${periodo}-${operacion}.html`);
      fs.writeFileSync(outPath, detResp.body, 'latin1');

      if (detResp.body.includes('SESION HA EXPIRADO')) {
        console.warn('    [WARN] Sesión expirada — revisar cookies / DTEauth');
        console.log('\n--- BODY (500 chars) ---\n', detResp.body.slice(0, 500));
      } else {
        console.log('    HTML guardado en:', outPath);
        console.log('\n--- BODY ---\n', detResp.body);
      }
    }
  }

  console.log('\n=== Fin ===');
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  console.error(e.stack);
  process.exit(1);
});
