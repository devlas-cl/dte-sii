// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * SetParser - Parseo de Sets de Prueba del SII
 * 
 * Extrae casos de prueba del HTML/texto descargado del portal SII
 * y genera estructuras compatibles con los módulos de certificación.
 * 
 * @module dte-sii/cert/SetParser
 */

// ═══════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES
// ═══════════════════════════════════════════════════════════════

/**
 * Detecta el tipo de set según el nombre
 */
function detectarTipoSet(nombreSet) {
  const nombre = nombreSet.toUpperCase();
  if (nombre.includes('LIBRO DE COMPRAS PARA EXENTOS')) return 'LIBRO_COMPRAS_EXENTOS';
  if (nombre.includes('LIBRO DE COMPRAS')) return 'LIBRO_COMPRAS';
  if (nombre.includes('LIBRO DE VENTAS')) return 'LIBRO_VENTAS';
  if (nombre.includes('LIBRO DE GUIAS')) return 'LIBRO_GUIAS';
  if (nombre.includes('GUIA DE DESPACHO') || nombre.includes('GUIA')) return 'GUIA_DESPACHO';
  if (nombre.includes('FACTURA EXENTA') || nombre.includes('NO AFECTA')) return 'FACTURA_EXENTA';
  if (nombre.includes('EXPORTACION')) return 'EXPORTACION';
  if (nombre.includes('LIQUIDACION')) return 'LIQUIDACION';
  if (nombre.includes('FACTURA DE COMPRA') || nombre.includes('EMISOR DE FACTURA DE COMPRA')) return 'FACTURA_COMPRA';
  if (nombre.includes('BASICO')) return 'BASICO';
  return 'OTRO';
}

/**
 * Detecta el tipo DTE a partir del nombre del documento
 */
function detectarTipoDTE(documento) {
  if (!documento) return null;
  const doc = documento.toUpperCase();

  if (doc.includes('LIQUIDACION') || doc.includes('LIQUIDACI')) {
    return { codigo: 43, nombre: 'Liquidación Factura' };
  }
  if (doc.includes('FACTURA DE COMPRA')) {
    return { codigo: 46, nombre: 'Factura de Compra' };
  }
  if (doc.includes('FACTURA DE EXPORTACION') || doc.includes('FACTURA DE EXPORTACI')) {
    return { codigo: 110, nombre: 'Factura de Exportación' };
  }
  if (doc.includes('NOTA DE CREDITO') && doc.includes('EXPORTACION')) {
    return { codigo: 112, nombre: 'NC Exportación' };
  }
  if (doc.includes('NOTA DE DEBITO') && doc.includes('EXPORTACION')) {
    return { codigo: 111, nombre: 'ND Exportación' };
  }
  if (doc.includes('NO AFECTA') || doc.includes('EXENTA')) {
    return { codigo: 34, nombre: 'Factura Exenta' };
  }
  if (doc.includes('GUIA DE DESPACHO') || doc.includes('GUIA')) {
    return { codigo: 52, nombre: 'Guía de Despacho' };
  }
  if (doc.includes('NOTA DE CREDITO') || doc.includes('NOTA DE CRÉDITO')) {
    return { codigo: 61, nombre: 'Nota de Crédito' };
  }
  if (doc.includes('NOTA DE DEBITO') || doc.includes('NOTA DE DÉBITO')) {
    return { codigo: 56, nombre: 'Nota de Débito' };
  }
  if (doc.includes('FACTURA')) {
    return { codigo: 33, nombre: 'Factura Electrónica' };
  }

  return null;
}

/**
 * Determina código de referencia según razón
 */
function determinarCodRef(razon) {
  if (!razon) return 1;
  const r = razon.toUpperCase();
  if (r.includes('ANULA')) return 1;
  if (r.includes('CORRIGE') && r.includes('GIRO')) return 2;
  if (r.includes('CORRIGE') && r.includes('TEXTO')) return 2;
  if (r.includes('DEVOLUCION')) return 3;
  if (r.includes('MODIFICA')) return 3;
  return 1;
}

/**
 * Determina indicador de traslado para guías
 */
function determinarIndTraslado(motivo) {
  if (!motivo) return 1;
  const m = motivo.toUpperCase();
  if (m.includes('TRASLADO') && (m.includes('INTERNO') || m.includes('BODEGA'))) return 5;
  if (m.includes('VENTA')) return 1;
  if (m.includes('CONSIGNACION')) return 2;
  if (m.includes('ENTREGA GRATUITA')) return 3;
  if (m.includes('COMPROBANTE')) return 4;
  if (m.includes('TRASLADO')) return 5;
  if (m.includes('DEVOLUCION')) return 6;
  return 1;
}

/**
 * Determina tipo de despacho
 */
function determinarTpoDespacho(trasladoPor) {
  if (!trasladoPor) return null;
  const t = trasladoPor.toUpperCase();
  // IMPORTANTE: Buscar EMISOR primero porque frases como
  // "EMISOR DEL DOCUMENTO AL LOCAL DEL CLIENTE" contienen ambas palabras
  if (t.includes('EMISOR')) return 2;
  if (t.includes('CLIENTE')) return 1;
  return null;
}

/**
 * Mapea tipo documento de texto a código SII
 */
function mapearTipoDocLibro(tipo) {
  const t = tipo.toUpperCase();
  if (t.includes('FACTURA DE COMPRA ELECTRONICA')) return 46;
  if (t.includes('FACTURA EXENTA ELECTRONICA') || (t.includes('NO AFECTA') && t.includes('ELECTRONICA'))) return 34;
  if (t.includes('FACTURA ELECTRONICA')) return 33;
  if (t.includes('FACTURA EXENTA') || t.includes('FACTURA NO AFECTA')) return 30; // exenta papel
  if (t === 'FACTURA') return 30; // factura afecta papel → TpoDoc=30 (regular libro); exentos libro usa lógica especial
  if (t.includes('NOTA DE CREDITO') && (t.includes('ELECTRONICA') || t.includes('ELECTRONICO'))) return 61;
  if (t.includes('NOTA DE CREDITO')) return 60;
  if (t.includes('NOTA DE DEBITO') && (t.includes('ELECTRONICA') || t.includes('ELECTRONICO'))) return 56;
  if (t.includes('NOTA DE DEBITO')) return 55;
  return null;
}

