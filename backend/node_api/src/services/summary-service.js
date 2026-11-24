import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { classifyPriority, extractDeadline } from './priority-service.js';
import { getSettings } from './settings-service.js';

const logger = createLogger('summary-service');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const CLAUDE_PDF_LIMIT_BYTES = 30 * 1024 * 1024;
const OLLAMA_TEXT_LIMIT = 12000;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-4 sentence plain-English summary of what the document says and requires' },
    key_points: { type: 'array', items: { type: 'string' }, description: 'Up to 5 short bullet points: requirements, changes, dates, who it applies to' },
    action_required: { type: 'string', description: 'What an airline operator should do, in one sentence. "No action required" if none.' },
    applies_to: { type: 'array', items: { type: 'string' }, description: 'Affected functions, e.g. Flight Operations, Engineering, Training, Cargo, Ground Handling, Safety, Legal, None' },
    deadline: { type: 'string', description: 'Earliest response or compliance deadline as YYYY-MM-DD, or empty string if none' },
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    priority_reason: { type: 'string', description: 'One short phrase explaining the priority' }
  },
  required: ['summary', 'key_points', 'action_required', 'applies_to', 'deadline', 'priority', 'priority_reason'],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are a regulatory analyst for the flight operations department of a scheduled Indian airline. You read new publications from India's Directorate General of Civil Aviation (DGCA) and write the short briefing that goes into an email alert.

Write in clear English even when the document is in Hindi. Be factual: report only what the document says, and keep reference numbers, dates and section names exactly as written.

