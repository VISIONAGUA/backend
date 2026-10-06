/**
 * Vision Água — Backend de Recarga
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

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Vision Água Backend', timestamp: new Date().toISOString() });
});

app.post('/criar-pix', async (req, res) => {
  try {
    const { uid, valor, nome } = req.body;
    if (!uid || typeof uid !== 'string') return res.status(400).json({ erro: 'uid é obrigatório' });
    if (!valor || typeof valor !== 'number' || valor < 2.50) return res.status(400).json({ erro: 'Valor mínimo R$ 2,50' });
    if (valor > 500) return res.status(400).json({ erro: 'Valor máximo R$ 500,00' });

    const clienteSnap = await db.ref('clientes/' + uid).once('value');
    if (!clienteSnap.exists()) return res.status(404).json({ erro: 'Cliente não encontrado' });
    const cliente = clienteSnap.val();
    const idempotencyKey = `pix-${uid}-${Date.now()}`;

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
      uid, valor, criado_em: Math.floor(Date.now() / 1000), status: 'pending',
      nome: cliente.nome || '', external_reference: `APP_CLI_${uid}`
    });

    const pix = mpData.point_of_interaction?.transaction_data || {};
    return res.json({
      sucesso: true, payment_id: paymentId, valor,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      ticket_url: pix.ticket_url
    });
  } catch (e) {
    console.error('❌ Erro:', e);
    res.status(500).json({ erro: 'Erro interno', detalhe: e.message });
  }
});

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

    const resultado = await db.ref(`clientes/${uid}`).transaction((cliente) => {
      if (!cliente) return cliente;
      const saldoAtual = Number(cliente.saldo || 0);
      cliente.saldo = Number((saldoAtual + valor).toFixed(2));
      if (!cliente.transacoes) cliente.transacoes = {};
      cliente.transacoes[`pix_${paymentId}`] = {
        tipo: 'recarga', valor, data: Math.floor(Date.now() / 1000),
        payment_id: String(paymentId), metodo: 'pix_app'
      };
      return cliente;
    });

    await db.ref(`transacoes/pix_${paymentId}`).set({
      id: `pix_${paymentId}`, valor, status: 'liberado',
      origem: 'app_cliente', motivo: 'recarga_app',
      processado_em: Math.floor(Date.now() / 1000),
      uid, payment_id: String(paymentId), external_reference: ref
    });

    await db.ref(`pagamentos_pendentes/${paymentId}`).update({
      status: 'completed', completado_em: Math.floor(Date.now() / 1000)
    });

    console.log(`✅ R$ ${valor.toFixed(2)} creditado para ${uid}`);
  } catch (e) { console.error('❌ Erro webhook:', e); }
});

app.get('/status/:paymentId', async (req, res) => {
  try {
    const snap = await db.ref(`pagamentos_pendentes/${req.params.paymentId}`).once('value');
    if (!snap.exists()) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(snap.val());
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Vision Água Backend rodando na porta ${PORT}`);
});