// ═══════════════════════════════════════════════════════════════
// PARSER PRINCIPAL
// ═══════════════════════════════════════════════════════════════

/**
 * Extrae los casos de prueba del texto del set descargado del SII
 * 
 * @param {string} texto - Texto plano del set (HTML limpio)
 * @returns {Object} Datos extraídos con sets y casos
 */
function extraerCasosDelSet(texto) {
  const resultado = {
    sets: [],
    totalCasos: 0,
  };

  const lineas = texto.split('\n');

  let setActual = null;
  let casoActual = null;
  let enCabecera = false;
  let enLibroCompras = false;
  let enLibroComprasExentos = false;
  let docActual = null;
  let esperandoMontos = false;

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    const lineaTrim = linea.trim();

    // Detectar inicio de SET
    // Regex flexible: ATENCION puede tener tilde corrupta (ï¿½), tilde UTF-8 (Ó) o sin tilde (O)
    const matchSet = lineaTrim.match(/^SET\s+(.+?)\s*[-:]\s*NUMERO DE ATENCI[^\d:]*[:\s]*(\d+)/i);
    if (matchSet) {
      // Guardar caso anterior si existe
      if (casoActual && setActual) {
        setActual.casos.push(casoActual);
        casoActual = null;
      }
      // Guardar documento actual del libro si existe
      if (docActual && setActual) {
        setActual.documentosLibro.push(docActual);
        docActual = null;
      }
      // Guardar set anterior si existe
      if (setActual) {
        resultado.sets.push(setActual);
      }

      const nombreSet = matchSet[1].trim();
      const tipoSet = detectarTipoSet(nombreSet);
      setActual = {
        nombre: nombreSet,
        numeroAtencion: matchSet[2],
        tipo: tipoSet,
        casos: [],
        instrucciones: [],
        documentosLibro: [], // Para SET LIBRO DE COMPRAS
        observaciones: null,
        factorProporcionalidad: null,
      };
      enLibroCompras = (tipoSet === 'LIBRO_COMPRAS');
      enLibroComprasExentos = (tipoSet === 'LIBRO_COMPRAS_EXENTOS');
      esperandoMontos = false;
      continue;
    }

    // Detectar inicio de CASO (formato: CASO 4670590-1)
    const matchCaso = lineaTrim.match(/^CASO\s+(\d+)-(\d+)\s*$/i);
    if (matchCaso) {
      // Guardar caso anterior si existe
      if (casoActual && setActual) {
        setActual.casos.push(casoActual);
      }
      // Guardar documento actual si existe
      if (docActual && setActual) {
        setActual.documentosLibro.push(docActual);
        docActual = null;
      }
      enLibroCompras = false;
      enLibroComprasExentos = false;

      casoActual = {
        setId: matchCaso[1],
        numeroCaso: parseInt(matchCaso[2]),
        id: `${matchCaso[1]}-${matchCaso[2]}`,
        documento: null,
        tipoDTE: null,
        items: [],
        referencia: null,
        razonReferencia: null,
        descuentoGlobal: null,
        motivo: null,
        trasladoPor: null,
        moneda: null,
        unidadMedida: null,
        // Campos de exportación
        formaPago: null,
        modalidadVenta: null,
        clausulaVenta: null,
        totalClausula: null,
        viaTransporte: null,
        puertoEmbarque: null,
        puertoDesembarque: null,
        tipoBulto: null,
        totalBultos: null,
        flete: null,
        seguro: null,
        paisDestino: null,
        comisionExtranjero: null,
        raw: [],
      };
      enCabecera = true;
      continue;
    }

    // Ignorar línea de separación ======
    if (lineaTrim.match(/^=+$/)) {
      enCabecera = false;
      continue;
    }

    // Si estamos en un caso, parsear contenido
    if (casoActual) {
      casoActual.raw.push(lineaTrim);

      // Detectar tipo de documento
      const matchDocumento = lineaTrim.match(/^DOCUMENTO\s+(.+)$/i);
      if (matchDocumento) {
        casoActual.documento = matchDocumento[1].trim();
        casoActual.tipoDTE = detectarTipoDTE(casoActual.documento);
        continue;
      }

      // Detectar referencia (puede tener : o no)
      const matchRef = lineaTrim.match(/^REFERENCIA[:\s]+(.+)$/i);
      if (matchRef) {
        casoActual.referencia = matchRef[1].trim();
        // Extraer caso referenciado
        const matchCasoRef = casoActual.referencia.match(/CASO\s+(\d+-\d+)/i);
        if (matchCasoRef) {
          casoActual.casoReferenciado = matchCasoRef[1];
        }
        continue;
      }

      // Detectar razón referencia
      const matchRazon = lineaTrim.match(/^RAZON\s+REFERENCIA\s+(.+)$/i);
      if (matchRazon) {
        casoActual.razonReferencia = matchRazon[1].trim();
        continue;
      }

      // Detectar motivo (para guías)
      const matchMotivo = lineaTrim.match(/^MOTIVO[:\s]+(.+)$/i);
      if (matchMotivo) {
        casoActual.motivo = matchMotivo[1].trim();
        continue;
      }

      // Detectar traslado por
      const matchTraslado = lineaTrim.match(/^TRASLADO\s+POR[:\s]+(.+)$/i);
      if (matchTraslado) {
        casoActual.trasladoPor = matchTraslado[1].trim();
        continue;
      }

      // Detectar descuento global
      const matchDescGlobal = lineaTrim.match(/^DESCUENTO\s+GLOBAL.+?(\d+)%/i);
      if (matchDescGlobal) {
        casoActual.descuentoGlobal = parseInt(matchDescGlobal[1]);
        continue;
      }

      // Detectar moneda
      const matchMoneda = lineaTrim.match(/^MONEDA\s+DE\s+LA\s+OPERACION[:\s]+(.+)$/i);
      if (matchMoneda) {
        casoActual.moneda = matchMoneda[1].trim();
        continue;
      }

      // ===== CAMPOS DE EXPORTACIÓN =====
      const matchFormaPago = lineaTrim.match(/^FORMA\s+DE\s+PAGO\s+EXPORTACION[:\s]+(.+)$/i);
      if (matchFormaPago) {
        casoActual.formaPago = matchFormaPago[1].trim();
        continue;
      }

      const matchModalidad = lineaTrim.match(/^MODALIDAD\s+DE\s+VENTA[:\s]+(.+)$/i);
      if (matchModalidad) {
        casoActual.modalidadVenta = matchModalidad[1].trim();
        continue;
      }

      const matchClausula = lineaTrim.match(/^CLAUSULA\s+DE\s+VENTA.+?[:\s]+(.+)$/i);
      if (matchClausula) {
        casoActual.clausulaVenta = matchClausula[1].trim();
        continue;
      }

      const matchTotalClausula = lineaTrim.match(/^TOTAL\s+CLAUSULA\s+DE\s+VENTA[:\s]+(.+)$/i);
      if (matchTotalClausula) {
        casoActual.totalClausula = parseFloat(matchTotalClausula[1].trim());
        continue;
      }

      const matchVia = lineaTrim.match(/^VIA\s+DE\s+TRANSPORTE[:\s]+(.+)$/i);
      if (matchVia) {
        casoActual.viaTransporte = matchVia[1].trim();
        continue;
      }

      const matchPuertoEmb = lineaTrim.match(/^PUERTO\s+DE\s+EMBARQUE[:\s]+(.+)$/i);
      if (matchPuertoEmb) {
        casoActual.puertoEmbarque = matchPuertoEmb[1].trim();
        continue;
      }

      const matchPuertoDes = lineaTrim.match(/^PUERTO\s+DE\s+DESEMBARQUE[:\s]+(.+)$/i);
      if (matchPuertoDes) {
        casoActual.puertoDesembarque = matchPuertoDes[1].trim();
        continue;
      }

      const matchTipoBulto = lineaTrim.match(/^TIPO\s+DE\s+BULTO[:\s]+(.+)$/i);
      if (matchTipoBulto) {
        casoActual.tipoBulto = matchTipoBulto[1].trim();
        continue;
      }

      const matchTotalBultos = lineaTrim.match(/^TOTAL\s+BULTOS[:\s]+(\d+)/i);
      if (matchTotalBultos) {
        casoActual.totalBultos = parseInt(matchTotalBultos[1]);
        continue;
      }

      const matchFlete = lineaTrim.match(/^FLETE[^:]*[:\s]+(.+)$/i);
      if (matchFlete) {
        casoActual.flete = parseFloat(matchFlete[1].trim());
        continue;
      }

      const matchSeguro = lineaTrim.match(/^SEGURO[^:]*[:\s]+(.+)$/i);
      if (matchSeguro) {
        casoActual.seguro = parseFloat(matchSeguro[1].trim());
        continue;
      }

      const matchPais = lineaTrim.match(/^PAIS\s+RECEPTOR.+?[:\s]+(.+)$/i);
      if (matchPais) {
        casoActual.paisDestino = matchPais[1].trim();
        continue;
      }
      
      const matchComision = lineaTrim.match(/^COMISIONES?\s+EN\s+EL\s+EXTRANJERO.+?(\d+)%/i);
      if (matchComision) {
        casoActual.comisionExtranjero = parseInt(matchComision[1]);
        continue;
      }

      // Ignorar cabeceras de items
      if (lineaTrim.match(/^ITEM\s+(CANTIDAD|VALOR)/i)) {
        continue;
      }

      // ===== PARSING DE ITEMS =====
      // Dividir por tabs o múltiples espacios para manejar diferentes formatos
      const partes = lineaTrim.split(/\t+|\s{2,}/).map(p => p.trim()).filter(p => p);

      // Formato con tabs: "NOMBRE    CANTIDAD    UNIDAD    PRECIO" o "NOMBRE    CANTIDAD    PRECIO    DESCUENTO"
      if (partes.length >= 2 && !lineaTrim.startsWith('DOCUMENTO') && !lineaTrim.startsWith('REFERENCIA')
          && !lineaTrim.startsWith('RAZON') && !lineaTrim.includes(':')) {

        const nombre = partes[0];

        // Ignorar si parece una cabecera
        if (nombre === 'ITEM' || nombre.includes('CANTIDAD') || nombre.includes('UNITARIO')) {
          continue;
        }

        // Detectar formato según número de partes
        if (partes.length === 4) {
          // Puede ser: NOMBRE, CANTIDAD, UNIDAD, PRECIO o NOMBRE, CANTIDAD, PRECIO, DESCUENTO
          const posibleUnidad = partes[2];
          if (posibleUnidad.match(/^[A-Za-z]+$/) && !posibleUnidad.includes('%')) {
            // Es una unidad de medida: NOMBRE, QTY, UNIDAD, PRECIO
            casoActual.items.push({
              nombre: nombre,
              cantidad: parseInt(partes[1]) || 1,
              unidadMedida: posibleUnidad,
              precioUnitario: parseInt(partes[3]) || 0,
            });
          } else {
            // Es descuento: NOMBRE, QTY, PRECIO, DESCUENTO
            casoActual.items.push({
              nombre: nombre,
              cantidad: parseInt(partes[1]) || 1,
              precioUnitario: parseInt(partes[2]) || 0,
              descuento: partes[3],
            });
          }
          continue;
        }

        if (partes.length === 3) {
          // NOMBRE, CANTIDAD, PRECIO/VALOR
          const qty = parseInt(partes[1]);
          const precio = parseInt(partes[2]);
          if (!isNaN(qty) && !isNaN(precio)) {
            casoActual.items.push({
              nombre: nombre,
              cantidad: qty,
              precioUnitario: precio,
            });
            continue;
          }
        }

        if (partes.length === 2) {
          // NOMBRE, CANTIDAD (guías sin precio) o NOMBRE, VALOR (NC/ND)
          const valor = parseInt(partes[1]);
          if (!isNaN(valor)) {
            // Para NC/ND que modifican monto, el segundo valor es el precio unitario modificado
            if (casoActual.razonReferencia?.includes('MODIFICA MONTO')) {
              casoActual.items.push({
                nombre: nombre,
                cantidad: 1,
                precioUnitario: valor,
              });
            } else {
              // Para guías o NC por devolución, es la cantidad
              casoActual.items.push({
                nombre: nombre,
                cantidad: valor,
              });
            }
            continue;
          }
        }
      }

      // Fallback: items con formato de espacios simples
      // "ITEM 1         56" - nombre con espacio, luego cantidad
      const matchItemSimple = lineaTrim.match(/^(ITEM\s+\d+|[A-Z][^0-9]+?)\s+(\d+)$/i);
      if (matchItemSimple) {
        casoActual.items.push({
          nombre: matchItemSimple[1].trim(),
          cantidad: parseInt(matchItemSimple[2]),
        });
        continue;
      }
    }

    // ===== SET LIBRO DE COMPRAS PARA EXENTOS =====
    // Formato columnar: TIPO  FOLIO  [MONTO_EXENTO]  [MONTO_AFECTO] (todo en una línea)
    // Observaciones van en línea siguiente con prefijo "OBS:"
    if (enLibroComprasExentos && setActual && !casoActual) {
      if (lineaTrim.includes('TIPO DOCUMENTO') && lineaTrim.includes('FOLIO')) continue;
      if (lineaTrim.includes('MONTO EXENTO') && lineaTrim.includes('MONTO AFECTO')) continue;
      if (lineaTrim.match(/^=+$/)) continue;

      // OBS: observación para el documento actual
      if (lineaTrim.match(/^OBS:/i)) {
        if (docActual) docActual.observacion = lineaTrim.replace(/^OBS:\s*/i, '').trim();
        continue;
      }

      // Parsear línea columnar: TIPO  FOLIO  [MONTO_EXENTO]  [MONTO_AFECTO]
      const partes = lineaTrim.split(/\t+|\s{2,}/).map(p => p.trim()).filter(p => p);
      if (partes.length >= 2 && /^\d+$/.test(partes[1])) {
        if (docActual) setActual.documentosLibro.push(docActual);
        const tipoDoc = partes[0].toUpperCase();
        docActual = {
          tipoDocumento: tipoDoc,
          folio: parseInt(partes[1]),
          observacion: null,
          montoExento: null,
          montoAfecto: null,
          ivaUsoComun: false,
          codigoIvaNoRec: null,
        };
        if (partes.length >= 4) {
          // Dos montos: exento + afecto
          docActual.montoExento = parseInt(partes[2]) || null;
          docActual.montoAfecto = parseInt(partes[3]) || null;
        } else if (partes.length === 3) {
          // Un monto: determinar columna por tipo de documento
          const esExento = /EXENTA|EXENTO|DEBITO/i.test(tipoDoc);
          if (esExento) docActual.montoExento = parseInt(partes[2]) || null;
          else docActual.montoAfecto = parseInt(partes[2]) || null;
        }
        continue;
      }
      continue;
    }

    // ===== SET LIBRO DE COMPRAS =====
    if (enLibroCompras && setActual && !casoActual) {
      // Detectar cabecera de tabla
      if (lineaTrim.includes('TIPO DOCUMENTO') && lineaTrim.includes('FOLIO')) {
        continue;
      }
      if (lineaTrim.includes('MONTO EXENTO') && lineaTrim.includes('MONTO AFECTO')) {
        continue;
      }

      // Detectar documento con folio
      // Formato: "FACTURA                234" o "FACTURA ELECTRONICA           32"
      const matchDocFolio = lineaTrim.match(/^(FACTURA DE COMPRA ELECTRONICA|FACTURA ELECTRONICA|FACTURA|NOTA DE CREDITO)\s+(\d+)\s*$/i);
      if (matchDocFolio) {
        // Guardar documento anterior si existe
        if (docActual) {
          setActual.documentosLibro.push(docActual);
        }
        docActual = {
          tipoDocumento: matchDocFolio[1].trim().toUpperCase(),
          folio: parseInt(matchDocFolio[2]),
          observacion: null,
          montoExento: null,
          montoAfecto: null,
          codigoIvaNoRec: null,
          ivaUsoComun: false,
        };
        esperandoMontos = false;
        continue;
      }

      // Detectar observación del documento
      if (docActual && !esperandoMontos) {
        // Líneas de observación conocidas
        if (lineaTrim.match(/^(FACTURA DEL GIRO|FACTURA CON IVA|NOTA DE CREDITO POR|ENTREGA GRATUITA|COMPRA CON RETENCION)/i)) {
          docActual.observacion = lineaTrim;
          // Detectar casos especiales
          if (lineaTrim.includes('IVA USO COMUN')) {
            docActual.ivaUsoComun = true;
          }
          if (lineaTrim.includes('ENTREGA GRATUITA')) {
            docActual.codigoIvaNoRec = 4; // IVA no recuperable - entrega gratuita
          }
          if (lineaTrim.includes('RETENCION TOTAL')) {
            docActual.retencionTotal = true;
          }
          esperandoMontos = true;
          continue;
        }
      }

      // Detectar montos (puede ser una o dos columnas)
      if (docActual && esperandoMontos) {
        // Formato: "   7893     3897" (exento afecto) o "          4305" (solo afecto)
        const matchDosMonto = lineaTrim.match(/^\s*(\d+)\s+(\d+)\s*$/);
        if (matchDosMonto) {
          docActual.montoExento = parseInt(matchDosMonto[1]);
          docActual.montoAfecto = parseInt(matchDosMonto[2]);
          esperandoMontos = false;
          continue;
        }

        // Solo monto afecto (con espacios iniciales)
        const matchUnMonto = lineaTrim.match(/^\s*(\d+)\s*$/);
        if (matchUnMonto) {
          docActual.montoAfecto = parseInt(matchUnMonto[1]);
          esperandoMontos = false;
          continue;
        }
      }

      // Detectar factor de proporcionalidad
      const matchFactor = lineaTrim.match(/FACTOR\s+DE\s+PROPORCIONALIDAD.+?(\d+\.?\d*)/i);
      if (matchFactor) {
        setActual.factorProporcionalidad = parseFloat(matchFactor[1]);
        setActual.observaciones = `Factor proporcionalidad IVA: ${matchFactor[1]}`;
        continue;
      }
    }

    // Línea separadora de sets
    if (lineaTrim.match(/^-{20,}$/)) {
      // Guardar caso actual si existe
      if (casoActual && setActual) {
        setActual.casos.push(casoActual);
        casoActual = null;
      }
      // Guardar documento actual si existe
      if (docActual && setActual) {
        setActual.documentosLibro.push(docActual);
        docActual = null;
      }
      enLibroCompras = false;
      enLibroComprasExentos = false;
      esperandoMontos = false;
      continue;
    }
  }

  // Guardar últimos elementos
  if (casoActual && setActual) {
    setActual.casos.push(casoActual);
  }
  if (docActual && setActual) {
    setActual.documentosLibro.push(docActual);
  }
  if (setActual) {
    resultado.sets.push(setActual);
  }

  // Contar total de casos
  for (const set of resultado.sets) {
    resultado.totalCasos += set.casos.length;
  }

  return resultado;
}

