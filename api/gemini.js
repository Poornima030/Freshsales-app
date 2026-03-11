export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageData, mimeType, text, mode } = req.body;

    const prompt = 'Extract contact information and return ONLY a valid JSON object with exactly these fields (null if not found), no markdown, no explanation: {"name":null,"title":null,"company":null,"email":null,"phone":null,"website":null,"address":null,"notes":null}';

    let userContent;

    if (mode === 'image') {
      userContent = [
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${imageData}` }
        },
        { type: 'text', text: prompt }
      ];
    } else {
      userContent = prompt + '\n\nContact info:\n' + text;
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: mode === 'image' ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.1,
        max_tokens: 512
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error });

    const raw = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text: raw });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
