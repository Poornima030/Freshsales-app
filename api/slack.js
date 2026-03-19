// Track processed events to prevent duplicate responses
const processedEvents = new Set();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // If Slack is retrying, ignore it — we already processed this event
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).end();
  }

  const { type, challenge, event } = req.body;

  if (type === 'url_verification') {
    return res.status(200).json({ challenge });
  }

  if (type !== 'event_callback' || event?.bot_id) {
    return res.status(200).end();
  }

  if (event?.type !== 'app_mention') {
    return res.status(200).end();
  }

  // Deduplicate using event timestamp + channel
  const eventId = `${event.channel}-${event.ts}`;
  if (processedEvents.has(eventId)) {
    return res.status(200).end();
  }
  processedEvents.add(eventId);

  // Clean up old entries after 60 seconds to prevent memory leak
  setTimeout(() => processedEvents.delete(eventId), 60000);

  const hasMention = (event.text || '').includes('<@');
  if (!hasMention) return res.status(200).end();

  try {
    // Extract URLs before cleaning (Slack wraps URLs in < > brackets)
    const urlRegex = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;
    const extractedUrls = [];
    let urlMatch;
    while ((urlMatch = urlRegex.exec(event.text || '')) !== null) {
      extractedUrls.push(urlMatch[1]);
    }

    let cleanText = (event.text || '')
      .replace(/<@[A-Z0-9]+>/g, '')
      .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
      .replace(/<tel:[^|>]+\|([^>]+)>/g, '$1')
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<[^>]+>/g, '')
      .trim();

    // ==================== THREAD REPLY HANDLING ====================
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
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: `Extract only the full name from this text. Return ONLY the name as plain text, nothing else: "${cleanParentText}"` }],
            temperature: 0.1, max_tokens: 50
          })
        });
        const nameData = await nameRes.json();
        searchName = nameData.choices?.[0]?.message?.content?.trim();
      }

      if (searchName && searchName !== 'recent') {
        const searchRes = await fetch(
          `https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/search?q=${encodeURIComponent(searchName)}&include=contact`,
          { headers: { 'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        const searchData = await searchRes.json();
        const foundContact = Array.isArray(searchData) ? searchData.find(r => r.type === 'contact') : null;

        if (foundContact) {
          let noteText = cleanText;
          if (extractedUrls.length > 0) {
            noteText += `\n🔗 Link: ${extractedUrls.join(', ')}`;
          }

          const noteRes = await fetch(
            `https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/notes`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}` },
              body: JSON.stringify({ note: { description: noteText, targetable_type: 'Contact', targetable_id: foundContact.id } })
            }
          );
          const noteData = await noteRes.json();
          const statusMsg = noteData.note
            ? `✅ Note added to *${foundContact.name}* in Freshsales!${extractedUrls.length > 0 ? `\n🔗 Link: ${extractedUrls[0]}` : ''}`
            : `⚠️ Couldn't add the note to *${foundContact.name}* in Freshsales.`;
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            body: JSON.stringify({ channel: event.channel, thread_ts: event.thread_ts, text: statusMsg })
          });
        }
      }
      return res.status(200).end();
    }

    // ==================== NEW CONTACT HANDLING ====================
    let contact = null;

    if (event.files && event.files.length > 0) {
      const file = event.files[0];
      if (!file.mimetype?.startsWith('image/')) return res.status(200).end();

      const imageRes = await fetch(file.url_private_download || file.url_private, {
        headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'User-Agent': 'Mozilla/5.0' }
      });
      if (!imageRes.ok) return res.status(200).end();

      const imageBuffer = await imageRes.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${base64Image}` } },
            { type: 'text', text: 'Extract contact information from this business card image and return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"first_name":null,"last_name":null,"job_title":null,"company":null,"email":null,"mobile_number":null,"address":null}' }
          ]}],
          temperature: 0.1, max_tokens: 512
        })
      });
      const groqData = await groqRes.json();
      const raw = groqData.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) { contact = JSON.parse(match[0]); if (cleanText) contact.notes = cleanText; }

    } else if (cleanText) {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: `Extract contact information from this message. Return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"first_name":null,"last_name":null,"job_title":null,"company":null,"email":null,"mobile_number":null,"address":null,"notes":null,"website":null}

