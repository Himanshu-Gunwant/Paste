import { Worker, type Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getQueueConnection } from '../queues/queues.js';
import type { EmailJobData } from '../queues/jobs.js';
import { renderEmail } from '../services/email-templates.js';

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!transporter) {
    if (!env.SMTP_HOST) {
      throw new Error('SMTP_HOST is not configured — email jobs will fail');
    }
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
    });
  }
  return transporter;
}

/**
 * Email processor (docs/ARCHITECTURE.md §12.3). Throwing retries with the
 * queue's exponential backoff; exhausted attempts land in the retained
 * failed set (dead-letter view via Bull Board + failed-jobs gauge alert).
 */
export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { subject, text, html } = renderEmail(job.data);
  await getTransporter().sendMail({
    from: env.EMAIL_FROM,
    to: job.data.to,
    subject,
    text,
    html,
  });
  logger.info({ jobId: job.id, type: job.data.type, to: job.data.to }, 'email sent');
}

export function startEmailWorker(): Worker<EmailJobData> {
  return new Worker<EmailJobData>('email', processEmailJob, {
    connection: getQueueConnection(),
    concurrency: 5,
  });
}
