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
  
  try {
    await pool.query(createTables);
    console.log('Tabelas verificadas/criadas com sucesso.');
  } catch (err) {
    console.error('Erro ao configurar banco:', err);
  }
}

// --- UTILITÁRIOS ---
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

// Converte chaves do banco (snake_case) para o frontend (camelCase)
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
    
    newObj[camelKey] = obj[key];
  }
  return newObj;
}

// --- ROTAS ---

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
        const { rows } = await pool.query(
            `INSERT INTO produtos (id, sku, nome, descricao, categoria, unidade, quantidade, estoqueminimo, localarmazenamento, fornecedor, criadoem, valorunitario) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [id, sku, nome, descricao, categoria, unidade, quantidade || 0, estoqueMinimo, localArmazenamento, fornecedor, nowISO(), valorUnitario]
        );
        res.status(201).json(toCamelCase(rows[0]));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/produtos/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    
    // Mapeia campos do frontend para colunas do banco
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

// --- MOVIMENTAÇÕES ---
app.get('/api/movimentacoes', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM movimentacoes ORDER BY criadoem DESC');
        res.json(rows.map(toCamelCase));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/movimentacoes', async (req, res) => {
    const { produtoId, tipo, quantidade, motivo } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
        const produto = prodRes.rows[0];
        if (!produto) throw new Error('Produto não encontrado');

        let novoSaldo = produto.quantidade;
        if (tipo === 'ajuste') novoSaldo = Number(quantidade);
        else novoSaldo += (tipo === 'entrada' ? 1 : -1) * Number(quantidade);
        
        if (novoSaldo < 0) novoSaldo = 0;

        await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novoSaldo, produtoId]);
        
        const movId = uid();
        await client.query(
            'INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem) VALUES ($1, $2, $3, $4, $5, NOW())',
            [movId, produtoId, tipo, Number(quantidade), motivo]
        );

        if (produto.estoqueminimo !== null && novoSaldo <= produto.estoqueminimo) {
            sendLowStockEmail(toCamelCase({ ...produto, quantidade: novoSaldo }));
        }

        const updatedProd = await client.query('SELECT * FROM produtos WHERE id = $1', [produtoId]);
        await client.query('COMMIT');
        
        res.status(201).json({ 
            movimentacao: toCamelCase({ id: movId, produtoId, tipo, quantidade, motivo, criadoEm: nowISO() }),
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
    if (movResult.rowCount === 0) throw new Error('Movimentação não encontrada.');
    
    const mov = movResult.rows[0];
    if (mov.tipo === 'ajuste') throw new Error('Não é possível excluir ajuste.');

    const prodResult = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [mov.produtoid]);
    const produto = prodResult.rows[0];
    
    // Reverte o saldo
    let novaQtd = produto.quantidade + (mov.tipo === 'saida' ? mov.quantidade : -mov.quantidade);
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

// --- ENTREGAS (LOGÍSTICA) ---

// Listar
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

// Criar (Com Baixa no Estoque)
app.post('/api/entregas', async (req, res) => {
  const { dataHoraSolicitacao, localArmazenagem, localObra, produtoId, itemQuantidade, responsavelNome, responsavelTelefone } = req.body;

  if (!produtoId || !itemQuantidade) return res.status(400).json({ error: 'Produto e quantidade obrigatórios.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
    const produto = prodRes.rows[0];
    
    if (!produto) throw new Error('Produto não encontrado.');
    if (produto.quantidade < itemQuantidade) throw new Error(`Estoque insuficiente (${produto.quantidade} disponível).`);

    const entregaId = uid();
    await client.query(
      `INSERT INTO entregas (id, data_hora_solicitacao, local_armazenagem, local_obra, produto_id, item_quantidade, item_unidade_medida, responsavel_nome, responsavel_telefone, status, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Pendente', NOW())`,
      [entregaId, dataHoraSolicitacao, localArmazenagem, localObra, produtoId, itemQuantidade, produto.unidade, responsavelNome, responsavelTelefone]
    );

    // Baixa estoque
    const novoSaldo = produto.quantidade - itemQuantidade;
    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novoSaldo, produtoId]);

    // Registra movimento (CORREÇÃO: Removido o argumento 'saida' extra)
    await client.query(
      `INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem)
       VALUES ($1, $2, 'saida', $3, $4, NOW())`,
      [uid(), produtoId, itemQuantidade, `Entrega para: ${localObra}`]
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

// Atualizar Entrega (Reprogramar Data/Hora/Local etc)
// (CORREÇÃO: Uso de COALESCE com fallback NULL para suportar atualizações parciais)
app.put('/api/entregas/:id', async (req, res) => {
    const { id } = req.params;
    const { dataHoraSolicitacao, localArmazenagem, localObra, responsavelNome, responsavelTelefone, status } = req.body;
    
    try {
        const { rows } = await pool.query(
            `UPDATE entregas 
             SET data_hora_solicitacao = COALESCE($1, data_hora_solicitacao),
                 local_armazenagem = COALESCE($2, local_armazenagem),
                 local_obra = COALESCE($3, local_obra),
                 responsavel_nome = COALESCE($4, responsavel_nome),
                 responsavel_telefone = COALESCE($5, responsavel_telefone),
                 status = COALESCE($6, status)
             WHERE id = $7 RETURNING *`,
            [
                dataHoraSolicitacao || null, 
                localArmazenagem || null, 
                localObra || null, 
                responsavelNome || null, 
                responsavelTelefone || null, 
                status || null, 
                id
            ]
        );
        
        if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });
        res.json(toCamelCase(rows[0]));
    } catch (err) {
        console.error('Erro PUT /entregas:', err);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/entregas/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE entregas SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/entregas/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM entregas WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});