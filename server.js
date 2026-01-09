const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();
// Certifique-se de que este arquivo existe ou comente a linha se não estiver usando emails
// const { sendLowStockEmail } = require('./services/emailService'); 
const sendLowStockEmail = (prod) => { console.log("Email simulado para:", prod.nome) }; // Mock para evitar erro

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
            END $$;
        `);
        console.log('Schema atualizado (coluna entrega_id verificada).');
    } catch (err) {
        console.error('Erro ao atualizar schema:', err.message);
    }
}

// --- UTILITÁRIOS ---
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

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
    
    // Converte campos numéricos que vêm como string do Postgres (numeric/decimal)
    if (['quantidade', 'valorUnitario', 'itemQuantidade', 'valorTotal'].includes(camelKey) && obj[key] !== null) {
        newObj[camelKey] = Number(obj[key]);
    } else {
        newObj[camelKey] = obj[key];
    }
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

// --- ROTA DE MOVIMENTAÇÕES (COM LÓGICA DE CUSTO MÉDIO PONDERADO) ---
app.get('/api/movimentacoes', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM movimentacoes ORDER BY criadoem DESC');
        res.json(rows.map(toCamelCase));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/movimentacoes', async (req, res) => {
    // Agora recebemos custoEntrada
    const { produtoId, tipo, quantidade, motivo, custoEntrada } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Bloqueia a linha do produto para garantir cálculo atômico
        const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
        const produto = prodRes.rows[0];
        if (!produto) throw new Error('Produto não encontrado');

        let novoSaldo = Number(produto.quantidade);
        if (tipo === 'ajuste') novoSaldo = Number(quantidade);
        else novoSaldo += (tipo === 'entrada' ? 1 : -1) * Number(quantidade);
        
        if (novoSaldo < 0) novoSaldo = 0;

        // --- LÓGICA DE CUSTO MÉDIO PONDERADO ---
        let novoValorUnitario = Number(produto.valorunitario);

        if (tipo === 'entrada' && custoEntrada !== undefined && custoEntrada !== null) {
            const qtdAtual = Number(produto.quantidade);
            const valorAtual = Number(produto.valorunitario || 0);
            const qtdEntrada = Number(quantidade);
            const valorEntrada = Number(custoEntrada);

            // Fórmula: ((QtdAtual * ValorAtual) + (QtdEntrada * ValorEntrada)) / (QtdAtual + QtdEntrada)
            const valorTotalEstoque = qtdAtual * valorAtual;
            const valorTotalNovaEntrada = qtdEntrada * valorEntrada;
            const novaQuantidadeTotal = qtdAtual + qtdEntrada;

            if (novaQuantidadeTotal > 0) {
                novoValorUnitario = (valorTotalEstoque + valorTotalNovaEntrada) / novaQuantidadeTotal;
            } else {
                novoValorUnitario = valorEntrada;
            }
            
            // Arredonda para 2 casas decimais para armazenar bonito no banco (opcional)
            // novoValorUnitario = Math.round(novoValorUnitario * 100) / 100; 
        }

        // Atualiza Produto (Quantidade E Valor Unitário)
        await client.query(
            'UPDATE produtos SET quantidade = $1, valorunitario = $2, atualizadoem = NOW() WHERE id = $3', 
            [novoSaldo, novoValorUnitario, produtoId]
        );
        
        // Registra Movimentação
        const movId = uid();
        await client.query(
            'INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem) VALUES ($1, $2, $3, $4, $5, NOW())',
            [movId, produtoId, tipo, Number(quantidade), motivo]
        );

        if (produto.estoqueminimo !== null && novoSaldo <= produto.estoqueminimo) {
            sendLowStockEmail(toCamelCase({ ...produto, quantidade: novoSaldo }));
        }

        // Busca o produto atualizado para retornar ao front
        const updatedProd = await client.query('SELECT * FROM produtos WHERE id = $1', [produtoId]);
        await client.query('COMMIT');
        
        res.status(201).json({ 
            movimentacao: toCamelCase({ id: movId, produtoId, tipo, quantidade, motivo, criadoEm: nowISO() }),
            produto: toCamelCase(updatedProd.rows[0]) // Este produto já tem o preço e quantidade novos
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
        if (movRes.rowCount === 0) throw new Error('Movimentação não encontrada');
        const movAntiga = movRes.rows[0];

        if (movAntiga.tipo === 'ajuste') throw new Error('Use um novo Ajuste para corrigir saldo.');

        const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [movAntiga.produtoid]);
        const produto = prodRes.rows[0];

        let saldoRevertido = Number(produto.quantidade);
        if (movAntiga.tipo === 'entrada') {
            saldoRevertido -= Number(movAntiga.quantidade); 
        } else if (movAntiga.tipo === 'saida') {
            saldoRevertido += Number(movAntiga.quantidade);
        }

        let novoSaldoFinal = saldoRevertido;
        const novaQtd = Number(quantidade);
        
        if (movAntiga.tipo === 'entrada') {
            novoSaldoFinal += novaQtd;
        } else if (movAntiga.tipo === 'saida') {
            novoSaldoFinal -= novaQtd;
        }

        if (novoSaldoFinal < 0) throw new Error('Estoque ficaria negativo com essa alteração.');

        await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novoSaldoFinal, produto.id]);
        
        const updates = [];
        const values = [];
        if (quantidade) {
            updates.push(`quantidade = $${values.length + 1}`);
            values.push(novaQtd);
        }
        if (motivo) {
            updates.push(`motivo = $${values.length + 1}`);
            values.push(motivo);
        }
        values.push(id);

        const movUpdateSql = `UPDATE movimentacoes SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`;
        const movUpdatedRes = await client.query(movUpdateSql, values);

        if (movAntiga.entrega_id && quantidade) {
            await client.query(
                'UPDATE entregas SET item_quantidade = $1 WHERE id = $2',
                [novaQtd, movAntiga.entrega_id]
            );
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

// --- LOGÍSTICA ---
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
    dataHoraSolicitacao, localArmazenagem, localObra, produtoId, itemQuantidade, responsavelNome, responsavelTelefone 
  } = req.body;

  const quantidadeNum = Number(itemQuantidade);
  if (isNaN(quantidadeNum) || quantidadeNum <= 0) return res.status(400).json({ error: 'Quantidade inválida.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [produtoId]);
    const produto = prodRes.rows[0];
    
    if (!produto) throw new Error('Produto não encontrado.');
    if (Number(produto.quantidade) < quantidadeNum) throw new Error(`Estoque insuficiente (${produto.quantidade} disponível).`);

    const entregaId = uid();
    await client.query(
      `INSERT INTO entregas (id, data_hora_solicitacao, local_armazenagem, local_obra, produto_id, item_quantidade, item_unidade_medida, responsavel_nome, responsavel_telefone, status, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Pendente', NOW())`,
      [entregaId, dataHoraSolicitacao, localArmazenagem, localObra, produtoId, quantidadeNum, produto.unidade, responsavelNome, responsavelTelefone]
    );

    const novoSaldo = Number(produto.quantidade) - quantidadeNum;
    await client.query('UPDATE produtos SET quantidade = $1, atualizadoem = NOW() WHERE id = $2', [novoSaldo, produtoId]);

    await client.query(
      `INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem, entrega_id)
       VALUES ($1, $2, 'saida', $3, $4, NOW(), $5)`,
      [uid(), produtoId, quantidadeNum, `Entrega para: ${localObra}`, entregaId]
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
        dataHoraSolicitacao, localArmazenagem, localObra, responsavelNome, responsavelTelefone, status, produtoId, itemQuantidade  
    } = req.body;

    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        const resAntiga = await client.query('SELECT * FROM entregas WHERE id = $1', [id]);
        if (resAntiga.rowCount === 0) throw new Error('Entrega não encontrada');
        const entregaAntiga = resAntiga.rows[0];

        const velhoProdutoId = entregaAntiga.produto_id;
        const velhaQuantidade = Number(entregaAntiga.item_quantidade);

        const novoProdutoId = produtoId || velhoProdutoId;
        const novaQuantidade = itemQuantidade ? Number(itemQuantidade) : velhaQuantidade;

        if (velhoProdutoId !== novoProdutoId || velhaQuantidade !== novaQuantidade) {
            // Devolver estoque antigo
            await client.query(
                'UPDATE produtos SET quantidade = quantidade + $1, atualizadoem = NOW() WHERE id = $2',
                [velhaQuantidade, velhoProdutoId]
            );

            // Verificar e deduzir novo estoque
            const resProdNovo = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [novoProdutoId]);
            const prodNovo = resProdNovo.rows[0];
            if (!prodNovo) throw new Error('Novo produto selecionado não encontrado.');
            
            await client.query(
                'UPDATE produtos SET quantidade = quantidade - $1, atualizadoem = NOW() WHERE id = $2',
                [novaQuantidade, novoProdutoId]
            );

            await client.query(
                `UPDATE movimentacoes 
                 SET produtoid = $1, quantidade = $2, motivo = $3 
                 WHERE entrega_id = $4 AND tipo = 'saida'`,
                [novoProdutoId, novaQuantidade, `Entrega Editada: ${localObra || entregaAntiga.local_obra}`, id]
            );
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
            [dataHoraSolicitacao || null, localArmazenagem || null, localObra || null, responsavelNome || null, responsavelTelefone || null, status || null, novoProdutoId, novaQuantidade, id]
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
        if (resEntrega.rowCount === 0) throw new Error('Entrega não encontrada.');
        const entrega = resEntrega.rows[0];
        const quantidadeEstorno = Number(entrega.item_quantidade);

        await client.query(
            'UPDATE produtos SET quantidade = quantidade + $1, atualizadoem = NOW() WHERE id = $2',
            [quantidadeEstorno, entrega.produto_id]
        );

        const motivoEstorno = `Estorno: Entrega excluída (Obra: ${entrega.local_obra})`;
        await client.query(
            `INSERT INTO movimentacoes (id, produtoid, tipo, quantidade, motivo, criadoem)
             VALUES ($1, $2, 'entrada', $3, $4, NOW())`,
            [uid(), entrega.produto_id, quantidadeEstorno, motivoEstorno]
        );

        await client.query('DELETE FROM entregas WHERE id = $1', [id]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'Entrega excluída e estoque estornado.' });
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
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});