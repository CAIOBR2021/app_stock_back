function buildChatPrompt(pergunta, produtos, movimentacoes) {
  // Formato compacto: "nome|qtd|un|min|cat|local|R$" — economiza ~60% de tokens vs JSON
  const linhasProdutos = produtos.map(p => {
    const campos = [
      p.nome,
      p.quantidade,
      p.unidade,
      p.estoqueminimo ?? '-',
      p.categoria ?? '-',
      p.localarmazenamento ?? '-',
      p.valorunitario != null ? p.valorunitario : '-',
    ];
    return campos.join('|');
  });

  // Últimas 50 movimentações (em vez de 200) — formato compacto
  const prodMap = new Map(produtos.map(p => [p.id, p.nome]));
  const linhasMovs = movimentacoes.slice(0, 50).map(m => {
    const campos = [
      prodMap.get(m.produtoid) ?? '?',
      m.tipo,
      m.quantidade,
      String(m.datacompetencia || m.criadoem || '').substring(0, 10),
      m.motivo ?? '-',
    ];
    return campos.join('|');
  });

  return `Você é "O Almoxarife", assistente de estoque de materiais de construção. Responda em pt-BR, de forma concisa e direta.

ESTOQUE (nome|qtd|un|min|cat|local|R$):
${linhasProdutos.join('\n')}

MOVIMENTAÇÕES RECENTES (produto|tipo|qtd|data|motivo):
${linhasMovs.join('\n')}

REGRAS: liste nome+qtd+unidade; busque por nome parcial; valores em R$ com 2 decimais; use quebras de linha em listas; se não encontrar nos dados, diga que não encontrou.

PERGUNTA: ${pergunta}`;
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
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
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
