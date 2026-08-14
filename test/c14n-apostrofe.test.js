// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Canonical XML no escapa apóstrofes ni comillas dobles en el contenido.
 *
 * Regresión de un caso real (14/08/2026, RUT 77111222-3 en maullin). La canonicalización
 * pasaba por un `fixEntities()` que convertía `'` en `&apos;` y `"` en `&quot;` dentro del
 * texto. El estándar (REC-xml-c14n-20010315) escapa en nodos de texto SOLO `&`, `<`, `>` y
 * el retorno de carro, así que la forma que firmábamos no era la que el SII recalcula al
 * recibir el documento: el DigestValue no coincidía y el SII rechazaba el ENVÍO ENTERO con
 * `RFR - Rechazado por Error en Firma`, sin indicar documento ni motivo.
 *
 * Lo difícil de ver era que dependía del CONTENIDO: de los cuatro sets de certificación,
 * los tres sin apóstrofes pasaban (EPR) y solo fallaba el que traía el ítem
 * "CAPACITACION USO PLC'S CNC" — un carácter en un documento tumbaba el envío completo.
 *
 * Se ejecuta con `node test/c14n-apostrofe.test.js`, sin red ni SII.
 */

const assert = require('assert');
const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const DTE = require('../DTE');
const Signer = require('../Signer');

const NS = 'http://www.sii.cl/SiiDte';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const sha1 = (s) => crypto.createHash('sha1').update(Buffer.from(s, 'utf8'), 'utf8').digest('base64');

// ── 1. El apóstrofe queda literal en la forma canónica del Documento ──────────
{
  const dte = Object.create(DTE.prototype);
  const xml =
    `<DTE xmlns="${NS}" xmlns:xsi="${XSI}" version="1.0"><Documento ID="F1T33">` +
    "<Detalle><NmbItem>CAPACITACION USO PLC&apos;s CNC</NmbItem></Detalle>" +
    '</Documento></DTE>';

  const c14n = dte._c14nDocumento(new DOMParser().parseFromString(xml, 'application/xml'));

  assert.ok(c14n.includes("PLC's CNC"),
    'el apóstrofe va literal en la forma canónica; escaparlo cambia el digest y el SII rechaza el envío');
  assert.ok(!c14n.includes('&apos;'),
    'no puede quedar ninguna entidad &apos; en el texto canonicalizado');
  console.log('✓ Documento: el apóstrofe queda literal, no como &apos;');
}

// ── 2. Lo mismo para la comilla doble, y para el SetDTE del envío ─────────────
{
  const signer = Object.create(Signer.prototype);
  const xml =
    `<EnvioDTE xmlns="${NS}" xmlns:xsi="${XSI}" version="1.0"><SetDTE ID="SET1">` +
    '<Caratula version="1.0"><RutEmisor>77111222-3</RutEmisor></Caratula>' +
    '<Nota>Cable de 3&quot; marca O&apos;Higgins</Nota>' +
    '</SetDTE></EnvioDTE>';

  const c14n = signer._c14nSetDTE(new DOMParser().parseFromString(xml, 'application/xml'), 'EnvioDTE');

  assert.ok(c14n.includes(`Cable de 3" marca O'Higgins`),
    'apóstrofe y comilla doble van literales en el contenido del SetDTE');
  assert.ok(!/&apos;|&quot;/.test(c14n.replace(/<[^>]*>/g, '')),
    'ninguna de las dos entidades puede sobrevivir en el texto');
  console.log('✓ SetDTE: apóstrofe y comilla doble quedan literales');
}

// ── 3. Sin apóstrofes ni comillas, la canonicalización no cambió ──────────────
//
// Confirma que el arreglo es quirúrgico: los documentos que el SII ya aceptaba siguen
// produciendo exactamente el mismo digest, así que no se rompe nada que hoy funcione.
{
  const dte = Object.create(DTE.prototype);
  const xml =
    `<DTE xmlns="${NS}" xmlns:xsi="${XSI}" version="1.0"><Documento ID="F2T33">` +
    '<Detalle><NmbItem>Panuelo AFECTO</NmbItem><Extra>a &amp; b &lt; c</Extra></Detalle>' +
    '</Documento></DTE>';

  const c14n = dte._c14nDocumento(new DOMParser().parseFromString(xml, 'application/xml'));

  assert.strictEqual(
    sha1(c14n),
    sha1(`<Documento xmlns="${NS}" xmlns:xsi="${XSI}" ID="F2T33">`
      + '<Detalle><NmbItem>Panuelo AFECTO</NmbItem><Extra>a &amp; b &lt; c</Extra></Detalle>'
      + '</Documento>'),
    'sin apóstrofes ni comillas el digest es el mismo de siempre: &, < y > se siguen escapando');
  console.log('✓ Sin apóstrofes: el digest no cambia (&, < y > siguen escapados)');
}

console.log('\nTodos los checks de canonicalización pasaron.');