Priority, from the airline's point of view:
- high: new or amended regulations (CARs, draft CARs open for comment), anything affecting flight safety, operations, airworthiness, crew licensing or duty time, dangerous goods, or with a deadline within 2 weeks.
- medium: circulars, guidance, training, licensing or approval process changes, and notices that may need follow-up.
- low: tenders, procurement, recruitment, internships and administrative notices with no operational impact.`;

let anthropicClient = null;

export async function getSummaryProvider() {
  const configured = (await getSettings()).summaryProvider;
  if (process.env.DGCA_ACTIONS_WORKER === '1' && configured !== 'basic') {
    throw Object.assign(new Error('Select the built-in summary engine in Settings before running monitoring on GitHub Actions'), { status: 409 });
  }
  if (configured !== 'auto') return configured;
  return process.env.ANTHROPIC_API_KEY ? 'claude' : 'ollama-or-basic';
}

// Live check of which summary engines can actually run right now.
export async function getSummaryEngineStatus() {
  const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  let ollama = { reachable: false, model, hasModel: false };
  if (process.env.VERCEL === '1') {
    const setting = (await getSettings()).summaryProvider;
    return { setting, active: setting === 'basic' ? 'basic' : null, claude: { keySet: false, model: CLAUDE_MODEL }, ollama };
  }
  try {
    const { data } = await axios.get(`${base}/api/tags`, { timeout: 1500 });
    const names = (data.models || []).map(m => m.name);
    ollama = { reachable: true, model, hasModel: names.some(n => n === model || n.startsWith(`${model}:`)) };
  } catch { /* not running */ }

  const provider = await getSummaryProvider();
  const claudeKeySet = !!process.env.ANTHROPIC_API_KEY;
  let active;
  if (provider === 'claude') active = claudeKeySet ? 'claude' : 'basic';
  else if (provider === 'ollama' || provider === 'ollama-or-basic') active = ollama.reachable && ollama.hasModel ? 'ollama' : 'basic';
  else active = 'basic';

  return { setting: (await getSettings()).summaryProvider, active, claude: { keySet: claudeKeySet, model: CLAUDE_MODEL }, ollama };
}

// Returns { summary, key_points, action_required, applies_to, deadline, priority, priority_reason, source }.
// options.builtInOnly skips AI engines (used for bulk archive imports, so they never run up AI costs).
export async function analyzePublication(update, pdf, options = {}) {
  const text = pdf?.text || '';
  const provider = options.builtInOnly ? 'basic' : await getSummaryProvider();

  let ai = null;
  if (provider === 'claude') {
    ai = await tryClaude(update, pdf);
  } else if (provider === 'ollama' || provider === 'ollama-or-basic') {
    ai = await tryOllama(update, text, provider === 'ollama');
  }

  if (ai) {
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(ai.deadline) ? ai.deadline : extractDeadline(text, update.publicationDate);
    const rules = classifyPriority({ ...update, text, deadline });
    return {
      summary: ai.summary,
      key_points: (ai.key_points || []).slice(0, 5),
      action_required: ai.action_required,
      applies_to: ai.applies_to || [],
      deadline,
      priority: rules.reason.startsWith('Deadline in') ? 'high' : ai.priority,
      priority_reason: rules.reason.startsWith('Deadline in') ? rules.reason : ai.priority_reason,
      source: ai.source
    };
  }

  return basicAnalysis(update, text);
}

async function tryClaude(update, pdf) {
  try {
    if (!anthropicClient) anthropicClient = new Anthropic();

    const intro = `New DGCA publication.\nTab: ${update.section}\nTitle: ${update.title}\nPublished: ${update.publicationDate}`;
    const content = [];
    if (pdf?.buffer && pdf.buffer.length <= CLAUDE_PDF_LIMIT_BYTES) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.buffer.toString('base64') } });
      content.push({ type: 'text', text: `${intro}\n\nThe attached PDF is the publication. Write the briefing.` });
    } else if (pdf?.text) {
      content.push({ type: 'text', text: `${intro}\n\nDocument text:\n${pdf.text}\n\nWrite the briefing.` });
    } else {
      content.push({ type: 'text', text: `${intro}\n\nThe PDF could not be downloaded. Write the briefing from the title only, and say so in the summary.` });
    }

    const response = await anthropicClient.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }]
    });

    if (response.stop_reason === 'refusal') {
      logger.warn('Claude declined to summarise; using built-in summary', { title: update.title.slice(0, 80) });
      return null;
    }
    if (response.stop_reason === 'max_tokens') {
      logger.warn('Claude summary was cut off; using built-in summary', { title: update.title.slice(0, 80) });
      return null;
    }
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) return null;
    return { ...JSON.parse(textBlock.text), source: `claude:${response.model}` };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      logger.error('Claude API key rejected - check ANTHROPIC_API_KEY; using built-in summary');
    } else if (error instanceof Anthropic.RateLimitError) {
      logger.warn('Claude rate limited; using built-in summary');
    } else if (error instanceof Anthropic.APIError) {
      logger.error(`Claude API error ${error.status}; using built-in summary`, { error: error.message });
    } else {
      logger.error('Claude summary failed; using built-in summary', { error: error.message });
    }
    return null;
  }
}

async function tryOllama(update, text, explicitlyConfigured) {
  const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  try {
    if (!explicitlyConfigured) {
      await axios.get(`${base}/api/tags`, { timeout: 1500 });
    }
    const prompt = `${SYSTEM_PROMPT}\n\nNew DGCA publication.\nTab: ${update.section}\nTitle: ${update.title}\nPublished: ${update.publicationDate}\n\n`
      + (text ? `Document text:\n${text.slice(0, OLLAMA_TEXT_LIMIT)}` : 'The document text is not available; use the title only and say so.')
      + '\n\nReply with JSON only.';
    const { data } = await axios.post(`${base}/api/generate`, {
      model, prompt, stream: false, format: ANALYSIS_SCHEMA, options: { temperature: 0.2, num_ctx: 16384 }
    }, { timeout: 300000 });
    const parsed = JSON.parse(data.response);
    if (!parsed.summary || !['high', 'medium', 'low'].includes(parsed.priority)) return null;
    return { ...parsed, source: `ollama:${model}` };
  } catch (error) {
    if (explicitlyConfigured) logger.error('Ollama summary failed; using built-in summary', { error: error.message });
    return null;
  }
}

function basicAnalysis(update, text) {
  const deadline = extractDeadline(`${update.title}\n${text}`, update.publicationDate);
  const { priority, reason } = classifyPriority({ ...update, text, deadline });

  let summary;
  if (!text || text.length < 80) {
    summary = text
      ? `Short document. ${update.title}.`
      : 'The PDF has no machine-readable text (it is probably a scanned image), so no automatic summary is available. Please read the attached PDF.';
  } else {
    summary = extractiveSummary(text)
      || 'The main pages of this PDF appear to be scanned, so no automatic summary is available. Please read the attached PDF.';
  }

  const draft = /\bdraft\b/i.test(update.title) || /comments?\s+(are\s+)?invited/i.test(update.title);
  let action;
  if (priority === 'low') action = 'For information - no operational action expected.';
  else if (draft && deadline) action = `Review the draft and send comments to DGCA by ${formatDate(deadline)}.`;
  else if (deadline) action = `Review for applicability; deadline ${formatDate(deadline)}.`;
  else action = 'Review for applicability to our operations.';

  return {
    summary,
    key_points: keyFacts(text),
    action_required: action,
    applies_to: [],
    deadline,
    priority,
    priority_reason: reason,
    source: 'basic'
  };
}

// Pulls the "Subject:" line and the first substantive sentences after the letterhead.
function extractiveSummary(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const subjectIdx = lines.findIndex(l => /^(subject|sub|विषय|निषय)\s*[:.-]/i.test(l));
  let subject = '';
  let subjectLines = 0;
  if (subjectIdx >= 0) {
    subjectLines = 1;
    while (subjectLines < 3 && lines[subjectIdx + subjectLines] && !/^\d/.test(lines[subjectIdx + subjectLines])) subjectLines++;
    subject = lines.slice(subjectIdx, subjectIdx + subjectLines).join(' ')
      .replace(/^(subject|sub|विषय|निषय)\s*[:.-]\s*/i, '')
      .trim();
  }

  const bodyStart = subjectIdx >= 0 ? subjectIdx + subjectLines : Math.min(8, lines.length);
  const body = lines.slice(bodyStart).join(' ')
    .replace(/(^|\s)\d+(\.\d+)+\.?\s+(?=[A-Z])|(^|\s)\d+\.\s+(?=[A-Z])/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[A-Z][A-Z&]+(\s[A-Z][A-Z&]+){0,4}\s(?=[A-Z][a-z])/, '');
  const sentences = (body.match(/[^.!?]{40,}?[.!?](?=\s|$)/g) || [])
    .map(s => s.trim())
    .filter(s => !/^(government of india|office of|file no|dated?|page \d)/i.test(s))
    .filter(s => !/…{2,}|\.{4,}|_{3,}/.test(s) && /^[A-Z(“"']/.test(s))
    .slice(0, 2);
  if (!subject && sentences.length === 0) return '';

  const parts = [];
  if (subject) parts.push(`Subject: ${subject.replace(/[.\s]+$/, '')}.`);
  parts.push(...sentences);
  const out = parts.join(' ').trim();
  return out.length > 700 ? `${out.slice(0, 697).replace(/\s+\S*$/, '')}...` : out;
}

function keyFacts(text) {
  const facts = [];
  const fileNo = text.match(/(?:e-?)?file\s*no\.?\s*[:-]?\s*([A-Z0-9][A-Z0-9/().\- ]{6,60}?)(?=\s{2}|\n|dated|date|$)/i);
  if (fileNo) facts.push(`File No. ${fileNo[1].trim()}`);
  const effective = text.match(/effective\s*[:-]?\s*(forthwith|immediately|from\s+[^\n.]{3,40}|\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
  if (effective) facts.push(`Effective: ${effective[1].trim()}`);
  const issue = text.match(/\b(issue\s+[ivx\d]+[^\n]{0,40}?rev(?:ision)?\.?\s*\d+|issue\s+[ivx\d]+)/i);
  if (issue) facts.push(issue[1].trim());
  return facts.slice(0, 5);
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
