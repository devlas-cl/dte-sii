'use strict';

const assert = require('node:assert/strict');
const { DOMParser } = require('@xmldom/xmldom');
const DTE = require('../DTE');

const base = {
  Encabezado: { IdDoc: { TipoDTE: 33, Folio: 1, FchEmis: '2026-08-24' },
    Emisor: {}, Receptor: {}, Totales: { MntTotal: 0 } }, Detalle: []
};

const ordinary = Object.create(DTE.prototype);
ordinary.documentElementName = 'Documento'; ordinary.id = 'F1T33';
const exportDte = Object.create(DTE.prototype);
exportDte.documentElementName = 'Exportaciones'; exportDte.id = 'F1T110';

assert.match(ordinary._c14nDocumento(new DOMParser().parseFromString('<DTE><Documento ID="F1T33"></Documento></DTE>')), /^<Documento/);
assert.match(exportDte._c14nDocumento(new DOMParser().parseFromString('<DTE><Exportaciones ID="F1T110"></Exportaciones></DTE>')), /^<Exportaciones/);

// The default remains the ordinary branch: callers that do not opt in retain
// the exact historical element name.
assert.equal(new DTE(base).documentElementName, 'Documento');