// ═══════════════════════════════════════════════════════════════
// GENERADORES DE ESTRUCTURAS
// ═══════════════════════════════════════════════════════════════

/**
 * Genera estructura para SET BASICO (Facturas 33, NC 61, ND 56)
 */
function generarEstructuraSetBasico(set) {
  const casosFactura = [];
  const casosNC = [];
  const casosND = [];

  for (const caso of set.casos) {
    const tipoCodigo = caso.tipoDTE?.codigo;

    if (tipoCodigo === 33) {
      casosFactura.push({
        id: caso.id,
        items: caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad,
          precio: item.precioUnitario,
          ...(item.descuento ? { descuentoPct: parseInt(item.descuento) } : {}),
          ...(item.nombre.includes('EXENTO') || item.nombre.includes('SERVICIO EXENTO') ? { exento: true } : {}),
        })),
        ...(caso.descuentoGlobal ? { descuentoGlobalPct: caso.descuentoGlobal } : {}),
      });
    } else if (tipoCodigo === 61) {
      casosNC.push({
        id: caso.id,
        tipoDte: 61,
        referenciaCaso: caso.casoReferenciado,
        codRef: determinarCodRef(caso.razonReferencia),
        razonRef: caso.razonReferencia,
        items: caso.items.length > 0 ? caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad,
          precio: item.precioUnitario || 0,
        })) : [{ nombre: caso.razonReferencia, cantidad: 1, precio: 0 }],
        ...(caso.razonReferencia?.includes('ANULA') ? { itemsFromCaso: caso.casoReferenciado } : {}),
      });
    } else if (tipoCodigo === 56) {
      casosND.push({
        id: caso.id,
        tipoDte: 56,
        referenciaCaso: caso.casoReferenciado,
        codRef: determinarCodRef(caso.razonReferencia),
        razonRef: caso.razonReferencia,
        items: caso.items.length > 0 ? caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad,
          precio: item.precioUnitario || 0,
        })) : [{ nombre: caso.razonReferencia, cantidad: 1, precio: 0 }],
      });
    }
  }

  return {
    numeroAtencion: set.numeroAtencion,
    casosFactura,
    casosNC,
    casosND,
    cafRequired: {
      33: casosFactura.length,
      61: casosNC.length,
      56: casosND.length,
    },
  };
}

