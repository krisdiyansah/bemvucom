'use strict';

const nodemailer = require('nodemailer');

class EmailConfigurationError extends Error {
  constructor() {
    super('Gmail SMTP is not configured.');
    this.name = 'EmailConfigurationError';
  }
}

function createOtpEmailSender(env = process.env) {
  return async function sendOtpEmail({ to, code, purpose }) {
    const user = String(env.SMTP_USER || '').trim();
    const pass = String(env.SMTP_PASS || '').replace(/\s/g, '');
    if (!user || !pass) throw new EmailConfigurationError();

    const port = Number(env.SMTP_PORT || 465);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SMTP_PORT must be a valid port number.');
    }

    const host = String(env.SMTP_HOST || 'smtp.gmail.com').trim();
    const secure = env.SMTP_SECURE === undefined
      ? port === 465
      : String(env.SMTP_SECURE).toLowerCase() === 'true';
    const isPasswordReset = purpose === 'password-reset';
    const subject = isPasswordReset
      ? 'Reset your Bemvu password | Atur ulang kata sandi Bemvu'
      : 'Verify your Bemvu account | Verifikasi akun Bemvu';
    const englishAction = isPasswordReset ? 'reset your password' : 'verify your email address';
    const indonesianAction = isPasswordReset ? 'mengatur ulang kata sandi' : 'memverifikasi alamat email';

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: String(env.SMTP_FROM || user),
      to,
      subject,
      text: [
        `Your Bemvu verification code to ${englishAction} is: ${code}`,
        'This code expires in 10 minutes. Do not share it with anyone.',
        '',
        `Kode verifikasi Bemvu untuk ${indonesianAction}: ${code}`,
        'Kode ini berlaku selama 10 menit. Jangan bagikan kepada siapa pun.',
      ].join('\n'),
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0f1e36">
          <h2>Bemvu</h2>
          <p>Use this code to ${englishAction}:</p>
          <p style="font-size:30px;font-weight:700;letter-spacing:8px;padding:14px;background:#f1f5f9;text-align:center">${code}</p>
          <p>This code expires in 10 minutes. Do not share it with anyone.</p>
          <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0">
          <p>Gunakan kode ini untuk ${indonesianAction}:</p>
          <p style="font-size:30px;font-weight:700;letter-spacing:8px;padding:14px;background:#f1f5f9;text-align:center">${code}</p>
          <p>Kode berlaku selama 10 menit. Jangan bagikan kepada siapa pun.</p>
        </div>
      `,
    });
  };
}

module.exports = {
  EmailConfigurationError,
  createOtpEmailSender,
};
