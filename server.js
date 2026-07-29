const http = require('http');
const https = require('https');
const fs = require('fs');
const Stripe = require('stripe');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// Firebase Admin SDK — used to write to Firestore bypassing security rules
let firebaseAdminReady = false;
try {
  const serviceAccountPath = fs.existsSync('/etc/secrets/firebase-service-account.json')
    ? '/etc/secrets/firebase-service-account.json'
    : './firebase-service-account.json';
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  firebaseAdminReady = true;
  console.log('Firebase Admin SDK inicializado ✓');
} catch(e) {
  console.log('Firebase Admin no disponible:', e.message);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ status: 'ok', service: 'Komebien API' }));
    return;
  }

  // Firebase config endpoint
  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      apiKey: FIREBASE_API_KEY || '',
      authDomain: "komebienmx.firebaseapp.com",
      projectId: "komebienmx",
      storageBucket: "komebienmx.firebasestorage.app",
      messagingSenderId: "465748859151",
      appId: "1:465748859151:web:1b7ace721717434ed9467a"
    }));
    return;
  }

  // Claude API proxy
  if (req.method === 'POST' && req.url === '/claude') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        if (!prompt) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ error: 'Prompt requerido' }));
          return;
        }
        if (!API_KEY) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ error: 'API key no configurada' }));
          return;
        }

        const postData = JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          messages: [{ role: 'user', content: prompt }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        // Transient errors (overloaded/server hiccups) get automatic retries
        // before we give up and tell the user — covers brief Anthropic blips
        const RETRYABLE_STATUSES = [429, 500, 502, 503, 529];
        const MAX_ATTEMPTS = 3;
        const callAnthropic = (attempt) => {
          const apiReq = https.request(options, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => data += chunk);
            apiRes.on('end', () => {
              console.log(`Claude status (intento ${attempt}):`, apiRes.statusCode);
              if (apiRes.statusCode !== 200) {
                if (RETRYABLE_STATUSES.includes(apiRes.statusCode) && attempt < MAX_ATTEMPTS) {
                  const wait = attempt * 2000; // 2s, 4s
                  console.log(`Reintentando en ${wait}ms...`);
                  setTimeout(() => callAnthropic(attempt + 1), wait);
                  return;
                }
                res.writeHead(apiRes.statusCode, CORS);
                res.end(JSON.stringify({ error: data, transient: RETRYABLE_STATUSES.includes(apiRes.statusCode) }));
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const text = parsed.content[0].text;
                console.log('Text length:', text.length);
                res.writeHead(200, CORS);
                res.end(JSON.stringify({ content: parsed.content }));
              } catch(parseErr) {
                console.log('Parse error:', parseErr.message);
                res.writeHead(500, CORS);
                res.end(JSON.stringify({ error: 'Parse error: ' + parseErr.message }));
              }
            });
          });
          apiReq.on('error', (e) => {
            if (attempt < MAX_ATTEMPTS) {
              const wait = attempt * 2000;
              setTimeout(() => callAnthropic(attempt + 1), wait);
              return;
            }
            res.writeHead(500, CORS);
            res.end(JSON.stringify({ error: e.message, transient: true }));
          });
          apiReq.write(postData);
          apiReq.end();
        };
        callAnthropic(1);

      } catch(e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Stripe: create checkout session for subscription
  if (req.method === 'POST' && req.url === '/create-checkout-session') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { priceId, uid, email } = JSON.parse(body);
        if (!priceId || !uid) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ error: 'priceId y uid son requeridos' }));
          return;
        }
        if (!stripe) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ error: 'Stripe no configurado en el servidor' }));
          return;
        }

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceId, quantity: 1 }],
          client_reference_id: uid,
          customer_email: email || undefined,
          allow_promotion_codes: true,
          success_url: 'https://app.komebien.mx/?checkout=success',
          cancel_url: 'https://app.komebien.mx/?checkout=cancel',
          metadata: { uid }
        });

        res.writeHead(200, CORS);
        res.end(JSON.stringify({ url: session.url }));
      } catch(e) {
        console.log('Stripe checkout error:', e.message);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Stripe: create a Customer Portal session so users can manage/cancel their own subscription
  if (req.method === 'POST' && req.url === '/create-portal-session') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { customerId } = JSON.parse(body);
        if (!customerId) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ error: 'customerId es requerido' }));
          return;
        }
        if (!stripe) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ error: 'Stripe no configurado en el servidor' }));
          return;
        }

        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: 'https://app.komebien.mx/'
        });

        res.writeHead(200, CORS);
        res.end(JSON.stringify({ url: session.url }));
      } catch(e) {
        console.log('Stripe portal error:', e.message);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Stripe webhook: marks user as Pro in Firestore after successful payment
  if (req.method === 'POST' && req.url === '/webhook') {
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk.toString());
    req.on('end', async () => {
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
      } catch(err) {
        console.log('Webhook signature inválida:', err.message);
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Webhook Error: ' + err.message);
        return;
      }

      try {
        if (!firebaseAdminReady) {
          console.log('Webhook recibido pero Firebase Admin no está listo');
        } else if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
          if (uid) {
            const montoMensual = typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
            // Fetch the full session with discount details expanded, to know if a coupon was used
            let cuponUsado = null;
            try {
              const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
                expand: ['total_details.breakdown.discounts']
              });
              const discounts = fullSession.total_details && fullSession.total_details.breakdown && fullSession.total_details.breakdown.discounts;
              if (discounts && discounts.length > 0) {
                cuponUsado = discounts[0].discount && discounts[0].discount.coupon
                  ? (discounts[0].discount.coupon.name || discounts[0].discount.coupon.id)
                  : null;
              }
            } catch(expandErr) { console.log('No se pudo expandir cupón:', expandErr.message); }

            await admin.firestore().collection('usuarios').doc(uid).set({
              suscripcion: {
                activa: true,
                stripeCustomerId: session.customer,
                stripeSubscriptionId: session.subscription,
                montoMensual,
                cuponUsado,
                fechaInicio: new Date().toISOString()
              }
            }, { merge: true });
            console.log('✓ Usuario marcado como Pro:', uid, '— $' + montoMensual + ' MXN' + (cuponUsado ? ' (cupón: ' + cuponUsado + ')' : ''));
          }
        } else if (event.type === 'customer.subscription.deleted') {
          const sub = event.data.object;
          const snap = await admin.firestore().collection('usuarios')
            .where('suscripcion.stripeCustomerId', '==', sub.customer).get();
          const batch = admin.firestore().batch();
          snap.forEach(doc => batch.set(doc.ref, { suscripcion: { activa: false } }, { merge: true }));
          await batch.commit();
          console.log('✓ Suscripción cancelada para customer:', sub.customer);
        }
      } catch(e) {
        console.log('Error procesando webhook:', e.message);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
    return;
  }

  // TEMPORARY admin endpoint: bulk-upload the curated recipe bank to Firestore.
  // Protected by a simple secret key check (not meant to stay long-term — remove once
  // the recipe bank is fully uploaded and confirmed working). Also used for the
  // separate salsas_casa collection via the optional "coleccion" parameter.
  if (req.method === 'POST' && req.url === '/admin-upload-recetas') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { secret, recetas, coleccion } = JSON.parse(body);
        if (secret !== process.env.ADMIN_UPLOAD_SECRET) {
          res.writeHead(403, CORS);
          res.end(JSON.stringify({ error: 'No autorizado' }));
          return;
        }
        if (!Array.isArray(recetas) || recetas.length === 0) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ error: 'recetas debe ser un array no vacío' }));
          return;
        }
        const coleccionDestino = coleccion === 'salsas_casa' ? 'salsas_casa' : 'banco_maestro_recetas';
        const db = admin.firestore();
        const batch = db.batch();
        recetas.forEach(receta => {
          const ref = db.collection(coleccionDestino).doc(receta.id);
          batch.set(ref, receta);
        });
        await batch.commit();
        console.log(`✓ Subido a ${coleccionDestino}: ${recetas.length} documentos`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, subidas: recetas.length, coleccion: coleccionDestino }));
      } catch(e) {
        console.log('Error subiendo:', e.message);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Verification endpoint: confirms how many recipes actually exist in Firestore,
  // broken down by objetivo/tipo, plus one sample recipe to sanity-check the data.
  if (req.method === 'GET' && req.url === '/admin-verificar-recetas') {
    (async () => {
      try {
        const db = admin.firestore();
        const snap = await db.collection('banco_maestro_recetas').get();
        const conteo = {};
        let ejemplo = null;
        snap.forEach(doc => {
          const d = doc.data();
          const key = `${d.objetivo} - ${d.tipo}`;
          conteo[key] = (conteo[key] || 0) + 1;
          if (!ejemplo) ejemplo = { id: doc.id, nombre: d.nombre, objetivo: d.objetivo, tipo: d.tipo };
        });
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ total: snap.size, conteo, ejemplo }, null, 2));
      } catch(e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  res.writeHead(404, CORS);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Komebien backend running on port ${PORT}`);
});