/**
 * Genera estructura para SET FACTURA EXENTA (34, NC 61, ND 56)
 */
function generarEstructuraSetExenta(set) {
  const casosFactura = [];
  const casosNC = [];
  const casosND = [];

  for (const caso of set.casos) {
    const tipoCodigo = caso.tipoDTE?.codigo;

    if (tipoCodigo === 34) {
      casosFactura.push({
        id: caso.id,
        items: caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad,
          unidad: item.unidadMedida || 'UN',
          precio: item.precioUnitario,
          exento: true,
        })),
      });
    } else if (tipoCodigo === 61) {
      casosNC.push({
        id: caso.id,
        referenciaCaso: caso.casoReferenciado,
        codRef: determinarCodRef(caso.razonReferencia),
        razonRef: caso.razonReferencia,
        items: caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad || 1,
          precio: item.precioUnitario || 0,
          exento: true,
        })),
      });
    } else if (tipoCodigo === 56) {
      casosND.push({
        id: caso.id,
        referenciaCaso: caso.casoReferenciado,
        codRef: determinarCodRef(caso.razonReferencia),
        razonRef: caso.razonReferencia,
        items: caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad || 1,
          precio: item.precioUnitario || 0,
          exento: true,
        })),
      });
    }
  }

  return {
    numeroAtencion: set.numeroAtencion,
    casosFactura,
    casosNC,
    casosND,
    cafRequired: {
      34: casosFactura.length,
      61: casosNC.length,
      56: casosND.length,
    },
  };
}

