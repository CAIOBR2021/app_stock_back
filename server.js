const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();
const { sendLowStockEmail } = require('./services/emailService');

// =====================
// CONFIGURAÇÃO INICIAL
// =====================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// =====================
// BANCO DE DADOS
// =====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.connect()
  .then(() => {
    console.log('PostgreSQL conectado com sucesso.');
    setupDatabase();
  })
  .catch(err => console.error('Erro ao conectar no banco:', err.message));

// =====================
// CRIAÇÃO DAS TABELAS
// =====================
async function setupDatabase() {
  const sql = `
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
      valorunitario NUMERIC(10,2)
    );

    CREATE TABLE IF NOT EXISTS movimentacoes (
      id UUID PRIMARY KEY,
      produtoid UUID NOT NULL,
      tipo TEXT NOT NULL,
      quantidade INTEGER NOT NULL,
      motivo TEXT,
      criadoem TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (produtoid) REFERENCES produtos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entregas (
      id UUID PRIMARY KEY,
      data_hora_solicitacao TIMESTAMPTZ NOT NULL,
      local_armazenagem TEXT NOT NULL,
      local_obra TEXT NOT NULL,
      produto_id UUID NOT NULL,
      item_quantidade NUMERIC(10,2) NOT NULL,
      item_unidade_medida TEXT,
      responsavel_nome TEXT,
      responsavel_telefone TEXT,
      status TEXT DEFAULT 'Pendente',
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE
    );
  `;
  await pool.query(sql);
  console.log('Tabelas verificadas/criadas.');
}

// =====================
// UTILITÁRIOS
// =====================
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

const toCamelCase = obj => {
  const map = {
    estoqueminimo: 'estoqueMinimo',
    localarmazenamento: 'localArmazenamento',
    criadoem: 'criadoEm',
    atualizadoem: 'atualizadoEm',
    valorunitario: 'valorUnitario',
    produtoid: 'produtoId',
    produto_id: 'produtoId',
    data_hora_solicitacao: 'dataHoraSolicitacao',
    local_armazenagem: 'localArmazenagem',
    local_obra: 'localObra',
    item_quantidade: 'itemQuantidade',
    item_unidade_medida: 'itemUnidadeMedida',
    responsavel_nome: 'responsavelNome',
    responsavel_telefone: 'responsavelTelefone'
  };

  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [map[k] || k, v])
  );
};

// =====================
// ENTREGAS – CRIAR (COM BAIXA)
// =====================
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

  const quantidadeInt = parseInt(itemQuantidade, 10);
  if (isNaN(quantidadeInt) || quantidadeInt <= 0) {
    return res.status(400).json({ error: 'Quantidade inválida.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query(
      'SELECT * FROM produtos WHERE id = $1 FOR UPDATE',
      [produtoId]
    );
    const produto = prodRes.rows[0];
    if (!produto) throw new Error('Produto não encontrado.');

    if (produto.quantidade < quantidadeInt) {
      throw new Error(`Estoque insuficiente (${produto.quantidade}).`);
    }

    await client.query(
      `INSERT INTO entregas (
        id, data_hora_solicitacao, local_armazenagem, local_obra,
        produto_id, item_quantidade, item_unidade_medida,
        responsavel_nome, responsavel_telefone
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        uid(),
        dataHoraSolicitacao,
        localArmazenagem,
        localObra,
        produtoId,
        quantidadeInt,
        produto.unidade,
        responsavelNome,
        responsavelTelefone
      ]
    );

    const novoSaldo = produto.quantidade - quantidadeInt;
    await client.query(
      'UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2',
      [novoSaldo, produtoId]
    );

    await client.query(
      `INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem)
       VALUES ($1,$2,'saida',$3,$4,NOW())`,
      [uid(), produtoId, quantidadeInt, `Entrega para: ${localObra}`]
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

// =====================
// ENTREGAS – EXCLUIR (COM ESTORNO)
// =====================
app.delete('/api/entregas/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      'SELECT * FROM entregas WHERE id = $1',
      [req.params.id]
    );
    if (r.rowCount === 0) throw new Error('Entrega não encontrada.');

    const entrega = r.rows[0];
    const quantidadeInt = parseInt(entrega.item_quantidade, 10);

    await client.query(
      'UPDATE produtos SET quantidade = quantidade + $1 WHERE id = $2',
      [quantidadeInt, entrega.produto_id]
    );

    await client.query(
      `INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem)
       VALUES ($1,$2,'entrada',$3,$4,NOW())`,
      [
        uid(),
        entrega.produto_id,
        quantidadeInt,
        `Estorno: Entrega excluída (${entrega.local_obra})`
      ]
    );

    await client.query('DELETE FROM entregas WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =====================
app.listen(PORT, () =>
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
);
