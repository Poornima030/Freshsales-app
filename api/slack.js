export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { type, challenge, event } = req.body;

  if (type === 'url_verification') {
    return res.status(200).json({ challenge });
  }

  if (type === 'event_callback' && event?.type === 'message' && !event.bot_id) {
    try {

      // ── Thread reply — add as notes to existing contact ──
      if (event.thread_ts && event.thread_ts !== event.ts) {
        // This is a thread reply — fetch parent message
        const parentRes = await fetch(
          `https://slack.com/api/conversations.replies?channel=${event.channel}&ts=${event.thread_ts}&limit=1`,
          {
            headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
          }
        );
        const parentData = await parentRes.json();
        const parentMsg = parentData.messages?.[0];

        if (!parentMsg) return res.status(200).end();

        // Find contact in Freshsales by searching parent message context
        // Extract name from parent message or its files
        let searchName = null;

        if (parentMsg.files && parentMsg.files.length > 0) {
          // Parent had an image — search by recent contacts
          searchName = 'recent';
        } else if (parentMsg.text) {
          // Extract name from parent text using Groq
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
                content: `Extract only the full name from this text. Return ONLY the name as plain text, nothing else: "${parentMsg.text}"`
              }],
              temperature: 0.1,
              max_tokens: 50
            })
          });
          const nameData = await nameRes.json();
          searchName = nameData.choices?.[0]?.message?.content?.trim();
        }

        if (searchName && searchName !== 'recent') {
          // Search for contact in Freshsales
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
          console.log('Search response:', JSON.stringify(searchData));

          // Find matching contact
          const foundContact = Array.isArray(searchData)
            ? searchData.find(r => r.type === 'contact')
            : null;

          if (foundContact) {
            // Add thread reply as a note to this contact
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
                    description: event.text,
                    targetable_type: 'Contact',
                    targetable_id: foundContact.id
                  }
                })
              }
            );
            const noteData = await noteRes.json();
            console.log('Note response:', JSON.stringify(noteData));

            const statusMsg = noteData.note
              ? `✅ Note added to *${foundContact.name}* in Freshsales!`
              : `⚠️ Could not add note. Error: ${JSON.stringify(noteData)}`;

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

      // ── Regular message (not a thread reply) ────────────
      let contact = null;

      if (event.files && event.files.length > 0) {
        const file = event.files[0];
        if (!file.mimetype?.startsWith('image/')) return res.status(200).end();

        const imageRes = await fetch(file.url_private, {
          headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
        });
        const imageBuffer = await imageRes.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');

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
        if (match) {
          contact = JSON.parse(match[0]);
          if (event.text && event.text.trim()) {
            contact.notes = event.text.trim();
          }
        }

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
              content: `Extract contact information from this message. Return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"first_name":null,"last_name":null,"job_title":null,"company":null,"email":null,"mobile_number":null,"address":null,"notes":null}\n\nFor the "notes" field: extract any commentary, context, or additional information that is NOT contact details (e.g. "Met at conference", "Follow up next week"). If no such context exists, set notes to null.\n\nMessage:\n${event.text}`
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

      // ── Save to Freshsales ───────────────────────────────
      if (contact && (contact.first_name || contact.email || contact.mobile_number)) {
        console.log('Saving contact:', JSON.stringify(contact));

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
        const statusMsg = fsData.contact
          ? `✅ Contact *${name}* saved to Freshsales!${contact.notes ? ` Notes: "${contact.notes}"` : ''}`
          : `⚠️ Could not save contact. Error: ${JSON.stringify(fsData)}`;

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
