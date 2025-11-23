// services/emailService.js
const { Resend } = require('resend');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Envia um e-mail de notificação de estoque baixo.
 * A função é "fire-and-forget", não bloqueia a resposta da API.
 * @param {object} produto - O objeto do produto (já em camelCase) que está com estoque baixo.
 */
async function sendLowStockEmail(produto) {
  // 1. Validação de segurança
  if (
    !produto ||
    typeof produto.estoqueMinimo === 'undefined' ||
    !process.env.EMAIL_RECIPIENTS
  ) {
    console.warn('Tentativa de envio de email cancelada: Dados do produto ou destinatários ausentes.');
    return;
  }

  // 2. Configuração do Remetente (Usa variável ou fallback para teste)
  const fromEmail = process.env.EMAIL_FROM || 'Sistema de Estoque <onboarding@resend.dev>';

  console.log(`📧 Preparando envio de alerta para o produto: ${produto.nome}`);

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: process.env.EMAIL_RECIPIENTS.split(',').map((email) => email.trim()),
      subject: `⚠️ Alerta: Estoque Baixo - ${produto.nome}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333;">
          <h2 style="color: #d9534f;">Alerta de Reposição Necessária</h2>
          <p>O sistema detectou que o seguinte item atingiu o nível crítico de estoque após uma movimentação recente.</p>
          
          <table border="1" cellpadding="10" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; border-color: #ddd;">
            <tr style="background-color: #f8f9fa;">
              <td width="30%"><strong>SKU</strong></td>
              <td>${produto.sku || '-'}</td>
            </tr>
            <tr>
              <td><strong>Produto</strong></td>
              <td style="font-size: 16px; font-weight: bold;">${produto.nome}</td>
            </tr>
            <tr>
              <td><strong>Estoque Atual</strong></td>
              <td style="color: #d9534f; font-weight: bold; font-size: 18px;">
                ${Number(produto.quantidade).toLocaleString('pt-BR')} ${produto.unidade}
              </td>
            </tr>
            <tr>
              <td><strong>Mínimo Definido</strong></td>
              <td>
                ${Number(produto.estoqueMinimo).toLocaleString('pt-BR')} ${produto.unidade}
              </td>
            </tr>
          </table>

          <p style="margin-top: 20px; font-size: 12px; color: #777;">
            Este é um e-mail automático gerado pelo Sistema Integrado.
            <br>Data do alerta: ${new Date().toLocaleString('pt-BR')}
          </p>
        </div>
      `,
    });

    if (error) {
      console.error(`❌ ERRO API Resend ao enviar para ${produto.nome}:`, error);
      return;
    }

    console.log(`✅ Email enviado! ID: ${data.id} | Produto: ${produto.nome}`);

  } catch (err) {
    console.error(`❌ ERRO CRÍTICO no serviço de email (${produto.nome}):`, err);
  }
}

module.exports = { sendLowStockEmail };