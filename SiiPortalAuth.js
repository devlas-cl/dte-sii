// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiPortalAuth.js
 *
 * Autenticación con certificado digital en el portal del SII (herculesr.sii.cl).
 * Permite obtener datos del contribuyente (fch_resol, nro_resol, razón social)
 * directamente desde el portal sin login manual.
 *
 * Flujo (confirmado por análisis del portal):
 *  1. GET  zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoCertificado.html?TARGET
 *          → obtiene cookie F5 BIG-IP de sesión
 *  2. POST herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi?TARGET   body: referencia=TARGET
 *          → herculesr SÍ solicita cert en el TLS handshake inicial (a diferencia de zeusr)
 *          → SII extrae el RUT del campo serialNumber del certificado
 *          → responde con set-cookie: NETSCAPE_LIVEWIRE.* (sesión activa)
 *  3. POST maullin.sii.cl/cvc_cgi/dte/ad_empresa2   body: RUT_EMP=XXXXX&DV_EMP=X
 *          → devuelve tabla HTML con datos del contribuyente
 *
 * @module SiiPortalAuth
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { URL } = require('url');
const forge  = require('node-forge');
const crypto = require('crypto');

// ─── Opciones TLS comunes para SII ────────────────────────────────────────────
const SII_TLS_OPTS = {
  rejectUnauthorized: false,
  maxVersion: 'TLSv1.2',
  secureOptions:
    crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION |
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
};

// ─── Ruta del caché de sesión ─────────────────────────────────────────────────
// Guarda las cookies NETSCAPE_LIVEWIRE.* para reusar entre ejecuciones y evitar
// el error "máximo de sesiones autenticadas" del SII.
const SESSION_CACHE_PATH = path.join(
  process.env.DATADIR || path.join(os.homedir(), 'AppData', 'Roaming', 'POS'),
  'sii_session_cache.json'
);

/**
 * Clase principal de autenticación con el portal SII
 */
class SiiPortalAuth {
  /**
   * @param {Object} options
   * @param {Buffer}  options.pfxBuffer   - Buffer del archivo PFX
   * @param {string}  options.pfxPassword - Contraseña del PFX
   */
  constructor({ pfxBuffer, pfxPassword }) {
    if (!pfxBuffer) throw new Error('SiiPortalAuth: pfxBuffer es obligatorio');
    if (pfxPassword === undefined) throw new Error('SiiPortalAuth: pfxPassword es obligatorio');

    const { certPem, keyPem } = SiiPortalAuth._extractPems(pfxBuffer, pfxPassword);
    this._certPem = certPem;
    this._keyPem  = keyPem;
    // Huella para identificar de qué cert es la sesión cacheada
    this._certHash = crypto.createHash('sha1').update(certPem).digest('hex').slice(0, 12);

    this._agentePlano = new https.Agent(SII_TLS_OPTS);
    this._agenteCert  = new https.Agent({ ...SII_TLS_OPTS, cert: certPem, key: keyPem });
  }

  /**
   * Extrae cert + key PEM desde un PFX usando node-forge
   * (node-forge soporta PKCS12 moderno AES-256 que Node nativo rechaza)
   * @private
   */
  static _extractPems(pfxBuffer, password) {
    const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

    // Clave privada
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]
      || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
    if (!keyBag?.key) throw new Error('SiiPortalAuth: no se encontró clave privada en el PFX');
    const keyPem = forge.pki.privateKeyToPem(keyBag.key);

    // Certificado
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag  = certBags[forge.pki.oids.certBag]?.[0];
    if (!certBag?.cert) throw new Error('SiiPortalAuth: no se encontró certificado en el PFX');
    const certPem = forge.pki.certificateToPem(certBag.cert);

