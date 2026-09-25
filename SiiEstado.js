// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiEstado.js
 *
 * Decide qué StateStore usa un componente de la librería para su estado persistente:
 *   1. el que se le pasó explícitamente (`options.estado`),
 *   2. si no, el configurado para todo el proceso con `SiiPortalAuth.configurarSesion({ estado })`,
 *   3. si no, archivos en `dir`, que es lo que la librería hacía siempre.
 */

'use strict';

const { FileStateStore, validarStateStore } = require('./SiiSessionPorts');

/**
 * @param {string} dir directorio de los archivos cuando no hay store configurado
 * @param {StateStore} [explicito]
 * @returns {StateStore}
 */
function resolverEstado(dir, explicito) {
  if (explicito) return validarStateStore(explicito, 'resolverEstado');
  // require perezoso: SiiPortalAuth depende de SiiSessionPorts, no al revés
  const configurado = require('./SiiPortalAuth').estadoConfigurado();
  return configurado || new FileStateStore(dir);
}

module.exports = { resolverEstado };
