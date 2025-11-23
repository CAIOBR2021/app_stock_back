// server.js
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();
const { sendLowStockEmail } = require('./services/emailService');

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const PORT = process.env.PORT || 10000;

// Middlewares
app.use(cors());
app.use(express.json());

// --- BANCO DE DADOS (PostgreSQL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

pool
  .connect()
  .then(() => {
    console.log('PostgreSQL database connected successfully.');
    setupDatabase();
  })
  .catch((err) =>
    console.error('Error connecting to the database:', err.message),
  );

// Função para criar as tabelas se não existirem
async function setupDatabase() {
  console.log('Iniciando a configuração do banco de dados...');

  const createTablesScript = `
    CREATE TABLE IF NOT EXISTS produtos (
      id UUID PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      categoria TEXT,
      unidade TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      estoqueminimo INTEGER,
      localarmazenamento TEXT,
      fornecedor TEXT,
      criadoem TIMESTAMPTZ NOT NULL,
      atualizadoem TIMESTAMPTZ,
      prioritario BOOLEAN DEFAULT FALSE,
      valorunitario NUMERIC(10, 2)
    );

    CREATE TABLE IF NOT EXISTS movimentacoes (
      id UUID PRIMARY KEY,
      produtoid UUID NOT NULL,
      tipo TEXT NOT NULL,
      quantidade INTEGER NOT NULL,
      motivo TEXT,
      criadoem TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (produtoid) REFERENCES produtos (id) ON DELETE CASCADE
    );

    -- NOVA TABELA: ENTREGAS (LOGÍSTICA)
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
  `;
  
  const alterTableScripts = `
    DO $$
    BEGIN
        IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='produtos' AND column_name='prioritario') THEN
            ALTER TABLE produtos ADD COLUMN prioritario BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='produtos' AND column_name='valorunitario') THEN
            ALTER TABLE produtos ADD COLUMN valorunitario NUMERIC(10, 2);
        END IF;
    END $$;
  `;

  try {
    await pool.query(createTablesScript);
    console.log('SUCESSO: Tabelas verificadas/criadas.');
    await pool.query(alterTableScripts);
    console.log('SUCESSO: Migrações aplicadas.');
  } catch (err) {
    console.error('ERRO CRÍTICO AO CONFIGURAR O BANCO DE DADOS:', err);
  }
}

