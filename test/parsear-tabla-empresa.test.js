'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SiiPortalAuth = require('../SiiPortalAuth');

// Fixtures sinteticas (datos inventados, repo publico) que reproducen el patron real de
// las paginas del SII involucradas, sin copiar texto literal ni datos identificables.

const PAGINA_EMPRESA_NO_AUTORIZADA = `
  <html><body>
    <h1>Actualizacion de Datos del Contribuyente</h1>
    <p>A traves de esta opcion usted podra actualizar tanto los antecedentes de los usuarios
    como del Contribuyente que representa.</p>
    <p>No ha sido posible completar su solicitud. Esto debido a que el Contribuyente no
    esta autorizado para operar en esta modalidad.</p>
  </body></html>
`;

function paginaConTabla({ fechaResol, nroResol } = {}) {
  return `
    <html><body>
      <table>
        <tr><td>DATOS DEL CONTRIBUYENTE RUT</td><td>&nbsp;12345678-9</td></tr>
        <tr><td>NOMBRE O RAZ&Oacute;N SOCIAL</td><td>&nbsp;EMPRESA EJEMPLO SPA</td></tr>
        ${fechaResol ? `<tr><td>FECHA RESOLUCION</td><td>&nbsp;${fechaResol}</td></tr>` : ''}
        ${nroResol ? `<tr><td>RESOLUCION</td><td>&nbsp;${nroResol}</td></tr>` : ''}
      </table>
    </body></html>
  `;
}

test('_parsearTablaEmpresa lanza EMPRESA_NO_AUTORIZADA cuando la empresa nunca fue postulada/enrolada', () => {
  assert.throws(
    () => SiiPortalAuth._parsearTablaEmpresa(PAGINA_EMPRESA_NO_AUTORIZADA),
    (e) => e.code === 'EMPRESA_NO_AUTORIZADA' && /no.*autorizada.*operar/i.test(e.message),
    'debe distinguir este caso del generico de "no se encontraron datos de resolucion"'
  );
});

test('_parsearTablaEmpresa lanza el generico solo cuando de verdad no hay campos (caso adversarial: pagina vacia sin el mensaje de no-autorizada)', () => {
  assert.throws(
    () => SiiPortalAuth._parsearTablaEmpresa('<html><body>pagina vacia sin relacion</body></html>'),
    (e) => e.code !== 'EMPRESA_NO_AUTORIZADA' && /no se encontraron datos de resoluci/i.test(e.message),
  );
});

test('_parsearTablaEmpresa parsea normal cuando la tabla trae fecha y numero de resolucion', () => {
  const datos = SiiPortalAuth._parsearTablaEmpresa(paginaConTabla({ fechaResol: '01-08-2026', nroResol: '80' }));
  assert.equal(datos.fch_resol, '2026-08-01');
  assert.equal(datos.nro_resol, 80);
});
