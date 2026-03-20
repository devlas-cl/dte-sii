// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * FolioRegistry.js - Registro local de folios
 * 
 * Maneja el control de folios usados, reservados y enviados al SII.
 * Proporciona persistencia en archivo JSON y control de conflictos.
 * 
 * @module FolioRegistry
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Clase para manejar el registro de folios
 */
class FolioRegistry {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {string} [options.registryPath] - Ruta al archivo de registro
   * @param {string} [options.baseDir] - Directorio base para el registro
   */
  constructor(options = {}) {
    if (options.registryPath) {
      this.registryPath = options.registryPath;
    } else if (options.baseDir) {
      this.registryPath = path.join(options.baseDir, 'debug', 'folios.json');
    } else {
      this.registryPath = path.resolve(__dirname, '..', '..', 'debug', 'folios.json');
    }
  }

  /**
   * Asegura que existe el directorio del registro
   * @private
   */
  _ensureDir() {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Carga el registro desde disco
   * @returns {Object}
   */
  load() {
    try {
      if (!fs.existsSync(this.registryPath)) {
        return { version: 1, entries: {} };
      }
      const raw = fs.readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
        return { version: 1, entries: {} };
      }
      return parsed;
    } catch (error) {
      return { version: 1, entries: {} };
    }
  }

