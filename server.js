const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const { sendLowStockEmail } = require('./services/emailService'); 

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --- BANCO DE DADOS ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, 
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.connect().then(() => {
  console.log('PostgreSQL database connected successfully.');
  setupDatabase();
}).catch((err) => console.error('Error connecting to database:', err.message));

// --- CONFIGURAÇÃO DO BANCO ---
async function setupDatabase() {
  const createTables = `
    CREATE TABLE IF NOT EXISTS produtos (
      id UUID PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      categoria TEXT,
      unidade TEXT NOT NULL,
      quantidade NUMERIC(10, 2) NOT NULL DEFAULT 0,
      estoqueminimo INTEGER,
      localarmazenamento TEXT,
      fornecedor TEXT,
      criadoem TIMESTAMPTZ NOT NULL,
      atualizadoem TIMESTAMPTZ,
      prioritario BOOLEAN DEFAULT FALSE,
      valorunitario NUMERIC(10, 2)
    );

    CREATE TABLE IF NOT EXISTS entregas (
      id UUID PRIMARY KEY,
      data_hora_solicitacao TIMESTAMPTZ NOT NULL,
      local_armazenagem TEXT NOT NULL,
      local_obra TEXT NOT NULL,
      produto_id UUID NOT NULL,
      item_quantidade NUMERIC(10, 2) NOT NULL,
      item_unidade_medida TEXT,
      responsavel_nome TEXT,
      responsavel_telefone TEXT,
      status TEXT NOT NULL DEFAULT 'Pendente',
      criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produto_id) REFERENCES produtos (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS movimentacoes (
      id UUID PRIMARY KEY,
      produtoid UUID NOT NULL,
      tipo TEXT NOT NULL,
      quantidade NUMERIC(10, 2) NOT NULL,
      motivo TEXT,
      criadoem TIMESTAMPTZ NOT NULL,
      entrega_id UUID,
      nome_obra TEXT,
      ordem_compra TEXT,
      custo_unitario_historico NUMERIC(10, 2),
      FOREIGN KEY (produtoid) REFERENCES produtos (id) ON DELETE CASCADE,
      FOREIGN KEY (entrega_id) REFERENCES entregas (id) ON DELETE CASCADE
    );
  `;
  
  try {
    await pool.query(createTables);
    console.log('Tabelas verificadas/criadas com sucesso.');
    await updateSchema();
  } catch (err) {
    console.error('Erro ao configurar banco:', err);
  }
}