/**
 * Genera estructura para SET GUIA DE DESPACHO (52)
 */
function generarEstructuraSetGuia(set) {
  const casos = [];

  for (const caso of set.casos) {
    const indTraslado = determinarIndTraslado(caso.motivo);
    const tpoDespacho = determinarTpoDespacho(caso.trasladoPor);

    casos.push({
      id: caso.id,
      indTraslado,
      ...(tpoDespacho ? { tpoDespacho } : {}),
      items: caso.items.map(item => ({
        nombre: item.nombre,
        cantidad: item.cantidad,
        ...(item.precioUnitario ? { precio: item.precioUnitario } : { monto: 0 }),
      })),
    });
  }

  return {
    numeroAtencion: set.numeroAtencion,
    casos,
    cafRequired: { 52: casos.length },
  };
}

/**
 * Genera estructura para Libro de Guías a partir del SET GUIA DE DESPACHO
 */
function generarEstructuraLibroGuiasDesdeSetGuia(setGuia, receptorConfig = {}) {
  const casos = [];
  const receptorBase = receptorConfig.rut && receptorConfig.razon_social
    ? { rut: receptorConfig.rut, razon: receptorConfig.razon_social }
    : null;

  (setGuia?.casos || []).forEach((caso) => {
    const items = (caso.items || []).map((item) => ({
      nombre: item.nombre,
      cantidad: item.cantidad || 1,
      precio: item.precio ?? 0,
    }));

    const totalFromPrecio = (caso.items || []).reduce((acc, item) => (
      acc + ((item.precio || 0) * (item.cantidad || 1))
    ), 0);
    const totalFromMonto = (caso.items || []).reduce((acc, item) => (
      acc + (item.monto || 0)
    ), 0);
    const total = totalFromPrecio + totalFromMonto;
    const hasMontoOnly = (caso.items || []).some((item) => (
      item.monto !== undefined && item.precio == null
    ));

    const tpoOper = caso.indTraslado === 1
      ? 1
      : (Number.isFinite(Number(caso.indTraslado)) ? Number(caso.indTraslado) : 2);
    const entry = {
      tpoOper,
      items,
    };

    if (hasMontoOnly) {
      entry.mntTotalOverride = total;
    }
    if (tpoOper === 1 && receptorBase) {
      entry.receptor = receptorBase;
    }
    casos.push(entry);
  });

  return {
    numeroAtencion: setGuia?.numeroAtencion,
    casos,
  };
}