  /**
   * Guarda el registro a disco
   * @param {Object} registry - Datos del registro
   */
  save(registry) {
    this._ensureDir();
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  /**
   * Crea un fingerprint único para un CAF
   * @param {string} cafXml - XML del CAF
   * @returns {string|undefined}
   */
  static createCafFingerprint(cafXml) {
    if (!cafXml) return undefined;
    return crypto.createHash('sha256').update(cafXml).digest('hex').slice(0, 12);
  }

  /**
   * Construye la clave única para una entrada
   * @param {Object} params - Parámetros
   * @returns {string}
   */
  static buildKey({ rutEmisor, tipoDte, folioDesde, folioHasta, ambiente, cafFingerprint }) {
    if (!rutEmisor || !tipoDte || !folioDesde || !folioHasta) {
      throw new Error('Faltan datos para construir la clave del registro de folios');
    }
    return [
      String(rutEmisor),
      String(tipoDte),
      String(folioDesde),
      String(folioHasta),
      String(ambiente || ''),
      String(cafFingerprint || ''),
    ].join('|');
  }

  /**
   * Recolecta folios bloqueados (anulados)
   * @param {Object} params - Parámetros de búsqueda
   * @returns {Set<number>}
   */
  collectBlockedFolios({ registry, rutEmisor, tipoDte, ambiente }) {
    const blocked = new Set();
    if (!registry || !registry.entries) return blocked;

    Object.values(registry.entries).forEach((entry) => {
      const meta = entry && entry.meta ? entry.meta : {};
      if (String(meta.rutEmisor) !== String(rutEmisor)) return;
      if (String(meta.tipoDte) !== String(tipoDte)) return;
      if (String(meta.ambiente || '') !== String(ambiente || '')) return;

      const nota = String(meta.nota || '').toLowerCase();
      if (nota.includes('anulad')) {
        (entry.usedFolios || []).forEach((folio) => blocked.add(Number(folio)));
      }

      const sent = entry.sentFolios || {};
      Object.keys(sent).forEach((folio) => {
        if (sent[folio] && sent[folio].anulado) {
          blocked.add(Number(folio));
        }
      });
    });

    return blocked;
  }

  /**
   * Reserva el siguiente folio disponible
   * @param {Object} params - Parámetros
   * @returns {number} - Folio reservado
   */
  reserveNextFolio({
    rutEmisor,
    tipoDte,
    folioDesde,
    folioHasta,
    ambiente,
    cafFingerprint,
  }) {
    const desde = Number(folioDesde);
    const hasta = Number(folioHasta);

    if (!rutEmisor || !tipoDte || Number.isNaN(desde) || Number.isNaN(hasta)) {
      throw new Error('Parámetros inválidos para reservar folio');
    }
    if (desde > hasta) {
      throw new Error(`Rango de folios inválido (${desde}-${hasta})`);
    }

    const registry = this.load();
    const blocked = this.collectBlockedFolios({ registry, rutEmisor, tipoDte, ambiente });
    const key = FolioRegistry.buildKey({ rutEmisor, tipoDte, folioDesde: desde, folioHasta: hasta, ambiente, cafFingerprint });
    
    const entry = registry.entries[key] || {
      usedFolios: [],
      lastReserved: null,
      meta: {
        rutEmisor,
        tipoDte,
        folioDesde: desde,
        folioHasta: hasta,
        ambiente: ambiente || null,
        cafFingerprint: cafFingerprint || null,
      },
    };

    const inRange = (folio) => Number(folio) >= desde && Number(folio) <= hasta;
    const baseUsed = (entry.usedFolios || []).filter(inRange).map((f) => Number(f));
    const usedSet = new Set(baseUsed);
    const sentFolios = entry.sentFolios || {};
    
    // Folios reutilizables: reservados pero no enviados ni bloqueados
    const reusable = baseUsed
      .filter((folio) => !sentFolios[String(folio)] && !blocked.has(Number(folio)))
      .sort((a, b) => a - b);

    let next = reusable.length
      ? reusable[0]
      : (entry.lastReserved ? Math.max(desde, Number(entry.lastReserved) + 1) : desde);

    while (usedSet.has(next) || blocked.has(next)) {
      next += 1;
    }

    if (next > hasta) {
      throw new Error(`No hay más folios disponibles (${desde}-${hasta})`);
    }

    usedSet.add(next);
    entry.usedFolios = Array.from(usedSet).filter(inRange).sort((a, b) => a - b);
    entry.lastReserved = entry.usedFolios.length ? Math.max(...entry.usedFolios) : null;
    entry.updatedAt = new Date().toISOString();

    registry.entries[key] = entry;
    this.save(registry);

    return next;
  }

  /**
   * Marca un folio como enviado al SII
   * @param {Object} params - Parámetros
   */
  markFolioSent({
    rutEmisor,
    tipoDte,
    folio,
    folioDesde,
    folioHasta,
    ambiente,
    cafFingerprint,
    trackId,
    sentAt,
    extra,
  }) {
    const desde = Number(folioDesde);
    const hasta = Number(folioHasta);
    const folioNum = Number(folio);

    if (!rutEmisor || !tipoDte || Number.isNaN(desde) || Number.isNaN(hasta) || Number.isNaN(folioNum)) {
      throw new Error('Parámetros inválidos para marcar folio como enviado');
    }
    if (folioNum < desde || folioNum > hasta) {
      throw new Error(`Folio ${folioNum} fuera de rango CAF (${desde}-${hasta})`);
    }

    const registry = this.load();
    const key = FolioRegistry.buildKey({ rutEmisor, tipoDte, folioDesde: desde, folioHasta: hasta, ambiente, cafFingerprint });
    
    const entry = registry.entries[key] || {
      usedFolios: [],
      lastReserved: null,
      sentFolios: {},
      meta: {
        rutEmisor,
        tipoDte,
        folioDesde: desde,
        folioHasta: hasta,
        ambiente: ambiente || null,
        cafFingerprint: cafFingerprint || null,
      },
    };

    if (!entry.usedFolios) entry.usedFolios = [];
    if (!entry.sentFolios) entry.sentFolios = {};

    if (!entry.usedFolios.includes(folioNum)) {
      entry.usedFolios.push(folioNum);
      entry.usedFolios.sort((a, b) => a - b);
    }

    entry.sentFolios[String(folioNum)] = {
      trackId: trackId || null,
      sentAt: sentAt || new Date().toISOString(),
      ...(extra ? { extra } : {}),
    };

    entry.updatedAt = new Date().toISOString();
    registry.entries[key] = entry;
    this.save(registry);
  }

  /**
   * Libera folios del registro
   * @param {Object} params - Parámetros
   */
  releaseFolios({
    rutEmisor,
    tipoDte,
    folios,
    folioDesde,
    folioHasta,
    ambiente,
    cafFingerprint,
  }) {
    const desde = Number(folioDesde);
    const hasta = Number(folioHasta);

    if (!rutEmisor || !tipoDte || Number.isNaN(desde) || Number.isNaN(hasta)) {
      throw new Error('Parámetros inválidos para liberar folios');
    }

    const foliosNum = (Array.isArray(folios) ? folios : [folios])
      .map((f) => Number(f))
      .filter((f) => !Number.isNaN(f));

    if (!foliosNum.length) return;

    const registry = this.load();
    const key = FolioRegistry.buildKey({ rutEmisor, tipoDte, folioDesde: desde, folioHasta: hasta, ambiente, cafFingerprint });
    const entry = registry.entries[key];
    
    if (!entry) return;

    const toRemove = new Set(foliosNum);
    const inRange = (f) => Number(f) >= desde && Number(f) <= hasta;
    
    entry.usedFolios = (entry.usedFolios || [])
      .filter((f) => !toRemove.has(Number(f)))
      .filter(inRange)
      .map((f) => Number(f));

    if (entry.sentFolios) {
      Object.keys(entry.sentFolios).forEach((folioKey) => {
        if (toRemove.has(Number(folioKey))) {
          delete entry.sentFolios[folioKey];
        }
      });
    }

    entry.lastReserved = entry.usedFolios.length ? Math.max(...entry.usedFolios) : null;
    entry.updatedAt = new Date().toISOString();
    registry.entries[key] = entry;
    this.save(registry);
  }

  /**
   * Obtiene folios restantes disponibles
   * @param {Object} params - Parámetros
   * @returns {number}
   */
  getRemainingFolios({
    rutEmisor,
    tipoDte,
    folioDesde,
    folioHasta,
    ambiente,
    cafFingerprint,
  }) {
    const desde = Number(folioDesde);
    const hasta = Number(folioHasta);
    const total = hasta - desde + 1;

    if (!fs.existsSync(this.registryPath)) {
      return total;
    }

    try {
      const registry = this.load();
      const key = FolioRegistry.buildKey({ 
        rutEmisor, 
        tipoDte, 
        folioDesde: desde, 
        folioHasta: hasta, 
        ambiente, 
        cafFingerprint 
      });
      const entry = registry.entries[key];
      const used = entry && Array.isArray(entry.usedFolios) ? entry.usedFolios.length : 0;
      return Math.max(0, total - used);
    } catch (_) {
      return total;
    }
  }

  /**
   * Obtiene estadísticas del registro para un tipo de DTE
   * @param {Object} params - Parámetros
   * @returns {Object}
   */
  getStats({ rutEmisor, tipoDte, ambiente }) {
    const registry = this.load();
    const stats = {
      totalEntries: 0,
      totalUsed: 0,
      totalSent: 0,
      ranges: [],
    };

    Object.entries(registry.entries).forEach(([key, entry]) => {
      const meta = entry.meta || {};
      if (String(meta.rutEmisor) !== String(rutEmisor)) return;
      if (String(meta.tipoDte) !== String(tipoDte)) return;
      if (ambiente && String(meta.ambiente || '') !== String(ambiente)) return;

      stats.totalEntries += 1;
      stats.totalUsed += (entry.usedFolios || []).length;
      stats.totalSent += Object.keys(entry.sentFolios || {}).length;
      stats.ranges.push({
        folioDesde: meta.folioDesde,
        folioHasta: meta.folioHasta,
        used: (entry.usedFolios || []).length,
        sent: Object.keys(entry.sentFolios || {}).length,
        remaining: (meta.folioHasta - meta.folioDesde + 1) - (entry.usedFolios || []).length,
      });
    });

    return stats;
  }

  /**
   * Busca el CAF más reciente para un tipo de DTE en un directorio
   * @param {number} tipoDte - Tipo de DTE (OBLIGATORIO)
   * @param {string} [cafDir] - Directorio base de CAFs (legacy)
   * @param {string} rutEmisor - RUT del emisor (OBLIGATORIO)
   * @param {string} ambiente - 'certificacion' o 'produccion' (OBLIGATORIO)
   * @param {string} [baseDir] - Directorio base del proyecto (para multi-tenant)
   * @returns {string|null} - Ruta al CAF o null
   */
  static findLatestCaf(tipoDte, cafDir, rutEmisor, ambiente, baseDir = null) {
    // Validar parámetros obligatorios
    if (!tipoDte) throw new Error('findLatestCaf: tipoDte es obligatorio');
    if (!rutEmisor) throw new Error('findLatestCaf: rutEmisor es obligatorio');
    if (!ambiente) throw new Error('findLatestCaf: ambiente es obligatorio');
    if (!['certificacion', 'produccion'].includes(ambiente)) {
      throw new Error(`findLatestCaf: ambiente inválido "${ambiente}"`);
    }

    const base = baseDir || process.cwd();
    
    // Buscar en estructura organizada: debug/caf/<ambiente>/<rut>/<tipoDte>/<fecha>/
    const rutClean = rutEmisor.replace(/\./g, '').toUpperCase();
    const organizedDir = path.resolve(base, 'debug', 'caf', ambiente, rutClean, String(tipoDte));
    
    if (fs.existsSync(organizedDir)) {
        // Obtener todas las subcarpetas de fecha, ordenadas de más reciente a más antigua
        const dateDirs = fs.readdirSync(organizedDir)
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .map((d) => path.join(organizedDir, d))
          .filter((d) => fs.statSync(d).isDirectory())
          .sort((a, b) => b.localeCompare(a)); // Ordenar fechas descendente
        
        const matches = [];
        
        // Buscar CAFs en cada carpeta de fecha
        for (const dateDir of dateDirs) {
          const files = fs.readdirSync(dateDir)
            .filter((f) => f.endsWith('.xml') && f.startsWith(`caf-${tipoDte}-`))
            .map((f) => path.join(dateDir, f));
          
          files.forEach((filePath) => {
            try {
              const xml = fs.readFileSync(filePath, 'utf8');
              if (!xml.includes('<AUTORIZACION')) return;
              const stat = fs.statSync(filePath);
              matches.push({ filePath, mtime: stat.mtimeMs });
            } catch (_) {
              // ignore
            }
          });
        }
        
        if (matches.length) {
          matches.sort((a, b) => b.mtime - a.mtime);
          return matches[0].filePath;
        }
      }

    // Fallback: buscar en debug/auto-caf (legacy)
    const dir = cafDir || path.resolve(base, 'debug', 'auto-caf');
    if (!fs.existsSync(dir)) return null;
    
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.xml') && f.startsWith('caf-solicitar-'))
      .map((f) => path.join(dir, f));

    const matches = [];
    files.forEach((filePath) => {
      try {
        const xml = fs.readFileSync(filePath, 'utf8');
        const tdMatch = xml.match(/<TD>(\d+)<\/TD>/i);
        if (tdMatch && Number(tdMatch[1]) === Number(tipoDte)) {
          const stat = fs.statSync(filePath);
          matches.push({ filePath, mtime: stat.mtimeMs });
        }
      } catch (_) {
        // ignore
      }
    });

    if (!matches.length) return null;
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].filePath;
  }

