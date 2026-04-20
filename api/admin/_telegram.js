// Telegram Bot API helper.
// Sends messages via https://api.telegram.org/bot<TOKEN>/sendMessage.
// Pure Node — no dependencies.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN        — bot token from @BotFather (format "<id>:<secret>")
//   TELEGRAM_ADMIN_CHAT_ID    — your Telegram chat ID (numeric, may be negative for groups)

const https = require('https');

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token)  return reject(new Error('TELEGRAM_BOT_TOKEN not configured'));
    if (!chatId) return reject(new Error('TELEGRAM_ADMIN_CHAT_ID not configured'));

    const body = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_notification: false,
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      // Short timeout — Vercel functions have limited runtime
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) return resolve(parsed);
          return reject(new Error('Telegram API: ' + (parsed.description || 'unknown error')));
        } catch (e) {
          return reject(new Error('Telegram API: invalid response'));
        }
      });
    });
    req.on('error', (e) => reject(new Error('Telegram request failed: ' + e.message)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out'));
    });
    req.write(body);
    req.end();
  });
}

module.exports = { sendTelegramMessage };
