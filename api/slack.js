export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { type, challenge, event } = req.body;

  if (type === 'url_verification') {
    return res.status(200).json({ challenge });
  }

  if (type !== 'event_callback' || event?.bot_id) {
    return res.status(200).end();
  }

  if (event?.type !== 'app_mention' && event?.type !== 'message') {
    return res.status(200).end();
  }

  const hasMention = (event.text || '').includes('<@');
  if (!hasMention) return res.status(200).end();

  console.log('Event received:', JSON.stringify({
    type: event.type,
    text: event.text,
    hasFiles: !!(event.files?.length),
    thread_ts: event.thread_ts,
    ts: event.ts
  }));

  try {
    let cleanText = (event.text || '')
      .replace(/<@[A-Z0-9]+>/g, '')
      .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
      .replace(/<tel:[^|>]+\|([^>]+)>/g, '$1')
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<[^>]+>/g, '')
      .trim();

    // ── Thread reply ──────────────────────────────────────
    if (event.thread_ts && event.thread_ts !== event.ts) {
      const parentRes = await fetch(
        `https://slack.com/api/conversations.replies?channel=${event.channel}&ts=${event.thread_ts}&limit=1`,
        { headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
      );
      const parentData = await parentRes.json();
      const parentMsg = parentData.messages?.[0];
      if (!parentMsg) return res.status(200).end();

      let searchName = null;

      if (parentMsg.files && parentMsg.files.length > 0) {
        searchName = 'recent';
      } else if (parentMsg.text) {
        const cleanParentText = parentMsg.text
          .replace(/<@[A-Z0-9]+>/g, '')
          .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
          .replace(/<tel:[^|>]+\|([^>]+)>/g, '$1')
          .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
          .replace(/<[^>]+>/g, '')
          .trim();

        const nameRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{
              role: 'user',
              content: `Extract only the full name from this text. Return ONLY the name as plain text, nothing else: "${cleanParentText}"`
            }],
            temperature: 0.1,
            max_tokens: 50
          })
        });
        const nameData = await nameRes.json();
        searchName = nameData.choices?.[0]?.message?.content?.trim();
      }

      if (searchName && searchName !== 'recent') {
        const searchRes = await fetch(
          `https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/search?q=${encodeURIComponent(searchName)}&include=contact`,
          {
            headers: {
              'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );
        const searchData = await searchRes.json();
        const foundContact = Array.isArray(searchData)
          ? searchData.find(r => r.type === 'contact')
          : null;

        if (foundContact) {
          const noteRes = await fetch(
            `https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/notes`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}`
              },
              body: JSON.stringify({
                note: {
                  description: cleanText,
                  targetable_type: 'Contact',
                  targetable_id: foundContact.id
                }
              })
            }
          );
          const noteData = await noteRes.json();

          const statusMsg = noteData.note
            ? `✅ Note added to *${foundContact.name}* in Freshsales!`
            : `⚠️ Couldn't add the note to *${foundContact.name}* in Freshsales.`;

          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
            },
            body: JSON.stringify({
              channel: event.channel,
              thread_ts: event.thread_ts,
              text: statusMsg
            })
          });
        }
      }
      return res.status(200).end();
    }

    // ── Regular message ───────────────────────────────────
    let contact = null;

    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      if (!file.mimetype?.startsWith('image/')) return res.status(200).end();

      console.log('Downloading image:', file.url_private);

      const imageRes = await fetch(file.url_private_download || file.url_private, {
        headers: {
          'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (!imageRes.ok) {
        console.error('Image download failed:', imageRes.status, imageRes.statusText);
        return res.status(200).end();
      }

      const imageBuffer = await imageRes.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');
      console.log('Image downloaded, size:', base64Image.length);

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
      console.log('Groq image response:', JSON.stringify(groqData));
      const raw = groqData.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        contact = JSON.parse(match[0]);
        if (cleanText) contact.notes = cleanText;
      }

    } else if (cleanText) {
      console.log('Processing text:', cleanText);
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
            content: `Extract contact information from this message. Return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"first_name":null,"last_name":null,"job_title":null,"company":null,"email":null,"mobile_number":null,"address":null,"notes":null}\n\nFor the "notes" field: extract any commentary, context, or additional information that is NOT contact details (e.g. "Met at conference", "Follow up next week"). If no such context exists, set notes to null.\n\nMessage:\n${cleanText}`
          }],
          temperature: 0.1,
          max_tokens: 512
        })
      });

      const groqData = await groqRes.json();
      console.log('Groq text response:', JSON.stringify(groqData));
      const raw = groqData.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) contact = JSON.parse(match[0]);
    }

    console.log('Contact extracted:', JSON.stringify(contact));

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
      console.log('Freshsales response:', JSON.stringify(fsData));
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown';

      let statusMsg;
      if (fsData.contact) {
        statusMsg = `✅ Contact *${name}* saved to Freshsales!${contact.notes ? `\n📝 Notes: "${contact.notes}"` : ''}`;
      } else if (JSON.stringify(fsData).includes('already exists') || JSON.stringify(fsData).includes('not unique')) {
        statusMsg = `ℹ️ *${name}* is already in Freshsales.${contact.notes ? `\n📝 Notes: "${contact.notes}"` : ''}`;
      } else {
        statusMsg = `⚠️ Couldn't save *${name}* to Freshsales.`;
      }

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
    } else {
      console.log('No contact found to save');
    }

  } catch (err) {
    console.error('Error:', err.message);
  }

  return res.status(200).end();
}