/**
 * Genera estructura para SET FACTURA DE COMPRA (46, NC 61, ND 56)
 */
function generarEstructuraSetFacturaCompra(set) {
  let casoFactura = null;
  let casoNC = null;
  let casoND = null;

  for (const caso of set.casos) {
    const tipoCodigo = caso.tipoDTE?.codigo;

    if (tipoCodigo === 46) {
      casoFactura = {
        id: caso.id,
        items: caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad,
          precio: item.precioUnitario,
        })),
      };
    } else if (tipoCodigo === 61) {
      casoNC = {
        id: caso.id,
        referenciaCaso: caso.casoReferenciado,
        codRef: determinarCodRef(caso.razonReferencia),
        razonRef: caso.razonReferencia,
        items: caso.items.map(item => ({
          nombre: item.nombre,
          cantidad: item.cantidad,
          precio: item.precioUnitario,
        })),
      };
    } else if (tipoCodigo === 56) {
      casoND = {
        id: caso.id,
        referenciaCaso: caso.casoReferenciado,
        codRef: determinarCodRef(caso.razonReferencia),
        razonRef: caso.razonReferencia,
        items: casoNC?.items || [],
      };
    }
  }

  return {
    numeroAtencion: set.numeroAtencion,
    casoFactura,
    casoNC,
    casoND,
    cafRequired: {
      46: casoFactura ? 1 : 0,
      61: casoNC ? 1 : 0,
      56: casoND ? 1 : 0,
    },
  };
}

/**
 * Genera estructura para SET LIQUIDACIONES (43)
 */
function generarEstructuraSetLiquidaciones(set) {
  const casos = [];

  for (const caso of set.casos) {
    casos.push({
      id: caso.id,
      items: caso.items.map(item => ({
        nombre: item.nombre,
        cantidad: item.cantidad,
        totalLinea: item.totalLinea || item.precioUnitario * item.cantidad,
        ...(item.nombre.includes('EXENTO') ? { exento: true } : {}),
      })),
    });
  }

  return {
    numeroAtencion: set.numeroAtencion,
    casos,
    cafRequired: { 43: casos.length },
  };
}

/**
 * Genera estructura para SET EXPORTACION (110, 111, 112)
 */
function generarEstructuraSetExportacion(set) {
  const casos = [];

  for (const caso of set.casos) {
    casos.push({
      id: caso.id,
      tipoDTE: caso.tipoDTE?.codigo,
      items: caso.items.map(item => ({
        nombre: item.nombre,
        cantidad: item.cantidad,
        unidad: item.unidadMedida,
        precio: item.precioUnitario || item.valorLinea,
      })),
      moneda: caso.moneda,
      formaPago: caso.formaPago,
      modalidadVenta: caso.modalidadVenta,
      clausulaVenta: caso.clausulaVenta,
      totalClausula: caso.totalClausula,
      viaTransporte: caso.viaTransporte,
      puertoEmbarque: caso.puertoEmbarque,
      puertoDesembarque: caso.puertoDesembarque,
      tipoBulto: caso.tipoBulto,
      totalBultos: caso.totalBultos,
      flete: caso.flete,
      seguro: caso.seguro,
      paisDestino: caso.paisDestino,
      comisionExtranjero: caso.comisionExtranjero,
      ...(caso.casoReferenciado ? {
        referenciaCaso: caso.casoReferenciado,
        razonRef: caso.razonReferencia,
      } : {}),
    });
  }

  return {
    numeroAtencion: set.numeroAtencion,
    casos,
    cafRequired: {
      110: casos.filter(c => c.tipoDTE === 110).length,
      111: casos.filter(c => c.tipoDTE === 111).length,
      112: casos.filter(c => c.tipoDTE === 112).length,
    },
  };
}

/**
 * Genera estructura para LIBRO DE COMPRAS (IECV)
 */
