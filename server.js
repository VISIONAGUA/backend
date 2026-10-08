/**
 * Vision Água — Backend de Recarga
 * Versão 2.2 — Cashback + Níveis + VIP + Promoções + Voz IA (Google TTS)
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
    version: '2.2.0',
    features: ['pix', 'cashback', 'niveis', 'vip', 'promocoes', 'tts'],
    timestamp: new Date().toISOString()
  });
});

// =====================================================
// 🔊 TTS — Voz via Google Translate (grátis, sem lib)
// =====================================================
async function gerarAudioTTS(texto, res) {
  // Limita a 200 caracteres (limite do Google TTS)
  const textoLimpo = String(texto).substring(0, 200);
  
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=pt-BR&client=tw-ob&q=${encodeURIComponent(textoLimpo)}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Google TTS retornou HTTP ${response.status}`);
  }

  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-cache');

  return new Promise((resolve, reject) => {
    response.body.on('error', reject);
    response.body.on('end', resolve);
    response.body.pipe(res);
  });
}

// GET /falar?texto=Olá+João
app.get('/falar', async (req, res) => {
  try {
    const texto = String(req.query.texto || '').trim();
    if (!texto) return res.status(400).json({ erro: 'texto é obrigatório' });

    console.log(`🔊 TTS: "${texto.substring(0, 50)}..."`);
    await gerarAudioTTS(texto, res);
  } catch (e) {
    console.error('❌ Erro /falar (GET):', e.message);
    if (!res.headersSent) res.status(500).json({ erro: e.message });
  }
});

// POST /falar  body: { "texto": "Olá João" }
app.post('/falar', async (req, res) => {
  try {
    const texto = String(req.body?.texto || '').trim();
    if (!texto) return res.status(400).json({ erro: 'texto é obrigatório' });

    console.log(`🔊 TTS: "${texto.substring(0, 50)}..."`);
    await gerarAudioTTS(texto, res);
  } catch (e) {
    console.error('❌ Erro /falar (POST):', e.message);
    if (!res.headersSent) res.status(500).json({ erro: e.message });
  }
});

// =====================================================
// 💰 CÁLCULO DE CRÉDITOS
// =====================================================
async function calcularCreditos(uid, valorPago) {
  const resultado = {
    valor_pago: valorPago,
    cashback_padrao: 0,
    cashback_vip: 0,
    cashback_nivel: 0,
    bonus_promo: 0,
    bonus_total: 0,
    total: valorPago,
    promo_aplicada: null,
    nivel_aplicado: null,
    vip_aplicado: false,
    detalhes: []
  };

  try {
    const configSnap = await db.ref('config/cashback_padrao').once('value');
    const config = configSnap.val() || {};
    const percentualPadrao = Number(config.valor) || 0;

    const vipSnap = await db.ref(`clientes/${uid}/cashback_especial`).once('value');
    const vip = vipSnap.val() || {};
    const temVip = vip.ativo === true;

    let nivelAplicavel = null;
    if (!temVip) {
      try {
        const niveisSnap = await db.ref('config/niveis').once('value');
        const niveis = niveisSnap.val() || {};
        const statsSnap = await db.ref(`clientes/${uid}/stats`).once('value');
        const stats = statsSnap.val() || {};
        const totalRecargas = Number(stats.total_recargas || 0);

        let melhorNivel = null;
        for (const [nome, nivel] of Object.entries(niveis)) {
          if (!nivel || typeof nivel.min !== 'number') continue;
          if (totalRecargas >= nivel.min) {
            if (!melhorNivel || nivel.min > melhorNivel.min) {
              melhorNivel = { nome, min: nivel.min, percentual: Number(nivel.percentual) || 0 };
            }
          }
        }
        if (melhorNivel && melhorNivel.percentual > percentualPadrao) {
          nivelAplicavel = melhorNivel;
        }
      } catch (e) {
        console.warn('Erro lendo níveis:', e.message);
      }
    }

    let percentualEfetivo = percentualPadrao;
    let fonte = 'padrao';

    if (temVip) {
      if (vip.tipo === 'percentual') {
        percentualEfetivo = Number(vip.valor) || percentualPadrao;
        fonte = 'vip';
      }
    } else if (nivelAplicavel) {
      percentualEfetivo = nivelAplicavel.percentual;
      fonte = 'nivel';
    }

    if (config.ativo !== false && valorPago >= (config.valor_minimo || 0)) {
      let cbBase = valorPago * (percentualPadrao / 100);
      resultado.cashback_padrao = Number(cbBase.toFixed(2));
      if (resultado.cashback_padrao > 0) {
        resultado.detalhes.push({ tipo: 'cashback_padrao', valor: resultado.cashback_padrao });
      }

      if (fonte === 'vip') {
        let cbVip = 0;
        if (vip.tipo === 'percentual') {
          const totalVip = valorPago * (percentualEfetivo / 100);
          cbVip = totalVip - cbBase;
        } else {
          cbVip = Number(vip.valor) || 0;
        }
        if (cbVip > 0) {
          resultado.cashback_vip = Number(cbVip.toFixed(2));
          resultado.vip_aplicado = true;
          resultado.detalhes.push({ tipo: 'cashback_vip', valor: resultado.cashback_vip });
        }
      } else if (fonte === 'nivel' && nivelAplicavel) {
        const totalNivel = valorPago * (nivelAplicavel.percentual / 100);
        const cbNivel = totalNivel - cbBase;
        if (cbNivel > 0) {
          resultado.cashback_nivel = Number(cbNivel.toFixed(2));
          resultado.nivel_aplicado = nivelAplicavel.nome;
          resultado.detalhes.push({ 
            tipo: 'cashback_nivel', 
            valor: resultado.cashback_nivel,
            nivel: nivelAplicavel.nome 
          });
        }
      }

      const teto = Number(config.teto_bonus) || 0;
      if (teto > 0) {
        const somaCb = resultado.cashback_padrao + resultado.cashback_vip + resultado.cashback_nivel;
        if (somaCb > teto) {
          const fator = teto / somaCb;
          resultado.cashback_padrao = Number((resultado.cashback_padrao * fator).toFixed(2));
          resultado.cashback_vip = Number((resultado.cashback_vip * fator).toFixed(2));
          resultado.cashback_nivel = Number((resultado.cashback_nivel * fator).toFixed(2));
        }
      }
    }

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

    resultado.bonus_total = Number((
      resultado.cashback_padrao + 
      resultado.cashback_vip + 
      resultado.cashback_nivel +
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
      preview: {
        valor_pago: valor,
        cashback_padrao: preview.cashback_padrao,
        cashback_vip: preview.cashback_vip,
        cashback_nivel: preview.cashback_nivel,
        bonus_promo: preview.bonus_promo,
        bonus_total: preview.bonus_total,
        total_receber: preview.total,
        promo_titulo: preview.promo_aplicada?.titulo || null,
        nivel_aplicado: preview.nivel_aplicado
      }
    });
  } catch (e) {
    console.error('❌ Erro:', e);
    res.status(500).json({ erro: 'Erro interno', detalhe: e.message });
  }
});

// =====================================================
// 🎯 PREVIEW
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
      cashback_nivel: creditos.cashback_nivel,
      bonus_promo: creditos.bonus_promo,
      bonus_total: creditos.bonus_total,
      total_receber: creditos.total,
      promo_titulo: creditos.promo_aplicada?.titulo || null,
      nivel_aplicado: creditos.nivel_aplicado,
      vip_aplicado: creditos.vip_aplicado,
      detalhes: creditos.detalhes
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// =====================================================
// 📥 WEBHOOK
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

    if (!ref.startsWith('APP_CLI_')) { console.log('⏭️ Ignorado'); return; }
    const uid = ref.replace('APP_CLI_', '');
    const valor = Number(pagamento.transaction_amount);

    const txSnap = await db.ref(`clientes/${uid}/transacoes/pix_${paymentId}`).once('value');
    if (txSnap.exists()) { console.log('⏭️ Já processado'); return; }

    if (status !== 'approved') {
      await db.ref(`pagamentos_pendentes/${paymentId}`).update({ status });
      return;
    }

    const creditos = await calcularCreditos(uid, valor);
    const totalCreditar = creditos.total;
    
    console.log(`💰 Pago: R$${valor.toFixed(2)} | TOTAL: R$${totalCreditar.toFixed(2)}`);

    await db.ref(`clientes/${uid}`).transaction((cliente) => {
      if (!cliente) return cliente;
      
      cliente.saldo = Number((Number(cliente.saldo || 0) + totalCreditar).toFixed(2));
      
      if (!cliente.transacoes) cliente.transacoes = {};
      cliente.transacoes[`pix_${paymentId}`] = {
        tipo: 'recarga',
        valor: valor,
        cashback_padrao: creditos.cashback_padrao,
        cashback_vip: creditos.cashback_vip,
        cashback_nivel: creditos.cashback_nivel,
        bonus_promo: creditos.bonus_promo,
        bonus_total: creditos.bonus_total,
        total: totalCreditar,
        nivel_aplicado: creditos.nivel_aplicado,
        promo_id: creditos.promo_aplicada?.id || null,
        promo_titulo: creditos.promo_aplicada?.titulo || null,
        data: Math.floor(Date.now() / 1000),
        payment_id: String(paymentId),
        metodo: 'pix_app'
      };
      
      if (!cliente.historico_cashback) cliente.historico_cashback = {};
      cliente.historico_cashback[`pix_${paymentId}`] = {
        valor_recarga: valor,
        cashback_padrao: creditos.cashback_padrao,
        cashback_vip: creditos.cashback_vip,
        cashback_nivel: creditos.cashback_nivel,
        bonus_promo: creditos.bonus_promo,
        total_creditado: totalCreditar,
        data: Math.floor(Date.now() / 1000)
      };
      
      if (!cliente.stats) cliente.stats = {};
      cliente.stats.total_cashback_recebido = 
        Number(((cliente.stats.total_cashback_recebido || 0) + creditos.bonus_total).toFixed(2));
      cliente.stats.total_cashback_padrao = 
        Number(((cliente.stats.total_cashback_padrao || 0) + creditos.cashback_padrao).toFixed(2));
      cliente.stats.total_cashback_vip = 
        Number(((cliente.stats.total_cashback_vip || 0) + creditos.cashback_vip).toFixed(2));
      cliente.stats.total_cashback_nivel = 
        Number(((cliente.stats.total_cashback_nivel || 0) + creditos.cashback_nivel).toFixed(2));
      cliente.stats.total_bonus_promo = 
        Number(((cliente.stats.total_bonus_promo || 0) + creditos.bonus_promo).toFixed(2));
      cliente.stats.total_recargas = (cliente.stats.total_recargas || 0) + 1;
      cliente.stats.ultima_recarga = Math.floor(Date.now() / 1000);
      
      return cliente;
    });

    await db.ref(`transacoes/pix_${paymentId}`).set({
      id: `pix_${paymentId}`,
      valor: valor,
      valor_pago: valor,
      bonus_total: creditos.bonus_total,
      total_creditado: totalCreditar,
      cashback_padrao: creditos.cashback_padrao,
      cashback_vip: creditos.cashback_vip,
      cashback_nivel: creditos.cashback_nivel,
      bonus_promo: creditos.bonus_promo,
      nivel_aplicado: creditos.nivel_aplicado,
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
// 📊 CONSULTAR STATUS
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
  console.log(`🚀 Vision Água Backend v2.2 rodando na porta ${PORT}`);
  console.log(`📦 Recursos: PIX · Cashback · Níveis · VIP · Promoções · TTS`);
});
