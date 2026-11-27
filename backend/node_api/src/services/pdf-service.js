import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { checkWorkerDeadline, workerDelay, workerSignal } from './worker-deadline.js';

let pdfModule;

const logger = createLogger('pdf-service');

const MAX_PDF_BYTES = 40 * 1024 * 1024;
export const SUMMARY_PAGES = 30;
const MAX_TEXT_PAGES = SUMMARY_PAGES;

export async function downloadPdf(url, { beforeRedirect } = {}) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    signal: workerSignal(),
    maxContentLength: MAX_PDF_BYTES,
    beforeRedirect,
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
  checkWorkerDeadline();
  const pdfjs = await (pdfModule ??= import('pdfjs-dist/legacy/build/pdf.mjs'));
  checkWorkerDeadline();
  // Script evaluation stays off (defence in depth after CVE-2024-4367): only text is read.
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false });
  const signal = workerSignal();
  let cancellation;
  const cancel = () => { cancellation ??= task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let text = '';
  let pageCount;
  try {
    const doc = await task.promise;
    pageCount = doc.numPages;
    for (let p = 1; p <= Math.min(pageCount, maxPages); p++) {
      checkWorkerDeadline();
      const content = await (await doc.getPage(p)).getTextContent();
      text += content.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('') + '\n';
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await (cancellation ?? task.destroy());
  }
  return {
    text: text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim(),
    pageCount
  };
}

// Downloads and reads a publication's PDF; never throws, so a bad PDF can't block an alert.
export async function fetchPdfWithText(url, { maxPages = MAX_TEXT_PAGES, beforeRedirect } = {}) {
  if (!url) return null;
  try {
    let pdf;
    // DGCA occasionally answers with an empty response when busy; try a couple more times.
    for (const wait of [0, 3000, 8000]) {
      if (wait) await workerDelay(wait);
      try {
        pdf = await downloadPdf(url, { beforeRedirect });
        break;
      } catch (error) {
        checkWorkerDeadline();
        if (wait === 8000) throw error;
      }
    }
    let extracted = { text: '', pageCount: null };
    try {
      extracted = await extractText(pdf.buffer, maxPages);
    } catch (error) {
      checkWorkerDeadline();
      logger.warn('Could not read PDF text (may be scanned)', { url, error: error.message });
    }
    return { ...pdf, ...extracted };
  } catch (error) {
    checkWorkerDeadline();
    logger.warn('PDF download failed', { url, error: error.message });
    return null;
  }
}

function sanitizeFilename(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned || 'DGCA-document'}.pdf`;
}
