// ============================================================
// STALL — STORE BOOKING CLOUD FUNCTIONS
// Add to your existing Firebase Functions project (stall-app-1aab7).
// Requires: npm install razorpay
// Set config: firebase functions:config:set razorpay.key_id="..." razorpay.key_secret="..." razorpay.webhook_secret="..."
// ============================================================

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const razorpay = new Razorpay({
  key_id: functions.config().razorpay.key_id,
  key_secret: functions.config().razorpay.key_secret,
});

const STORE_PRICE_PAISE = 99900; // ₹999

// ------------------------------------------------------------
// 1. Callable: createStoreOrder
// Called from the booking form before opening Razorpay Checkout.
// Creates a pending Razorpay order and a matching "pending" vendor doc
// keyed by slug, so the slug is reserved the moment checkout opens.
// ------------------------------------------------------------
exports.createStoreOrder = functions.https.onCall(async (data, context) => {
  const { ownerName, storeName, storePhone, slug } = data;

  if (!ownerName || !storeName || !storePhone || !slug) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required fields.");
  }
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid page name.");
  }

  const vendorRef = db.collection("vendors").doc(slug);

  // Reserve the slug atomically — fails if already taken or reserved
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(vendorRef);
    if (existing.exists) {
      throw new functions.https.HttpsError("already-exists", "This page name is taken.");
    }
    tx.set(vendorRef, {
      status: "pending_payment",
      ownerName,
      storeName,
      storePhone,
      slug,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  const order = await razorpay.orders.create({
    amount: STORE_PRICE_PAISE,
    currency: "INR",
    receipt: `store_${slug}_${Date.now()}`,
    notes: { slug, storeName, storePhone },
  });

  await vendorRef.update({ razorpayOrderId: order.id });

  return { orderId: order.id, amount: STORE_PRICE_PAISE };
});

// ------------------------------------------------------------
// 2. HTTP: razorpayWebhook
// Configure this URL in the Razorpay Dashboard → Webhooks, subscribed
// to the "payment.captured" event. This is the ONLY place that actually
// marks a store as live — never trust the client-side handler for that.
// ------------------------------------------------------------
exports.razorpayWebhook = functions.https.onRequest(async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const expected = crypto
    .createHmac("sha256", functions.config().razorpay.webhook_secret)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== expected) {
    console.error("Razorpay webhook: signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  const event = req.body.event;
  if (event !== "payment.captured") {
    return res.status(200).send("Ignored"); // ack other events without acting
  }

  const payment = req.body.payload.payment.entity;
  const orderId = payment.order_id;
  const slug = payment.notes && payment.notes.slug;

  if (!slug) {
    console.error("Razorpay webhook: no slug in payment notes", orderId);
    return res.status(200).send("No slug — ignored");
  }

  const vendorRef = db.collection("vendors").doc(slug);

  // Idempotency: if this payment was already processed, ack and stop —
  // Razorpay retries webhooks, so this must be safe to call more than once.
  const snap = await vendorRef.get();
  if (!snap.exists) {
    console.error("Razorpay webhook: no reserved vendor doc for slug", slug);
    return res.status(200).send("No matching vendor — ignored");
  }
  if (snap.data().status === "live" && snap.data().paymentId === payment.id) {
    return res.status(200).send("Already processed");
  }

  await vendorRef.update({
    status: "live",
    paymentId: payment.id,
    razorpayOrderId: orderId,
    amountPaid: payment.amount,
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
    websiteUrl: `https://stall.cutncutestudio.in/store/${slug}`,
  });

  // TODO: send WhatsApp confirmation with the live link (reuse your
  // existing WhatsApp/vendorLink helper in geo.js) to the vendor's phone.

  return res.status(200).send("Provisioned");
});
