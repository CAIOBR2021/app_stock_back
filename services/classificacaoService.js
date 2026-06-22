const PROMPT = `Você é um assistente de almoxarifado/estoque de construção civil e materiais em geral.
Dado o nome de um item, classifique-o retornando APENAS um JSON válido (sem markdown, sem crases, sem texto extra).

Regras:
- categoria: uma das opções → Ferragens, Elétrica, Hidráulica, Pintura, EPI, Limpeza, Escritório, Ferramentas, Madeira, Cimento e Argamassa, Acabamento, Impermeabilização, Jardinagem, Segurança, Outros
- unidade: uma das opções → un, kg, m, m², m³, litro, cx, pct, rolo, par, saco, balde, lata, galão, tubo, folha, bloco, pç
- descricao: descrição técnica curta do item (máximo 80 caracteres)

Responda APENAS o JSON: {"categoria":"...","unidade":"...","descricao":"..."}`;

async function classificarMaterial(nome) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${PROMPT}\n\nItem: "${nome}"` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 150 },
      }),
    },
  );

  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('Resposta vazia do Gemini.');

  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { classificarMaterial };
