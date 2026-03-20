// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * ConfigLoader - Carga configuración de certificación desde .env
 * 
 * Centraliza la carga de configuración para que los runners (CLI)
 * no necesiten módulos intermedios.
 * 
 * @module dte-sii/cert/ConfigLoader
 */

const path = require('path');
const fs = require('fs');

/**
 * Carga configuración desde .env y retorna objetos estructurados
 * 
 * @param {Object} options
 * @param {string} [options.envPath] - Ruta al archivo .env (por defecto busca en static/nodejs/.env)
 * @param {string} [options.baseDir] - Directorio base para resolver rutas relativas
 * @returns {Object} Configuración estructurada { EMISOR, RECEPTOR, CERT_PATH, CERT_PASS, AMBIENTE, BASE_DIR, ... }
 */
function loadConfig(options = {}) {
  // Determinar baseDir
  const baseDir = options.baseDir || path.resolve(__dirname, '..', '..', '..');
  
  // Cargar .env
  const envPath = options.envPath || path.join(baseDir, '.env');
  
  if (!fs.existsSync(envPath)) {
    throw new Error(`Archivo .env no encontrado: ${envPath}\nCopia .env.example a .env y configura tus valores.`);
  }
  
  // Usar dotenv para cargar
  require('dotenv').config({ path: envPath });
  
  // Resolver rutas relativas
  const resolvePath = (filePath) => {
    if (!filePath) return null;
    return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
  };
  
  // Validar variables requeridas
  const required = ['CERT_PATH', 'EMISOR_RUT', 'EMISOR_RAZON_SOCIAL'];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Variables de entorno faltantes: ${missing.join(', ')}`);
  }
  
  // Construir objetos de configuración
  const AMBIENTE = process.env.SII_AMBIENTE || 'certificacion';

  const fch_resol = process.env.FECHA_RESOLUCION || new Date().toISOString().slice(0, 10);
  const nro_resol = parseInt(process.env.NRO_RESOLUCION || '0', 10);

  console.log(`[ConfigLoader] ✅ Resolución: NroResol=${nro_resol} FchResol=${fch_resol} (AMBIENTE=${AMBIENTE})`);

  const EMISOR = {
    rut: process.env.EMISOR_RUT,
    razon_social: process.env.EMISOR_RAZON_SOCIAL,
    giro: process.env.EMISOR_GIRO || 'ACTIVIDADES DE PROGRAMACION INFORMATICA',
    acteco: process.env.EMISOR_ACTECO || '620200',
    direccion: process.env.EMISOR_DIRECCION || '',
    comuna: process.env.EMISOR_COMUNA || 'Santiago',
    ciudad: process.env.EMISOR_CIUDAD || 'Santiago',
    fch_resol,
    nro_resol,
  };
  
  const RECEPTOR = {
    rut: process.env.RECEPTOR_RUT || '66666666-6',
    razon_social: process.env.RECEPTOR_RAZON_SOCIAL || 'CLIENTE TEST',
    giro: process.env.RECEPTOR_GIRO || 'ACTIVIDADES VARIAS',
    direccion: process.env.RECEPTOR_DIRECCION || 'AVENIDA PRINCIPAL 123',
    comuna: process.env.RECEPTOR_COMUNA || 'Santiago',
    ciudad: process.env.RECEPTOR_CIUDAD || 'Santiago',
  };
  
  const CERT_PATH = resolvePath(process.env.CERT_PATH);
  const CERT_PASS  = process.env.CERT_PASS || '';
  
  // Configuración SII
  const SII_CONFIG = {
    sendDelayMs: parseInt(process.env.SII_SEND_DELAY_MS || '8000', 10),
    sendRetries: parseInt(process.env.SII_SEND_RETRIES || '6', 10),
    cafRetries: parseInt(process.env.SII_CAF_RETRIES || '3', 10),
    reuseFolios: process.env.SII_REUSE_FOLIOS === 'true',
  };
  
  // Enviador (quien firma/envía)
  const ENVIADOR = {
    rut: process.env.ENVIADOR_RUT || EMISOR.rut,
  };
  
  return {
    EMISOR,
    RECEPTOR,
    CERT_PATH,
    CERT_PASS,
    AMBIENTE,
    BASE_DIR: baseDir,
    SII_CONFIG,
    ENVIADOR,
    
    // Helper para crear config de CertRunner
    toCertRunnerConfig() {
      return {
        certificado: { path: CERT_PATH, password: CERT_PASS },
        emisor: EMISOR,
        receptor: RECEPTOR,
        ambiente: AMBIENTE,
        resolucion: { fecha: EMISOR.fch_resol, numero: EMISOR.nro_resol },
        baseDir: baseDir,
        debugDir: path.join(baseDir, 'debug', 'cert-v2'),
      };
    },
  };
}

/**
 * Imprime banner de sección para CLI
 * @param {string} titulo
 */
function printBanner(titulo) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${titulo}`);
  console.log('═'.repeat(60));
}

module.exports = {
  loadConfig,
  printBanner,
};
