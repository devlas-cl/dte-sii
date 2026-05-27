// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SiiSessionStore.js
 *
 * Registro compartido en memoria de cookies de sesión del portal SII.
 * Permite que SiiPortalAuth y CafSolicitor/SiiSession usen la misma sesión
 * portal sin abrir conexiones duplicadas, independiente del orden de ejecución.
 *
 * Clave:  cert hash (SHA1[:12] del PEM del certificado) — único por certificado PFX.
 * Valor:  cookie string "KEY=val; KEY2=val2" — formato que acepta SiiSession.cookieJar.
 */

'use strict';

const _store = new Map();

module.exports = {
  get(certHash)                { return _store.get(certHash) ?? null; },
  set(certHash, cookieString)  { _store.set(certHash, cookieString); },
  delete(certHash)             { _store.delete(certHash); },
  entries()                    { return _store.entries(); },
  clear()                      { _store.clear(); },
};
