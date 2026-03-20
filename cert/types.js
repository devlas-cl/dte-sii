// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Tipos e interfaces para módulo de Certificación SII
 * 
 * Define las estructuras de datos comunes usadas por:
 * - Sets de prueba (SetBasico, SetExenta, SetGuia, SetCompra)
 * - Libros (Ventas, Compras, Guías)
 * - Runner de certificación
 * 
 * @module dte-sii/cert/types
 */

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

/**
 * Tipos de DTE por set de certificación
 */
const SETS_DTE = {
  basico: [33, 56, 61],      // Factura, ND, NC
  exenta: [34],              // Factura Exenta
  guia: [52],                // Guía de Despacho
  compra: [46],              // Factura de Compra
};

/**
 * Labels para cada set
 */
const SET_LABELS = {
  basico: 'Set Básico (Facturas)',
  exenta: 'Set Factura Exenta',
  guia: 'Set Guía Despacho',
  compra: 'Set Factura Compra',
};

/**
 * Orden de ejecución de sets (crítico para SII)
 */
const SET_ORDER = ['basico', 'guia', 'exenta', 'compra'];

/**
 * Tipos de libro
 */
const LIBRO_TYPES = {
  ventas: 'VENTAS',
  compras: 'COMPRAS',
  guias: 'GUIAS',
};

// ═══════════════════════════════════════════════════════════════
// ESTRUCTURAS DE CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} EmisorConfig
 * @property {string} rut - RUT completo con DV (ej: "76123456-7")
 * @property {string} razonSocial - Razón social
 * @property {string} giro - Giro comercial
 * @property {string} acteco - Código de actividad económica
 * @property {string} direccion - Dirección
 * @property {string} comuna - Comuna
 * @property {string} [ciudad] - Ciudad (opcional)
 */

/**
 * @typedef {Object} ReceptorConfig
 * @property {string} rut - RUT completo con DV
 * @property {string} razonSocial - Razón social
 * @property {string} giro - Giro comercial
 * @property {string} direccion - Dirección
 * @property {string} comuna - Comuna
 */

/**
 * @typedef {Object} ResolucionConfig
 * @property {number} numero - Número de resolución (0 para certificación)
 * @property {string} fecha - Fecha resolución (YYYY-MM-DD)
 */

/**
 * @typedef {Object} CertificadoConfig
 * @property {string} path - Ruta al archivo .pfx
 * @property {string} password - Contraseña del certificado
 */

/**
 * Configuración completa para certificación
 * @typedef {Object} CertConfig
 * @property {EmisorConfig} emisor
 * @property {ReceptorConfig} receptor
 * @property {CertificadoConfig} certificado
 * @property {ResolucionConfig} resolucion
 * @property {string} ambiente - 'certificacion' | 'produccion'
 * @property {string} debugDir - Directorio para XMLs de debug
 */

// ═══════════════════════════════════════════════════════════════
// ESTRUCTURAS DE RESULTADO
// ═══════════════════════════════════════════════════════════════

/**
 * Resultado de un DTE individual generado
 * @typedef {Object} DteResult
 * @property {number} tipo - Tipo de DTE (33, 34, etc.)
 * @property {number} folio - Folio asignado
 * @property {string} id - ID del documento (ej: "T33F123")
 * @property {number} montoTotal - Monto total del DTE
 */

/**
 * Resultado de ejecución de un Set
 */
class SetResult {
  constructor() {
    /** @type {boolean} */
    this.success = false;
    
    /** @type {string|null} - Track ID del SII */
    this.trackId = null;
    
    /** @type {DteResult[]} - DTEs generados */
    this.dtes = [];
    
    /** @type {Object[]} - Documentos con totales para libros */
    this.documentos = [];
    
    /** @type {string[]} - Errores encontrados */
    this.errors = [];
    
    /** @type {string|null} - Path al XML enviado */
    this.xmlPath = null;
    
    /** @type {string|null} - Path al XML de respuesta */
    this.responsePath = null;
    
    /** @type {number} - Duración en ms */
    this.duration = 0;
    
    /** @type {string} - Timestamp de ejecución */
    this.timestamp = new Date().toISOString();
  }

