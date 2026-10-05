// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * `CertRunner.cuerpoAutorizarBoleta()`: cuerpo GWT de la declaración de cumplimiento de
 * boleta (autorizarEmpresaBolProd).
 *
 * El SII rechazaba la declaración de algunas empresas con "The call failed on the server"
 * cuando la propia empresa iba como proveedor de software y el DV del usuario iba fijo en
 * "8". Con el proveedor real (RUT, DV, nombre y correo) y el DV de la sesión, igual que el
 * portal, la aceptó (prueba A/B sobre una misma postulación en P90, 05/10/2026).
 *
 * Se ejecuta con `node test/declaracion-boleta-cuerpo.test.js`, sin red ni SII.
 */
const assert = require('assert');
const mod = require('../cert/CertRunner');
const CertRunner = mod.CertRunner || mod;

const base = { url: 'https://www4.sii.cl/certBolElectDteInternet/', policy: 'POLICY', servicio: 'SVC' };
const datos = {
  rutEmpresa: '77111222-3',
  razonSocial: 'EMPRESA DE PRUEBA SPA',
  rutUsuario: '11111111',
  dvUsuario: '1',
  fecha: '05-10-2026',
  fchAutorizacion: '',
  longCharValue: '0',
  proveedor: { rut: '79555666-7', nombre: 'PROVEEDOR SPA', correo: 'soporte@proveedor.cl', link: 'www.sii.cl' },
};

const c = CertRunner.cuerpoAutorizarBoleta(base, datos);

// RUT empresa, RUT proveedor y RUT usuario en ese orden (campos r, s, t).
assert.ok(c.includes('|8|77111222|8|79555666|8|11111111|'), 'r/s/t: empresa, proveedor, usuario');
// DV proveedor y DV usuario reales (campos e, f), luego SII, fecha, correo y nombre del proveedor.
assert.ok(c.includes('|7|1|SII|05-10-2026|soporte@proveedor.cl|PROVEEDOR SPA|19|S|www.sii.cl|'), 'e/f/n/o/u');
// La tabla tiene 24 strings.
assert.ok(c.startsWith('7|0|24|'), 'tabla de 24 strings');
// El separador "|" dentro de un texto va escapado.
const escapado = CertRunner.cuerpoAutorizarBoleta(base, { ...datos, razonSocial: 'A|B' });
assert.ok(escapado.includes('|A\\!B|'), 'escape de |');
// Sin datos de negocios: el armado no inventa proveedor.
assert.ok(!/77967443|WELCOME/i.test(c), 'la librería no trae datos de ningún negocio');

console.log('OK declaracion-boleta-cuerpo');