IMPORTANT RULES:
- If a URL/link is present in the message, put it in "website" field
- For "notes" field: extract any commentary, context, or additional information that is NOT a standard contact field (e.g. "referrer for BoxPay", "met at conference", "interested in partnership")
- Do NOT put URLs in the notes field, put them in "website"
- If only one name is given with no clear first/last distinction, put it in "first_name" and leave "last_name" as null
- If two names are given, first word goes in "first_name" and second word goes in "last_name"

Message:
${cleanText}` }],
          temperature: 0.1, max_tokens: 512
        })
      });
      const groqData = await groqRes.json();
      const raw = groqData.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) contact = JSON.parse(match[0]);
    }

    // Add any URLs extracted from Slack formatting that AI might have missed
    if (contact && extractedUrls.length > 0 && !contact.website) {
      contact.website = extractedUrls[0];
    }

    if (contact && (contact.first_name || contact.last_name || contact.email || contact.mobile_number)) {
      // Separate notes and website from contact payload
      const notes = contact.notes;
      const website = contact.website;
      const contactPayload = { ...contact };
      delete contactPayload.notes;
      delete contactPayload.website;

      // Auto-generate placeholder email if no email provided (Freshsales requires unique email)
      if (!contactPayload.email) {
        const namePart = (contact.first_name || contact.last_name || 'contact').toLowerCase().replace(/[^a-z0-9]/g, '');
        const timestamp = Date.now();
        contactPayload.email = `${namePart}.${timestamp}@placeholder.com`;
      }

      // Remove null/undefined values
      Object.keys(contactPayload).forEach(key => {
        if (contactPayload[key] === null || contactPayload[key] === undefined) {
          delete contactPayload[key];
        }
      });

      // Display name for Slack messages
      const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown';

      // Save contact to Freshsales
      const fsRes = await fetch(
        `https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/contacts`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}` },
          body: JSON.stringify({ contact: contactPayload })
        }
      );
      const fsData = await fsRes.json();

      let statusMsg;
      if (fsData.contact) {
        // Contact created — now add notes + link as a Freshsales Note
        const noteParts = [];
        if (notes) noteParts.push(notes);
        if (website) noteParts.push(`🔗 Link: ${website}`);
        const fullNote = noteParts.join('\n');

        if (fullNote) {
          await fetch(
            `https://${process.env.FRESHSALES_DOMAIN}.myfreshworks.com/crm/sales/api/notes`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Token token=${process.env.FRESHSALES_API_KEY}` },
              body: JSON.stringify({ note: { description: fullNote, targetable_type: 'Contact', targetable_id: fsData.contact.id } })
            }
          );
        }

        statusMsg = `✅ Contact *${displayName}* saved to Freshsales!`;
        if (notes) statusMsg += `\n📝 Notes: "${notes}"`;
        if (website) statusMsg += `\n🔗 Link: ${website}`;

      } else if (JSON.stringify(fsData).includes('already exists') || JSON.stringify(fsData).includes('not unique')) {
        statusMsg = `ℹ️ *${displayName}* is already in Freshsales.`;
        if (notes) statusMsg += `\n📝 Notes: "${notes}"`;
        if (website) statusMsg += `\n🔗 Link: ${website}`;
      } else {
        statusMsg = `⚠️ Couldn't save *${displayName}* to Freshsales. Error: ${JSON.stringify(fsData).substring(0, 200)}`;
      }

      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel: event.channel, text: statusMsg })
      });
    }

  } catch (err) {
    console.error('Error:', err.message);
  }

  return res.status(200).end();
}
