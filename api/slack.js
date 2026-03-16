import crypto from 'crypto';

function verifySlackSignature(req, body) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const sigBaseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
  hmac.update(sigBaseString);
  const mySignature = `v0=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = JSON.stringify(req.body);

  // Verify it's really from Slack
  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { type, challenge, event } = req.body;

  // Slack URL verification handshake
  if (type === 'url_verification') {
    return res.status(200).json({ challenge });
  }

  // Only process messages from real users (not bots)
  if (type === 'event_callback' && event.type === 'message' && !event.bot_id && event.text) {
    try {
      // Step 1 — Extract contact using Groq AI
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{
            role: 'user',
            content: `Extract contact information from this message and return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"first_name":null,"last_name":null,"job_title":null,"company":null,"email":null,"mobile_number":null,"address":null}\n\nMessage:\n${event.text}`
          }],
          temperature: 0.1,
          max_tokens: 512
        })
      });

      const groqData = await groqRes.json();
      const raw = groqData.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found');
      const contact = JSON.parse(match[0]);

      // Skip if no useful data extracted
      if (!contact.first_name && !contact.email && !contact.mobile_number) {
        return res.status(200).end();
      }

      // Step 2 — Push to Freshsales CRM
      const fsRes = await fetch(`https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}`
        },
        body: JSON.stringify({ contact })
      });

      const fsData = await fsRes.json();

      // Step 3 — Send confirmation back to Slack
      if (fsData.contact) {
        await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
          },
          body: JSON.stringify({
            channel: event.channel,
            text: `✅ Contact *${contact.first_name || ''} ${contact.last_name || ''}* saved to Freshsales!`
          })
        });
      }

    } catch (err) {
      console.error('Error:', err.message);
    }
  }

  return res.status(200).end();
}
