// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Módulo de Certificación SII
 * 
 * Proporciona todo lo necesario para ejecutar el proceso de
 * certificación de facturación electrónica del SII de Chile.
 * 
 * Componentes:
 * - CertRunner: Orquestador del proceso completo
 * - Sets: SetBasico, SetExenta, SetGuia, SetCompra
 * - Libros: LibroVentasCert, LibroComprasCert, LibroGuiasCert
 * - Simulacion: Etapa 2 del proceso
 * 
 * @module dte-sii/cert
 * @example
 * const { CertRunner, SetBasico } = require('@devlas/dte-sii/cert');
 * 
 * const runner = new CertRunner(config);
 * await runner.ejecutar();
 */

// Tipos y constantes
const types = require('./types');

// Helpers existentes
const CertFolioHelper = require('./CertFolioHelper');
// Configuración centralizada
const ConfigLoader = require('./ConfigLoader');
// Parser de sets de prueba
const SetParser = require('./SetParser');
// Clase base
const SetBase = require('./SetBase');

// Obtención de sets de prueba (Fase 2)
const SetsProvider = require('./SetsProvider');

// ═══════════════════════════════════════════════════════════════
// SETS
// ═══════════════════════════════════════════════════════════════

// Fase 3 - Sets migrados ✅
const SetBasico = require('./SetBasico');
const SetGuia = require('./SetGuia');
const SetExenta = require('./SetExenta');
const SetCompra = require('./SetCompra');

// ═══════════════════════════════════════════════════════════════
// LIBROS (Fase 4) ✅
// ═══════════════════════════════════════════════════════════════

const LibroVentas = require('./LibroVentas');
const LibroCompras = require('./LibroCompras');
const LibroGuias = require('./LibroGuias');

// ═══════════════════════════════════════════════════════════════
// RUNNER Y SIMULACIÓN
// ═══════════════════════════════════════════════════════════════

const CertRunner = require('./CertRunner');

// Fase 6 - Simulación ✅
const Simulacion = require('./Simulacion');

// ═══════════════════════════════════════════════════════════════
// BOLETAS ELECTRÓNICAS
// ═══════════════════════════════════════════════════════════════

const BoletaCert = require('./BoletaCert');

// ═══════════════════════════════════════════════════════════════
// INTERCAMBIO DE INFORMACIÓN
// ═══════════════════════════════════════════════════════════════

const IntercambioCert = require('./IntercambioCert');

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Tipos y constantes
  ...types,
  
  // Helpers existentes (v1)
  CertFolioHelper,
  
  // Configuración centralizada
  ConfigLoader,
  loadConfig: ConfigLoader.loadConfig,
  printBanner: ConfigLoader.printBanner,
  
  // Parser de sets de prueba
  SetParser,
  
  // Clases base
  SetBase,
  
  // Obtención de sets (Fase 2)
  SetsProvider,
  
  // Sets
  SetBasico,
  SetGuia,
  SetExenta,
  SetCompra,
  
  // Libros (Fase 4) ✅
  LibroVentas,
  LibroCompras,
  LibroGuias,
  
  // Runner (orquestador principal)
  CertRunner,
  
  // Simulación (Fase 6) ✅
  Simulacion,
  
  // Boletas Electrónicas
  BoletaCert,
  
  // Intercambio de Información
  IntercambioCert,
};
