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

// Gym pilot program: maps each pilot coupon (100% off, temporary) to the renewal coupon
// that should auto-apply once the free period ends (e.g. a permanent 30% discount for
// gym socios/dueños). Update this map by hand as new gym partnerships are set up —
// low volume for now, so a simple object is easier to reason about than a database table.
// IMPORTANT: coupon names here must match the "name" (or id) exactly as created in Stripe.
const PILOT_RENEWAL_COUPONS = {
  // 'NOMBRE_CUPON_PILOTO': 'NOMBRE_CUPON_RENOVACION',
  'METCON': 'METCON30', // Metcon House Cumbres — socios: 3 meses gratis → 30% fijo de por vida
};
// Case-insensitive lookup: Stripe's coupon "name" field can end up differently cased than
// what was typed as the coupon "id" (e.g. displayed as "Metcon" instead of "METCON"), and
// a strict PILOT_RENEWAL_COUPONS[cuponUsado] lookup silently fails on any case mismatch —
// this bit us on the very first real test. Normalize both sides to uppercase before comparing.
function buscarCuponRenovacion(cuponUsado) {
  if (!cuponUsado) return null;
  const clave = Object.keys(PILOT_RENEWAL_COUPONS).find(k => k.toUpperCase() === cuponUsado.toUpperCase());
  return clave ? PILOT_RENEWAL_COUPONS[clave] : null;
}
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

            // Gym pilot tracking: if this signup used one of the known gym pilot coupons
            // (100% off for N months), remember which renewal coupon to auto-apply once
            // that free period ends — see PILOT_RENEWAL_COUPONS below.
            const renewalCoupon = buscarCuponRenovacion(cuponUsado);

            await admin.firestore().collection('usuarios').doc(uid).set({
              suscripcion: {
                activa: true,
                stripeCustomerId: session.customer,
                stripeSubscriptionId: session.subscription,
                montoMensual,
                cuponUsado,
                renewalCoupon,
                fechaInicio: new Date().toISOString()
              }
            }, { merge: true });
            console.log('✓ Usuario marcado como Pro:', uid, '— $' + montoMensual + ' MXN' + (cuponUsado ? ' (cupón: ' + cuponUsado + ')' : '') + (renewalCoupon ? ' [renovación: ' + renewalCoupon + ']' : ''));
          }
        } else if (event.type === 'customer.subscription.updated') {
          // Detect when a subscription's discount just expired (transitioned from having
          // a discount to having none) — this is how we know a gym pilot's free period
          // (3 or 6 months at 100% off) just ended. Stripe's previous_attributes tells us
          // what changed since the last event, so we only act on the actual transition,
          // not on every subscription update.
          const sub = event.data.object;
          const previousAttrs = event.data.previous_attributes || {};
          const teniaDescuento = previousAttrs.hasOwnProperty('discount');
          const yaNoTieneDescuento = !sub.discount;
          if (teniaDescuento && yaNoTieneDescuento) {
            const snap = await admin.firestore().collection('usuarios')
              .where('suscripcion.stripeCustomerId', '==', sub.customer).limit(1).get();
            if (!snap.empty) {
              const userDoc = snap.docs[0];
              const suscripcionData = userDoc.data().suscripcion || {};
              const renewalCoupon = suscripcionData.renewalCoupon;
              const cuponUsado = suscripcionData.cuponUsado;

              if (renewalCoupon) {
                // Gym pilot flow: auto-apply the permanent discount coupon.
                try {
                  await stripe.subscriptions.update(sub.id, { coupon: renewalCoupon });
                  await userDoc.ref.set({ suscripcion: { renewalCouponApplied: true, renewalAppliedFecha: new Date().toISOString() } }, { merge: true });
                  console.log(`✓ Cupón de renovación "${renewalCoupon}" aplicado automáticamente a`, userDoc.id);
                } catch(renewErr) {
                  console.log('Error aplicando cupón de renovación:', renewErr.message);
                }
              } else if (cuponUsado && /50$/i.test(cuponUsado)) {
                // Referral program flow: coupons named like "JUAN50", "MARIA50" (any name
                // ending in "50") mark a referred signup. No second coupon is applied here
                // — referrer payouts are manual (a bank transfer Armando sends by hand once
                // a month), so we just flag that this referral is now "confirmed" (the
                // referred user made it past their discounted first month and started
                // paying full price), along with which referrer coupon it came from, so the
                // admin dashboard can group and total how much is owed to each referrer.
                const referrerName = cuponUsado.replace(/50$/i, '');
                await userDoc.ref.set({
                  suscripcion: {
                    referidoConfirmado: true,
                    referidoPor: referrerName,
                    referidoConfirmadoFecha: new Date().toISOString()
                  }
                }, { merge: true });
                console.log(`✓ Referido confirmado — cupón "${cuponUsado}" (referidor: ${referrerName}) —`, userDoc.id);
              }
            }
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

  // Referral program summary: groups confirmed referrals by referrer name, so Armando
  // can see at a glance who to pay and how much (manual bank transfer, $50 MXN per
  // confirmed referral as of this writing — adjust PAGO_POR_REFERIDO if that changes).
  if (req.method === 'GET' && req.url === '/admin-referidos') {
    (async () => {
      try {
        const PAGO_POR_REFERIDO = 50; // MXN — update here if the referral payout amount changes
        const db = admin.firestore();
        const snap = await db.collection('usuarios')
          .where('suscripcion.referidoConfirmado', '==', true).get();
        const porReferidor = {};
        snap.forEach(doc => {
          const s = doc.data().suscripcion || {};
          const ref = s.referidoPor || 'desconocido';
          if (!porReferidor[ref]) porReferidor[ref] = { referidos: 0, aPagar: 0 };
          porReferidor[ref].referidos += 1;
          porReferidor[ref].aPagar += PAGO_POR_REFERIDO;
        });
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ total: snap.size, pagoPorReferido: PAGO_POR_REFERIDO, porReferidor }, null, 2));
      } catch(e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // Gym commission summary: UNLIKE referrals (one-time payment), this is a RECURRING
  // monthly commission that only counts socios who are both (a) past their free pilot
  // period — i.e. their renewal coupon already kicked in, meaning they're actually
  // paying — and (b) still active today. A socio who cancels simply stops counting the
  // next time this is checked; there's no separate "confirmed once" flag like referrals,
  // since the amount owed changes month to month based on who's still around.
  // Keyed by the ORIGINAL pilot coupon name (e.g. "METCON"), matching PILOT_RENEWAL_COUPONS,
  // since that's what stays on the user's record even after the renewal coupon applies.
  const GYM_COMMISSIONS = {
    'METCON': { gimnasio: 'Metcon House', comisionPorSocio: 30 },
  };
  if (req.method === 'GET' && req.url === '/admin-comisiones-gym') {
    (async () => {
      try {
        const db = admin.firestore();
        const snap = await db.collection('usuarios')
          .where('suscripcion.renewalCouponApplied', '==', true)
          .where('suscripcion.activa', '==', true)
          .get();
        const porGym = {};
        snap.forEach(doc => {
          const s = doc.data().suscripcion || {};
          const claveGym = Object.keys(GYM_COMMISSIONS).find(k => s.cuponUsado && k.toUpperCase() === s.cuponUsado.toUpperCase());
          const config = claveGym ? GYM_COMMISSIONS[claveGym] : null;
          if (!config) return; // socio came from a pilot coupon not (yet) in the commission map
          if (!porGym[config.gimnasio]) porGym[config.gimnasio] = { sociosActivos: 0, aPagarEsteMes: 0 };
          porGym[config.gimnasio].sociosActivos += 1;
          porGym[config.gimnasio].aPagarEsteMes += config.comisionPorSocio;
        });
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ nota: 'Comisión recurrente — recalcular cada mes antes de transferir', porGym }, null, 2));
      } catch(e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // TEMPORARY manual test endpoint: simulates exactly what the customer.subscription.updated
  // webhook handler does when a discount expires, without needing to wait for a real Stripe
  // discount to actually run out (which would take 3 real months for the Metcon pilot).
  // This lets Armando verify OUR renewal/commission logic works correctly on a real test
  // subscription right now, trusting that Stripe's own webhook delivery (separate, well-
  // tested infrastructure) will fire the real event correctly when the time actually comes.
  // Remove this endpoint once the Metcon pilot is running smoothly and confidence is high.
  if (req.method === 'POST' && req.url === '/admin-test-vencimiento') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { secret, stripeSubscriptionId } = JSON.parse(body);
        if (secret !== process.env.ADMIN_UPLOAD_SECRET) {
          res.writeHead(403, CORS);
          res.end(JSON.stringify({ error: 'No autorizado' }));
          return;
        }
        if (!stripeSubscriptionId) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ error: 'Falta stripeSubscriptionId' }));
          return;
        }
        const db = admin.firestore();
        const snap = await db.collection('usuarios')
          .where('suscripcion.stripeSubscriptionId', '==', stripeSubscriptionId).limit(1).get();
        if (snap.empty) {
          res.writeHead(404, CORS);
          res.end(JSON.stringify({ error: 'No se encontró un usuario con ese stripeSubscriptionId' }));
          return;
        }
        const userDoc = snap.docs[0];
        const s = userDoc.data().suscripcion || {};
        const resultado = { uid: userDoc.id, cuponUsado: s.cuponUsado, accion: null };

        if (s.renewalCoupon) {
          await stripe.subscriptions.update(stripeSubscriptionId, { coupon: s.renewalCoupon });
          await userDoc.ref.set({ suscripcion: { renewalCouponApplied: true, renewalAppliedFecha: new Date().toISOString() } }, { merge: true });
          resultado.accion = `Cupón de renovación "${s.renewalCoupon}" aplicado (simulado)`;
        } else if (s.cuponUsado && /50$/i.test(s.cuponUsado)) {
          const referrerName = s.cuponUsado.replace(/50$/i, '');
          await userDoc.ref.set({ suscripcion: { referidoConfirmado: true, referidoPor: referrerName, referidoConfirmadoFecha: new Date().toISOString() } }, { merge: true });
          resultado.accion = `Referido confirmado (simulado) — referidor: ${referrerName}`;
        } else {
          resultado.accion = 'Este usuario no tiene renewalCoupon ni cupón de referido — nada que simular';
        }
        res.writeHead(200, CORS);
        res.end(JSON.stringify(resultado, null, 2));
      } catch(e) {
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
