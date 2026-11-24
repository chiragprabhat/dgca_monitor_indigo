import nodemailer from 'nodemailer';
import { getDatabase } from '../config/database.js';
import { createLogger } from '../utils/logger.js';
import { claimEmailDelivery, markAsNotified } from './state-service.js';
import { daysUntil } from './priority-service.js';
import { formatDate } from './summary-service.js';
import { getSettings } from './settings-service.js';
import { getTrustedCAs } from '../utils/system-ca.js';
import { parseRevision } from './revision-service.js';

const logger = createLogger('notification-service');

// Turns low-level connection errors into something a non-developer can act on.
export function explainEmailError(error) {
  const msg = error?.message || String(error);
  if (/certificate|self[- ]signed|CERT_|UNABLE_TO_VERIFY/i.test(msg)) {
    return `${msg} - the network is inspecting secure connections with a certificate Windows doesn't trust either. Ask IT to allow SMTP to smtp.gmail.com, or use the company mail server (SMTP_* settings).`;
  }
  if (/Invalid login|Username and Password not accepted|535/i.test(msg)) {
    return `${msg} - Gmail rejected the sign-in. Check EMAIL_FROM and the 16-character app password in api\\.env.`;
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
    return `${msg} - could not reach the mail server. The network may block outgoing email ports (465/587).`;
  }
  return msg;
}

let transporter = null;

const SECTION_NAMES = {
  tenders: 'Tenders',
  regulation: 'Regulation',
  guidance: 'Guidance',
  announcements: 'Announcements'
};

const PRIORITY_STYLE = {
  high: { label: 'HIGH PRIORITY', bg: '#B91C1C', soft: '#FEF2F2', border: '#FCA5A5' },
  medium: { label: 'MEDIUM PRIORITY', bg: '#B45309', soft: '#FFFBEB', border: '#FCD34D' },
  low: { label: 'LOW PRIORITY', bg: '#047857', soft: '#ECFDF5', border: '#6EE7B7' }
};

export async function isEmailEnabled() {
  return (await getSettings()).emailEnabled;
}

export async function getRecipients() {
  return (await getSettings()).recipients;
}

function senderAddress() {
  return process.env.EMAIL_FROM || process.env.SMTP_USER || '';
}

function senderName() {
  return process.env.EMAIL_FROM_NAME || 'DGCA Regulatory Alerts';
}

export async function initializeEmailService() {
  if (!await isEmailEnabled()) return null;
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER || process.env.EMAIL_FROM;
  const pass = process.env.SMTP_PASSWORD || process.env.EMAIL_APP_PASSWORD;

  if (host) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure && port === 587,
      tls: { ca: getTrustedCAs() },
      ...(user && pass ? { auth: { user, pass } } : {})
    });
    logger.info(`Email service initialized (SMTP ${host}:${port})`);
  } else {
    if (!user || !pass) {
      logger.warn('Email configuration incomplete (EMAIL_FROM / EMAIL_APP_PASSWORD). Notifications will not be sent.');
      return null;
    }
    transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass }, tls: { ca: getTrustedCAs() } });
    logger.info('Email service initialized (Gmail)');
  }
  return transporter;
}

