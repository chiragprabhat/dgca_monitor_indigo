import axios from 'axios';
import { createLogger } from '../utils/logger.js';

// pdfjs warns at load that the optional canvas module (DOMMatrix, Path2D) is missing;
// it's only needed for rendering pages to images, not for reading text.
const { log: origLog, warn: origWarn } = console;
console.log = console.warn = () => {};
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
console.log = origLog;
console.warn = origWarn;

const logger = createLogger('pdf-service');

const MAX_PDF_BYTES = 40 * 1024 * 1024;
export const SUMMARY_PAGES = 30;
const MAX_TEXT_PAGES = SUMMARY_PAGES;

export async function downloadPdf(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: MAX_PDF_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  const type = String(response.headers['content-type'] || '');
  const buffer = Buffer.from(response.data);
  if (!type.includes('pdf') && buffer.subarray(0, 4).toString() !== '%PDF') {
    throw new Error(`not a PDF (content-type: ${type || 'none'})`);
  }

  const disposition = String(response.headers['content-disposition'] || '');
  const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const filename = sanitizeFilename(nameMatch ? decodeURIComponent(nameMatch[1]) : 'DGCA-document.pdf');

  return { buffer, filename, sizeBytes: buffer.length };
}

// Comparisons need the whole document; summaries only need the opening pages.
export const FULL_DOCUMENT_PAGES = 600;

export async function extractText(buffer, maxPages = MAX_TEXT_PAGES) {
  // Script evaluation stays off (defence in depth after CVE-2024-4367): only text is read.
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false });
  const doc = await task.promise;
  const pageCount = doc.numPages;
  let text = '';
  try {
    for (let p = 1; p <= Math.min(pageCount, maxPages); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      text += content.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('') + '\n';
    }
  } finally {
    await task.destroy();
  }
  return {
    text: text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim(),
    pageCount
  };
}

// Downloads and reads a publication's PDF; never throws, so a bad PDF can't block an alert.
export async function fetchPdfWithText(url, { maxPages = MAX_TEXT_PAGES } = {}) {
  if (!url) return null;
  try {
    let pdf;
    // DGCA occasionally answers with an empty response when busy; try a couple more times.
    for (const wait of [0, 3000, 8000]) {
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      try {
        pdf = await downloadPdf(url);
        break;
      } catch (error) {
        if (wait === 8000) throw error;
      }
    }
    let extracted = { text: '', pageCount: null };
    try {
      extracted = await extractText(pdf.buffer, maxPages);
    } catch (error) {
      logger.warn('Could not read PDF text (may be scanned)', { url, error: error.message });
    }
    return { ...pdf, ...extracted };
  } catch (error) {
    logger.warn('PDF download failed', { url, error: error.message });
    return null;
  }
}

function sanitizeFilename(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned || 'DGCA-document'}.pdf`;
}