// --- FUNÇÕES AUXILIARES ---
function uid() {
  return crypto.randomUUID();
}
function gerarSKU() {
  return `PROD-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}
function nowISO() {
  return new Date().toISOString();
}

function toCamelCase(obj) {
  if (!obj) return obj;
  const newObj = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    // Ajustes manuais para campos específicos
    if (camelKey === 'estoqueminimo') newObj['estoqueMinimo'] = obj[key];
    else if (camelKey === 'localarmazenamento') newObj['localArmazenamento'] = obj[key];
    else if (camelKey === 'criadoem') newObj['criadoEm'] = obj[key];
    else if (camelKey === 'atualizadoem') newObj['atualizadoEm'] = obj[key];
    else if (camelKey === 'produtoid') newObj['produtoId'] = obj[key];
    else if (camelKey === 'valorunitario') newObj['valorUnitario'] = obj[key];
    // Campos de entrega
    else if (camelKey === 'produtoId') newObj['produtoId'] = obj[key];
    else if (camelKey === 'dataHoraSolicitacao') newObj['dataHoraSolicitacao'] = obj[key];
    else if (camelKey === 'localArmazenagem') newObj['localArmazenagem'] = obj[key];
    else if (camelKey === 'localObra') newObj['localObra'] = obj[key];
    else if (camelKey === 'itemQuantidade') newObj['itemQuantidade'] = obj[key];
    else if (camelKey === 'itemUnidadeMedida') newObj['itemUnidadeMedida'] = obj[key];
    else if (camelKey === 'responsavelNome') newObj['responsavelNome'] = obj[key];
    else if (camelKey === 'responsavelTelefone') newObj['responsavelTelefone'] = obj[key];
    else if (camelKey === 'criadoEm') newObj['criadoEm'] = obj[key];
    else newObj[camelKey] = obj[key];
  }
  return newObj;
}

// --- ROTAS DA API ---

// AUTENTICAÇÃO
app.post('/api/auth/verify-password', async (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Senha incorreta.' });
  }
});

// --- PRODUTOS ---
app.get('/api/produtos', async (req, res) => {
  const page = parseInt(req.query._page, 10) || 1;
  const limit = parseInt(req.query._limit, 10) || 10000;
  const offset = (page - 1) * limit;
  const searchTerm = req.query.q || '';

  try {
    let sql;
    const params = [];

    if (searchTerm) {
      sql = `
        SELECT * FROM produtos
        WHERE
          nome ILIKE $1 OR
          sku ILIKE $1 OR
          categoria ILIKE $1
        ORDER BY nome ASC
        LIMIT $2 OFFSET $3
      `;
      params.push(`%${searchTerm}%`, limit, offset);
    } else {
      sql = 'SELECT * FROM produtos ORDER BY nome ASC LIMIT $1 OFFSET $2';
      params.push(limit, offset);
    }

    const { rows } = await pool.query(sql, params);
    res.json(rows.map(toCamelCase));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/produtos', async (req, res) => {
  const { nome, descricao, categoria, unidade, quantidade, estoqueMinimo, localArmazenamento, fornecedor, valorUnitario } = req.body;

  if (!nome || !unidade) {
    return res.status(400).json({ error: 'Nome e Unidade são obrigatórios.' });
  }

  const novoProduto = {
    id: uid(),
    sku: gerarSKU(),
    nome,
    descricao: descricao || null,
    categoria: categoria || null,
    unidade,
    quantidade: Number(quantidade) || 0,
    estoqueminimo: estoqueMinimo !== undefined ? Number(estoqueMinimo) : null,
    localarmazenamento: localArmazenamento || null,
    fornecedor: fornecedor || null,
    criadoem: nowISO(),
    atualizadoem: null,
    prioritario: false,
    valorunitario: valorUnitario !== undefined ? Number(valorUnitario) : null,
  };

  const sql = `
    INSERT INTO produtos (id, sku, nome, descricao, categoria, unidade, quantidade, estoqueminimo, localarmazenamento, fornecedor, criadoem, atualizadoem, prioritario, valorunitario)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`;
  
  try {
    const { rows } = await pool.query(sql, Object.values(novoProduto));
    res.status(201).json(toCamelCase(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/produtos/:id', async (req, res) => {
  const { id } = req.params;
  const patch = req.body;
  const allowedFields = ['nome', 'descricao', 'categoria', 'unidade', 'estoqueMinimo', 'localArmazenamento', 'fornecedor', 'prioritario', 'valorUnitario'];
  const fieldsToUpdate = Object.keys(patch).filter((key) => allowedFields.includes(key));
  
  if (fieldsToUpdate.length === 0) return res.status(400).json({ error: 'Nenhum campo válido.' });
  
  const dbFieldsToUpdate = fieldsToUpdate.map(field => {
      if (field === 'estoqueMinimo') return 'estoqueminimo';
      if (field === 'localArmazenamento') return 'localarmazenamento';
      if (field === 'valorUnitario') return 'valorunitario';
      return field;
  });

  const setClause = dbFieldsToUpdate.map((field, index) => `${field} = $${index + 1}`).join(', ');
  const values = fieldsToUpdate.map((key) => patch[key]);
  
  const sql = `UPDATE produtos SET ${setClause}, atualizadoem = $${values.length + 1} WHERE id = $${values.length + 2} RETURNING *`;
  const params = [...values, nowISO(), id];

  try {
    const result = await pool.query(sql, params);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.status(200).json(toCamelCase(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/produtos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM produtos WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.status(200).json({ message: 'Produto deletado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/produtos/valor-total', async (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Não autorizado.' });

  try {
    const { rows } = await pool.query('SELECT SUM(quantidade * valorunitario) as valorTotal FROM produtos WHERE valorunitario IS NOT NULL AND valorunitario > 0');
    res.json({ valorTotal: parseFloat(rows[0].valortotal || 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MOVIMENTAÇÕES ---
app.get('/api/movimentacoes', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM movimentacoes ORDER BY criadoem DESC');
    res.json(rows.map(toCamelCase));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/movimentacoes', async (req, res) => {
  const { produtoId, tipo, quantidade, motivo } = req.body;
  if (!produtoId || !tipo || !quantidade || Number(quantidade) <= 0) return res.status(400).json({ error: 'Dados inválidos.' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productResult = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
    const produto = productResult.rows[0];
    if (!produto) throw new Error('Produto não encontrado.');

    let novaQuantidade = produto.quantidade;
    if (tipo === 'ajuste') novaQuantidade = Number(quantidade);
    else novaQuantidade += (tipo === 'entrada' ? 1 : -1) * Number(quantidade);
    
    novaQuantidade = Math.max(0, novaQuantidade);

    if (produto.estoqueminimo !== null && novaQuantidade <= produto.estoqueminimo && novaQuantidade !== produto.quantidade) {
      sendLowStockEmail(toCamelCase({ ...produto, quantidade: novaQuantidade }));
    }

    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = $2 WHERE id = $3', [novaQuantidade, nowISO(), produtoId]);
    
    const novaMov = { id: uid(), produtoid: produtoId, tipo, quantidade: Number(quantidade), motivo: motivo || null, criadoem: nowISO() };
    await client.query('INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem) VALUES ($1, $2, $3, $4, $5, $6)', Object.values(novaMov));
    
    const updatedProd = await client.query('SELECT * FROM produtos WHERE id = $1', [produtoId]);
    await client.query('COMMIT');
    
    res.status(201).json({ movimentacao: toCamelCase(novaMov), produto: toCamelCase(updatedProd.rows[0]) });
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
    if (movResult.rowCount === 0) throw new Error('Movimentação não encontrada.');
    
    const mov = movResult.rows[0];
    if (mov.tipo === 'ajuste') throw new Error('Não é possível excluir ajuste.');

    const prodResult = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [mov.produtoid]);
    const produto = prodResult.rows[0];
    
    let novaQtd = produto.quantidade + (mov.tipo === 'saida' ? mov.quantidade : -mov.quantidade);
    novaQtd = Math.max(0, novaQtd);

    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = $2 WHERE id = $3', [novaQtd, nowISO(), produto.id]);
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

// --- ENTREGAS (LOGÍSTICA) ---

// Listar entregas
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
        formatted.itemNome = row.item_nome || 'Produto Excluído';
        formatted.sku = row.sku || '-';
        return formatted;
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar entrega (COM BAIXA NO ESTOQUE)
app.post('/api/entregas', async (req, res) => {
  const {
    dataHoraSolicitacao,
    localArmazenagem,
    localObra,
    produtoId,
    itemQuantidade,
    responsavelNome,
    responsavelTelefone
  } = req.body;

  if (!produtoId || !itemQuantidade) {
    return res.status(400).json({ error: 'Produto e Quantidade são obrigatórios.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Verifica Saldo
    const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
    const produto = prodRes.rows[0];
    if (!produto) throw new Error('Produto não encontrado.');
    
    const qtdSolicitada = Number(itemQuantidade);
    const saldoAtual = Number(produto.quantidade);

    if (saldoAtual < qtdSolicitada) {
      throw new Error(`Estoque insuficiente. Disponível: ${saldoAtual}, Solicitado: ${qtdSolicitada}`);
    }

    // 2. Insere Entrega
    const novaEntregaId = uid();
    const insertEntregaSql = `
      INSERT INTO entregas (id, data_hora_solicitacao, local_armazenagem, local_obra, produto_id, item_quantidade, item_unidade_medida, responsavel_nome, responsavel_telefone, status, criado_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Pendente', $10)
      RETURNING *
    `;
    await client.query(insertEntregaSql, [
      novaEntregaId,
      dataHoraSolicitacao,
      localArmazenagem,
      localObra,
      produtoId,
      qtdSolicitada,
      produto.unidade,
      responsavelNome,
      responsavelTelefone,
      nowISO()
    ]);

    // 3. Baixa no Estoque
    const novoSaldo = saldoAtual - qtdSolicitada;
    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = $2 WHERE id = $3', [novoSaldo, nowISO(), produtoId]);

    // 4. Registra Movimentação
    const movId = uid();
    await client.query(
      'INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem) VALUES ($1, $2, $3, $4, $5, $6)',
      [movId, produtoId, 'saida', qtdSolicitada, `Entrega Logística p/ ${localObra}`, nowISO()]
    );

    if (produto.estoqueminimo !== null && novoSaldo <= produto.estoqueminimo) {
       const produtoAtualizado = { ...produto, quantidade: novoSaldo };
       sendLowStockEmail(toCamelCase(produtoAtualizado));
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Entrega agendada e estoque atualizado.' });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Deletar entrega
app.delete('/api/entregas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM entregas WHERE id = $1', [id]);
    res.json({ message: 'Entrega excluída.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar status da entrega
app.patch('/api/entregas/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query('UPDATE entregas SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});