    return { certPem, keyPem };
  }

  // ─── HTTP helpers ────────────────────────────────────────────────────────────

  _request(urlStr, { method = 'GET', cookieJar = {}, body = null, headers = {}, usarCert = false } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-CL,es;q=0.9',
          'Connection': 'keep-alive',
          ...headers,
        },
      };

      const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieStr) options.headers['Cookie'] = cookieStr;

      if (body) {
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      if (isHttps) options.agent = usarCert ? this._agenteCert : this._agentePlano;

      const req = (isHttps ? https : http).request(options, (res) => {
        // Capturar cookies
        for (const cookieHeader of (res.headers['set-cookie'] || [])) {
          const [pair] = cookieHeader.split(';');
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) {
            const name = pair.slice(0, eqIdx).trim();
            const val  = pair.slice(eqIdx + 1).trim();
            cookieJar[name] = val;
          }
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = res.headers['content-type'] || '';
          // Todos los hosts *.sii.cl sirven páginas ISO-8859-1; a veces no incluyen charset en Content-Type.
          const isSiiHost = url.hostname.endsWith('.sii.cl');
          const encoding = (isSiiHost || /iso-8859|latin-1|windows-1252/i.test(ct)) ? 'latin1' : 'utf8';
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString(encoding), cookieJar });
        });
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // ─── API pública ─────────────────────────────────────────────────────────────

  /**
   * Autenticar con certificado en el portal SII y obtener cookies de sesión.
   * Retorna el cookieJar con NETSCAPE_LIVEWIRE.* si tuvo éxito.
   *
   * @returns {Promise<Object>} cookieJar con sesión SII activa
   * @throws {Error} Si la autenticación falla
   */
  async autenticar() {
    const TARGET = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';

    // ── 1. Intentar reusar sesión cacheada ───────────────────────────────────
    const cached = SiiPortalAuth._cargarSesionCache(this._certHash);
    if (cached) {
      const valida = await this._validarSesion(cached);
      if (valida) {
        console.log('[SiiPortalAuth] ♻️  Reutilizando sesión SII cacheada');
        return cached;
      }
      console.log('[SiiPortalAuth] ⚠️  Sesión cacheada expirada, re-autenticando...');
    }

    // ── 2. Nueva autenticación ────────────────────────────────────────────────
    const cookieJar = {};

    await this._request(
      `https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoCertificado.html?${TARGET}`,
      { cookieJar }
    );

    const r2 = await this._request(
      `https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi?${TARGET}`,
      {
        method: 'POST',
        body: `referencia=${encodeURIComponent(TARGET)}`,
        cookieJar,
        usarCert: true,
      }
    );

    // Verificar mensaje de límite de sesiones
    if (r2.body.includes('m\u00e1ximo de sesiones') || r2.body.includes('maximo de sesiones') ||
        r2.body.includes('01.01.215.500.709')) {
      throw new Error(
        'SiiPortalAuth: límite de sesiones SII alcanzado.\n' +
        'Cierra sesión en sii.cl y espera ~30 min, o las sesiones anteriores expirarán solas.'
      );
    }

    const autenticado = Object.keys(cookieJar).some(k => k.startsWith('NETSCAPE_LIVEWIRE'));
    if (!autenticado) {
      throw new Error('SiiPortalAuth: autenticación fallida — no se recibieron cookies de sesión NETSCAPE_LIVEWIRE.*');
    }

    SiiPortalAuth._guardarSesionCache(this._certHash, cookieJar);
    return cookieJar;
  }

  /**
   * Verifica si una sesión cacheada sigue activa haciendo un GET liviano.
   * Si el SII redirige al login → sesión expirada.
   * @private
   */
  async _validarSesion(cookieJar) {
    try {
      const res = await this._request(
        'https://maullin.sii.cl/cvc_cgi/dte/ad_empresa1',
        { cookieJar: { ...cookieJar } } // copia para no contaminar
      );
      // Si redirige al login SII → expirada
      const loc = res.headers['location'] || '';
      if (loc.includes('InicioAutenticacion') || loc.includes('IngresoRutClave')) return false;
      // Si el body contiene formulario de empresa → válida
      const valida = res.status === 200 && (res.body.includes('RUT_EMP') || res.body.includes('ad_empresa'));
      // Refrescar timestamp del caché para extender TTL mientras la sesión se usa activamente
      if (valida) SiiPortalAuth._guardarSesionCache(this._certHash, cookieJar);
      return valida;
    } catch {
      return false;
    }
  }

  /** Lee sesión cacheada del disco para el cert dado. @private */
  static _cargarSesionCache(certHash) {
    try {
      if (!fs.existsSync(SESSION_CACHE_PATH)) return null;
      const data = JSON.parse(fs.readFileSync(SESSION_CACHE_PATH, 'utf8'));
      if (data.certHash !== certHash) return null;
      // TTL: 90 minutos (SII permite ~2h de inactividad; se refresca en cada validación)
      if (Date.now() - data.ts > 90 * 60 * 1000) return null;
      return data.cookies;
    } catch {
      return null;
    }
  }

  /** Guarda sesión en disco. @private */
  static _guardarSesionCache(certHash, cookieJar) {
    try {
      fs.mkdirSync(path.dirname(SESSION_CACHE_PATH), { recursive: true });
      fs.writeFileSync(SESSION_CACHE_PATH, JSON.stringify({
        certHash,
        ts: Date.now(),
        cookies: cookieJar,
      }), 'utf8');
    } catch { /* no crítico */ }
  }

  /** Borra la sesión cacheada (útil para forzar re-login). */
  static limpiarSesionCache() {
    try { fs.unlinkSync(SESSION_CACHE_PATH); } catch { /* ignorar */ }
  }

  /**
   * Obtiene datos del contribuyente desde ad_empresa2.
   * Incluye fch_resol, nro_resol, razón social, etc.
   *
   * @param {string} rutEmpresa - RUT sin DV (ej: "78206276")
   * @param {string} dvEmpresa  - DV (ej: "K")
   * @param {Object} [cookieJar] - Sesión ya autenticada (opcional; si omite, autenticará)
   * @returns {Promise<Object>} { rut, razonSocial, fch_resol, nro_resol, fecha_autorizacion }
   */
  async obtenerDatosEmpresa(rutEmpresa, dvEmpresa, cookieJar = null) {
    const jar = cookieJar || await this.autenticar();

    // ad_empresa1 → mostrar el form de ingreso de RUT (obtiene cookie de sesión maullin)
    await this._request('https://maullin.sii.cl/cvc_cgi/dte/ad_empresa1', { cookieJar: jar });

    // ad_empresa2 → POST con RUT empresa → devuelve tabla con datos
    const res = await this._request(
      'https://maullin.sii.cl/cvc_cgi/dte/ad_empresa2',
      {
        method: 'POST',
        body: `RUT_EMP=${encodeURIComponent(rutEmpresa)}&DV_EMP=${encodeURIComponent(dvEmpresa)}&ACEPTAR=Ingresar`,
        cookieJar: jar,
      }
    );

    return SiiPortalAuth._parsearTablaEmpresa(res.body);
  }

  /**
   * Método de conveniencia: autentica y obtiene TODOS los datos del emisor en un solo paso:
   * - fch_resol / nro_resol   (desde ad_empresa2)
   * - rut, razonSocial, giro, dirección, comuna, acteco  (desde pe_construccion_dte)
   *
   * @param {string} rutEmpresa - RUT sin DV (ej: "78206276")
   * @param {string} dvEmpresa  - DV (ej: "K")
   * @returns {Promise<Object>} Datos completos del emisor
   */
  async fetchDatosEmpresa(rutEmpresa, dvEmpresa) {
    const cookieJar = await this.autenticar();
    const [resolucion, contribuyente] = await Promise.all([
      this.obtenerDatosEmpresa(rutEmpresa, dvEmpresa, cookieJar),
      this.obtenerDatosContribuyente(rutEmpresa, dvEmpresa, cookieJar).catch(() => null),
    ]);
    return { ...contribuyente, ...resolucion };
  }

  /**
   * Obtiene datos fidedignos del contribuyente para construcción DTE.
   * Flujo:
   *   1. POST pe_construccion_dte con RUT_EMP + DV_EMP
   *      → redirige a ce_consulta_muestra_e con la tabla de datos
   *   2. Parsea la tabla: nombre, dirección, actividades económicas, glosa
   *
   * @param {string} rutEmpresa - RUT sin DV (ej: "78206276")
   * @param {string} dvEmpresa  - DV (ej: "K")
   * @param {Object} [cookieJar] - Sesión autenticada (si omite, autenticará)
   * @returns {Promise<Object>} { rut, razonSocial, direccion, comuna, dirReg, acteco, glosa }
   */
  async obtenerDatosContribuyente(rutEmpresa, dvEmpresa, cookieJar = null) {
    const jar = cookieJar || await this.autenticar();

    // POST directo al action del form: ce_consulta_muestra_e
    // (pe_construccion_dte solo devuelve el formulario, no los datos)
    const res = await this._request(
      'https://maullin.sii.cl/cvc_cgi/dte/ce_consulta_muestra_e',
      {
        method: 'POST',
        body: `RUT_EMP=${encodeURIComponent(rutEmpresa)}&DV_EMP=${encodeURIComponent(dvEmpresa)}&ACEPTAR=CONSULTAR`,
        cookieJar: jar,
      }
    );

    return SiiPortalAuth._parsearCeConsultaMuestra(res.body);
  }

  /**
   * Parsea el HTML de ce_consulta_muestra_e.
   *
   * Estructura real del SII:
   *   <td>DATOS DEL CONTRIBUYENTE RUT</td><td>78206276-K</td>
   *   <td>NOMBRE O RAZÓN SOCIAL</td><td>DEVLAS SPA</td>
   *   <td>DIRECCIÓN DE LA EMPRESA</td><td>AV.ESC.AGRICOLA 1710..., Comuna MACUL</td>
   *   <td>DIRECCIÓN REGIONAL DEL CONTRIBUYENTE</td><td>NUNOA</td>
   *   + tabla actividades: <td>620100</td><td>ACTIVIDADES DE PROGRAMACION...</td><td>SI</td>
   *   + tabla glosa: <td>GLOSA DESCRIPTIVA</td><td>Desarrollo de software...</td>
   * @private
   */
  static _parsearCeConsultaMuestra(html) {
    const clean = (s) => s
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&oacute;/g, 'ó').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é')
      .replace(/&iacute;/g, 'í').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
      .replace(/&Oacute;/g, 'Ó').replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É')
      .replace(/&Iacute;/g, 'Í').replace(/&Ntilde;/g, 'Ñ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    const datos = {};
    const actividades = [];

    for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const celdas = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(m[1]));
      if (celdas.length === 2 && celdas[0]) {
        datos[celdas[0].toUpperCase()] = celdas[1];
      } else if (celdas.length === 3) {
        // Filas de actividades económicas: código, descripción, afecto IVA
        const codigo = celdas[0].replace(/\s/g, '');
        if (/^\d{4,6}$/.test(codigo)) {
          actividades.push({ codigo, descripcion: celdas[1], afectoIva: celdas[2] });
        }
      }
    }

    // Extraer dirección y comuna (la dirección incluye "Comuna XXXX" al final)
    const dirRaw = datos['DIRECCIÓN DE LA EMPRESA'] || datos['DIRECCION DE LA EMPRESA'] || null;
    let direccion = dirRaw;
    let comuna = null;
    if (dirRaw) {
      const comunaMatch = dirRaw.match(/,?\s*Comuna\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑA-Z ]+)$/i);
      if (comunaMatch) {
        comuna = comunaMatch[1].trim();
        direccion = dirRaw.slice(0, comunaMatch.index).replace(/,\s*$/, '').trim();
      }
    }

    const dirReg = datos['DIRECCIÓN REGIONAL DEL CONTRIBUYENTE'] || datos['DIRECCION REGIONAL DEL CONTRIBUYENTE'] || null;
    const glosa  = datos['GLOSA DESCRIPTIVA'] || null;

    return {
      rut:          datos['DATOS DEL CONTRIBUYENTE RUT'] || null,
      razonSocial:  datos['NOMBRE O RAZÓN SOCIAL'] || datos['NOMBRE O RAZON SOCIAL'] || null,
      giro:         actividades[0]?.descripcion || null,  // descripción de la primera actividad económica
      direccion,
      comuna,
      dirReg,
      sucursal_sii: dirReg ? `S.I.I. - ${dirReg}` : null,
      acteco:       actividades[0]?.codigo || null,
      actividades:  actividades.length ? actividades : null,
      glosa,
    };
  }

  // ─── Parser interno ──────────────────────────────────────────────────────────

  /**
   * Parsea la tabla HTML de ad_empresa2.
   * El HTML tiene filas <tr><td>Label</td><td>&nbsp;Valor</td></tr>
   * @private
   */
  static _parsearTablaEmpresa(html) {
    const datos = {};
    const decode = s => s
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, '')
      .replace(/&oacute;/g, 'ó')
      .replace(/&aacute;/g, 'á')
      .replace(/&eacute;/g, 'é')
      .replace(/&iacute;/g, 'í')
      .replace(/&uacute;/g, 'ú')
      .replace(/&ntilde;/g, 'ñ')
      .replace(/&amp;/g, '&')
      .trim();

    // Dividir por apertura <TR> — HTML 4.01 no exige tags </TR> de cierre
    for (const seg of html.split(/<tr[^>]*>/i)) {
      const celdas = [...seg.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => decode(m[1]));
      if (celdas.length >= 2 && celdas[0]) datos[celdas[0]] = celdas[1];
    }

    // Buscar por regex para ser resiliente ante variaciones de encoding / tildes
    const fechaKey  = Object.keys(datos).find(k => /fecha.*resol/i.test(k)) || null;
    const nroKey    = Object.keys(datos).find(k => /^resoluci/i.test(k) && !/fecha/i.test(k)) || null;
    const fechaResol = fechaKey ? datos[fechaKey] : null;
    const nroResol   = nroKey   ? datos[nroKey]   : null;

    if (fechaResol === null && nroResol === null) {
      // Loguear los campos encontrados para diagnóstico
      const camposEncontrados = Object.keys(datos);
      console.warn('[SiiPortalAuth] ad_empresa2 campos encontrados:', camposEncontrados.length ? camposEncontrados.join(', ') : '(ninguno)');
      if (!camposEncontrados.length) {
        // Puede ser una página de login o error — loguear inicio del HTML
        console.warn('[SiiPortalAuth] HTML ad_empresa2 (primeros 500 chars):', html.slice(0, 500).replace(/\s+/g, ' '));
      }
      throw new Error('SiiPortalAuth: no se encontraron datos de resolución en la respuesta del SII');
    }

    // Convertir fecha DD-MM-YYYY → YYYY-MM-DD
    const fchResolIso = fechaResol
      ? fechaResol.replace(/^(\d{2})-(\d{2})-(\d{4})$/, '$3-$2-$1')
      : null;

    return {
      rut:               datos['Rut']               || null,
      razonSocial:       datos['Razón Social']       || null,
      fch_resol:         fchResolIso,
      nro_resol:         nroResol !== null ? parseInt(nroResol, 10) : null,
      fecha_autorizacion: datos['Fecha Autorización'] || null,
    };
  }
}

module.exports = SiiPortalAuth;
