const NF_PROMPT = `Você é um especialista em leitura de notas fiscais brasileiras (NF-e, NFS-e, cupom fiscal, DANFE).

Analise a imagem da nota fiscal e extraia TODOS os itens/produtos listados.

Para cada item, retorne:
- nome: nome do produto/material exatamente como aparece
- quantidade: quantidade numérica
- unidade: unidade de medida (UN, KG, M, M2, M3, L, PCT, CX, etc.)
- valorUnitario: valor unitário em reais (número decimal)

Também extraia, se disponível, aplicando RIGOROSAMENTE as regras de formatação:
- numeroNF: número da nota fiscal (remova zeros à esquerda. Ex: 00012345 → 12345)
- ordemCompra: número da ordem de compra / pedido de compra (procure por campos como "OC", "Ordem de Compra", "Pedido", "Pedido de Compra", "Nº Pedido", "PO", "Purchase Order" ou similares). REMOVA todos os zeros à esquerda (Ex: 000003331 → 3331)
- nomeObra: nome da obra, projeto ou local de destino. Procure PRINCIPALMENTE no campo de Observações por nomes como "PEDIDO CCEAM", "Obra X", etc. Também procure em campos como "Obra", "Nome da Obra", "Local", "Projeto", "Destino", "Centro de Custo", "Filial", "Unidade", "Canteiro". Extraia apenas o nome limpo (Ex: se nas observações constar "PEDIDO CCEAM", retorne "CCEAM")
- fornecedor: nome do fornecedor/emitente. REMOVA quaisquer números/códigos que apareçam ANTES do nome (Ex: "0003044VIX ARTEFATOS DE CONCRETO LTDA" → "VIX ARTEFATOS DE CONCRETO LTDA", "00154 Construtora Exemplo" → "Construtora Exemplo")
- dataEmissao: data de emissão (formato YYYY-MM-DD)

Responda APENAS com JSON válido neste formato exato, sem markdown:
{
  "numeroNF": "string ou null",
  "ordemCompra": "string ou null",
  "nomeObra": "string ou null",
  "fornecedor": "string ou null",
  "dataEmissao": "string ou null",
  "itens": [
    {
      "nome": "string",
      "quantidade": number,
      "unidade": "string",
      "valorUnitario": number
    }
  ]
}

Se não conseguir identificar algum campo, use null. Se não conseguir ler a imagem ou não for uma nota fiscal, retorne: {"erro": "mensagem explicativa"}`;

async function analisarNotaFiscal(imageBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada no servidor.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: NF_PROMPT },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
      }),
    },
  );

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Erro na API Gemini (${response.status})`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Resposta vazia da IA.');

  const jsonStr = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseErr) {
    // JSON truncado — tenta recuperar fechando arrays/objetos abertos
    let fixed = jsonStr;

    // Remove o último item incompleto (após a última vírgula dentro do array)
    const lastCompleteItem = fixed.lastIndexOf('},');
    if (lastCompleteItem !== -1) {
      fixed = fixed.substring(0, lastCompleteItem + 1);
    }

    // Fecha array e objeto se necessário
    if (!fixed.includes(']}')) {
      fixed += ']}';
    }

    try {
      parsed = JSON.parse(fixed);
    } catch {
      throw new Error('Não foi possível processar a resposta da IA. O documento pode ter muitos itens — tente enviar páginas separadamente.');
    }
  }

  if (parsed.erro) {
    throw new Error(parsed.erro);
  }

  return parsed;
}

module.exports = { analisarNotaFiscal };
