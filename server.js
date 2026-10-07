/**
 * Vision Água — Backend de Recarga
 * Versão 2.0 — Cashback + Promoções + VIP
 * 
 * Recursos:
 *   1. Cria PIX no Mercado Pago com external_reference "APP_CLI_{uid}"
 *   2. Recebe webhook quando o PIX é pago
 *   3. Calcula e credita: valor pago + cashback padrão + cashback VIP + bônus promoção
 *   4. Registra tudo no Firebase pra o app e o dash mostrarem
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MP_TOKEN = process.env.MP_TOKEN;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const PORT = process.env.PORT || 3000;

if (!MP_TOKEN) { console.error('❌ MP_TOKEN não configurado!'); process.exit(1); }
if (!FIREBASE_SERVICE_ACCOUNT) { console.error('❌ FIREBASE_SERVICE_ACCOUNT não configurado!'); process.exit(1); }

try {
  const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://visionespinho-default-rtdb.firebaseio.com'
  });
  console.log('✅ Firebase Admin iniciado');
} catch (e) {
  console.error('❌ Erro no Firebase:', e.message);
  process.exit(1);
}

const db = admin.database();

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Vision Água Backend',
    version: '2.0.0',
    features: ['pix', 'cashback', 'promocoes', 'vip'],
    timestamp: new Date().toISOString()
  });
});

// =====================================================
// 💰 CÁLCULO DE CRÉDITOS
// Soma: valor pago + cashback padrão + cashback VIP + bônus promo
// =====================================================
async function calcularCreditos(uid, valorPago) {
  const resultado = {
    valor_pago: valorPago,
    cashback_padrao: 0,
    cashback_vip: 0,
    bonus_promo: 0,
    bonus_total: 0,
    total: valorPago,
    promo_aplicada: null,
    detalhes: []
  };

  try {
    // ============ 1. CASHBACK PADRÃO (global) ============
    const configSnap = await db.ref('config/cashback_padrao').once('value');
    const config = configSnap.val() || {};
    
    if (config.ativo && valorPago >= (config.valor_minimo || 0)) {
      let cb = 0;
      if (config.tipo === 'percentual') {
        cb = valorPago * (Number(config.valor) / 100);
      } else {
        cb = Number(config.valor) || 0;
      }
      // Aplica teto se houver
      if (config.teto_bonus && cb > Number(config.teto_bonus)) {
        cb = Number(config.teto_bonus);
      }
      resultado.cashback_padrao = Number(cb.toFixed(2));
      if (resultado.cashback_padrao > 0) {
        resultado.detalhes.push({ tipo: 'cashback_padrao', valor: resultado.cashback_padrao });
      }
    }

    // ============ 2. CASHBACK ESPECIAL (VIP do cliente) ============
    const clienteSnap = await db.ref(`clientes/${uid}/cashback_especial`).once('value');
    const vip = clienteSnap.val() || {};
    
    if (vip.ativo) {
      let cbVipTotal = 0;
      if (vip.tipo === 'percentual') {
        cbVipTotal = valorPago * (Number(vip.valor) / 100);
      } else {
        cbVipTotal = Number(vip.valor) || 0;
      }
      
      // Desconta o cashback padrão pra não contar duas vezes
      // Ex: VIP 10% - Padrão 5% = Extra 5%
      let extra = 0;
      if (vip.tipo === 'percentual' && config.tipo === 'percentual') {
        extra = valorPago * ((Number(vip.valor) - Number(config.valor)) / 100);
      } else {
        extra = cbVipTotal;
      }
      
      if (extra > 0) {
        resultado.cashback_vip = Number(extra.toFixed(2));
        resultado.detalhes.push({ tipo: 'cashback_vip', valor: resultado.cashback_vip });
      }
    }

    // ============ 3. PROMOÇÕES ATIVAS ============
    const promosSnap = await db.ref('promocoes').once('value');
    const promocoes = promosSnap.val() || {};
    const agora = Math.floor(Date.now() / 1000);
    
    let melhorBonus = 0;
    let melhorPromo = null;

    for (const [id, promo] of Object.entries(promocoes)) {
      if (!promo.ativo) continue;
      if (agora < (promo.data_inicio || 0)) continue;
      if (agora > (promo.data_fim || Infinity)) continue;
      if (valorPago < (promo.valor_minimo || 0)) continue;

      let bonus = 0;
      if (promo.regra === 'bonus_fixo') {
        bonus = Number(promo.valor_bonus) || 0;
      } else if (promo.regra === 'percentual') {
        bonus = valorPago * ((Number(promo.percentual) || 0) / 100);
      } else if (promo.regra === 'multiplicador') {
        bonus = valorPago * ((Number(promo.multiplicador) || 1) - 1);
      }

      if (bonus > melhorBonus) {
        melhorBonus = bonus;
        melhorPromo = { id, titulo: promo.titulo || 'Promoção', bonus: Number(bonus.toFixed(2)) };
      }
    }

    if (melhorBonus > 0) {
      resultado.bonus_promo = melhorBonus;
      resultado.promo_aplicada = melhorPromo;
      resultado.detalhes.push({ tipo: 'promocao', valor: melhorBonus, id: melhorPromo.id, titulo: melhorPromo.titulo });
    }

    // ============ 4. SOMA FINAL ============
    resultado.bonus_total = Number((
      resultado.cashback_padrao + 
      resultado.cashback_vip + 
      resultado.bonus_promo
    ).toFixed(2));

    resultado.total = Number((
      valorPago + resultado.bonus_total
    ).toFixed(2));

  } catch (e) {
    console.error('Erro no cálculo de créditos:', e);
    resultado.total = valorPago;
  }

  return resultado;
}

// =====================================================
// 💳 CRIAR PIX
// =====================================================
app.post('/criar-pix', async (req, res) => {
  try {
    const { uid, valor, nome } = req.body;

    if (!uid || typeof uid !== 'string') {
      return res.status(400).json({ erro: 'uid é obrigatório' });
    }
    if (!valor || typeof valor !== 'number' || valor < 2.50) {
      return res.status(400).json({ erro: 'Valor mínimo R$ 2,50' });
    }
    if (valor > 500) {
      return res.status(400).json({ erro: 'Valor máximo R$ 500,00' });
    }

    const clienteSnap = await db.ref('clientes/' + uid).once('value');
    if (!clienteSnap.exists()) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    const cliente = clienteSnap.val();
    const idempotencyKey = `pix-${uid}-${Date.now()}`;

    // Calcula o que o cliente vai receber (pra mostrar antes)
    const preview = await calcularCreditos(uid, valor);

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        transaction_amount: Number(valor.toFixed(2)),
        description: `Recarga Vision Água - ${nome || cliente.nome || 'Cliente'}`,
        payment_method_id: 'pix',
        external_reference: `APP_CLI_${uid}`,
        payer: {
          email: cliente.cpf.replace(/\D/g, '') + '@visionagua.app',
          first_name: (cliente.nome || 'Cliente').split(' ')[0],
          last_name: (cliente.nome || 'Cliente').split(' ').slice(1).join(' ') || 'Vision',
          identification: { type: 'CPF', number: cliente.cpf.replace(/\D/g, '') }
        }
      })
    });

    const mpData = await mpResponse.json();
    if (!mpResponse.ok) {
      console.error('❌ Erro MP:', mpData);
      return res.status(500).json({ erro: 'Erro ao criar PIX', detalhe: mpData.message || 'Erro desconhecido' });
    }

    const paymentId = String(mpData.id);
    await db.ref(`pagamentos_pendentes/${paymentId}`).set({
      uid, valor,
      criado_em: Math.floor(Date.now() / 1000),
      status: 'pending',
      nome: cliente.nome || '',
      external_reference: `APP_CLI_${uid}`,
      preview_bonus: preview.bonus_total,
      preview_total: preview.total
    });

    const pix = mpData.point_of_interaction?.transaction_data || {};
    return res.json({
      sucesso: true,
      payment_id: paymentId,
      valor,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      ticket_url: pix.ticket_url,
      // Preview do que vai receber
      preview: {
        valor_pago: valor,
        cashback_padrao: preview.cashback_padrao,
        cashback_vip: preview.cashback_vip,
        bonus_promo: preview.bonus_promo,
        bonus_total: preview.bonus_total,
        total_receber: preview.total,
        promo_titulo: preview.promo_aplicada?.titulo || null
      }
    });
  } catch (e) {
    console.error('❌ Erro:', e);
    res.status(500).json({ erro: 'Erro interno', detalhe: e.message });
  }
});

// =====================================================
// 🎯 PREVIEW (opcional) — consulta quanto cliente recebe
// GET /preview/:uid/:valor
// =====================================================
app.get('/preview/:uid/:valor', async (req, res) => {
  try {
    const { uid, valor } = req.params;
    const valorNum = parseFloat(valor);
    if (!uid || !valorNum || valorNum < 2.50) {
      return res.status(400).json({ erro: 'Parâmetros inválidos' });
    }
    const creditos = await calcularCreditos(uid, valorNum);
    res.json({
      sucesso: true,
      valor_pago: valorNum,
      cashback_padrao: creditos.cashback_padrao,
      cashback_vip: creditos.cashback_vip,
      bonus_promo: creditos.bonus_promo,
      bonus_total: creditos.bonus_total,
      total_receber: creditos.total,
      promo_titulo: creditos.promo_aplicada?.titulo || null,
      detalhes: creditos.detalhes
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// =====================================================
// 📥 WEBHOOK — recebe notificação do Mercado Pago
// =====================================================
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  
  try {
    const { action, data, type } = req.body;
    if (type !== 'payment' && action !== 'payment.created' && action !== 'payment.updated') return;
    const paymentId = data?.id || req.body.data?.id;
    if (!paymentId) { console.log('⚠️ Webhook sem ID'); return; }

    console.log(`📥 Webhook: payment ${paymentId}`);
    await new Promise(r => setTimeout(r, 2000));

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    if (!mpResponse.ok) { console.error('❌ Erro consulta MP'); return; }

    const pagamento = await mpResponse.json();
    const status = pagamento.status;
    const ref = pagamento.external_reference || '';
    console.log(`📊 Payment ${paymentId}: status=${status}, ref=${ref}`);

    // Filtra: só processa PIX do app
    if (!ref.startsWith('APP_CLI_')) { console.log('⏭️ Ignorado'); return; }
    const uid = ref.replace('APP_CLI_', '');
    const valor = Number(pagamento.transaction_amount);

    // Idempotência
    const txSnap = await db.ref(`clientes/${uid}/transacoes/pix_${paymentId}`).once('value');
    if (txSnap.exists()) { console.log('⏭️ Já processado'); return; }

    if (status !== 'approved') {
      await db.ref(`pagamentos_pendentes/${paymentId}`).update({ status });
      return;
    }

    // ============ CALCULA OS CRÉDITOS ============
    const creditos = await calcularCreditos(uid, valor);
    const totalCreditar = creditos.total;
    
    console.log(`💰 Pago: R$${valor.toFixed(2)} | Cashback: R$${creditos.cashback_padrao.toFixed(2)} | VIP: R$${creditos.cashback_vip.toFixed(2)} | Promo: R$${creditos.bonus_promo.toFixed(2)} | TOTAL: R$${totalCreditar.toFixed(2)}`);
    if (creditos.promo_aplicada) console.log(`🎁 Promo: ${creditos.promo_aplicada.titulo}`);

    // ============ CREDITA NO FIREBASE ============
    const resultado = await db.ref(`clientes/${uid}`).transaction((cliente) => {
      if (!cliente) return cliente;
      
      cliente.saldo = Number((Number(cliente.saldo || 0) + totalCreditar).toFixed(2));
      
      if (!cliente.transacoes) cliente.transacoes = {};
      cliente.transacoes[`pix_${paymentId}`] = {
        tipo: 'recarga',
        valor: valor,
        cashback_padrao: creditos.cashback_padrao,
        cashback_vip: creditos.cashback_vip,
        bonus_promo: creditos.bonus_promo,
        bonus_total: creditos.bonus_total,
        total: totalCreditar,
        promo_id: creditos.promo_aplicada?.id || null,
        promo_titulo: creditos.promo_aplicada?.titulo || null,
        data: Math.floor(Date.now() / 1000),
        payment_id: String(paymentId),
        metodo: 'pix_app'
      };
      
      // Histórico de cashback (agregado)
      if (!cliente.historico_cashback) cliente.historico_cashback = {};
      cliente.historico_cashback[`pix_${paymentId}`] = {
        valor_recarga: valor,
        cashback_padrao: creditos.cashback_padrao,
        cashback_vip: creditos.cashback_vip,
        bonus_promo: creditos.bonus_promo,
        total_creditado: totalCreditar,
        data: Math.floor(Date.now() / 1000)
      };
      
      // Estatísticas acumuladas (pro dashboard)
      if (!cliente.stats) cliente.stats = {};
      cliente.stats.total_cashback_recebido = 
        Number(((cliente.stats.total_cashback_recebido || 0) + creditos.bonus_total).toFixed(2));
      cliente.stats.total_cashback_padrao = 
        Number(((cliente.stats.total_cashback_padrao || 0) + creditos.cashback_padrao).toFixed(2));
      cliente.stats.total_cashback_vip = 
        Number(((cliente.stats.total_cashback_vip || 0) + creditos.cashback_vip).toFixed(2));
      cliente.stats.total_bonus_promo = 
        Number(((cliente.stats.total_bonus_promo || 0) + creditos.bonus_promo).toFixed(2));
      cliente.stats.total_recargas = (cliente.stats.total_recargas || 0) + 1;
      cliente.stats.ultima_recarga = Math.floor(Date.now() / 1000);
      
      return cliente;
    });

    // ============ REGISTRO GLOBAL ============
    await db.ref(`transacoes/pix_${paymentId}`).set({
      id: `pix_${paymentId}`,
      valor: valor,
      valor_pago: valor,
      bonus_total: creditos.bonus_total,
      total_creditado: totalCreditar,
      cashback_padrao: creditos.cashback_padrao,
      cashback_vip: creditos.cashback_vip,
      bonus_promo: creditos.bonus_promo,
      promo_id: creditos.promo_aplicada?.id || null,
      promo_titulo: creditos.promo_aplicada?.titulo || null,
      status: 'liberado',
      origem: 'app_cliente',
      motivo: 'recarga_app',
      processado_em: Math.floor(Date.now() / 1000),
      uid,
      payment_id: String(paymentId),
      external_reference: ref
    });

    await db.ref(`pagamentos_pendentes/${paymentId}`).update({
      status: 'completed',
      completado_em: Math.floor(Date.now() / 1000),
      bonus_aplicado: creditos.bonus_total,
      total_creditado: totalCreditar
    });

    console.log(`✅ Creditado: R$ ${totalCreditar.toFixed(2)} para ${uid}`);

  } catch (e) {
    console.error('❌ Erro webhook:', e);
  }
});

// =====================================================
// 📊 CONSULTAR STATUS DE PAGAMENTO
// =====================================================
app.get('/status/:paymentId', async (req, res) => {
  try {
    const snap = await db.ref(`pagamentos_pendentes/${req.params.paymentId}`).once('value');
    if (!snap.exists()) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(snap.val());
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Vision Água Backend v2.0 rodando na porta ${PORT}`);
  console.log(`📦 Recursos: PIX · Cashback · Promoções · VIP`);
});
