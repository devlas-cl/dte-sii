// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * constants.js - Constantes centralizadas del SII
 * 
 * Centraliza todas las constantes relacionadas con tipos de documentos,
 * códigos y configuraciones del SII.
 * 
 * @module utils/constants
 */

/**
 * Tipos de Documentos Tributarios Electrónicos
 */
const TIPOS_DTE = {
  FACTURA: 33,
  FACTURA_ELECTRONICA: 33,
  FACTURA_EXENTA: 34,
  FACTURA_EXENTA_ELECTRONICA: 34,
  BOLETA: 39,
  BOLETA_ELECTRONICA: 39,
  BOLETA_EXENTA: 41,
  BOLETA_EXENTA_ELECTRONICA: 41,
  LIQUIDACION_FACTURA: 43,
  FACTURA_COMPRA: 46,
  FACTURA_COMPRA_ELECTRONICA: 46,
  GUIA_DESPACHO: 52,
  GUIA_DESPACHO_ELECTRONICA: 52,
  NOTA_DEBITO: 56,
  NOTA_DEBITO_ELECTRONICA: 56,
  NOTA_CREDITO: 61,
  NOTA_CREDITO_ELECTRONICA: 61,
};

/**
 * Tipos que son boletas (no requieren receptor identificado)
 */
const TIPOS_BOLETA = [39, 41];

/**
 * Tipos exentos de IVA
 */
const TIPOS_EXENTOS = [34, 41];

/**
 * Tipos que son notas (requieren referencia)
 */
const TIPOS_NOTAS = [56, 61];

/**
 * Tipos que son facturas
 */
const TIPOS_FACTURA = [33, 34, 46];

/**
 * Tipos que requieren receptor identificado
 */
const TIPOS_RECEPTOR_REQUERIDO = [33, 34, 46, 52, 56, 61];

/**
 * Nombres de los tipos de DTE
 */
const NOMBRES_DTE = {
  33: 'Factura Electrónica',
  34: 'Factura Exenta Electrónica',
  39: 'Boleta Electrónica',
  41: 'Boleta Exenta Electrónica',
  43: 'Liquidación Factura Electrónica',
  46: 'Factura de Compra Electrónica',
  52: 'Guía de Despacho Electrónica',
  56: 'Nota de Débito Electrónica',
  61: 'Nota de Crédito Electrónica',
  110: 'Factura de Exportación Electrónica',
  111: 'Nota de Débito de Exportación Electrónica',
  112: 'Nota de Crédito de Exportación Electrónica',
};

/**
 * Nombres de DTE para muestras impresas (mayúsculas según Manual SII)
 */
const NOMBRES_DTE_IMPRESOS = {
  33: 'FACTURA ELECTRÓNICA',
  34: 'FACTURA NO AFECTA O EXENTA ELECTRÓNICA',
  39: 'BOLETA ELECTRÓNICA',
  41: 'BOLETA EXENTA ELECTRÓNICA',
  43: 'LIQUIDACIÓN FACTURA ELECTRÓNICA',
  46: 'FACTURA DE COMPRA ELECTRÓNICA',
  52: 'GUÍA DE DESPACHO ELECTRÓNICA',
  56: 'NOTA DE DÉBITO ELECTRÓNICA',
  61: 'NOTA DE CRÉDITO ELECTRÓNICA',
  110: 'FACTURA DE EXPORTACIÓN ELECTRÓNICA',
  111: 'NOTA DE DÉBITO DE EXPORTACIÓN ELECTRÓNICA',
  112: 'NOTA DE CRÉDITO DE EXPORTACIÓN ELECTRÓNICA',
};

/**
 * Tipos que requieren copia cedible y recuadro de acuse de recibo
 */
const TIPOS_CEDIBLES = [33, 34, 52, 46, 43];

/**
 * Tipos que NO tienen cedible ni acuse (notas)
 */
const TIPOS_NO_CEDIBLES = [56, 61, 111, 112];

/**
 * Texto del acuse de recibo según Res. 51/2005
 */
const DECLARACION_RECIBO = 'El acuse de recibo que se declara en este acto, de acuerdo a lo dispuesto en la letra b) del Art. 4°, y la letra c) del Art. 5° de la Ley 19.983, acredita que la entrega de mercaderías o servicio(s) prestado(s) ha(n) sido recibido(s).';

/**
 * Nombres cortos de los tipos de DTE
 */
const NOMBRES_DTE_CORTOS = {
  33: 'FACTURA',
  34: 'FACTURA EXENTA',
  39: 'BOLETA',
  41: 'BOLETA EXENTA',
  43: 'LIQUIDACION FACTURA',
  46: 'FACTURA COMPRA',
  52: 'GUIA DESPACHO',
  56: 'NOTA DEBITO',
  61: 'NOTA CREDITO',
};

/**
 * Códigos de referencia según SII
 */
const CODIGOS_REFERENCIA = {
  ANULA: 1,           // Anula documento de referencia
  CORRIGE_TEXTO: 2,   // Corrige texto del documento de referencia
  CORRIGE_MONTOS: 3,  // Corrige montos
  SET_PRUEBAS: 0,     // Referencia a set de pruebas (certificación)
};

