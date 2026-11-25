'use strict';

class WhatsAppConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WhatsAppConfigurationError';
  }
}

class WhatsAppDeliveryError extends Error {
  constructor(status) {
    super(`Meta WhatsApp API returned HTTP ${status}.`);
    this.name = 'WhatsAppDeliveryError';
    this.status = status;
  }
}

function createOtpWhatsAppSender(env = process.env, fetchImpl = globalThis.fetch) {
  return async function sendOtpWhatsApp({ to, code }) {
    const accessToken = String(env.WHATSAPP_ACCESS_TOKEN || '').trim();
    const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
    const templateName = String(env.WHATSAPP_OTP_TEMPLATE_NAME || '').trim();
    const templateLanguage = String(env.WHATSAPP_OTP_TEMPLATE_LANGUAGE || 'id').trim();
    const apiVersion = String(env.WHATSAPP_GRAPH_API_VERSION || 'v27.0').trim();
    if (!accessToken || !phoneNumberId || !templateName) {
      throw new WhatsAppConfigurationError(
        'Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_OTP_TEMPLATE_NAME.'
      );
    }
    if (!/^\d+$/.test(phoneNumberId) || !/^v\d+\.\d+$/.test(apiVersion)) {
      throw new WhatsAppConfigurationError('WhatsApp Cloud API configuration is invalid.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new WhatsAppConfigurationError('This Node.js runtime does not provide fetch().');
    }

    const response = await fetchImpl(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLanguage },
            components: [
              {
                type: 'body',
                parameters: [{ type: 'text', text: code }],
              },
              {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: code }],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new WhatsAppDeliveryError(response.status);
    }
  };
}

module.exports = {
  WhatsAppConfigurationError,
  WhatsAppDeliveryError,
  createOtpWhatsAppSender,
};
