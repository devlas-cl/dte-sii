// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * utils/browser.js
 *
 * Helper para lanzar Puppeteer con el Chromium correcto según el entorno:
 *  - Producción / serverless (Railway, Lambda, etc.): usa @sparticuz/chromium
 *  - Desarrollo local: usa el Chrome del sistema si @sparticuz/chromium no está disponible
 *
 * Uso:
 *   const { launchBrowser } = require('./utils/browser')
 *   const browser = await launchBrowser()
 */

'use strict';

const puppeteer = require('puppeteer');

/**
 * Devuelve las opciones de lanzamiento para puppeteer.launch() según el entorno.
 * @returns {Promise<import('puppeteer').LaunchOptions>}
 */
async function getLaunchOptions() {
  // 1. @sparticuz/chromium — solo en Linux (Railway/serverless). En Windows entrega
  //    un binario ELF que existe en disco pero no es ejecutable.
  if (process.platform !== 'win32') {
    try {
      const chromium = require('@sparticuz/chromium');
      const executablePath = await chromium.executablePath();
      if (executablePath) {
        return {
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath,
          headless: chromium.headless ?? true,
        };
      }
    } catch {
      // No está disponible, continuar con fallback
    }
  }

  // 2. Ruta explícita por variable de entorno
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    };
  }

  // 3. Chrome del sistema (rutas comunes Linux / Windows)
  const fs = require('fs');
  const SYSTEM_PATHS = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const executablePath = SYSTEM_PATHS.find(p => { try { return fs.existsSync(p) } catch { return false } });
  return {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(executablePath ? { executablePath } : {}),
  };
}

/**
 * Lanza un browser Puppeteer con el Chromium correcto para el entorno actual.
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function launchBrowser() {
  const opts = await getLaunchOptions();
  return puppeteer.launch(opts);
}

module.exports = { launchBrowser, getLaunchOptions };
