'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CafSolicitor } = require('../index.js');

// Fixtures sinteticas (repo publico): reproducen la redaccion de la pagina de solicitud de
// timbraje cuando el SII bloquea a la persona autenticada. Sin datos de ningun contribuyente.

const CABECERA = `
  <html><head><style>.titulo { font-family: arial; font-size: 14pt; }</style></head><body>
    <h1>SOLICITUD DE TIMBRAJE ELECTRONICO DE DOCUMENTOS</h1>
    <p>En esta p&aacute;gina podr&aacute; solicitar rangos de numeraci&oacute;n para utilizar en los
    Documentos Tributarios Electr&oacute;nicos autorizados para los contribuyentes.</p>
`;

const PAGINA_PERSONA_BLOQUEADA = `${CABECERA}
    <p>La persona autenticada no puede realizar tr&aacute;mites de Factura Electr&oacute;nica, ya que
    tiene situaciones pendientes con el SII. Para regularizarlas debe concurrir a la Unidad del SII
    que corresponda a su jurisdicci&oacute;n.</p>
  </body></html>`;

const PAGINA_FORMULARIO_NORMAL = `${CABECERA}
    <form action="/cvc_cgi/dte/of_confirma_folio" method="post">
      <select name="COD_DOCTO"><option value="39">BOLETA ELECTRONICA</option></select>
    </form>
  </body></html>`;

test('esPersonaConSituacionesPendientes detecta el bloqueo de la persona autenticada', () => {
  assert.equal(CafSolicitor.esPersonaConSituacionesPendientes(PAGINA_PERSONA_BLOQUEADA), true);
});

test('lo detecta aunque la frase quede pasados los 400 caracteres de textoVisible por defecto', () => {
  const relleno = '<p>' + 'texto de relleno '.repeat(60) + '</p>';
  const html = PAGINA_PERSONA_BLOQUEADA.replace('<p>La persona', relleno + '<p>La persona');
  assert.ok(CafSolicitor.textoVisible(html).length <= 400);
  assert.equal(CafSolicitor.esPersonaConSituacionesPendientes(html), true);
});

test('no se activa con un formulario normal de solicitud de folios', () => {
  assert.equal(CafSolicitor.esPersonaConSituacionesPendientes(PAGINA_FORMULARIO_NORMAL), false);
  assert.equal(CafSolicitor.esPersonaConSituacionesPendientes(''), false);
  assert.equal(CafSolicitor.esPersonaConSituacionesPendientes(null), false);
});

test('es un rechazo duro: el flujo no sigue de largo ni se reintenta', () => {
  assert.equal(CafSolicitor.esRechazoDuro(PAGINA_PERSONA_BLOQUEADA), true);
  assert.equal(CafSolicitor.esRechazoDuro(PAGINA_FORMULARIO_NORMAL), false);
});