function generarEstructuraLibroCompras(set, opts = {}) {
  const esExentos = opts.esExentos === true;
  const detalle = [];
  const resumen = {};

  for (const doc of set.documentosLibro) {
    let tipoDoc = mapearTipoDocLibro(doc.tipoDocumento);
    const tasaIva = 0.19;

    // En libro de compras EXENTOS, los TpoDoc correctos son:
    //   FACTURA (papel afecta)         → 30  (con IVANoRec)
    //   FACTURA EXENTA (papel)         → 32  (Fac. Venta B&S No Afectos/Exentos, papel)
    //   FACTURA ELECTRONICA            → 33  (con IVANoRec si tiene montoAfecto)
    //   FACTURA EXENTA ELECTRONICA     → 34  (puramente exenta)
    //   NC/NCE/ND/NDE                  → 60/61/55/56
    // Total: 7 tipos distintos = 7 líneas de resumen
    const esFacturaExentaPapel = esExentos && tipoDoc === 30
      && !doc.montoAfecto && !!doc.montoExento;
    if (esFacturaExentaPapel) tipoDoc = 32;

    const detalleDoc = {
      TpoDoc: tipoDoc,
      NroDoc: doc.folio,
      TasaImp: tasaIva,
      FchDoc: new Date().toISOString().split('T')[0], // Se debe ajustar
      RUTDoc: '17096073-4', // RUT por defecto para certificación
      RznSoc: 'Razon Social',
    };

    if (doc.montoExento) detalleDoc.MntExe = doc.montoExento;
    if (doc.montoAfecto) {
      detalleDoc.MntNeto = doc.montoAfecto;
      detalleDoc.MntIVA = Math.round(doc.montoAfecto * tasaIva);
    }

    if (doc.ivaUsoComun) {
      detalleDoc.TpoImp = 1;
      detalleDoc.IVAUsoComun = Math.round((doc.montoAfecto || 0) * tasaIva);
    }

    if (doc.codigoIvaNoRec) {
      detalleDoc.IVANoRec = {
        CodIVANoRec: doc.codigoIvaNoRec,
        MntIVANoRec: Math.round((doc.montoAfecto || 0) * tasaIva),
      };
    }

    if (doc.retencionTotal && tipoDoc === 46) {
      detalleDoc.OtrosImp = {
        CodImp: 15,
        TasaImp: tasaIva,
        MntImp: Math.round((doc.montoAfecto || 0) * tasaIva),
      };
      detalleDoc.IVARetTotal = Math.round((doc.montoAfecto || 0) * tasaIva);
    }

    // Referencia para notas de crédito/débito (TpoDoc 60/61/55/56)
    const esNota = (tipoDoc === 60 || tipoDoc === 61 || tipoDoc === 55 || tipoDoc === 56);
    if (esNota && doc.observacion) {
      // El folio referenciado es siempre el último número de la observación
      const matchFolio = doc.observacion.match(/(\d+)\s*$/i);
      if (matchFolio) {
        detalleDoc.FolioDocRef = parseInt(matchFolio[1]);
        if (doc.observacion.match(/FACTURA EXENTA ELECTRONICA/i)) {
          detalleDoc.TpoDocRef = 34;
        } else if (doc.observacion.match(/FACTURA EXENTA/i)) {
          detalleDoc.TpoDocRef = esExentos ? 32 : 30;
        } else if (doc.observacion.match(/FACTURA.*ELECTRONICA/i)) {
          detalleDoc.TpoDocRef = 33;
        } else if (doc.observacion.match(/FACTURA/i)) {
          detalleDoc.TpoDocRef = 30;
        }
        // Sin TpoDocRef si no se menciona FACTURA (ej. referencia a otra NC/ND)
      }
    }

    // En libro de compras EXENTOS: lógica por tipo de doc
    //   Docs con montoAfecto → IVANoRec (IVA no recuperable)
    //   Docs puramente exentos (TpoDoc=32/34) → sin IVANoRec
    //   TpoDoc=46 → usa IVARetTotal (no IVANoRec)
    const esPuramenteExento = !doc.montoAfecto && !!doc.montoExento;
    if (esExentos && tipoDoc !== 46 && !esPuramenteExento) {
      const mntIVA = detalleDoc.MntIVA || 0;
      detalleDoc.IVANoRec = { CodIVANoRec: 1, MntIVANoRec: mntIVA };
      detalleDoc.MntIVA = 0;
      if (detalleDoc.MntNeto === undefined || detalleDoc.MntNeto === null) {
        detalleDoc.MntNeto = 0;
      }
    }
    // TpoDoc=32 (Fac. Exenta papel): solo MntExe + MntTotal, sin TasaImp/MntNeto/MntIVA/IVANoRec
    if (esFacturaExentaPapel) {
      delete detalleDoc.TasaImp;
      delete detalleDoc.MntNeto;
      delete detalleDoc.MntIVA;
      delete detalleDoc.IVANoRec;
    }
    // Para docs puramente exentos que NO son TpoDoc=32: TasaImp=19 + MntNeto=0 + MntIVA=0
    if (esExentos && esPuramenteExento && !esFacturaExentaPapel) {
      detalleDoc.TasaImp = Math.round(tasaIva * 100); // TasaImp=19 requerido
      detalleDoc.MntNeto = 0;
      detalleDoc.MntIVA = 0;
    }

    // MntTotal incluye IVANoRec (IVA pagado pero no deducible)
    const mntIvaNoRecTotal = (esExentos && detalleDoc.IVANoRec) ? (detalleDoc.IVANoRec.MntIVANoRec || 0) : 0;
    detalleDoc.MntTotal = (detalleDoc.MntNeto || 0) + (detalleDoc.MntIVA || 0) + (detalleDoc.MntExe || 0) + mntIvaNoRecTotal;
    if (doc.retencionTotal && tipoDoc === 46) {
      detalleDoc.MntTotal = detalleDoc.MntNeto || 0; // Sin IVA pagado
    }

    detalle.push(detalleDoc);

    // Acumular resumen
    if (!resumen[tipoDoc]) {
      resumen[tipoDoc] = {
        TpoDoc: tipoDoc,
        TotDoc: 0,
        TotMntExe: 0,
        TotMntNeto: 0,
        TotMntIVA: 0,
        TotMntTotal: 0,
      };
    }
    resumen[tipoDoc].TotDoc++;
    resumen[tipoDoc].TotMntExe += detalleDoc.MntExe || 0;
    resumen[tipoDoc].TotMntNeto += detalleDoc.MntNeto || 0;
    resumen[tipoDoc].TotMntIVA += detalleDoc.MntIVA || 0;
    resumen[tipoDoc].TotMntTotal += detalleDoc.MntTotal || 0;
  }

  // Post-proceso para libro de compras EXENTOS:
  // NC/NCE con sin montos declarados que anulan un doc con montos deben heredar esos montos
  if (esExentos) {
    for (const doc of detalle) {
      const esNotaAnulacion = (doc.TpoDoc === 60 || doc.TpoDoc === 61 || doc.TpoDoc === 55 || doc.TpoDoc === 56)
        && !doc.MntNeto && !doc.MntExe && doc.FolioDocRef;
      if (esNotaAnulacion) {
        const refDoc = detalle.find(d => d.NroDoc === doc.FolioDocRef);
        if (refDoc) {
          if (refDoc.MntExe) doc.MntExe = refDoc.MntExe;
          if (refDoc.MntNeto) {
            doc.MntNeto = refDoc.MntNeto;
            // Heredar IVANoRec del doc referenciado
            if (refDoc.IVANoRec) {
              doc.IVANoRec = { CodIVANoRec: 1, MntIVANoRec: refDoc.IVANoRec.MntIVANoRec || 0 };
            }
          }
          const mntIvaNoRecDoc = (doc.IVANoRec ? (doc.IVANoRec.MntIVANoRec || 0) : 0);
          doc.MntTotal = (doc.MntNeto || 0) + (doc.MntExe || 0) + mntIvaNoRecDoc;
          // Actualizar resumen para este TpoDoc
          if (resumen[doc.TpoDoc]) {
            resumen[doc.TpoDoc].TotMntExe += doc.MntExe || 0;
            resumen[doc.TpoDoc].TotMntNeto += doc.MntNeto || 0;
            resumen[doc.TpoDoc].TotMntTotal += doc.MntTotal;
          }
        }
      }
    }
  }

  return {
    numeroAtencion: set.numeroAtencion,
    factorProporcionalidad: set.factorProporcionalidad || 0.6,
    detalle,
    resumen: Object.values(resumen),
    documentosOriginales: set.documentosLibro,
  };
}