async function updateSchema() {
  try {
    await pool.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='movimentacoes' AND column_name='entrega_id') THEN 
          ALTER TABLE movimentacoes ADD COLUMN entrega_id UUID REFERENCES entregas(id) ON DELETE CASCADE; 
        END IF; 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='movimentacoes' AND column_name='nome_obra') THEN 
          ALTER TABLE movimentacoes ADD COLUMN nome_obra TEXT; 
        END IF; 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='movimentacoes' AND column_name='ordem_compra') THEN 
          ALTER TABLE movimentacoes ADD COLUMN ordem_compra TEXT; 
        END IF; 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='movimentacoes' AND column_name='custo_unitario_historico') THEN 
          ALTER TABLE movimentacoes ADD COLUMN custo_unitario_historico NUMERIC(10, 2); 
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='movimentacoes' AND column_name='data_competencia') THEN 
          ALTER TABLE movimentacoes ADD COLUMN data_competencia DATE;
          UPDATE movimentacoes SET data_competencia = criadoem::DATE WHERE data_competencia IS NULL;
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_movimentacoes_criadoem ON movimentacoes(criadoem DESC);
      CREATE INDEX IF NOT EXISTS idx_movimentacoes_produtoid ON movimentacoes(produtoid);
      CREATE INDEX IF NOT EXISTS idx_produtos_nome ON produtos(nome);
      CREATE INDEX IF NOT EXISTS idx_entregas_data ON entregas(data_hora_solicitacao DESC);
      CREATE INDEX IF NOT EXISTS idx_movimentacoes_produto_data_competencia
        ON movimentacoes(produtoid, data_competencia DESC, criadoem DESC);
    `);

    console.log('Schema atualizado com sucesso (novas colunas e indices de performance aplicados).');
  } catch (err) {
    console.error('Erro ao atualizar schema:', err.message);
  }
}

// --- UTILITARIOS ---
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

const hojeISO = () => {
  const d = new Date();
  // 'en-CA' força o formato nativo YYYY-MM-DD e o timeZone fixa no horário de Brasília
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
};

function toCamelCase(obj) {
  if (!obj) return obj;
  const newObj = {};
  for (const key in obj) {
    let camelKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    
    if (key === 'estoqueminimo') camelKey = 'estoqueMinimo';
    else if (key === 'localarmazenamento') camelKey = 'localArmazenamento';
    else if (key === 'criadoem') camelKey = 'criadoEm';
    else if (key === 'atualizadoem') camelKey = 'atualizadoEm';
    else if (key === 'produtoid') camelKey = 'produtoId';
    else if (key === 'valorunitario') camelKey = 'valorUnitario';
    else if (key === 'produto_id') camelKey = 'produtoId';
    else if (key === 'data_hora_solicitacao') camelKey = 'dataHoraSolicitacao';
    else if (key === 'local_armazenagem') camelKey = 'localArmazenamento';
    else if (key === 'local_obra') camelKey = 'localObra';
    else if (key === 'item_quantidade') camelKey = 'itemQuantidade';
    else if (key === 'item_unidade_medida') camelKey = 'itemUnidadeMedida';
    else if (key === 'responsavel_nome') camelKey = 'responsavelNome';
    else if (key === 'responsavel_telefone') camelKey = 'responsavelTelefone';
    else if (key === 'entrega_id') camelKey = 'entregaId';
    else if (key === 'nome_obra') camelKey = 'nomeObra';
    else if (key === 'ordem_compra') camelKey = 'ordemCompra';
    else if (key === 'custo_unitario_historico') camelKey = 'custoUnitarioHistorico';
    else if (key === 'data_competencia') camelKey = 'dataCompetencia';
    
    if (['quantidade', 'valorUnitario', 'itemQuantidade', 'valorTotal', 'custoUnitarioHistorico'].includes(camelKey) && obj[key] !== null) {
      newObj[camelKey] = Number(obj[key]);
    } else {
      newObj[camelKey] = obj[key];
    }
  }
  return newObj;
}

// Garante que havia saldo suficiente na data informada.
// Entradas retroativas nunca precisam de validacao.
async function validarSaidaRetroativa(client, produtoId, quantidade, dataCompetencia) {
  const { rows: ajusteRows } = await client.query(`
    SELECT quantidade, data_competencia, criadoem
    FROM movimentacoes
    WHERE produtoid = $1
      AND tipo = 'ajuste'
      AND COALESCE(data_competencia, criadoem::DATE) <= $2
    ORDER BY data_competencia DESC, criadoem DESC
    LIMIT 1
  `, [produtoId, dataCompetencia]);

  let saldoNaData;

  if (ajusteRows.length > 0) {
    const ajuste = ajusteRows[0];
    const { rows: posAjuste } = await client.query(`
      SELECT COALESCE(SUM(
        CASE tipo
          WHEN 'entrada' THEN  quantidade
          WHEN 'saida'   THEN -quantidade
          ELSE 0
        END
      ), 0) AS delta
      FROM movimentacoes
      WHERE produtoid = $1
        AND tipo IN ('entrada', 'saida')
        AND (
          COALESCE(data_competencia, criadoem::DATE) > $2
          OR (COALESCE(data_competencia, criadoem::DATE) = $2 AND criadoem > $3)
        )
        AND COALESCE(data_competencia, criadoem::DATE) <= $4
    `, [produtoId, ajuste.data_competencia, ajuste.criadoem, dataCompetencia]);

    saldoNaData = Number(ajuste.quantidade) + Number(posAjuste[0].delta);
  } else {
    const { rows } = await client.query(`
      SELECT COALESCE(SUM(
        CASE tipo
          WHEN 'entrada' THEN  quantidade
          WHEN 'saida'   THEN -quantidade
          ELSE 0
        END
      ), 0) AS saldo
      FROM movimentacoes
      WHERE produtoid = $1
        AND tipo IN ('entrada', 'saida')
        AND COALESCE(data_competencia, criadoem::DATE) <= $2
    `, [produtoId, dataCompetencia]);

    saldoNaData = Number(rows[0].saldo);
  }

  if (saldoNaData < Number(quantidade)) {
    throw new Error(
      `Saldo insuficiente na data ${dataCompetencia}. ` +
      `Disponivel naquela data: ${saldoNaData} — Solicitado: ${quantidade}`
    );
  }
}

// --- ROTAS ---

app.get('/ping', (req, res) => {
  res.status(200).send('Servidor ativo');
});

app.post('/api/auth/verify-password', async (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Senha incorreta.' });
  }
});

app.get('/api/produtos', async (req, res) => {
  const { _page, _limit, q } = req.query;
  const page = parseInt(_page) || 1;
  const limit = parseInt(_limit) || 10000;
  const offset = (page - 1) * limit;

  try {
    let sql = 'SELECT * FROM produtos';
    const params = [];
    
    if (q) {
      sql += ` WHERE nome ILIKE $1 OR sku ILIKE $1 OR categoria ILIKE $1`;
      params.push(`%${q}%`);
    }
    
    sql += ` ORDER BY nome ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await pool.query(sql, params);
    res.json(rows.map(toCamelCase));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/produtos', async (req, res) => {
  const { nome, descricao, categoria, unidade, quantidade, estoqueMinimo, localArmazenamento, fornecedor, valorUnitario } = req.body;
  const id = uid();
  const sku = `PROD-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  
  try {
    // 1. Cria o produto na tabela "produtos"
    const { rows } = await pool.query(
      `INSERT INTO produtos (id, sku, nome, descricao, categoria, unidade, quantidade, estoqueminimo, localarmazenamento, fornecedor, criadoem, valorunitario) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [id, sku, nome, descricao, categoria, unidade, quantidade || 0, estoqueMinimo, localArmazenamento, fornecedor, nowISO(), valorUnitario]
    );

    // 2. Se o produto foi criado com saldo > 0, cria o histórico em "movimentacoes"
    const qtdInicial = Number(quantidade) || 0;
    if (qtdInicial > 0) {
      await pool.query(
        `INSERT INTO movimentacoes 
           (id, produtoid, tipo, quantidade, motivo, criadoem, data_competencia) 
         VALUES ($1, $2, 'ajuste', $3, 'Saldo inicial na criação do produto', NOW(), $4)`,
        [uid(), id, qtdInicial, hojeISO()]
      );
    }

    // 3. Devolve a resposta ao cliente
    res.status(201).json(toCamelCase(rows[0]));
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.patch('/api/produtos/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  const fieldMap = {
    estoqueMinimo: 'estoqueminimo',
    localArmazenamento: 'localarmazenamento',
    valorUnitario: 'valorunitario',
    prioritario: 'prioritario'
  };

  const fields = Object.keys(updates).map((key, i) => {
    const dbField = fieldMap[key] || key;
    return `${dbField} = $${i + 1}`;
  });
  
  if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

  try {
    const { rows } = await pool.query(
      `UPDATE produtos SET ${fields.join(', ')}, atualizadoem = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
      [...Object.values(updates), id]
    );
    res.json(toCamelCase(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/produtos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/produtos/valor-total', async (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Senha incorreta' });
  try {
    const { rows } = await pool.query('SELECT SUM(quantidade * valorunitario) as total FROM produtos');
    res.json({ valorTotal: Number(rows[0].total || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ROTA DE MOVIMENTACOES ---
app.get('/api/movimentacoes', async (req, res) => {
  try {
    // CORREÇÃO: Ordenar primeiro pela data do acontecimento (competência)
    // Se houver mais de um lançamento no mesmo dia, o mais recente digitado fica no topo
    const { rows } = await pool.query(`
      SELECT * FROM movimentacoes 
      ORDER BY COALESCE(data_competencia, criadoem::DATE) DESC, criadoem DESC
    `);
    res.json(rows.map(toCamelCase));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/movimentacoes', async (req, res) => {
  const {
    produtoId, tipo, quantidade, motivo,
    custoEntrada, nomeObra, ordemCompra, custoUnitarioHistorico,
    dataCompetencia
  } = req.body;

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
    const produto = prodRes.rows[0];
    if (!produto) throw new Error('Produto nao encontrado');

    const dataCompetenciaFinal = dataCompetencia || hojeISO();
    const hoje = hojeISO();
    const isRetroativa = dataCompetenciaFinal < hoje;

    // CORREÇÃO 2: Impedir o ajuste absoluto com data no passado
    if (tipo === 'ajuste' && isRetroativa) {
      throw new Error('Não é permitido lançar Ajuste de Estoque retroativo. O ajuste deve refletir a contagem física atual.');
    }

    // ── CORREÇÃO: saídas usam saldo atual para hoje, histórico só para datas passadas ──
    if (tipo === 'saida') {
      if (isRetroativa) {
        await validarSaidaRetroativa(client, produtoId, quantidade, dataCompetenciaFinal);
      } else {
        if (Number(produto.quantidade) < Number(quantidade)) {
          throw new Error(
            `Estoque insuficiente. Disponivel: ${produto.quantidade} — Solicitado: ${quantidade}`
          );
        }
      }
    }

    // Logica de saldo atual
    let novoSaldo = Number(produto.quantidade);
    if (tipo === 'ajuste') novoSaldo = Number(quantidade);
    else novoSaldo += (tipo === 'entrada' ? 1 : -1) * Number(quantidade);
    
    if (novoSaldo < 0) novoSaldo = 0;

    // Custo medio ponderado
    let novoValorUnitario = Number(produto.valorunitario);
    if (tipo === 'entrada' && custoEntrada !== undefined && custoEntrada !== null) {
      const qtdAtual = Number(produto.quantidade);
      let valorAtual = Number(produto.valorunitario || 0); 
      const qtdEntrada = Number(quantidade);
      const valorEntrada = Number(custoEntrada);

      if (qtdAtual > 0 && valorAtual === 0) valorAtual = valorEntrada;

      const valorTotalEstoque = qtdAtual * valorAtual;
      const valorTotalNovaEntrada = qtdEntrada * valorEntrada;
      const novaQuantidadeTotal = qtdAtual + qtdEntrada;

      novoValorUnitario = novaQuantidadeTotal > 0
        ? (valorTotalEstoque + valorTotalNovaEntrada) / novaQuantidadeTotal
        : valorEntrada;
    }

    await client.query(
      'UPDATE produtos SET quantidade = $1, valorunitario = $2, atualizadoem = NOW() WHERE id = $3', 
      [novoSaldo, novoValorUnitario, produtoId]
    );
    
    const movId = uid();
    await client.query(
      `INSERT INTO movimentacoes 
         (id, produtoid, tipo, quantidade, motivo, criadoem,
          data_competencia, nome_obra, ordem_compra, custo_unitario_historico) 
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)`,
      [
        movId, produtoId, tipo, Number(quantidade), motivo,
        dataCompetenciaFinal,
        nomeObra || null,
        ordemCompra || null,
        custoUnitarioHistorico !== undefined ? Number(custoUnitarioHistorico) : null
      ]
    );

    if (produto.estoqueminimo !== null && novoSaldo <= produto.estoqueminimo) {
      sendLowStockEmail(toCamelCase({ ...produto, quantidade: novoSaldo }));
    }

    const updatedProd = await client.query('SELECT * FROM produtos WHERE id = $1', [produtoId]);
    await client.query('COMMIT');
    
    res.status(201).json({ 
      movimentacao: toCamelCase({ 
        id: movId, 
        produtoid: produtoId, 
        tipo, 
        quantidade, 
        motivo, 
        criadoem: nowISO(),
        data_competencia: dataCompetenciaFinal,
        nome_obra: nomeObra,
        ordem_compra: ordemCompra,
        custo_unitario_historico: custoUnitarioHistorico
      }),
      produto: toCamelCase(updatedProd.rows[0]) 
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/movimentacoes/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movResult = await client.query('SELECT * FROM movimentacoes WHERE id = $1', [id]);
    if (movResult.rowCount === 0) throw new Error('Movimentacao nao encontrada.');
    
    const mov = movResult.rows[0];
    if (mov.tipo === 'ajuste') throw new Error('Nao e possivel excluir ajuste.');

    if (mov.entrega_id) {
      await client.query('DELETE FROM entregas WHERE id = $1', [mov.entrega_id]);
    }

    const prodResult = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [mov.produtoid]);
    const produto = prodResult.rows[0];
    
    let novaQtd = Number(produto.quantidade) + (mov.tipo === 'saida' ? Number(mov.quantidade) : -Number(mov.quantidade));
    novaQtd = Math.max(0, novaQtd);

    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novaQtd, produto.id]);
    await client.query('DELETE FROM movimentacoes WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    res.status(200).json({ produtoAtualizado: toCamelCase({ ...produto, quantidade: novaQtd }) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/movimentacoes/:id', async (req, res) => {
  const { id } = req.params;
  const { quantidade, motivo } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const movRes = await client.query('SELECT * FROM movimentacoes WHERE id = $1', [id]);
    if (movRes.rowCount === 0) throw new Error('Movimentacao nao encontrada');
    const movAntiga = movRes.rows[0];

    if (movAntiga.tipo === 'ajuste') throw new Error('Use um novo Ajuste para corrigir saldo.');

    const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [movAntiga.produtoid]);
    const produto = prodRes.rows[0];

    let saldoRevertido = Number(produto.quantidade);
    if (movAntiga.tipo === 'entrada') saldoRevertido -= Number(movAntiga.quantidade); 
    else if (movAntiga.tipo === 'saida') saldoRevertido += Number(movAntiga.quantidade);

    let novoSaldoFinal = saldoRevertido;
    const novaQtd = Number(quantidade);
    
    if (movAntiga.tipo === 'entrada') novoSaldoFinal += novaQtd;
    else if (movAntiga.tipo === 'saida') novoSaldoFinal -= novaQtd;

    if (novoSaldoFinal < 0) throw new Error('Estoque ficaria negativo com essa alteracao.');

    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novoSaldoFinal, produto.id]);
    
    const updates = [];
    const values = [];
    if (quantidade) { updates.push(`quantidade = $${values.length + 1}`); values.push(novaQtd); }
    if (motivo)     { updates.push(`motivo = $${values.length + 1}`);     values.push(motivo); }
    values.push(id);

    const movUpdateSql = `UPDATE movimentacoes SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`;
    const movUpdatedRes = await client.query(movUpdateSql, values);

    if (movAntiga.entrega_id && quantidade) {
      await client.query('UPDATE entregas SET item_quantidade = $1 WHERE id = $2', [novaQtd, movAntiga.entrega_id]);
    }

    await client.query('COMMIT');

    const produtoFinal = { ...produto, quantidade: novoSaldoFinal };
    res.json({
      movimentacaoAtualizada: toCamelCase(movUpdatedRes.rows[0]),
      produtoAtualizado: toCamelCase(produtoFinal)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- LOGISTICA ---
app.get('/api/entregas', async (req, res) => {
  try {
    const sql = `
      SELECT e.*, p.nome as item_nome, p.sku 
      FROM entregas e
      LEFT JOIN produtos p ON e.produto_id = p.id
      ORDER BY e.data_hora_solicitacao DESC
    `;
    const { rows } = await pool.query(sql);
    const result = rows.map(row => {
      const formatted = toCamelCase(row);
      formatted.itemNome = row.item_nome || 'Produto Removido';
      formatted.sku = row.sku || '-';
      return formatted;
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/entregas', async (req, res) => {
  const { 
    dataHoraSolicitacao, localArmazenagem, localObra, produtoId,
    itemQuantidade, responsavelNome, responsavelTelefone 
  } = req.body;

  const quantidadeNum = Number(itemQuantidade);
  if (isNaN(quantidadeNum) || quantidadeNum <= 0) return res.status(400).json({ error: 'Quantidade invalida.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
    const produto = prodRes.rows[0];
    
    if (!produto) throw new Error('Produto nao encontrado.');
    if (Number(produto.quantidade) < quantidadeNum) throw new Error(`Estoque insuficiente (${produto.quantidade} disponivel).`);

    const entregaId = uid();
    await client.query(
      `INSERT INTO entregas (id, data_hora_solicitacao, local_armazenagem, local_obra, produto_id, item_quantidade, item_unidade_medida, responsavel_nome, responsavel_telefone, status, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Pendente', NOW())`,
      [entregaId, dataHoraSolicitacao, localArmazenagem, localObra, produtoId, quantidadeNum, produto.unidade, responsavelNome, responsavelTelefone]
    );

    const novoSaldo = Number(produto.quantidade) - quantidadeNum;
    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novoSaldo, produtoId]);

    await client.query(
      `INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem, data_competencia, entrega_id, nome_obra)
       VALUES ($1, $2, 'saida', $3, $4, NOW(), $5, $6, $7)`,
      [uid(), produtoId, quantidadeNum, `Entrega para: ${localObra}`, hojeISO(), entregaId, localObra]
    );

    if (produto.estoqueminimo !== null && novoSaldo <= produto.estoqueminimo) {
      sendLowStockEmail(toCamelCase({ ...produto, quantidade: novoSaldo }));
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/entregas/:id', async (req, res) => {
  const { id } = req.params;
  const { 
    dataHoraSolicitacao, localArmazenagem, localObra,
    responsavelNome, responsavelTelefone, status, produtoId, itemQuantidade  
  } = req.body;

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const resAntiga = await client.query('SELECT * FROM entregas WHERE id = $1', [id]);
    if (resAntiga.rowCount === 0) throw new Error('Entrega nao encontrada');
    const entregaAntiga = resAntiga.rows[0];

    const velhoProdutoId = entregaAntiga.produto_id;
    const velhaQuantidade = Number(entregaAntiga.item_quantidade);
    const novoProdutoId = produtoId || velhoProdutoId;
    const novaQuantidade = itemQuantidade ? Number(itemQuantidade) : velhaQuantidade;

    if (velhoProdutoId !== novoProdutoId || velhaQuantidade !== novaQuantidade) {
      await client.query(
        'UPDATE produtos SET quantidade = quantidade + $1, atualizadoem = NOW() WHERE id = $2',
        [velhaQuantidade, velhoProdutoId]
      );

      const resProdNovo = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [novoProdutoId]);
      const prodNovo = resProdNovo.rows[0];
      if (!prodNovo) throw new Error('Novo produto selecionado nao encontrado.');
      if (Number(prodNovo.quantidade) < novaQuantidade) throw new Error(`Estoque insuficiente (${prodNovo.quantidade} disponivel).`);

      const novoSaldo = Number(prodNovo.quantidade) - novaQuantidade;
      await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novoSaldo, novoProdutoId]);

      await client.query(
        `UPDATE movimentacoes 
         SET produtoid = $1, quantidade = $2, motivo = $3, nome_obra = $4
         WHERE entrega_id = $5 AND tipo = 'saida'`,
        [novoProdutoId, novaQuantidade, `Entrega Editada: ${localObra || entregaAntiga.local_obra}`, localObra || entregaAntiga.local_obra, id]
      );

      if (prodNovo.estoqueminimo !== null && novoSaldo <= prodNovo.estoqueminimo) {
        sendLowStockEmail(toCamelCase({ ...prodNovo, quantidade: novoSaldo }));
      }
    }

    const { rows } = await client.query(
      `UPDATE entregas 
       SET data_hora_solicitacao = COALESCE($1, data_hora_solicitacao),
           local_armazenagem = COALESCE($2, local_armazenagem),
           local_obra = COALESCE($3, local_obra),
           responsavel_nome = COALESCE($4, responsavel_nome),
           responsavel_telefone = COALESCE($5, responsavel_telefone),
           status = COALESCE($6, status),
           produto_id = $7,
           item_quantidade = $8,
           item_unidade_medida = (SELECT unidade FROM produtos WHERE id = $7)
       WHERE id = $9 RETURNING *`,
      [dataHoraSolicitacao || null, localArmazenagem || null, localObra || null,
       responsavelNome || null, responsavelTelefone || null, status || null,
       novoProdutoId, novaQuantidade, id]
    );
    
    await client.query('COMMIT');
    res.json(toCamelCase(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/entregas/:id/status', async (req, res) => {
  try {
    await pool.query('UPDATE entregas SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/entregas/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const resEntrega = await client.query('SELECT * FROM entregas WHERE id = $1', [id]);
    if (resEntrega.rowCount === 0) throw new Error('Entrega nao encontrada.');
    const entrega = resEntrega.rows[0];
    const quantidadeEstorno = Number(entrega.item_quantidade);

    await client.query(
      'UPDATE produtos SET quantidade = quantidade + $1, atualizadoem = NOW() WHERE id = $2',
      [quantidadeEstorno, entrega.produto_id]
    );

    const motivoEstorno = `Estorno: Entrega excluida (Obra: ${entrega.local_obra})`;
    await client.query(
      `INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem, data_competencia)
       VALUES ($1, $2, 'entrada', $3, $4, NOW(), $5)`,
      [uid(), entrega.produto_id, quantidadeEstorno, motivoEstorno, hojeISO()]
    );

    await client.query('DELETE FROM entregas WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ success: true, message: 'Entrega excluida e estoque estornado.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/produtos-lista', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, nome FROM produtos");
    res.json({ message: "success", data: rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});