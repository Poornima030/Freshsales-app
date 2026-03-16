export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { type, challenge, event } = req.body;

  // Slack URL verification handshake
  if (type === 'url_verification') {
    return res.status(200).json({ challenge });
  }

  // Only process messages from real users (not bots)
  if (type === 'event_callback' && event?.type === 'message' && !event.bot_id) {
    try {
      let contact = null;

      // ── Case 1: Image uploaded ──────────────────────────
      if (event.files && event.files.length > 0) {
        const file = event.files[0];

        // Only process image files
        if (!file.mimetype?.startsWith('image/')) {
          return res.status(200).end();
        }

        // Download image from Slack (needs bot token)
        const imageRes = await fetch(file.url_private, {
          headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
        });
        const imageBuffer = await imageRes.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');

        // Send to Groq vision AI
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:${file.mimetype};base64,${base64Image}` }
                },
                {
                  type: 'text',
                  text: 'Extract contact information from this business card image and return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"first_name":null,"last_name":null,"job_title":null,"company":null,"email":null,"mobile_number":null,"address":null}'
                }
              ]
            }],
            temperature: 0.1,
            max_tokens: 512
          })
        });

        const groqData = await groqRes.json();
        const raw = groqData.choices?.[0]?.message?.content || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) contact = JSON.parse(match[0]);

      // ── Case 2: Text message ────────────────────────────
      } else if (event.text && event.text.trim()) {
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
        if (match) contact = JSON.parse(match[0]);
      }

      // ── Save to Freshsales if contact found ─────────────
      if (contact && (contact.first_name || contact.email || contact.mobile_number)) {
        const fsRes = await fetch(
          `https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/contacts`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}`
            },
            body: JSON.stringify({ contact })
          }
        );

        const fsData = await fsRes.json();

        // Send confirmation back to Slack
        const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown';
        const statusMsg = fsData.contact
          ? `✅ Contact *${name}* saved to Freshsales!`
          : `⚠️ Could not save contact to Freshsales. Please check manually.`;

        await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
          },
          body: JSON.stringify({
            channel: event.channel,
            text: statusMsg
          })
        });
      }

    } catch (err) {
      console.error('Error:', err.message);
    }
  }

  return res.status(200).end();
}
