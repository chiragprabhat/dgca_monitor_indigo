import axios from 'axios';
import { load } from 'cheerio';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scraper');

const DGCA_BASE_URL = 'https://www.dgca.gov.in/digigov-portal/';
const TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS || '30000');
const RETRY_ATTEMPTS = parseInt(process.env.SCRAPER_RETRY_ATTEMPTS || '3');

// Tabs of the portal's "What's New" block. Tenders and Announcements are in the
// server-rendered HTML; Regulation and Guidance panes are empty placeholders that
// the page fills on tab click via ajaxCallService('<name>') in commonDynamic.js.
// Each tab's "More" page (a form POST) lists its current items, then the
// "Archived" ones in a hidden #archiveData block. It shows far more than the 3
// items on the home page, so it is the primary source; the home page is the fallback.
const SECTIONS = {
  tenders: { paneId: 'tenders', more: { actionVal: 'viewAllTenderService', classification: '' } },
  announcements: { paneId: 'announcement', more: { actionVal: 'viewAllService', classification: 'announcement' } },
  regulation: { ajaxClassification: 'Regulation', more: { actionVal: 'viewAllService', classification: 'regulations' } },
  guidance: { ajaxClassification: 'Guidance', more: { actionVal: 'viewAllService', classification: 'guidance' } }
};

export const SECTION_KEYS = Object.keys(SECTIONS);

// The endpoint takes the tab name, not the numeric code it echoes back
// (5006000087 = Regulation, 5006000088 = Guidance). en_US returns English titles.
const AJAX_LOCALE = 'en_US';

async function fetchWithRetry(url, method = 'get', attempt = 1) {
  try {
    const response = await axios.request({
      url,
      method,
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(method === 'post' ? { Referer: DGCA_BASE_URL } : {})
      }
    });
    return response.data;
  } catch (error) {
    if (attempt < RETRY_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn(`Fetch failed, retry ${attempt}/${RETRY_ATTEMPTS} after ${delay}ms`, { url });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, method, attempt + 1);
    }
    throw error;
  }
}

