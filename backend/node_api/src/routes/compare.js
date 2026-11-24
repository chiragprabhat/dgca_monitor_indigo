import { asyncRoute } from '../utils/async-route.js';
import express from 'express';
import { getDatabase } from '../config/database.js';
import { fetchPdfWithText, FULL_DOCUMENT_PAGES } from '../services/pdf-service.js';
import { diffTexts, fullTextOf } from '../services/revision-service.js';
import { MAX_UPLOAD_BYTES, storeUpload, listUploads, deleteUpload, loadUpload } from '../services/upload-service.js';

const router = express.Router();

const ALLOWED_HOSTS = new Set(['www.dgca.gov.in', 'dgca.gov.in']);

// "car:CAR S8 O 2" is a Civil Aviation Requirement in force, "upload:<id>" a PDF the user uploaded;
// anything else is a stored publication.
async function loadById(id) {
  if (id.startsWith('car:')) return await loadCar(id.slice(4));
  if (id.startsWith('upload:')) return await loadUpload(id.slice(7));
  const row = await getDatabase().prepare('SELECT * FROM updates WHERE id = $1').get(id);
  if (!row) throw Object.assign(new Error(`Publication ${id} not found`), { status: 404 });
  const text = await fullTextOf(row);
  const pages = (await getDatabase().prepare('SELECT pdf_pages FROM updates WHERE id = $1').get(id))?.pdf_pages ?? row.pdf_pages;
  if (!text && !JSON.parse(row.pdf_urls || '[]')[0]) throw Object.assign(new Error(`"${row.title.slice(0, 60)}" has no PDF`), { status: 422 });
  return { label: row.title, published: row.publication_date, section: row.section, pages, text };
}

async function loadCar(carId) {
  const db = getDatabase();
  const car = await db.prepare('SELECT * FROM car_documents WHERE id = $1').get(carId);
  if (!car) throw Object.assign(new Error(`${carId} is not in the stored CAR list - refresh it in Document Comparison`), { status: 404 });
  if (car.status !== 'in force' || !car.pdf_url) {
    const why = car.status === 'removed' ? 'no longer listed by DGCA' : 'revoked';
    throw Object.assign(new Error(`${carId} is ${why}; there is no document in force to compare with`), { status: 422 });
  }
  let { pdf_text: text, pdf_pages: pages } = car;
  if (text == null) {
    const pdf = await fetchPdfWithText(car.pdf_url, { maxPages: FULL_DOCUMENT_PAGES });
    if (!pdf) throw Object.assign(new Error(`Could not download ${carId} from DGCA`), { status: 502 });
    ({ text, pageCount: pages } = pdf);
    await db.prepare('UPDATE car_documents SET pdf_text = $1, pdf_pages = $2, read_at = dgca_utc_now() WHERE id = $3').run(text || '', pages ?? null, carId);
  }
  const roman = car.part;
  return {
    label: `CAR Section ${car.section} Series ${car.series} Part ${roman} - ${car.subject} (in force: ${[car.issue, car.amendment].filter(Boolean).join(', ')})`,
    published: car.amendment_date || car.issue_date, section: 'car', pages, text
  };
}

async function loadByUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('Not a valid link'), { status: 400 }); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw Object.assign(new Error('Only https://www.dgca.gov.in PDF links can be compared'), { status: 400 });
  }
  const pdf = await fetchPdfWithText(url.href);
  if (!pdf) throw Object.assign(new Error('Could not download a PDF from that link'), { status: 502 });
  return { label: pdf.filename, published: null, section: null, pages: pdf.pageCount, text: pdf.text };
}

// GET /api/compare?a=<id>&b=<id>   or   ?a=<id>&url=<DGCA PDF link>
router.get('/', async (req, res, next) => {
  try {
    const { a, b, url } = req.query;
    if (!a || (!b && !url)) return res.status(400).json({ error: 'Choose two documents to compare' });
    if (b && a === b) return res.status(400).json({ error: 'Choose two different documents' });

    const [left, right] = await Promise.all([loadById(a), b ? loadById(b) : loadByUrl(url)]);
    const { leftLines, rightLines, chunks, stats } = diffTexts(left.text, right.text);
    const warnings = [];
    if (leftLines.length < 3) warnings.push(`"${left.label.slice(0, 60)}" has little or no readable text (probably scanned).`);
    if (rightLines.length < 3) warnings.push(`"${right.label.slice(0, 60)}" has little or no readable text (probably scanned).`);

    res.json({
      left: { label: left.label, published: left.published, section: left.section, pages: left.pages, lines: leftLines.length },
      right: { label: right.label, published: right.published, section: right.section, pages: right.pages, lines: rightLines.length },
      stats,
      warnings,
      chunks
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

// POST /api/compare/upload?name=<file name>   body: the raw PDF bytes
// Stores the PDF's text so it can be compared (as "upload:<id>") with a CAR in force or any publication.
router.post('/upload', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res, next) => {
  try {
    res.status(201).json(await storeUpload(req.body, req.query.name));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

// GET /api/compare/uploads - files uploaded so far, newest first.
router.get('/uploads', asyncRoute(async (req, res) => res.json({ data: await listUploads() })));

// DELETE /api/compare/uploads/<id>
router.delete('/uploads/:id', asyncRoute(async (req, res) => {
  if (!await deleteUpload(req.params.id.replace(/^upload:/, ''))) return res.status(404).json({ error: 'Uploaded file not found' });
  res.json({ deleted: true });
}));

export default router;
