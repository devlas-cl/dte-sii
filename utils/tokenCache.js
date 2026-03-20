// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Token Cache
 * 
 * Cache de tokens SII para evitar solicitudes innecesarias
 * Los tokens tienen validez de ~60 minutos
 * 
 * @module dte-sii/utils/tokenCache
 */

const { getConfigSection } = require('./config');

// ============================================
// ALMACENAMIENTO EN MEMORIA
// ============================================

/**
 * Estructura del cache:
 * {
 *   'certificacion:rest:78206276-K': { token: 'xxx', expiresAt: Date },
 *   'produccion:soap:78206276-K': { token: 'yyy', expiresAt: Date },
 * }
 */
const tokenStore = new Map();

// ============================================
// FUNCIONES PRINCIPALES
// ============================================

/**
 * Generar clave única para el cache
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @param {string} tipo - 'rest' o 'soap'
 * @param {string} rutEmisor - RUT del emisor
 * @returns {string} Clave del cache
 */
function generateCacheKey(ambiente, tipo, rutEmisor) {
  return `${ambiente}:${tipo}:${rutEmisor}`;
}

/**
 * Obtener token del cache si existe y no ha expirado
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @param {string} tipo - 'rest' o 'soap'
 * @param {string} rutEmisor - RUT del emisor
 * @returns {string|null} Token cacheado o null
 */
function getCachedToken(ambiente, tipo, rutEmisor) {
  const config = getConfigSection('tokenCache');
  
  if (!config?.enabled) {
    return null;
  }
  
  const key = generateCacheKey(ambiente, tipo, rutEmisor);
  const cached = tokenStore.get(key);
  
  if (!cached) {
    return null;
  }
  
  // Verificar expiración
  if (Date.now() >= cached.expiresAt) {
    tokenStore.delete(key);
    return null;
  }
  
  return cached.token;
}

/**
 * Guardar token en cache
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @param {string} tipo - 'rest' o 'soap'
 * @param {string} rutEmisor - RUT del emisor
 * @param {string} token - Token a cachear
 * @param {number} [ttlMinutes] - TTL personalizado (opcional)
 */
function setCachedToken(ambiente, tipo, rutEmisor, token, ttlMinutes) {
  const config = getConfigSection('tokenCache');
  
  if (!config?.enabled) {
    return;
  }
  
  const ttl = ttlMinutes ?? config.ttlMinutes ?? 55;
  const expiresAt = Date.now() + (ttl * 60 * 1000);
  
  const key = generateCacheKey(ambiente, tipo, rutEmisor);
  tokenStore.set(key, {
    token,
    expiresAt,
    createdAt: Date.now(),
    ambiente,
    tipo,
    rutEmisor,
  });
}

/**
 * Invalidar token específico
 * @param {string} ambiente - 'certificacion' o 'produccion'
 * @param {string} tipo - 'rest' o 'soap'
 * @param {string} rutEmisor - RUT del emisor
 */
function invalidateToken(ambiente, tipo, rutEmisor) {
  const key = generateCacheKey(ambiente, tipo, rutEmisor);
  tokenStore.delete(key);
}

/**
 * Invalidar todos los tokens de un ambiente
 * @param {string} ambiente - 'certificacion' o 'produccion'
 */
function invalidateAmbiente(ambiente) {
  for (const key of tokenStore.keys()) {
    if (key.startsWith(`${ambiente}:`)) {
      tokenStore.delete(key);
    }
  }
}

/**
 * Invalidar todos los tokens de un emisor
 * @param {string} rutEmisor - RUT del emisor
 */
function invalidateEmisor(rutEmisor) {
  for (const key of tokenStore.keys()) {
    if (key.endsWith(`:${rutEmisor}`)) {
      tokenStore.delete(key);
    }
  }
}

/**
 * Limpiar todo el cache
 */
function clearTokenCache() {
  tokenStore.clear();
}

/**
 * Obtener estadísticas del cache
 * @returns {Object} Estadísticas
 */
function getTokenCacheStats() {
  const now = Date.now();
  let active = 0;
  let expired = 0;
  
  for (const [key, value] of tokenStore.entries()) {
    if (now >= value.expiresAt) {
      expired++;
    } else {
      active++;
    }
  }
  
  return {
    total: tokenStore.size,
    active,
    expired,
    entries: Array.from(tokenStore.entries()).map(([key, value]) => ({
      key,
      ambiente: value.ambiente,
      tipo: value.tipo,
      rutEmisor: value.rutEmisor,
      createdAt: new Date(value.createdAt).toISOString(),
      expiresAt: new Date(value.expiresAt).toISOString(),
      isExpired: now >= value.expiresAt,
      remainingMinutes: Math.max(0, Math.round((value.expiresAt - now) / 60000)),
    })),
  };
}

/**
 * Limpiar tokens expirados (limpieza manual)
 * @returns {number} Número de tokens eliminados
 */
function pruneExpiredTokens() {
  const now = Date.now();
  let pruned = 0;
  
  for (const [key, value] of tokenStore.entries()) {
    if (now >= value.expiresAt) {
      tokenStore.delete(key);
      pruned++;
    }
  }
  
  return pruned;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Operaciones principales
  getCachedToken,
  setCachedToken,
  
  // Invalidación
  invalidateToken,
  invalidateAmbiente,
  invalidateEmisor,
  clearTokenCache,
  
  // Utilidades
  getTokenCacheStats,
  pruneExpiredTokens,
  generateCacheKey,
};
