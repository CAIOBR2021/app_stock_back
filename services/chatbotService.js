function buildChatPrompt(pergunta, produtos, movimentacoes) {
  const resumoProdutos = produtos.map(p => ({
    nome: p.nome,
    sku: p.sku,
    quantidade: p.quantidade,
    unidade: p.unidade,
    estoqueMinimo: p.estoqueminimo ?? null,
    categoria: p.categoria ?? null,
    fornecedor: p.fornecedor ?? null,
    localArmazenamento: p.localarmazenamento ?? null,
    valorUnitario: p.valorunitario ?? null,
  }));

  const resumoMovs = movimentacoes.slice(0, 200).map(m => {
    const prod = produtos.find(p => p.id === m.produtoid);
    return {
      produto: prod?.nome ?? m.produtoid,
      tipo: m.tipo,
      quantidade: m.quantidade,
      data: m.datacompetencia || m.criadoem,
      motivo: m.motivo ?? null,
      obra: m.nomeobra ?? null,
    };
  });

  return `Você é "O Almoxarife", um assistente inteligente de controle de estoque. Responda perguntas sobre o estoque de materiais de construção de forma clara, objetiva e útil.

DADOS DO ESTOQUE ATUAL (${resumoProdutos.length} produtos):
${JSON.stringify(resumoProdutos, null, 0)}

ÚLTIMAS MOVIMENTAÇÕES (${resumoMovs.length} registros):
${JSON.stringify(resumoMovs, null, 0)}

REGRAS:
- Responda SEMPRE em português brasileiro
- Seja conciso e direto
- Use formatação simples (sem markdown complexo)
- Quando listar produtos, mostre nome, quantidade e unidade
- Se não souber a resposta com base nos dados, diga que não encontrou
- Pode fazer cálculos, comparações, rankings e análises com os dados
- Se perguntarem sobre um produto específico, busque por nome parcial (ex: "luva" deve encontrar "LUVA DE PROCEDIMENTO")
- Valores monetários em R$ com 2 casas decimais
- Use quebras de linha para organizar listas

PERGUNTA DO USUÁRIO: ${pergunta}`;
}

async function responderPergunta(pergunta, produtos, movimentacoes) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada.');
  }

  const prompt = buildChatPrompt(pergunta, produtos, movimentacoes);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
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

  return text.trim();
}

module.exports = { responderPergunta };
