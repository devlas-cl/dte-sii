// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Detalle de una revisión de muestras impresas rechazada (`muestraMail`).
 *
 * La cabecera (`leeImpreso`) solo dice RECHAZADO. Caso real (11/10/2026, certificación):
 * el SII rechazó la revisión en segundos y cada PDF figuraba "aprobado". El detalle mostró
 * que los documentos de dos sets estaban clasificados como SIMULACION: eran de un envío
 * distinto del que el SII registró para esos sets.
 *
 * Se ejecuta con `node test/muestras-detalle-rechazo.test.js`, sin red ni SII.
 */

const assert = require('assert');
const CertRunner = require('../cert/CertRunner');

// Mismo formato que la respuesta real: HTML escapado con \xNN dentro de la tabla de strings GWT.
const esc = (s) => s.replace(/[<>='&]/g, (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const fila = (...c) => `<tr>${c.map((x) => `<td>${x}</td>`).join('')}</tr>`;
const html =
  "<html><head><meta charset='UTF-8' /><title>Resultado de Etapa de Impresos.</title></head><body>" +
  '<p>La revisi&oacute;n de las muestras impresas ha sido <b>APROBADA</b></p><table border=\'1\'>' +
  fila('Id', 'Archivo', 'Tipo Pdf', 'Tipo de Documento', 'Folio', 'Copia', 'Caso de prueba', 'Doc. de Prueba') +
  fila('1', 'muestra_33_35.pdf', 'PRUEBA', 'Factura Electronica', '35', 'TRIBUTARIA', '5120510', '1') +
  fila('2', 'muestra_33_35_cedible.pdf', 'PRUEBA', 'Factura Electronica', '35', 'CEDIBLE', '5120510', '1') +
  fila('3', 'muestra_34_7.pdf', 'SIMULACION', 'Factura Exenta Electronica', '7', 'TRIBUTARIA', '', '') +
  fila('4', 'muestra_52_4.pdf', 'SIMULACION', 'Guia de Despacho Electronica', '4', 'TRIBUTARIA', '', '') +
  '</table></body></html>';
const body = `//OK[2,0,1,["cl.sii.sdi.did.coredtecert.to.StringTo/1902593157","${esc(html)}"],0,7]`;

const detalle = CertRunner.parsearDetalleMuestras(body);
assert.strictEqual(detalle.length, 4, 'una fila por PDF, sin la cabecera de la tabla');
assert.deepStrictEqual(detalle[0], {
  archivo: 'muestra_33_35.pdf', tipoPdf: 'PRUEBA', tipoDocumento: 'Factura Electronica',
  folio: 35, copia: 'TRIBUTARIA', caso: '5120510',
});
assert.strictEqual(detalle[2].tipoPdf, 'SIMULACION');
console.log('✓ parsearDetalleMuestras lee la tabla de muestraMail');

const resumen = CertRunner.resumirDetalleMuestras(detalle);
assert.match(resumen, /set de pruebas 1 documento\(s\) \(casos 5120510: Factura Electronica 1\)/, 'las cedibles no se cuentan dos veces');
assert.match(resumen, /simulación 2 \(Factura Exenta Electronica 1, Guia de Despacho Electronica 1\)/);
console.log('✓ resumirDetalleMuestras dice qué quedó como simulación');

assert.deepStrictEqual(CertRunner.parsearDetalleMuestras('//OK[0,[],0,7]'), []);
assert.strictEqual(CertRunner.resumirDetalleMuestras([]), '');
console.log('✓ sin detalle no inventa nada');

console.log('\nOK muestras-detalle-rechazo');
