export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { targetLang, items } = req.body || {};

  if (!targetLang || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Parametri mancanti (targetLang, items)' });
  }

  const languageNames = {
    en: 'English', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese'
  };
  const langName = languageNames[targetLang];
  if (!langName) {
    return res.status(400).json({ error: 'Lingua non supportata' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY non configurata sul server' });
  }

  const systemPrompt = `You are a professional culinary and wine translator for a high-end Italian restaurant.
Translate the provided JSON array of Italian menu items into elegant, natural ${langName}.

CRITICAL RULES:
1. Translate the "description" field fully and naturally into ${langName}.
2. For the "name" field, follow these rules carefully:
   - If the name is a generic Italian dish description (e.g. "Tagliata di manzo con rucola e grana"), translate it naturally into ${langName}, but KEEP any proper nouns, brand names, geographic indications, or specific product names untouched within the translation (e.g. keep "Fiore Sardo", "Pecorino", "Bottarga", "Fregula", "Guanciale", "Culurgiones").
   - If the name IS a proper noun / branded name (e.g. a wine name, a winery/producer name, a cocktail name, or a dish named after a person or place — like "Vermentino di Gallura DOCG", "Cannonau di Sardegna", "Barolo Riserva", "Chardonnay Cantina Santadi", "Negroni"), DO NOT translate it at all. Leave it EXACTLY as written in Italian, including accents, capitalization, and abbreviations like DOCG, DOC, IGT.
   - Never invent, shorten, or alter brand names, winery names, grape varietals, or appellation names under any circumstance.
3. The translation must sound appetizing, natural and professional in ${langName}, never literal or robotic.
4. Preserve numbers, units (cl, ml, gr), vintages/years, and percentages exactly as given.
5. Return ONLY a valid JSON object matching the provided schema, with no markdown, no comments, and no text outside the JSON.`;

  const sourceData = items.map(item => ({
    id: item.id,
    name: item.name,
    description: item.description || ''
  }));

  const userQuery = `Translate this JSON list to ${langName}:\n${JSON.stringify(sourceData)}`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          translatedItems: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                id: { type: 'INTEGER' },
                name: { type: 'STRING' },
                description: { type: 'STRING' }
              },
              required: ['id', 'name', 'description']
            }
          }
        },
        required: ['translatedItems']
      }
    },
    systemInstruction: { parts: [{ text: systemPrompt }] }
  };

  try {
    let response;
    let lastErrText = '';
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) break;

      lastErrText = await response.text();
      console.error(`Gemini API error (attempt ${attempt + 1}):`, response.status, lastErrText);

      // Retry only on rate limit / transient errors
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }
      break;
    }

    if (!response.ok) {
      return res.status(502).json({ error: 'Errore chiamata Gemini', details: lastErrText });
    }

    const result = await response.json();
    const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textResponse) {
      console.error('Risposta Gemini senza testo:', JSON.stringify(result));
      return res.status(502).json({ error: 'Risposta Gemini vuota' });
    }

    const parsed = JSON.parse(textResponse);
    const translatedItems = parsed.translatedItems || parsed;

    return res.status(200).json({ translatedItems });
  } catch (err) {
    console.error('Errore interno:', err);
    return res.status(500).json({ error: 'Errore interno del server' });
  }
}
