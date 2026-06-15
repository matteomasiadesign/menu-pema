import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://cpmianmjcxhputneygsw.supabase.co";
const SUPABASE_KEY = "sb_publishable_NtnKIMk1srrth8CjqcUl0w_hyotnwgm";

const languageNames = {
  en: 'English', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { targetLang, items, categories } = req.body || {};

  if (!targetLang || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Parametri mancanti (targetLang, items)' });
  }

  const langName = languageNames[targetLang];
  if (!langName) {
    return res.status(400).json({ error: 'Lingua non supportata' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY non configurata sul server' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const sourceCategories = Array.isArray(categories) ? categories : [];

  try {
    // --- 1. Carica cache esistente per questa lingua ---
    const itemIds = items.map(i => i.id);

    const { data: cachedItems, error: cacheErr } = await supabase
      .from('translation_cache')
      .select('product_id, name, description, source_name, source_description')
      .eq('lang', targetLang)
      .in('product_id', itemIds);

    if (cacheErr) console.error('Errore lettura cache item:', cacheErr);

    const { data: cachedCats, error: catCacheErr } = await supabase
      .from('category_translation_cache')
      .select('category_name, translated')
      .eq('lang', targetLang)
      .in('category_name', sourceCategories.length > 0 ? sourceCategories : ['__none__']);

    if (catCacheErr) console.error('Errore lettura cache categorie:', catCacheErr);

    const cachedItemMap = new Map((cachedItems || []).map(c => [c.product_id, c]));
    const cachedCatMap = new Map((cachedCats || []).map(c => [c.category_name, c.translated]));

    // --- 2. Determina cosa manca o è obsoleto (testo IT cambiato) ---
    const missingItems = items.filter(i => {
      const cached = cachedItemMap.get(i.id);
      if (!cached) return true;
      const currentName = i.name || '';
      const currentDesc = i.description || '';
      return cached.source_name !== currentName || cached.source_description !== currentDesc;
    });
    const missingCategories = sourceCategories.filter(c => !cachedCatMap.has(c));

    let newTranslatedItems = [];
    let newTranslatedCategories = [];

    // --- 3. Se manca qualcosa, chiama Gemini SOLO per i mancanti ---
    if (missingItems.length > 0 || missingCategories.length > 0) {
      const geminiResult = await translateWithGemini(apiKey, langName, missingItems, missingCategories);
      newTranslatedItems = geminiResult.translatedItems || [];
      newTranslatedCategories = geminiResult.translatedCategories || [];

      // --- 4. Salva i nuovi risultati in cache ---
      if (newTranslatedItems.length > 0) {
        const rows = newTranslatedItems.map(t => {
          const original = missingItems.find(i => i.id === t.id);
          return {
            product_id: t.id,
            lang: targetLang,
            name: t.name,
            description: t.description || '',
            source_name: original ? (original.name || '') : '',
            source_description: original ? (original.description || '') : ''
          };
        });
        const { error: upsertErr } = await supabase.from('translation_cache').upsert(rows);
        if (upsertErr) console.error('Errore salvataggio cache item:', upsertErr);
      }

      if (newTranslatedCategories.length > 0) {
        const catRows = newTranslatedCategories.map(c => ({
          category_name: c.name,
          lang: targetLang,
          translated: c.translated
        }));
        const { error: upsertCatErr } = await supabase.from('category_translation_cache').upsert(catRows);
        if (upsertCatErr) console.error('Errore salvataggio cache categorie:', upsertCatErr);
      }
    }

    // --- 5. Combina cache + nuove traduzioni ---
    const translatedItems = items.map(item => {
      const cached = cachedItemMap.get(item.id);
      if (cached) return { id: item.id, name: cached.name, description: cached.description };
      const fresh = newTranslatedItems.find(t => t.id === item.id);
      if (fresh) return fresh;
      // Fallback estremo: testo originale italiano
      return { id: item.id, name: item.name, description: item.description || '' };
    });

    const translatedCategories = sourceCategories.map(catName => {
      if (cachedCatMap.has(catName)) return { name: catName, translated: cachedCatMap.get(catName) };
      const fresh = newTranslatedCategories.find(c => c.name === catName);
      if (fresh) return fresh;
      return { name: catName, translated: catName };
    });

    return res.status(200).json({ translatedItems, translatedCategories });
  } catch (err) {
    console.error('Errore interno:', err);
    return res.status(500).json({ error: 'Errore interno del server' });
  }
}

async function translateWithGemini(apiKey, langName, items, categories) {
  const systemPrompt = `You are a professional culinary and wine translator for a high-end Italian restaurant.
Translate the provided JSON data into elegant, natural ${langName}.

The data has two parts:
- "items": an array of menu items, each with "id", "name", "description".
- "categories": an array of menu category/section names (e.g. "Primi Piatti", "Brace e Forno", "Vini Rossi").

CRITICAL RULES FOR ITEMS:
1. Translate the "description" field fully and naturally into ${langName}.
2. The "name" field MUST ALWAYS be translated into ${langName}. Dish names are NOT proper nouns just because they describe a specific preparation — translate them like any other phrase.
   - Examples of dish names that MUST be translated: "Degustazione di mare" -> a translation meaning "Seafood tasting", "Crudo del giorno" -> "Today's raw fish / crudo of the day", "Tataki del giorno" -> "Today's tataki", "Rana pescatrice pomodoro alla brace, zucchina" -> fully translate every word ("Grilled monkfish with tomato and zucchini" style), "Polpo alla brace, olio piccante e patate" -> fully translate ("Grilled octopus, spicy oil and potatoes").
   - The ONLY exceptions — things you must leave exactly as written in Italian — are:
     a) Specific Italian regional ingredient/product names with no real equivalent: e.g. "Fiore Sardo", "Pecorino", "Bottarga", "Fregula", "Guanciale", "Culurgiones", "Sebadas".
     b) Wine names, wine appellations/denominations, and winery/producer names: e.g. "Vermentino di Gallura DOCG", "Cannonau di Sardegna", "Barolo Riserva", "Chardonnay Cantina Santadi", abbreviations DOCG/DOC/IGT.
     c) Cocktail names that are proper names: e.g. "Negroni", "Spritz".
   - Everything else in the name — verbs, prepositions, descriptive words, cooking techniques, ingredient names that have a normal translation (mare, pesce, pomodoro, zucchina, polpo, brace, olio, patate, brodo, crostacei, gambero, ragù, formaggio, etc.) — MUST be translated, even if part of the name also contains one of the exceptions above. Translate everything around the exception, keep only the exception itself untouched.
3. The translation must sound appetizing, natural and professional in ${langName}, never literal or robotic, and must read as a complete translated phrase — never leave the name partially or fully in Italian unless it falls under exception (a), (b), or (c) above.
4. Preserve numbers, units (cl, ml, gr), vintages/years, and percentages exactly as given.

CRITICAL RULES FOR CATEGORIES:
5. Translate each category/section name into ${langName} as a short menu heading (e.g. "Primi Piatti" -> appropriate translation for "First Courses" in ${langName}, "Brace e Forno" -> appropriate translation for "Grill & Oven").
6. If a category name is itself a proper noun, wine type, or appellation (e.g. "Franciacorta", "Champagne"), leave it unchanged.
7. Return each category exactly once, preserving the original Italian "name" field so it can be matched back.

8. If "items" is an empty array, return an empty "translatedItems" array. If "categories" is an empty array, return an empty "translatedCategories" array.
9. Return ONLY a valid JSON object matching the provided schema, with no markdown, no comments, and no text outside the JSON.`;

  const sourceData = items.map(item => ({
    id: item.id,
    name: item.name,
    description: item.description || ''
  }));

  const userQuery = `Translate this data to ${langName}:\n${JSON.stringify({ items: sourceData, categories })}`;

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
          },
          translatedCategories: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                translated: { type: 'STRING' }
              },
              required: ['name', 'translated']
            }
          }
        },
        required: ['translatedItems', 'translatedCategories']
      }
    },
    systemInstruction: { parts: [{ text: systemPrompt }] }
  };

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

    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
    break;
  }

  if (!response.ok) {
    throw new Error(`Chiamata Gemini fallita: ${response.status} ${lastErrText}`);
  }

  const result = await response.json();
  const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!textResponse) {
    throw new Error('Risposta Gemini vuota');
  }

  const parsed = JSON.parse(textResponse);
  return {
    translatedItems: parsed.translatedItems || [],
    translatedCategories: parsed.translatedCategories || []
  };
}
