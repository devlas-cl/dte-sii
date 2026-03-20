// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * CafSolicitor.js - Solicitador de CAFs al SII
 * 
 * Módulo interno del core para solicitar Códigos de Autorización de Folios (CAF)
 * directamente al SII. Usa SiiSession para evitar duplicación de código.
 * 
 * Migrado desde: scripts/cert/test-caf-solicitar.js
 * Refactorizado: Usa SiiSession para HTTP y utilidades
 * 
 * @module CafSolicitor
 */

const fs = require('fs');
const path = require('path');
const SiiSession = require('./SiiSession');
const { splitRut } = require('./utils/rut');

/**
 * Clase para solicitar CAFs al SII
 */
class CafSolicitor {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} options.ambiente - 'certificacion' o 'produccion'
   * @param {string} options.rutEmisor - RUT del emisor (ej: 76192083-9)
   * @param {string} options.pfxPath - Ruta absoluta al certificado PFX
   * @param {string} options.pfxPassword - Contraseña del certificado
   * @param {string} [options.baseDir] - Directorio base para guardar archivos
   * @param {string} [options.sessionPath] - Ruta al archivo de sesión compartida
   * @param {string} [options.runStamp] - Timestamp de la ejecución
   */
  constructor(options = {}) {
    if (!options.ambiente) {
      throw new Error('CafSolicitor: options.ambiente es obligatorio');
    }
    if (!options.rutEmisor) {
      throw new Error('CafSolicitor: options.rutEmisor es obligatorio');
    }
    if (!options.pfxPath) {
      throw new Error('CafSolicitor: options.pfxPath es obligatorio');
    }
    if (!options.pfxPassword) {
      throw new Error('CafSolicitor: options.pfxPassword es obligatorio');
    }

    this.ambiente = options.ambiente.toLowerCase();
    this.rutEmisor = options.rutEmisor;
    this.baseDir = options.baseDir || path.resolve(__dirname, '..', '..');
    this.sessionPath = options.sessionPath || null;
    this.runStamp = options.runStamp || new Date().toISOString().replace(/[:.]/g, '-');

    // Crear SiiSession para manejar HTTP y cookies
    this.session = new SiiSession({
      ambiente: this.ambiente,
      pfxPath: options.pfxPath,
      pfxPassword: options.pfxPassword,
    });

    // Cargar sesión compartida si existe
    if (this.sessionPath) {
      const loaded = this.session.loadSession(this.sessionPath);
      if (loaded) {
        console.log('[CafSolicitor] ✓ Usando sesión compartida');
      }
    }
  }

  /**
   * Crea directorio para debug de esta solicitud
   * @private
   */
  _getDebugDir(tipoDte) {
    const rutClean = String(this.rutEmisor).replace(/\./g, '').toUpperCase();
    const runDir = path.join(this.baseDir, 'debug', 'auto-caf', rutClean, this.runStamp, String(tipoDte));
    fs.mkdirSync(runDir, { recursive: true });
    return runDir;
  }

  /**
   * Guarda respuesta de debug
   * @private
   */
  _saveDebug(debugDir, filename, content) {
    const filePath = path.join(debugDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`${filename}`);
  }

  /**
   * Extrae información del CAF desde XML
   * @private
   */
  _extractCafInfo(xml, tipoDte) {
    const tdMatch = xml.match(/<TD>(\d+)<\/TD>/i);
    const dMatch = xml.match(/<D>(\d+)<\/D>/i);
    const hMatch = xml.match(/<H>(\d+)<\/H>/i);
    const faMatch = xml.match(/<FA>(\d{4}-\d{2}-\d{2})<\/FA>/i);
    
    return {
      tipoDte: tdMatch ? tdMatch[1] : tipoDte,
      folioDesde: dMatch ? dMatch[1] : 'unknown',
      folioHasta: hMatch ? hMatch[1] : 'unknown',
      fechaAutorizacion: faMatch ? faMatch[1] : new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * Guarda el CAF en ubicación organizada
   * @private
   */
  _saveCafOrganized(xml, tipoDte) {
    const info = this._extractCafInfo(xml, tipoDte);
    const rutClean = this.rutEmisor.replace(/\./g, '').toUpperCase();
    
    const cafDir = path.join(
      this.baseDir, 'debug', 'caf', this.ambiente,
      rutClean, String(info.tipoDte), this.runStamp
    );
    fs.mkdirSync(cafDir, { recursive: true });
    
    const cafFileName = `caf-${info.tipoDte}-${info.folioDesde}-${info.folioHasta}.xml`;
    const cafPath = path.join(cafDir, cafFileName);
    fs.writeFileSync(cafPath, xml, 'utf-8');
    
    console.log(`✅ CAF guardado: ${cafFileName}`);
    console.log(`   Ruta: ${cafPath}`);
    
    return cafPath;
  }

  /**
   * Detecta si la respuesta del SII requiere autenticación con certificado.
   * @private
   */
  _requiresAuthentication(responseBody = '') {
    if (!responseBody || typeof responseBody !== 'string') return false;

    return (
      responseBody.includes('Autenticaci') ||
      responseBody.includes('autInicioDTE.cgi') ||
      responseBody.includes('cgi_AUT2000') ||
      responseBody.includes('302 Found')
    );
  }

  /**
   * Solicita un CAF al SII
   * @param {Object} params - Parámetros
   * @param {number} params.tipoDte - Tipo de DTE (33, 34, 39, 56, 61, etc.)
   * @param {number} [params.cantidad=1] - Cantidad de folios a solicitar
   * @returns {Promise<Object>} - { success, cafPath, xml, error }
   */
  async solicitar({ tipoDte, cantidad = 1 }) {
    const { numero: rut, dv } = splitRut(this.rutEmisor);
    const debugDir = this._getDebugDir(tipoDte);
    
    console.log('─'.repeat(60));
    console.log(`[CafSolicitor] Solicitando CAF tipo ${tipoDte} x${cantidad}`);
    console.log(`   RUT: ${this.rutEmisor} | Ambiente: ${this.ambiente}`);

    try {
      // Paso 1: POST inicial a of_solicita_folios
      const fields = {
        RUT_EMP: rut,
        DV_EMP: dv,
        COD_DOCTO: tipoDte,
        CANTIDAD: cantidad,
      };

      let response = await this.session.submitForm('/cvc_cgi/dte/of_solicita_folios', fields);

      // Manejar autenticación si es necesaria (incluye 302 a autInicioDTE)
      if (this._requiresAuthentication(response.body)) {
        const authResult = await this.session.ensureSession('/cvc_cgi/dte/of_solicita_folios');
        if (authResult.body) {
          // Reintentar después de autenticación
          response = await this.session.submitForm('/cvc_cgi/dte/of_solicita_folios', fields);
        }
        
        // Guardar sesión para reutilización
        if (this.sessionPath) {
          this.session.saveSession(this.sessionPath);
        }
      }

      // Procesar flujo multi-paso del SII
      response = await this._processMultiStepFlow(response, rut, dv, tipoDte, cantidad, debugDir);

      // Guardar respuesta final
      this._saveDebug(debugDir, `caf-final-${this.runStamp}.html`, response.body || '');

      // Verificar si obtuvimos el CAF
      if (response.body && response.body.includes('<AUTORIZACION')) {
        const cafPath = this._saveCafOrganized(response.body, tipoDte);
        return { success: true, cafPath, xml: response.body };
      }

      if (response.body && response.body.includes('Autenticaci')) {
        return { success: false, error: 'El SII devolvió página de autenticación' };
      }

      return { success: false, error: 'No se obtuvo CAF en la respuesta' };

    } catch (err) {
      console.error(`[CafSolicitor] Error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Procesa el flujo multi-paso del SII para obtener CAF
   * @private
   */
  async _processMultiStepFlow(response, rut, dv, tipoDte, cantidad, debugDir) {
    let currentHtml = response.body || '';

    // Paso 2: of_solicita_folios_dcto
    if (currentHtml.includes('of_solicita_folios_dcto')) {
      const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_solicita_folios_dcto';
      const hiddenInputs = SiiSession.extractInputValues(currentHtml);

      const step2Fields = {
        ...hiddenInputs,
        RUT_EMP: rut,
        DV_EMP: dv,
      };

      response = await this.session.submitForm(formAction, step2Fields);
      currentHtml = response.body || '';
      this._saveDebug(debugDir, `step2-${this.runStamp}.html`, currentHtml);

      // Selección de tipo de documento
      if (currentHtml.includes('COD_DOCTO')) {
        const selectInputs = SiiSession.extractInputValues(currentHtml);
        const selectFields = {
          ...selectInputs,
          RUT_EMP: rut,
          DV_EMP: dv,
          COD_DOCTO: tipoDte,
        };

        response = await this.session.submitForm('/cvc_cgi/dte/of_solicita_folios_dcto', selectFields);
        currentHtml = response.body || '';
        this._saveDebug(debugDir, `select-${this.runStamp}.html`, currentHtml);
      }

      // Paso 3: Solicitar numeración
      response = await this._processStep3(response, rut, dv, tipoDte, cantidad, debugDir);
    }

    return response;
  }

  /**
   * Procesa paso 3 y siguientes
   * @private
   */
  async _processStep3(response, rut, dv, tipoDte, cantidad, debugDir) {
    let currentHtml = response.body || '';
    
    const formAction3 = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_confirma_folio';
    const inputs3 = SiiSession.extractInputValues(currentHtml);
    
    const step3Fields = {
      ...inputs3,
      RUT_EMP: rut,
      DV_EMP: dv,
      COD_DOCTO: tipoDte,
      CANT_DOCTOS: cantidad,
      ACEPTAR: 'Solicitar Numeración',
    };

    response = await this.session.submitForm(formAction3, step3Fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, `step3-${this.runStamp}.html`, currentHtml);

    // Confirmar folio inicial
    if (currentHtml.includes('of_confirma_folio')) {
      response = await this._processConfirmFolio(response, debugDir);
    } else if (currentHtml.includes('of_genera_folio')) {
      response = await this._processGeneraFolio(response, debugDir);
    }

    return response;
  }

  /**
   * Procesa confirmación de folio
   * @private
   */
  async _processConfirmFolio(response, debugDir) {
    let currentHtml = response.body || '';
    
    const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_confirma_folio';
    const inputs = SiiSession.extractInputValues(currentHtml);
    
    const fields = {
      ...inputs,
      FOLIO_INICIAL: inputs.FOLIO_INICIAL || '1',
      ACEPTAR: 'Confirmar Folio Inicial',
    };

    response = await this.session.submitForm(formAction, fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, `confirm-${this.runStamp}.html`, currentHtml);

    if (currentHtml.includes('of_genera_folio')) {
      response = await this._processGeneraFolio(response, debugDir);
    }

    return response;
  }

  /**
   * Procesa generación de folio
   * @private
   */
  async _processGeneraFolio(response, debugDir) {
    let currentHtml = response.body || '';
    
    const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_genera_folio';
    const inputs = SiiSession.extractInputValues(currentHtml);
    
    const fields = {
      ...inputs,
      ACEPTAR: 'Obtener Folios',
    };

    response = await this.session.submitForm(formAction, fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, `genera-${this.runStamp}.html`, currentHtml);

    // Paso final: of_genera_archivo
    if (!currentHtml.includes('<AUTORIZACION') && currentHtml.includes('of_genera_archivo')) {
      response = await this._processGeneraArchivo(response, debugDir);
    }

    return response;
  }

  /**
   * Procesa generación de archivo CAF
   * @private
   */
  async _processGeneraArchivo(response, debugDir) {
    let currentHtml = response.body || '';
    
    const formAction = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_genera_archivo';
    const inputs = SiiSession.extractInputValues(currentHtml);
    
    const fields = {
      ...inputs,
      ACEPTAR: 'AQUI',
    };

    response = await this.session.submitForm(formAction, fields);
    currentHtml = response.body || '';
    this._saveDebug(debugDir, `archivo-${this.runStamp}.xml`, currentHtml);

    // A veces hay un paso extra
    if (!currentHtml.includes('<AUTORIZACION') && currentHtml.includes('of_genera_archivo')) {
      const formAction2 = SiiSession.extractFormAction(currentHtml) || '/cvc_cgi/dte/of_genera_archivo';
      const inputs2 = SiiSession.extractInputValues(currentHtml);
      
      const fields2 = {
        ...inputs2,
        ACEPTAR: 'AQUI',
      };

      response = await this.session.submitForm(formAction2, fields2);
      this._saveDebug(debugDir, `archivo2-${this.runStamp}.xml`, response.body || '');
    }

    return response;
  }
}

module.exports = CafSolicitor;
