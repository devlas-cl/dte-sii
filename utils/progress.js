// Copyright (c) 2026 Devlas SpA
// Sistema de progreso estructurado para el runner de certificacion SII.
// El runner y la libreria emiten lineas [PROGRESS]{...json...} que la API
// parsea sin regex frágiles sobre texto libre.

const STEPS = {
  // Autenticacion
  AUTH_INIT:          'AUTH_INIT',
  AUTH_OK:            'AUTH_OK',
  // Sets
  SETS_DOWNLOADING:   'SETS_DOWNLOADING',
  SETS_LOADED:        'SETS_LOADED',
  // CAFs
  CAF_REQUESTING:     'CAF_REQUESTING',   // data: { tipo }
  CAF_OK:             'CAF_OK',           // data: { tipo }
  // Ejecucion de sets
  SET_START:          'SET_START',        // data: { set }
  SET_SIGNING:        'SET_SIGNING',      // data: { set }
  SET_SENDING:        'SET_SENDING',      // data: { set }
  SET_OK:             'SET_OK',           // data: { set, trackId }
  SET_ERROR:          'SET_ERROR',        // data: { set, error }
  // Declaracion
  SETS_DECLARING:     'SETS_DECLARING',
  SETS_DECLARED:      'SETS_DECLARED',
  // Polling aprobacion sets
  POLLING:            'POLLING',          // data: { intento, max }
  SET_APPROVED:       'SET_APPROVED',     // data: { set }
  SETS_APPROVED:      'SETS_APPROVED',
  SETS_REJECTED:      'SETS_REJECTED',
  // Libros (Fase 4)
  BOOKS_START:        'BOOKS_START',
  BOOK_SENDING:       'BOOK_SENDING',     // data: { book }
  BOOK_OK:            'BOOK_OK',          // data: { book, trackId }
  BOOK_SKIPPED:       'BOOK_SKIPPED',     // data: { book }
  BOOK_ERROR:         'BOOK_ERROR',       // data: { book, error }
  BOOKS_DECLARING:    'BOOKS_DECLARING',
  BOOKS_DONE:         'BOOKS_DONE',
  // Avance (Fase 5)
  ADVANCE_WAITING:    'ADVANCE_WAITING',
  ADVANCE_DONE:       'ADVANCE_DONE',
  // Simulacion (Fase 6)
  SIM_START:          'SIM_START',
  SIM_SENDING:        'SIM_SENDING',
  SIM_OK:             'SIM_OK',           // data: { trackId }
  SIM_DECLARING:      'SIM_DECLARING',
  SIM_POLLING:        'SIM_POLLING',      // data: { intento, max }
  SIM_DONE:           'SIM_DONE',
  // Intercambio (Fase 7)
  INTERCAMBIO_START:  'INTERCAMBIO_START',
  INTERCAMBIO_DONE:   'INTERCAMBIO_DONE',
  // Muestras impresas (Fase 8)
  MUESTRAS_START:     'MUESTRAS_START',
  MUESTRAS_PDFS:      'MUESTRAS_PDFS',
  MUESTRAS_UPLOADING: 'MUESTRAS_UPLOADING',
  MUESTRAS_DONE:      'MUESTRAS_DONE',
  // Boleta electronica
  BOLETA_START:       'BOLETA_START',
  BOLETA_SENDING:     'BOLETA_SENDING',
  BOLETA_OK:          'BOLETA_OK',
  BOLETA_DECLARING:   'BOLETA_DECLARING',
  BOLETA_DONE:        'BOLETA_DONE',
  // Fin
  CERT_DONE:          'CERT_DONE',
  CERT_ERROR:         'CERT_ERROR',       // data: { error }
};

/**
 * Emite una linea de progreso estructurada a stdout.
 * Formato: [PROGRESS]{"step":"...","clave":"valor",...}
 *
 * @param {string} step  - Una de las constantes STEPS
 * @param {Object} [data] - Datos adicionales opcionales
 */
function emitProgress(step, data = {}) {
  process.stdout.write(`[PROGRESS]${JSON.stringify({ step, ...data })}\n`);
}

module.exports = { STEPS, emitProgress };