/**
 * Tipos de traslado para Guías de Despacho
 */
const TIPOS_TRASLADO = {
  OPERACION_CONSTITUYE_VENTA: 1,
  VENTAS_POR_EFECTUAR: 2,
  CONSIGNACIONES: 3,
  ENTREGA_GRATUITA: 4,
  TRASLADOS_INTERNOS: 5,
  OTROS_NO_VENTA: 6,
  GUIA_DEVOLUCION: 7,
  TRASLADO_EXPORTACION: 8,
  VENTA_EXPORTACION: 9,
};

/**
 * Nombres de tipos de traslado para muestras impresas
 */
const NOMBRES_TRASLADO = {
  1: 'Operación constituye venta',
  2: 'Ventas por efectuar',
  3: 'Consignaciones',
  4: 'Entrega gratuita',
  5: 'Traslados internos',
  6: 'Otros traslados no venta',
  7: 'Guía de devolución',
  8: 'Traslado para exportación (no venta)',
  9: 'Venta para exportación',
};

/**
 * Tipos de despacho
 */
const TIPOS_DESPACHO = {
  DESPACHO_POR_CUENTA_RECEPTOR: 1,
  DESPACHO_POR_CUENTA_EMISOR_LUGAR_RECEPTOR: 2,
  DESPACHO_POR_CUENTA_EMISOR_OTRAS_INSTALACIONES: 3,
};

/**
 * Indicadores de servicio (para boletas)
 */
const INDICADORES_SERVICIO = {
  SERVICIOS_PERIODICOS: 1,
  SERVICIOS_PERIODICOS_DOMICILIARIOS: 2,
  VENTAS_SERVICIOS: 3,          // Más común
  ESPECTACULOS_EMITIDOS: 4,
};

/**
 * Formas de pago
 */
const FORMAS_PAGO = {
  CONTADO: 1,
  CREDITO: 2,
  SIN_COSTO: 3,
};

/**
 * Tasa de IVA vigente (19%)
 */
const TASA_IVA = 19;

/**
 * RUT del consumidor final genérico
 */
const RUT_CONSUMIDOR_FINAL = '66666666-6';

/**
 * IDK para CAFs de certificación
 */
const IDK_CERTIFICACION = 100;

/**
 * Verificar si un tipo es boleta
 * @param {number} tipo - Tipo de DTE
 * @returns {boolean}
 */
function esBoleta(tipo) {
  return TIPOS_BOLETA.includes(Number(tipo));
}

/**
 * Verificar si un tipo es exento
 * @param {number} tipo - Tipo de DTE
 * @returns {boolean}
 */
function esExento(tipo) {
  return TIPOS_EXENTOS.includes(Number(tipo));
}

/**
 * Verificar si un tipo es nota (NC o ND)
 * @param {number} tipo - Tipo de DTE
 * @returns {boolean}
 */
function esNota(tipo) {
  return TIPOS_NOTAS.includes(Number(tipo));
}

/**
 * Verificar si un tipo requiere receptor identificado
 * @param {number} tipo - Tipo de DTE
 * @returns {boolean}
 */
function requiereReceptor(tipo) {
  return TIPOS_RECEPTOR_REQUERIDO.includes(Number(tipo));
}

/**
 * Obtener nombre del tipo de DTE
 * @param {number} tipo - Tipo de DTE
 * @param {boolean} [corto=false] - Si usar nombre corto
 * @returns {string}
 */
function getNombreDte(tipo, corto = false) {
  const nombres = corto ? NOMBRES_DTE_CORTOS : NOMBRES_DTE;
  return nombres[Number(tipo)] || `Tipo ${tipo}`;
}

/**
 * Validar tipo de DTE
 * @param {number} tipo - Tipo a validar
 * @returns {boolean}
 */
function esTipoValido(tipo) {
  return Object.values(TIPOS_DTE).includes(Number(tipo));
}

module.exports = {
  // Tipos
  TIPOS_DTE,
  TIPOS_BOLETA,
  TIPOS_EXENTOS,
  TIPOS_NOTAS,
  TIPOS_FACTURA,
  TIPOS_RECEPTOR_REQUERIDO,
  TIPOS_CEDIBLES,
  TIPOS_NO_CEDIBLES,
  
  // Nombres
  NOMBRES_DTE,
  NOMBRES_DTE_CORTOS,
  NOMBRES_DTE_IMPRESOS,
  NOMBRES_TRASLADO,
  
  // Códigos
  CODIGOS_REFERENCIA,
  TIPOS_TRASLADO,
  TIPOS_DESPACHO,
  INDICADORES_SERVICIO,
  FORMAS_PAGO,
  
  // Constantes
  TASA_IVA,
  RUT_CONSUMIDOR_FINAL,
  IDK_CERTIFICACION,
  DECLARACION_RECIBO,
  
  // Funciones
  esBoleta,
  esExento,
  esNota,
  requiereReceptor,
  getNombreDte,
  esTipoValido,
};