// update: a row from the updates table. analysis/pdf come from the monitor cycle.
export async function sendNotification(update, { analysis, pdf, automatic, assertHeld } = {}) {
  if (!await isEmailEnabled()) {
    return { success: false, skipped: true, error: 'Email notifications disabled (EMAIL_NOTIFICATIONS_ENABLED is not true)' };
  }
  if (!transporter) transporter = await initializeEmailService();
  if (!transporter) return { success: false, error: 'Email service not configured' };

  const recipients = await getRecipients();
  if (recipients.length === 0) return { success: false, error: 'No recipients (set EMAIL_RECIPIENTS)' };

  const email = renderEmail(update, analysis);
  const attachments = [];
  const maxBytes = parseFloat(process.env.EMAIL_MAX_ATTACHMENT_MB || '15') * 1024 * 1024;
  let attachmentNote = 'no PDF';
  if (pdf?.buffer && !(await getSettings()).attachPdf) {
    attachmentNote = 'PDF attachments turned off in Settings - link only';
  } else if (pdf?.buffer && pdf.buffer.length <= maxBytes) {
    attachments.push({ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' });
    attachmentNote = `attached ${pdf.filename}`;
  } else if (pdf?.buffer) {
    attachmentNote = `PDF too large to attach (${(pdf.buffer.length / 1048576).toFixed(1)} MB) - link only`;
  }

  assertHeld?.();
  const claimed = await claimEmailDelivery(update.id);
  if (automatic && !claimed) return { success: false, alreadyAttempted: true };
  assertHeld?.();
  try {
    const info = await transporter.sendMail({
      from: { name: senderName(), address: senderAddress() },
      to: recipients.join(', '),
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments,
      headers: analysis?.priority === 'high' ? { Importance: 'High', 'X-Priority': '1' } : {}
    });

    await logNotification(update.id, recipients.join(', '), 'sent');
    await markAsNotified(update.id);
    logger.info(`Email sent to ${recipients.length} recipient(s) for: ${update.title.slice(0, 80)} (${attachmentNote})`, { messageId: info.messageId });
    return { success: true, messageId: info.messageId, recipients };
  } catch (error) {
    const reason = explainEmailError(error);
    logger.error('Failed to send email:', { error: reason, updateId: update.id });
    await logNotification(update.id, recipients.join(', '), 'failed', reason);
    return { success: false, error: reason };
  }
}

export function renderEmail(update, analysis) {
  const sectionName = SECTION_NAMES[update.section] || update.section;
  const priority = analysis?.priority || update.priority || 'medium';
  const style = PRIORITY_STYLE[priority] || PRIORITY_STYLE.medium;
  const pdfUrl = parseUrls(update.pdf_urls)[0] || '';
  const published = formatDate(update.publication_date);
  const reason = analysis?.priority_reason || update.priority_reason || '';
  const summary = analysis?.summary || update.summary || '';
  const keyPoints = analysis?.key_points || [];
  const action = analysis?.action_required || '';
  const appliesTo = (analysis?.applies_to || []).filter(a => a && !/^none$/i.test(a));
  const deadline = analysis?.deadline || update.deadline || '';
  const days = daysUntil(deadline);
  const deadlineText = deadline
    ? `${formatDate(deadline)}${days !== null && days >= 0 ? ` (${days} day${days === 1 ? '' : 's'} left)` : ''}`
    : '';
  const source = analysis?.source || update.summary_source || '';
  const sourceText = source.startsWith('claude') ? 'AI summary (Claude)'
    : source.startsWith('ollama') ? 'AI summary (local model)'
    : 'Automatic summary from the PDF text - please verify against the document';

  const revision = parseRevision(update.revision);
  const revisionStats = revision?.stats
    ? `${revision.stats.added} sentence${revision.stats.added === 1 ? '' : 's'} added, ${revision.stats.removed} removed (${revision.stats.similarity}% unchanged)`
    : '';

  const subject = `[${priority.toUpperCase()}] DGCA ${sectionName}: ${truncate(update.title, 110)}`;

  const row = (label, value) => value ? `
              <tr>
                <td style="padding:4px 12px 4px 0;font-size:13px;color:#6B7280;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
                <td style="padding:4px 0;font-size:13px;color:#111827;">${value}</td>
              </tr>` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F4F6" style="background-color:#F3F4F6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:640px;max-width:640px;background-color:#FFFFFF;border:1px solid #E5E7EB;font-family:Segoe UI,Arial,Helvetica,sans-serif;">
      <tr><td bgcolor="#002060" style="background-color:#002060;padding:16px 24px;">
        <span style="font-size:13px;color:#BFD4EE;letter-spacing:1px;">DGCA REGULATORY INTELLIGENCE</span><br>
        <span style="font-size:20px;font-weight:bold;color:#FFFFFF;">New ${esc(sectionName)} publication</span>
      </td></tr>
      <tr><td bgcolor="${style.bg}" style="background-color:${style.bg};padding:10px 24px;">
        <span style="font-size:14px;font-weight:bold;color:#FFFFFF;letter-spacing:1px;">${style.label}</span>
        ${reason ? `<span style="font-size:13px;color:#FFFFFF;">&nbsp;&nbsp;|&nbsp;&nbsp;${esc(reason)}</span>` : ''}
      </td></tr>
      <tr><td style="padding:20px 24px 8px 24px;">
        <div style="font-size:18px;font-weight:bold;color:#002060;line-height:1.4;">${esc(update.title)}</div>
      </td></tr>
      <tr><td style="padding:4px 24px 12px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          ${row('Category', esc(sectionName))}
          ${row('Published', esc(published))}
          ${row('Deadline', deadlineText ? `<b style="color:${style.bg};">${esc(deadlineText)}</b>` : '')}
          ${row('Applies to', esc(appliesTo.join(', ')))}
        </table>
      </td></tr>
      ${summary ? `
      <tr><td style="padding:4px 24px 12px 24px;">
        <div style="font-size:12px;font-weight:bold;color:#6B7280;letter-spacing:1px;padding-bottom:6px;">SUMMARY</div>
        <div style="font-size:14px;color:#1F2937;line-height:1.6;">${esc(summary)}</div>
      </td></tr>` : ''}
      ${keyPoints.length ? `
      <tr><td style="padding:4px 24px 12px 24px;">
        <div style="font-size:12px;font-weight:bold;color:#6B7280;letter-spacing:1px;padding-bottom:6px;">KEY POINTS</div>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#1F2937;line-height:1.6;">
          ${keyPoints.map(p => `<li style="margin-bottom:4px;">${esc(p)}</li>`).join('')}
        </ul>
      </td></tr>` : ''}
      ${revision ? `
      <tr><td style="padding:4px 24px 12px 24px;">
        <div style="font-size:12px;font-weight:bold;color:#6B7280;letter-spacing:1px;padding-bottom:6px;">WHAT CHANGED SINCE THE PREVIOUS VERSION</div>
        <div style="font-size:13px;color:#1F2937;line-height:1.5;padding-bottom:6px;">Compared with: <b>${esc(truncate(revision.previous.title, 160))}</b> (${esc(formatDate(revision.previous.publication_date))})</div>
        ${revisionStats ? `<div style="font-size:14px;font-weight:bold;color:#002060;padding-bottom:6px;">${esc(revisionStats)}</div>` : ''}
        ${revision.note ? `<div style="font-size:13px;color:#6B7280;padding-bottom:6px;">${esc(revision.note)}</div>` : ''}
        ${(revision.added || []).map(l => `<div style="font-size:13px;color:#14532D;background-color:#DCFCE7;border-left:3px solid #16A34A;padding:6px 8px;margin-bottom:4px;line-height:1.5;">+ ${esc(l)}</div>`).join('')}
        ${(revision.removed || []).map(l => `<div style="font-size:13px;color:#7F1D1D;background-color:#FEE2E2;border-left:3px solid #DC2626;padding:6px 8px;margin-bottom:4px;line-height:1.5;">&minus; ${esc(l)}</div>`).join('')}
        ${revision.stats ? '<div style="font-size:12px;color:#6B7280;padding-top:4px;">First key changes shown. The full comparison is in the dashboard under Document Comparison.</div>' : ''}
      </td></tr>` : ''}
      ${action ? `
      <tr><td style="padding:4px 24px 16px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${style.soft}" style="background-color:${style.soft};border:1px solid ${style.border};">
          <tr><td style="padding:12px 14px;font-size:14px;color:#111827;"><b>Action required:</b> ${esc(action)}</td></tr>
        </table>
      </td></tr>` : ''}
      <tr><td style="padding:4px 24px 20px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          ${pdfUrl ? `<td bgcolor="#0759A8" style="background-color:#0759A8;padding:10px 18px;"><a href="${esc(pdfUrl)}" style="font-size:14px;font-weight:bold;color:#FFFFFF;text-decoration:none;">Open PDF on DGCA</a></td><td width="12"></td>` : ''}
          <td style="padding:10px 18px;border:1px solid #0759A8;"><a href="https://www.dgca.gov.in/digigov-portal/" style="font-size:14px;color:#0759A8;text-decoration:none;">DGCA What's New</a></td>
        </tr></table>
      </td></tr>
      <tr><td bgcolor="#F9FAFB" style="background-color:#F9FAFB;border-top:1px solid #E5E7EB;padding:12px 24px;font-size:12px;color:#6B7280;line-height:1.5;">
        ${esc(sourceText)}. The full DGCA document is attached when available.<br>
        Automated alert from the DGCA Regulatory Intelligence monitor.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `${style.label}${reason ? ` - ${reason}` : ''}`,
    '',
    update.title,
    `Category: ${sectionName}`,
    `Published: ${published}`,
    deadlineText ? `Deadline: ${deadlineText}` : '',
    appliesTo.length ? `Applies to: ${appliesTo.join(', ')}` : '',
    '',
    summary ? `Summary: ${summary}` : '',
    ...keyPoints.map(p => `- ${p}`),
    revision ? `\nWhat changed since ${truncate(revision.previous.title, 100)} (${formatDate(revision.previous.publication_date)}): ${revisionStats || revision.note || ''}` : '',
    ...(revision?.added || []).map(l => `+ ${l}`),
    ...(revision?.removed || []).map(l => `- ${l}`),
    action ? `\nAction required: ${action}` : '',
    '',
    pdfUrl ? `PDF: ${pdfUrl}` : '',
    'DGCA What\'s New: https://www.dgca.gov.in/digigov-portal/',
    '',
    `${sourceText}.`
  ].filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n');

  return { subject, html, text };
}

function parseUrls(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3).replace(/\s+\S*$/, '')}...` : text;
}

async function logNotification(updateId, recipient, status, error = null) {
  try {
    await getDatabase().prepare(`
      INSERT INTO notifications (update_id, recipient_email, status, error_message)
      VALUES ($1, $2, $3, $4)
    `).run(updateId, recipient, status, error);
  } catch (err) {
    logger.error('Error logging notification:', { error: err.message });
  }
}

export async function getEmailConfiguration() {
  const hasPassword = !!(process.env.SMTP_HOST
    ? (process.env.SMTP_PASSWORD || process.env.EMAIL_APP_PASSWORD)
    : process.env.EMAIL_APP_PASSWORD && !/your_|here/.test(process.env.EMAIL_APP_PASSWORD));
  const last = async status => await getDatabase().prepare(
    'SELECT sent_at, recipient_email, error_message FROM notifications WHERE status = $1 ORDER BY sent_at DESC NULLS LAST LIMIT 1'
  ).get(status) || null;
  return {
    from: senderAddress(),
    fromName: senderName(),
    recipients: await getRecipients(),
    transport: process.env.SMTP_HOST ? `smtp:${process.env.SMTP_HOST}` : 'gmail',
    enabled: await isEmailEnabled(),
    sameDayOnly: (await getSettings()).sameDayOnly,
    senderPasswordSet: hasPassword,
    lastSent: await last('sent'),
    lastFailed: await last('failed'),
    isConfigured: !!(senderAddress() && hasPassword && (await getRecipients()).length)
  };
}

export async function validateEmailConfig() {
  const errors = [];
  if (!senderAddress()) errors.push('EMAIL_FROM not configured');
  const recipients = await getRecipients();
  if (recipients.length === 0) errors.push('EMAIL_RECIPIENTS not configured');
  for (const r of recipients) if (!isValidEmail(r)) errors.push(`Not a valid email address: ${r}`);
  if (senderAddress() && !isValidEmail(senderAddress())) errors.push('EMAIL_FROM is not a valid email address');
  return { valid: errors.length === 0, errors };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function getNotificationHistory(limit = 20) {
  try {
    return await getDatabase().prepare('SELECT * FROM notifications ORDER BY sent_at DESC NULLS LAST LIMIT NULLIF(GREATEST($1::bigint, -1), -1)').all(limit);
  } catch (error) {
    logger.error('Error getting notification history:', { error: error.message });
    return [];
  }
}

export async function testEmailConnection() {
  if (!transporter) transporter = await initializeEmailService();
  if (!transporter) return { success: false, error: await isEmailEnabled() ? 'Email service not configured' : 'Email notifications disabled' };
  try {
    await transporter.verify();
    return { success: true, message: 'Email connection verified' };
  } catch (error) {
    return { success: false, error: explainEmailError(error) };
  }
}