  /**
   * Crea un resultado exitoso
   * @param {Object} data
   * @returns {SetResult}
   */
  static success(data = {}) {
    const result = new SetResult();
    result.success = true;
    result.trackId = data.trackId || null;
    result.dtes = data.dtes || [];
    result.documentos = data.documentos || []; // Para libros
    result.xmlPath = data.xmlPath || null;
    result.responsePath = data.responsePath || null;
    result.duration = data.duration || 0;
    return result;
  }

  /**
   * Crea un resultado fallido
   * @param {string|string[]} errors
   * @returns {SetResult}
   */
  static failure(errors) {
    const result = new SetResult();
    result.success = false;
    result.errors = Array.isArray(errors) ? errors : [errors];
    return result;
  }

  /**
   * Agrega un DTE al resultado
   * @param {DteResult} dte
   */
  addDte(dte) {
    this.dtes.push(dte);
  }

  /**
   * Agrega un error
   * @param {string} error
   */
  addError(error) {
    this.errors.push(error);
    this.success = false;
  }
}

/**
 * Resultado de ejecución de un Libro
 */
class LibroResult {
  constructor() {
    /** @type {boolean} */
    this.success = false;
    
    /** @type {string|null} - Track ID del SII */
    this.trackId = null;
    
    /** @type {string} - Tipo: VENTAS, COMPRAS, GUIAS */
    this.tipo = '';
    
    /** @type {string} - Período YYYYMM */
    this.periodo = '';
    
    /** @type {number} - Total de documentos en el libro */
    this.totalDocumentos = 0;
    
    /** @type {string[]} */
    this.errors = [];
    
    /** @type {string|null} */
    this.xmlPath = null;
  }

  static success(data = {}) {
    const result = new LibroResult();
    result.success = true;
    Object.assign(result, data);
    return result;
  }

  static failure(errors) {
    const result = new LibroResult();
    result.success = false;
    result.errors = Array.isArray(errors) ? errors : [errors];
    return result;
  }
}

/**
 * Resultado completo del runner de certificación
 */
class CertRunnerResult {
  constructor() {
    /** @type {boolean} */
    this.success = false;
    
    /** @type {string} - Timestamp de inicio */
    this.started = new Date().toISOString();
    
    /** @type {string|null} - Timestamp de fin */
    this.finished = null;
    
    /** @type {Object.<string, SetResult>} - Resultados por set */
    this.sets = {};
    
    /** @type {Object.<string, LibroResult>} - Resultados por libro */
    this.libros = {};
    
    /** @type {SetResult|null} - Resultado de simulación */
    this.simulacion = null;
    
    /** @type {Object|null} - Estado de avance del SII */
    this.avance = null;
    
    /** @type {string[]} */
    this.errors = [];
  }

  /**
   * Calcula el resumen de la ejecución
   * @returns {Object}
   */
  getSummary() {
    const setKeys = Object.keys(this.sets);
    const libroKeys = Object.keys(this.libros);
    
    return {
      setsTotal: setKeys.length,
      setsOk: setKeys.filter(k => this.sets[k].success).length,
      librosTotal: libroKeys.length,
      librosOk: libroKeys.filter(k => this.libros[k].success).length,
      simulacionOk: this.simulacion?.success || false,
      duracion: this.finished 
        ? new Date(this.finished) - new Date(this.started) 
        : null,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// ESTRUCTURAS DE CASOS (del SII)
// ═══════════════════════════════════════════════════════════════

/**
 * Item de un caso de prueba
 * @typedef {Object} CasoItem
 * @property {string} nombre - Nombre del item
 * @property {number} cantidad - Cantidad
 * @property {number} precio - Precio unitario (neto)
 * @property {number} [descuentoPct] - Descuento porcentual
 */

/**
 * Caso de prueba del SII
 * @typedef {Object} CasoPrueba
 * @property {string} id - ID del caso (ej: "4668070-1")
 * @property {number} tipoDte - Tipo de DTE
 * @property {CasoItem[]} items - Items del documento
 * @property {number} [descuentoGlobalPct] - Descuento global %
 * @property {Object} [referencia] - Referencia a otro documento
 */

/**
 * Estructura de un set de pruebas parseado del SII
 * @typedef {Object} SetEstructura
 * @property {Object} cafRequired - { 33: 5, 56: 2, 61: 3 }
 * @property {CasoPrueba[]} casos - Lista de casos
 */

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Constantes
  SETS_DTE,
  SET_LABELS,
  SET_ORDER,
  LIBRO_TYPES,
  
  // Clases de resultado
  SetResult,
  LibroResult,
  CertRunnerResult,
};
