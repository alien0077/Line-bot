import { createHmac } from 'node:crypto';
import 'dotenv/config';

const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:8080';
const secret = process.env.LINE_CHANNEL_SECRET ?? '';
const payload = {
  destination: 'local-dev',
  events: [
    {
      type: 'message',
      timestamp: Date.now(),
      source: {
        type: 'group',
        groupId: 'local-demo-group',
        userId: 'local-demo-user'
      },
      message: {
        id: `sample-${Date.now()}`,
        type: 'text',
        text: '請大家明天下午三點前回覆表單，這是本機 sample webhook。'
      }
    }
  ]
};

const body = JSON.stringify(payload);
const signature = secret ? createHmac('sha256', secret).update(body).digest('base64') : '';

const response = await fetch(`${baseUrl}/webhook/line`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-line-signature': signature
  },
  body
});

console.log(response.status, await response.text());
