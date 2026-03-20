// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Clases de Envío (EnvioBOLETA, EnvioDTE)
 * 
 * Sobres para agrupar múltiples DTEs y enviar al SII
 */

const Signer = require('./Signer');

// ============================================
// CLASE BASE ENVIO
// ============================================

class EnvioBase {
  constructor(config) {
    this.certificado = config.certificado;
    this.config = config;
    this.dtes = [];
    this.caratula = null;
    this.setId = null;
    this.xml = null;
    this.xmlSinFirma = null;
  }
  
  /**
   * Agregar un DTE al sobre
   */
  agregar(dte) {
    // Auto-generar si tiene certificado/caf guardados
    if (dte._certificado && dte._caf && !dte.xml) {
      dte.generarXML();
      dte.timbrar(dte._caf);
      dte.firmar(dte._certificado);
    }
    this.dtes.push(dte);
    return this;
  }
  
  /**
   * Calcular subtotales por tipo de DTE
   */
  _getSubTotDTE() {
    const tipos = {};
    for (const dte of this.dtes) {
      const tipo = dte.datos.Encabezado.IdDoc.TipoDTE;
      if (!tipos[tipo]) tipos[tipo] = 0;
      tipos[tipo]++;
    }
    return Object.entries(tipos).map(([tipo, cantidad]) => ({
      TpoDTE: parseInt(tipo, 10),
      NroDTE: cantidad,
    }));
  }
  
  /**
   * Generar timestamp para firma
   */
  _generateTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '');
  }
  
  /**
   * Generar SetId con formato específico
   */
  _generateSetId(prefix) {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${prefix}_${dd}_${mm}_${yyyy}_${hh}_${min}`;
  }
  
  /**
   * Extraer XML de DTEs sin declaration
   */
  _extractDTEsXml() {
    return this.dtes.map(dte => {
      return dte.getXML()
        .replace('<?xml version="1.0" encoding="ISO-8859-1"?>', '')
        .replace('<?xml version="1.0"?>', '')
        .trim();
    }).join('\n');
  }
  
  getXML() { return this.xml; }
  getXMLSinFirma() { return this.xmlSinFirma; }
}

// ============================================
// CLASE ENVIOBOLETA
// ============================================

// DD-MM-YYYY → YYYY-MM-DD (xs:date requerido por EnvioBOLETA_v11.xsd y ConsumoFolios.xsd)
function _normDateXsd(d) {
  if (!d) return d;
  const m = String(d).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
}

class EnvioBOLETA extends EnvioBase {
  setCaratula(caratula) {
    this.setId = this._generateSetId('ENVIOBOLETA');
    const timestamp = caratula.TmstFirmaEnv || this._generateTimestamp();
    
    this.caratula = {
      RutEmisor: caratula.RutEmisor,
      RutEnvia: caratula.RutEnvia,
      RutReceptor: '60803000-K', // Siempre SII para boletas
      FchResol: _normDateXsd(caratula.FchResol),
      NroResol: caratula.NroResol,
      TmstFirmaEnv: timestamp,
      SubTotDTE: this._getSubTotDTE(),
    };
    
    return this;
  }
  
  generar() {
    if (!this.dtes.length) throw new Error('No hay DTEs para enviar');
    if (!this.caratula) throw new Error('Falta carátula');
    
    const subTotDTEs = this.caratula.SubTotDTE
      .map(s => `<SubTotDTE><TpoDTE>${s.TpoDTE}</TpoDTE><NroDTE>${s.NroDTE}</NroDTE></SubTotDTE>`)
      .join('');
    
    const xmlBase = `<?xml version="1.0" encoding="ISO-8859-1"?>
<EnvioBOLETA xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sii.cl/SiiDte EnvioBOLETA_v11.xsd" version="1.0"><SetDTE ID="${this.setId}"><Caratula version="1.0"><RutEmisor>${this.caratula.RutEmisor}</RutEmisor><RutEnvia>${this.caratula.RutEnvia}</RutEnvia><RutReceptor>${this.caratula.RutReceptor}</RutReceptor><FchResol>${this.caratula.FchResol}</FchResol><NroResol>${this.caratula.NroResol}</NroResol><TmstFirmaEnv>${this.caratula.TmstFirmaEnv}</TmstFirmaEnv>${subTotDTEs}</Caratula><!-- DTES_PLACEHOLDER --></SetDTE></EnvioBOLETA>`;
    
    const dtesXml = this._extractDTEsXml();
    this.xmlSinFirma = xmlBase.replace('<!-- DTES_PLACEHOLDER -->', dtesXml);
    
    const signer = new Signer(this.certificado);
    this.xml = signer.firmarSetDTE(this.xmlSinFirma, this.setId, 'EnvioBOLETA');
    
    return this.xml;
  }
}

// ============================================
// CLASE ENVIODTE
// ============================================

class EnvioDTE extends EnvioBase {
  setCaratula(caratula) {
    this.setId = caratula.SetDTEId || caratula.SetId || this._generateSetId('DTE_SetDoc');
    const timestamp = this._generateTimestamp();
    
    // Ordenar subtotales (33, 61, 56 primero)
    const subTotDTE = this._getSubTotDTE().sort((a, b) => {
      const orden = [33, 61, 56];
      const idxA = orden.indexOf(a.TpoDTE);
      const idxB = orden.indexOf(b.TpoDTE);
      if (idxA === -1 && idxB === -1) return a.TpoDTE - b.TpoDTE;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
    
    this.caratula = {
      RutEmisor: caratula.RutEmisor,
      RutEnvia: caratula.RutEnvia,
      RutReceptor: caratula.RutReceptor || '',
      FchResol: caratula.FchResol,
      NroResol: caratula.NroResol,
      TmstFirmaEnv: timestamp,
      SubTotDTE: subTotDTE,
    };
    
    return this;
  }
  
  generar() {
    if (!this.dtes.length) throw new Error('No hay DTEs para enviar');
    if (!this.caratula) throw new Error('Falta carátula');
    
    const subTotDTEs = this.caratula.SubTotDTE
      .map(s => `<SubTotDTE><TpoDTE>${s.TpoDTE}</TpoDTE><NroDTE>${s.NroDTE}</NroDTE></SubTotDTE>`)
      .join('');
    
    const xmlBase = `<?xml version="1.0" encoding="ISO-8859-1"?>
<EnvioDTE xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sii.cl/SiiDte EnvioDTE_v10.xsd" version="1.0"><SetDTE ID="${this.setId}"><Caratula version="1.0"><RutEmisor>${this.caratula.RutEmisor}</RutEmisor><RutEnvia>${this.caratula.RutEnvia}</RutEnvia><RutReceptor>${this.caratula.RutReceptor}</RutReceptor><FchResol>${this.caratula.FchResol}</FchResol><NroResol>${this.caratula.NroResol}</NroResol><TmstFirmaEnv>${this.caratula.TmstFirmaEnv}</TmstFirmaEnv>${subTotDTEs}</Caratula><!-- DTES_PLACEHOLDER --></SetDTE></EnvioDTE>`;
    
    const dtesXml = this._extractDTEsXml();
    this.xmlSinFirma = xmlBase.replace('<!-- DTES_PLACEHOLDER -->', dtesXml);
    
    const signer = new Signer(this.certificado);
    this.xml = signer.firmarSetDTE(this.xmlSinFirma, this.setId, 'EnvioDTE');
    
    return this.xml;
  }
}

module.exports = { EnvioBase, EnvioBOLETA, EnvioDTE };
