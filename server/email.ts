/**
 * Optional email sending over HTTPS (Railway's free plan blocks SMTP ports).
 *
 *   BREVO_API_KEY + SENDER_EMAIL (+ SENDER_NAME)  — brevo.com free plan, ~300 emails/day, no card.
 *                                                    Verify SENDER_EMAIL as a sender in Brevo first.
 *
 * Without a key, the UI opens the email pre-filled in Gmail / your mail app instead
 * (which is also the best option for deliverability on low-volume investor outreach).
 */
import { gmailConfigured, gmailSend } from './gmail';

const env = (k: string) => (process.env[k] || '').trim();

/** 'gmail' (free helper script, best) → 'brevo' → 'none' (you send by hand from Gmail). */
export function emailProvider(): string {
  if (gmailConfigured()) return 'gmail';
  return env('BREVO_API_KEY') && env('SENDER_EMAIL') ? 'brevo' : 'none';
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  replyTo?: string,
  fromName?: string,
  label?: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: 'Invalid recipient email' };
  if (emailProvider() === 'gmail') {
    const r = await gmailSend(to, subject, body, { replyTo, fromName, label });
    return r.ok ? { ok: true, id: r.threadId } : { ok: false, error: r.error };
  }
  if (emailProvider() !== 'brevo') return { ok: false, error: 'No email sender set up (add the Gmail helper script, or BREVO_API_KEY + SENDER_EMAIL).' };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': env('BREVO_API_KEY') },
    body: JSON.stringify({
      sender: { email: env('SENDER_EMAIL'), name: fromName || env('SENDER_NAME') || undefined },
      to: [{ email: to }],
      replyTo: replyTo ? { email: replyTo } : undefined,
      subject,
      textContent: body
    }),
    signal: AbortSignal.timeout(20000)
  });
  const txt = await res.text();
  if (!res.ok) return { ok: false, error: `Brevo ${res.status}: ${txt.slice(0, 200)}` };
  try {
    return { ok: true, id: JSON.parse(txt).messageId };
  } catch {
    return { ok: true };
  }
}