// ═══════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════

/**
 * Genera estructuras compatibles con los scripts de certificación
 * a partir de los datos extraídos del set
 * 
 * @param {Object} datosExtraidos - Resultado de extraerCasosDelSet()
 * @param {Object} [receptorConfig] - Configuración del receptor para libros
 * @returns {Object} Estructuras para cada set/libro
 */
function generarEstructurasParaScripts(datosExtraidos, receptorConfig = {}) {
  const estructuras = {
    setBasico: null,
    setFacturaExenta: null,
    setGuiaDespacho: null,
    setFacturaCompra: null,
    setLiquidaciones: null,
    setExportacion1: null,
    setExportacion2: null,
    libroVentas: null,
    libroCompras: null,
    libroComprasExentos: null,
    libroGuias: null,
  };

  for (const set of datosExtraidos.sets) {
    switch (set.tipo) {
      case 'BASICO':
        estructuras.setBasico = generarEstructuraSetBasico(set);
        break;
      case 'FACTURA_EXENTA':
        estructuras.setFacturaExenta = generarEstructuraSetExenta(set);
        break;
      case 'GUIA_DESPACHO':
        estructuras.setGuiaDespacho = generarEstructuraSetGuia(set);
        if (!estructuras.libroGuias) {
          estructuras.libroGuias = generarEstructuraLibroGuiasDesdeSetGuia(estructuras.setGuiaDespacho, receptorConfig);
        }
        break;
      case 'FACTURA_COMPRA':
        estructuras.setFacturaCompra = generarEstructuraSetFacturaCompra(set);
        break;
      case 'LIQUIDACION':
        estructuras.setLiquidaciones = generarEstructuraSetLiquidaciones(set);
        break;
      case 'EXPORTACION':
        if (set.nombre.includes('(1)')) {
          estructuras.setExportacion1 = generarEstructuraSetExportacion(set);
        } else if (set.nombre.includes('(2)')) {
          estructuras.setExportacion2 = generarEstructuraSetExportacion(set);
        }
        break;
      case 'LIBRO_COMPRAS':
        estructuras.libroCompras = generarEstructuraLibroCompras(set);
        break;
      case 'LIBRO_COMPRAS_EXENTOS':
        // En el libro de exentos, FACTURA afecta papel usa TpoDoc=29 (Factura de Inicio)
        // para distinguirse de FACTURA EXENTA (TpoDoc=30) en el ResumenPeriodo
        estructuras.libroComprasExentos = generarEstructuraLibroCompras(set, { esExentos: true });
        break;
      case 'LIBRO_VENTAS':
        // El libro de ventas se genera con los datos del set básico o exento
        estructuras.libroVentas = { numeroAtencion: set.numeroAtencion, instruccion: 'Usar DTEs del SET BASICO' };
        break;
      case 'LIBRO_GUIAS':
        // El libro de guías se genera con los datos del set guía
        estructuras.libroGuias = estructuras.libroGuias || { numeroAtencion: set.numeroAtencion, instruccion: 'Usar DTEs del SET GUIA DE DESPACHO' };
        break;
    }
  }

  return estructuras;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Función principal de extracción
  extraerCasosDelSet,
  
  // Generador de estructuras
  generarEstructurasParaScripts,
  
  // Generadores individuales (para uso avanzado)
  generarEstructuraSetBasico,
  generarEstructuraSetExenta,
  generarEstructuraSetGuia,
  generarEstructuraSetFacturaCompra,
  generarEstructuraSetLiquidaciones,
  generarEstructuraSetExportacion,
  generarEstructuraLibroCompras,
  generarEstructuraLibroGuiasDesdeSetGuia,
  
  // Helpers de detección
  detectarTipoDTE,
  detectarTipoSet,
  determinarCodRef,
  determinarIndTraslado,
  determinarTpoDespacho,
  mapearTipoDocLibro,
};
