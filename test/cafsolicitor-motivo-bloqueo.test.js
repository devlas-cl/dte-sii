'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CafSolicitor } = require('../index.js');

// Estructura sintética que reproduce el patrón real de la página de bloqueo de
// timbraje del SII (verificado 2026-09-03 contra un caso real de producción, sin
// copiar el texto literal ni ningún dato identificable — ver CLAUDE.md: este repo
// es público, los fixtures son inventados).
function paginaBloqueo(motivo, { conBoilerplateFinal = true } = {}) {
  return `
    <html><body>
      <h1>Solicitud de Timbraje Electronico de Documentos</h1>
      <p>En esta pagina podra solicitar rangos de numeracion para utilizar en los
      Documentos Tributarios Electronicos autorizados para los contribuyentes.</p>
      <p><b>NO AUTORIZA TIMBRAJE ELECTRoNICA</b> - ${motivo}</p>
      ${conBoilerplateFinal ? '<p>Si necesita mas informacion comuniquese con la Mesa de ayuda SII Internet.</p>' : ''}
    </body></html>
  `;
}

test('extraerMotivoBloqueoTimbraje aísla el motivo real, no el boilerplate de la página', () => {
  const html = paginaBloqueo(
    'Sr. Contribuyente: de acuerdo a nuestros registros, usted tiene disponible una ' +
    'cantidad de folios suficiente para emitir documentos electronicos. Para habilitar ' +
    'nuevamente el timbraje, debe emitir y enviar documentos electronicos al SII o anular folios.'
  );
  const motivo = CafSolicitor.extraerMotivoBloqueoTimbraje(html);
  assert.ok(motivo, 'debe extraer algo');
  assert.ok(motivo.startsWith('NO AUTORIZA TIMBRAJE'), 'empieza en el marcador, no en el título de la página');
  assert.ok(motivo.includes('tiene disponible una'), 'conserva el motivo real');
  assert.ok(!motivo.includes('En esta pagina podra solicitar'), 'no arrastra el párrafo introductorio');
  assert.ok(!motivo.includes('Mesa de ayuda'), 'corta antes del boilerplate final');
});

test('extraerMotivoBloqueoTimbraje funciona sin el boilerplate final (caso adversarial: motivo al final de la página)', () => {
  const html = paginaBloqueo('Sr. Contribuyente: situacion tributaria pendiente de regularizar.', { conBoilerplateFinal: false });
  const motivo = CafSolicitor.extraerMotivoBloqueoTimbraje(html);
  assert.ok(motivo, 'debe extraer igual sin el cierre estándar');
  assert.ok(motivo.includes('situacion tributaria pendiente'));
});

test('extraerMotivoBloqueoTimbraje devuelve null si la página no tiene el marcador', () => {
  const html = '<html><body><p>Página sin relación con timbraje.</p></body></html>';
  assert.equal(CafSolicitor.extraerMotivoBloqueoTimbraje(html), null);
});

test('esBloqueoTimbraje sigue detectando el bloqueo igual que antes (no se tocó su contrato)', () => {
  const html = paginaBloqueo('Sr. Contribuyente: cualquier motivo.');
  assert.equal(CafSolicitor.esBloqueoTimbraje(html), true);
});