  /**
   * Resuelve la ruta de un CAF, buscando uno disponible si es necesario
   * @param {Object} params - Parámetros
   * @param {number} params.tipoDte - Tipo de DTE (OBLIGATORIO)
   * @param {string} params.rutEmisor - RUT del emisor (OBLIGATORIO)
   * @param {string} params.ambiente - 'certificacion' o 'produccion' (OBLIGATORIO)
   * @param {string} [params.cafPath] - Ruta explícita al CAF
   * @param {number} [params.requiredCount=1] - Folios mínimos requeridos
   * @param {string} [params.cafDir] - Directorio de CAFs (legacy)
   * @param {string} [params.baseDir] - Directorio base del proyecto (para multi-tenant)
   * @param {string} [params.registryPath] - Ruta al registro de folios
   * @returns {string|null} - Ruta al CAF o null
   */
  static resolveCafPath({
    tipoDte,
    rutEmisor,
    ambiente,
    cafPath = null,
    requiredCount = 1,
    cafDir,
    baseDir = null,
    registryPath = null,
  }) {
    // Validar parámetros obligatorios
    if (!tipoDte) throw new Error('resolveCafPath: tipoDte es obligatorio');
    if (!rutEmisor) throw new Error('resolveCafPath: rutEmisor es obligatorio');
    if (!ambiente) throw new Error('resolveCafPath: ambiente es obligatorio');
    if (!['certificacion', 'produccion'].includes(ambiente)) {
      throw new Error(`resolveCafPath: ambiente inválido "${ambiente}"`);
    }

    const CAF = require('./CAF');
    const registry = new FolioRegistry({ baseDir, registryPath });
    
    let resolvedPath = cafPath;

    // Si no hay CAF o no existe, buscar el más reciente (estructura organizada primero)
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      resolvedPath = FolioRegistry.findLatestCaf(tipoDte, cafDir, rutEmisor, ambiente, baseDir);
    }

    // Validar si hay folios suficientes
    if (resolvedPath && fs.existsSync(resolvedPath)) {
      const cafXml = fs.readFileSync(resolvedPath, 'utf8');
      const caf = new CAF(cafXml);
      const cafFingerprint = FolioRegistry.createCafFingerprint(cafXml);

      const remaining = registry.getRemainingFolios({
        rutEmisor,
        tipoDte: caf.getTipoDTE(),
        folioDesde: caf.getFolioDesde(),
        folioHasta: caf.getFolioHasta(),
        ambiente,
        cafFingerprint,
      });

      if (remaining < requiredCount) {
        // Intentar buscar otro CAF más nuevo
        const newerCaf = FolioRegistry.findLatestCaf(tipoDte, cafDir, rutEmisor, ambiente, baseDir);
        if (newerCaf && newerCaf !== resolvedPath) {
          resolvedPath = newerCaf;
        }
      }
    }

    return resolvedPath;
  }
}

module.exports = FolioRegistry;