export async function scrapeAllSections() {
  const startTime = Date.now();

  try {
    const html = await fetchWithRetry(DGCA_BASE_URL);
    const $ = load(html);
    const allUpdates = [];
    const sectionResults = {};

    for (const [sectionKey, config] of Object.entries(SECTIONS)) {
      let items;
      try {
        const current = (await fetchMoreList(sectionKey)).filter(i => !i.inArchive);
        if (current.length) {
          sectionResults[sectionKey] = current.length;
          allUpdates.push(...current);
          continue;
        }
        logger.warn(`${sectionKey}: "More" list was empty - falling back to the home page tab`);
      } catch (error) {
        logger.warn(`${sectionKey}: could not read the "More" list - falling back to the home page tab`, { error: error.message });
      }
      try {
        if (config.ajaxClassification) {
          items = await fetchAjaxTab(sectionKey, config.ajaxClassification);
        } else {
          const $pane = $(`.tab-pane#${config.paneId}`);
          if ($pane.length === 0) {
            logger.error(`What's New tab #${config.paneId} not found - DGCA page layout may have changed`);
            sectionResults[sectionKey] = 'missing';
            continue;
          }
          items = parsePane($, $pane, sectionKey);
        }
      } catch (error) {
        logger.error(`${sectionKey}: failed to read What's New tab`, { error: error.message });
        sectionResults[sectionKey] = 'error';
        continue;
      }

      sectionResults[sectionKey] = items.length;
      allUpdates.push(...items);
      if (items.length === 0) {
        logger.warn(`${sectionKey}: tab contained no publications`);
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`Scraping completed in ${duration}ms, found ${allUpdates.length} publications`, sectionResults);

    if (allUpdates.length === 0) {
      return {
        success: false,
        items: [],
        error: "No publications found in any What's New tab - page layout may have changed",
        timestamp: new Date().toISOString()
      };
    }

    return {
      success: true,
      items: allUpdates,
      duration,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Scraping failed:', { error: error.message });
    return {
      success: false,
      items: [],
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

function parsePane($, $pane, sectionKey) {
  const updates = [];
  const detectedAt = new Date().toISOString();

  $pane.find('.sub-section').each((_, el) => {
    const $block = $(el);
    const $heading = $block.find('p.sub-heading').first();
    const title = clean($heading.text());
    if (!title) return;

    const metaText = clean($block.find('p.sub-content').first().text());
    const publicationDate = parseDgcaDate(metaText);
    if (!publicationDate) {
      logger.warn(`${sectionKey}: skipped item without a recognisable date`, { title: title.slice(0, 80) });
      return;
    }

    const attachId = extractAttachId($heading.find('a').attr('onclick'))
      || extractAttachId($block.find('a[onclick*="pdfDownload"]').first().attr('onclick'));
    const sizeMatch = metaText.match(/([\d.]+\s*MB)/i);

    updates.push({
      section: sectionKey,
      title,
      description: sizeMatch ? `PDF, ${sizeMatch[1]}` : '',
      publicationDate,
      pdfUrl: attachId ? `${DGCA_BASE_URL}Upload?flag=iframeAttachView&attachId=${attachId}&baseLocale=en` : '',
      sourcePageUrl: DGCA_BASE_URL,
      detectedAt
    });
  });

  return updates;
}

async function fetchAjaxTab(sectionKey, classification) {
  const url = `${DGCA_BASE_URL}scan?baseLocale=${AJAX_LOCALE}&requestType=ApplicationRH`
    + `&actionVal=viewAllServiceForAJAX&screenId=10000001&classification=${classification}`;
  const data = await fetchWithRetry(url, 'post');
  if (!data || typeof data !== 'object' || !Array.isArray(data.contents)) {
    throw new Error('unexpected response (not the What\'s New JSON) - endpoint may have changed');
  }

  const detectedAt = new Date().toISOString();
  const updates = [];
  data.contents.forEach((rawTitle, i) => {
    const title = clean(rawTitle);
    if (!title) return;

    const publicationDate = parseDgcaDate(String(data.startDate?.[i] || ''));
    if (!publicationDate) {
      logger.warn(`${sectionKey}: skipped item without a recognisable date`, { title: title.slice(0, 80) });
      return;
    }

    const attachId = data.attachId?.[i] && data.attachId[i] !== 0 ? String(data.attachId[i]) : '';
    const doc = data.attachMstVOListTwo?.[i]?.docAttachMpgVOs?.[0];
    const sizeMb = doc?.docSize ? (doc.docSize / 1024 / 1024).toFixed(2) : null;

    updates.push({
      section: sectionKey,
      title,
      description: doc?.docFileType && sizeMb ? `${doc.docFileType.toUpperCase()}, ${sizeMb} MB` : '',
      publicationDate,
      pdfUrl: attachId ? `${DGCA_BASE_URL}Upload?flag=iframeAttachView&attachId=${attachId}&baseLocale=en` : '',
      sourcePageUrl: DGCA_BASE_URL,
      detectedAt
    });
  });

  return updates;
}

// Every publication on a tab's "More" page, current and archived (inArchive: true).
export async function fetchMoreList(sectionKey) {
  const config = SECTIONS[sectionKey];
  if (!config) throw new Error(`Unknown section ${sectionKey}`);
  const body = new URLSearchParams({
    baseLocale: '', screenId: '10000001', requestType: 'ApplicationRH', langType: '2',
    actionVal: config.more.actionVal, classification: config.more.classification
  }).toString();

  let html;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await axios.post(`${DGCA_BASE_URL}scan?baseLocale=en_US`, body, {
        timeout: Math.max(TIMEOUT_MS, 60000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: DGCA_BASE_URL
        }
      });
      html = response.data;
      break;
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }

  const $ = load(html);
  const detectedAt = new Date().toISOString();
  const items = [];
  $('.sub-section').each((_, el) => {
    const $block = $(el);
    const title = clean($block.find('.sub-heading').first().text());
    if (!title) return;
    const metaText = clean($block.find('.sub-content').first().text());
    const publicationDate = parseDgcaDate(metaText);
    if (!publicationDate) return;
    const attachId = extractAttachId($block.find('.sub-heading a').attr('onclick'))
      || extractAttachId($block.find('a[onclick*="pdfDownload"]').first().attr('onclick'));
    const sizeMatch = metaText.match(/([\d.]+\s*(MB|KB))/i);
    items.push({
      section: sectionKey,
      title,
      description: sizeMatch ? `PDF, ${sizeMatch[1]}` : '',
      publicationDate,
      pdfUrl: attachId ? `${DGCA_BASE_URL}Upload?flag=iframeAttachView&attachId=${attachId}&baseLocale=en` : '',
      sourcePageUrl: DGCA_BASE_URL,
      detectedAt,
      inArchive: $block.closest('#archiveData').length > 0
    });
  });
  if (items.length === 0) throw new Error('no publications found on the "More" page - layout may have changed');
  return items;
}

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// DGCA prints dates day-first: "05/10/2026" or "30.08.2025 (01:00 AM)".
function parseDgcaDate(text) {
  const m = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = parseInt(d, 10);
  const month = parseInt(mo, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractAttachId(onclick) {
  const m = (onclick || '').match(/pdfDownload\(\s*['"]([^'"]+)['"]/);
  return m ? m[1] : '';
}

export async function validatePdfUrl(url) {
  if (!url) return false;
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      maxRedirects: 5
    });
    return response.status === 200;
  } catch (error) {
    logger.debug(`PDF URL validation failed for ${url}:`, { error: error.message });
    return false;
  }
}
