const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =====================================================
   FIREBASE ADMIN
===================================================== */

let firebaseReady = false;

try {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n");

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    privateKey
  ) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey
      }),
      databaseURL:
        `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
    });

    firebaseReady = true;
    console.log("Firebase Admin ready");
  }
} catch (err) {
  console.error("Firebase initialization error:", err.message);
}

/* =====================================================
   FCM PUSH NOTIFICATIONS
===================================================== */

function tokenKey(token) {
  return Buffer.from(String(token)).toString("base64url");
}

async function getUserFcmTokens(uid) {
  if (!uid) return [];
  const snap = await database().ref(`users/${uid}/fcmTokens`).once("value");
  const obj = snap.val() || {};
  return Object.values(obj).map(v => typeof v === "string" ? v : v?.token).filter(Boolean);
}

async function sendPushToUsers(uids, title, body, data = {}) {
  if (!firebaseReady || !admin.messaging) return { sent: 0, failed: 0 };
  const uniqueUids = [...new Set((uids || []).filter(Boolean))];
  const pairs = [];
  for (const uid of uniqueUids) {
    const tokens = await getUserFcmTokens(uid);
    tokens.forEach(token => pairs.push({ uid, token }));
  }
  if (!pairs.length) return { sent: 0, failed: 0 };

  const cleanData = {};
  Object.entries(data || {}).forEach(([k, v]) => { cleanData[String(k)] = String(v ?? ""); });
  cleanData.title = String(title || "FFX");
  cleanData.body = String(body || "");

  const response = await admin.messaging().sendEachForMulticast({
    tokens: pairs.map(x => x.token),
    data: cleanData,
    webpush: {
      fcmOptions: { link: "https://ffx-tournament.netlify.app/" }
    }
  });

  const removals = [];
  response.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        removals.push(database().ref(`users/${pairs[i].uid}/fcmTokens/${tokenKey(pairs[i].token)}`).remove());
      }
    }
  });
  if (removals.length) await Promise.allSettled(removals);
  return { sent: response.successCount, failed: response.failureCount };
}

/* =====================================================
   AUTH
===================================================== */

async function requireAuth(req, res, next) {
  try {
    if (!firebaseReady) {
      return res.status(500).json({
        success: false,
        message: "Firebase Admin is not configured."
      });
    }

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication token is required."
      });
    }

    const token = authHeader.substring(7);

    req.firebaseUser = await admin.auth().verifyIdToken(token);

    next();

  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token."
    });
  }
}

/* =====================================================
   ADMIN AUTH
===================================================== */

async function requireAdmin(req, res, next) {

  return requireAuth(req, res, async () => {

    try {

      const uid = req.firebaseUser.uid;
      const database = admin.database();

      /* Main admin */
      const adminSnap =
        await database.ref(`admins/${uid}`).once("value");

      if (adminSnap.val() === true) {
        req.isAdmin = true;
        return next();
      }

      /* Staff */
      const staffSnap =
        await database.ref(`staff/${uid}`).once("value");

      const staff = staffSnap.val();

      if (staff && staff.status === "Active") {
        req.staff = staff;
        return next();
      }

      /* Optional Render environment variable */
      const allowedEmails =
        (process.env.ADMIN_EMAILS || "")
          .split(",")
          .map(x => x.trim().toLowerCase())
          .filter(Boolean);

      const email =
        String(req.firebaseUser.email || "").toLowerCase();

      if (allowedEmails.includes(email)) {
        return next();
      }

      return res.status(403).json({
        success: false,
        message: "Admin access denied."
      });

    } catch (err) {

      return res.status(403).json({
        success: false,
        message: "Admin verification failed."
      });

    }

  });
}

function database() {
  return admin.database();
}

/* =====================================================
   MONGODB
===================================================== */

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("MONGO_URI is missing.");
  process.exit(1);
}

mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000
  })
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB:", err.message));

/* =====================================================
   MODELS
===================================================== */

const paymentOrderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    unique: true,
    index: true
  },

  uid: {
    type: String,
    index: true
  },

  email: String,

  amount: Number,

  status: {
    type: String,
    default: "Pending"
  },

  credited: {
    type: Boolean,
    default: false
  },

  txnId: String,

  utr: String,

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: Date
});

const PaymentOrder =
  mongoose.model("PaymentOrder", paymentOrderSchema);


const couponSchema = new mongoose.Schema({

  code: {
    type: String,
    unique: true,
    index: true
  },

  amount: Number,

  maxUses: {
    type: Number,
    default: 1
  },

  usedCount: {
    type: Number,
    default: 0
  },

  expiryDate: Date,

  createdAt: {
    type: Date,
    default: Date.now
  }

});

const Coupon =
  mongoose.model("Coupon", couponSchema);


const notificationSchema = new mongoose.Schema({

  title: String,

  message: String,

  targetUser: {
    type: String,
    default: "ALL"
  },

  sentAt: {
    type: Date,
    default: Date.now
  }

});

const Notification =
  mongoose.model("Notification", notificationSchema);


const tutorialSchema = new mongoose.Schema({
  title: String,
  videoUrl: String,
  category: {
    type: String,
    default: "General"
  }
});

const Tutorial =
  mongoose.model("Tutorial", tutorialSchema);


const bannerSchema = new mongoose.Schema({
  title: String,
  imageUrl: String,
  targetUrl: String,
  isActive: {
    type: Boolean,
    default: true
  }
});

const Banner =
  mongoose.model("Banner", bannerSchema);


const configSchema = new mongoose.Schema({
  appMode: {
    type: String,
    enum: [
      "Live",
      "Maintenance",
      "Testing"
    ],
    default: "Live"
  }
});

const Config =
  mongoose.model("Config", configSchema);


/* =====================================================
   HEALTH
===================================================== */

app.get("/", (req, res) => {

  res.json({
    success: true,
    app: "FFX API",
    status: "online"
  });

});

app.get("/api/health", (req, res) => {

  res.json({
    success: true,
    status: "online"
  });

});


/* =====================================================
   ZAPUPI CREATE ORDER
===================================================== */

app.post(
  "/api/gateway/zapupi/create-order",
  requireAuth,
  async (req, res) => {

    const requestId =
      `PAY_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 7)
        .toUpperCase()}`;

    try {

      const amount =
        Number(req.body?.amount);

      if (
        !Number.isFinite(amount) ||
        amount < 10
      ) {

        return res.status(400).json({
          success: false,
          message: "Minimum deposit amount is ₹10."
        });

      }

      const zapKey =
        process.env.ZAPUPI_KEY;

      if (!zapKey) {

        return res.status(500).json({
          success: false,
          message: "ZapUPI is not configured."
        });

      }

      const orderId =
        `FFX_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)
          .toUpperCase()}`;

      await PaymentOrder.create({

        orderId,

        uid:
          req.firebaseUser.uid,

        email:
          req.body?.email ||
          req.firebaseUser.email ||
          "",

        amount,

        status: "Pending",

        updatedAt: new Date()

      });

      const payload = {

        zap_key: zapKey,

        order_id: orderId,

        amount,

        success_url:
          "https://ffx-tournament.netlify.app/?payment=success",

        failed_url:
          "https://ffx-tournament.netlify.app/?payment=failed",

        timeout_url:
          "https://ffx-tournament.netlify.app/?payment=timeout",

        webhook_url:
          "https://ffx-2.onrender.com/api/gateway/zapupi/webhook"

      };

      const gatewayResponse =
        await fetch(
          "https://pay.zapupi.com/api/create-order",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(payload),

            signal:
              AbortSignal.timeout(20000)

          }
        );

      const raw =
        await gatewayResponse.text();

      let data = {};

      try {
        data =
          raw ? JSON.parse(raw) : {};
      } catch {}

      console.log(
        `[${requestId}] ZapUPI HTTP=${gatewayResponse.status} status=${data.status || "unknown"} order=${orderId}`
      );

      if (
        !gatewayResponse.ok ||
        data.status !== "success" ||
        !data.payment_url
      ) {

        await PaymentOrder.updateOne(
          { orderId },
          {
            $set: {
              status: "CreateFailed",
              updatedAt: new Date()
            }
          }
        );

        return res.status(
          gatewayResponse.ok ? 400 : 502
        ).json({

          success: false,

          message:
            data.message ||
            "ZapUPI order creation failed.",

          requestId

        });

      }

      return res.json({

        success: true,

        paymentUrl:
          data.payment_url,

        orderId,

        requestId

      });

    } catch (err) {

      console.error(
        `[${requestId}] create-order`,
        err
      );

      return res.status(500).json({

        success: false,

        message:
          "Server error while creating payment order.",

        requestId

      });

    }

  }
);


/* =====================================================
   ZAPUPI WEBHOOK
===================================================== */

app.post(
  "/api/gateway/zapupi/webhook",
  async (req, res) => {

    try {

      const webhook =
        req.body || {};

      const orderId =
        webhook.order_id;

      if (!orderId) {

        return res.status(400).json({
          status: "error",
          message: "order_id is required"
        });

      }

      const payment =
        await PaymentOrder.findOne({
          orderId
        });

      if (!payment) {

        return res.status(404).json({
          status: "error",
          message: "Order not found"
        });

      }

      if (payment.credited) {

        return res.status(200).json({
          status: "ok",
          message: "Already credited"
        });

      }

      const webhookStatus =
        String(
          webhook.status || ""
        ).toLowerCase();

      if (
        ![
          "success",
          "successful"
        ].includes(webhookStatus)
      ) {

        await PaymentOrder.updateOne(
          { orderId },
          {
            $set: {
              status:
                webhook.status ||
                "Failed",

              txnId:
                webhook.txn_id,

              utr:
                webhook.utr,

              updatedAt:
                new Date()
            }
          }
        );

        return res.status(200).json({
          status: "ok"
        });

      }

      const zapKey =
        process.env.ZAPUPI_KEY;

      if (!zapKey) {

        return res.status(500).json({
          status: "error",
          message:
            "Gateway not configured"
        });

      }

      /* Server-side verification */

      const verifyResponse =
        await fetch(
          "https://pay.zapupi.com/api/order-status",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                zap_key: zapKey,
                order_id: orderId
              }),

            signal:
              AbortSignal.timeout(20000)

          }
        );

      const verifyData =
        await verifyResponse
          .json()
          .catch(() => ({}));

      const verifiedStatus =
        String(
          verifyData?.data?.status ||
          verifyData?.status ||
          ""
        ).toLowerCase();

      const verifiedAmount =
        Number(
          verifyData?.data?.amount ??
          verifyData?.amount ??
          webhook.amount
        );

      if (
        !verifyResponse.ok ||
        ![
          "success",
          "successful"
        ].includes(verifiedStatus)
      ) {

        await PaymentOrder.updateOne(
          { orderId },
          {
            $set: {
              status:
                verifyData?.data?.status ||
                webhook.status ||
                "Pending",

              updatedAt:
                new Date()
            }
          }
        );

        return res.status(200).json({
          status: "ok",
          message:
            "Payment not verified yet"
        });

      }

      if (
        !Number.isFinite(
          verifiedAmount
        ) ||
        Math.abs(
          verifiedAmount -
          payment.amount
        ) > 0.001
      ) {

        await PaymentOrder.updateOne(
          { orderId },
          {
            $set: {
              status:
                "AmountMismatch",

              updatedAt:
                new Date()
            }
          }
        );

        return res.status(400).json({
          status: "error",
          message:
            "Amount mismatch"
        });

      }

      /* Idempotency lock */

      const lock =
        await database()
          .ref(
            `paymentOrders/${orderId}/credited`
          )
          .transaction(
            value =>
              value === true
                ? undefined
                : true
          );

      if (!lock.committed) {

        return res.status(200).json({
          status: "ok",
          message:
            "Already processed"
        });

      }

      const walletRef =
        database()
          .ref(
            `users/${payment.uid}/wallet/balance`
          );

      const before =
        Number(
          (
            await walletRef
              .once("value")
          ).val() || 0
        );

      const after =
        before + payment.amount;

      await walletRef.set(after);

      await database()
        .ref(
          `users/${payment.uid}/walletTransactions`
        )
        .push()
        .set({

          type: "Deposit",

          amount:
            payment.amount,

          balanceBefore:
            before,

          balanceAfter:
            after,

          referenceId:
            orderId,

          txnId:
            verifyData?.data?.txn_id ||
            webhook.txn_id ||
            null,

          utr:
            verifyData?.data?.utr ||
            webhook.utr ||
            null,

          timestamp:
            admin.database
              .ServerValue
              .TIMESTAMP

        });

      await database()
        .ref(
          `paymentOrders/${orderId}`
        )
        .update({

          uid:
            payment.uid,

          amount:
            payment.amount,

          status:
            "Success",

          credited:
            true,

          txnId:
            verifyData?.data?.txn_id ||
            webhook.txn_id ||
            null,

          utr:
            verifyData?.data?.utr ||
            webhook.utr ||
            null,

          creditedAt:
            admin.database
              .ServerValue
              .TIMESTAMP

        });

      await PaymentOrder.updateOne(
        { orderId },
        {
          $set: {

            status:
              "Success",

            credited:
              true,

            txnId:
              verifyData?.data?.txn_id ||
              webhook.txn_id,

            utr:
              verifyData?.data?.utr ||
              webhook.utr,

            updatedAt:
              new Date()

          }
        }
      );

      console.log(
        `Payment credited ${orderId} -> ${payment.uid} -> ₹${payment.amount}`
      );

      return res.status(200).json({
        status: "ok",
        message:
          "Payment verified and credited"
      });

    } catch (err) {

      console.error(
        "Webhook:",
        err
      );

      return res.status(500).json({
        status: "error"
      });

    }

  }
);


/* =====================================================
   USER - REDEEM COUPON
===================================================== */

app.post(
  "/api/coupons/redeem",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.firebaseUser.uid;

      const code =
        String(
          req.body?.code || ""
        )
        .trim()
        .toUpperCase();

      if (!code) {

        return res.status(400).json({
          success: false,
          message:
            "Enter a coupon code."
        });

      }

      const coupon =
        await Coupon.findOne({
          code
        });

      if (!coupon) {

        return res.status(404).json({
          success: false,
          message:
            "Invalid coupon code."
        });

      }

      if (
        coupon.expiryDate &&
        new Date(coupon.expiryDate) <
        new Date()
      ) {

        return res.status(400).json({
          success: false,
          message:
            "This coupon has expired."
        });

      }

      if (
        coupon.usedCount >=
        coupon.maxUses
      ) {

        return res.status(400).json({
          success: false,
          message:
            "This coupon has reached its usage limit."
        });

      }

      const redemptionRef =
        database().ref(
          `users/${uid}/redeemedCoupons/${code}`
        );

      const already =
        await redemptionRef.once(
          "value"
        );

      if (already.exists()) {

        return res.status(400).json({
          success: false,
          message:
            "You have already redeemed this code."
        });

      }

      const claim =
        await redemptionRef.transaction(
          value =>
            value
              ? undefined
              : {
                  amount:
                    coupon.amount,

                  timestamp:
                    admin.database
                      .ServerValue
                      .TIMESTAMP
                }
        );

      if (!claim.committed) {

        return res.status(400).json({
          success: false,
          message:
            "You have already redeemed this code."
        });

      }

      const walletRef =
        database().ref(
          `users/${uid}/wallet/balance`
        );

      const before =
        Number(
          (
            await walletRef
              .once("value")
          ).val() || 0
        );

      const reward =
        Number(
          coupon.amount || 0
        );

      const after =
        before + reward;

      try {

        await walletRef.set(after);

        await database()
          .ref(
            `users/${uid}/walletTransactions`
          )
          .push()
          .set({

            type:
              "Redeem Code",

            amount:
              reward,

            balanceBefore:
              before,

            balanceAfter:
              after,

            referenceId:
              code,

            timestamp:
              admin.database
                .ServerValue
                .TIMESTAMP

          });

        await Coupon.updateOne(
          {
            code,
            usedCount: {
              $lt:
                coupon.maxUses
            }
          },
          {
            $inc: {
              usedCount: 1
            }
          }
        );

        return res.json({

          success: true,

          amount:
            reward,

          message:
            "Coupon redeemed successfully."

        });

      } catch (err) {

        await redemptionRef.remove();

        throw err;

      }

    } catch (err) {

      console.error(
        "Redeem:",
        err
      );

      return res.status(500).json({

        success: false,
message:
          "Could not redeem coupon right now."

      });

    }

  }
);


/* =====================================================
   USER - JOIN TOURNAMENT
===================================================== */

app.post(
  "/api/tournaments/join",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.firebaseUser.uid;

      const tournamentId =
        String(
          req.body?.tournamentId || ""
        );

      if (!tournamentId) {

        return res.status(400).json({
          success: false,
          message:
            "Tournament ID is required."
        });

      }

      const tournamentRef =
        database()
          .ref(
            `tournaments/${tournamentId}`
          );

      const snap =
        await tournamentRef
          .once("value");

      const tournament =
        snap.val();

      if (!tournament) {

        return res.status(404).json({
          success: false,
          message:
            "Tournament not found."
        });

      }

      if (
        tournament.status &&
        ![
          "Registration Open",
          "Open"
        ].includes(
          tournament.status
        )
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Registration is closed."
        });

      }

      const existing =
        await tournamentRef
          .child(
            `participants/${uid}`
          )
          .once("value");

      if (existing.exists()) {

        return res.status(400).json({
          success: false,
          message:
            "You already joined this tournament."
        });

      }

      const fee =
        Number(
          tournament.entryFee || 0
        );

      const walletRef =
        database().ref(
          `users/${uid}/wallet/balance`
        );

      const transaction =
        await walletRef.transaction(
          balance => {

            const current = Number(balance == null ? 0 : balance);

            if (current < fee) {
              return undefined;
            }

            return current - fee;

          }
        );

      if (!transaction.committed) {

        return res.status(400).json({
          success: false,
          message:
            `Insufficient wallet balance. Available: ₹${Number((await walletRef.once("value")).val() || 0).toFixed(2)}`
        });

      }

      const userSnap =
        await database()
          .ref(`users/${uid}`)
          .once("value");

      const user =
        userSnap.val() || {};

      const profile =
        user.profile || {};

      const participant = {

        uid,

        ign:
          profile.ign || "",

        ffUid:
          profile.freefireUid || "",

        fullName:
          profile.fullName || "",

        joinedAt:
          admin.database
            .ServerValue
            .TIMESTAMP

      };

      const newSlot =
        Number(
          tournament.occupiedSlots || 0
        ) + 1;

      await tournamentRef
        .child(
          `participants/${uid}`
        )
        .set(participant);

      await tournamentRef.update({

        occupiedSlots:
          newSlot

      });

      await database()
        .ref(
          `users/${uid}/joinedMatches/${tournamentId}`
        )
        .set({

          name:
            tournament.name ||
            "Tournament",

          date:
            tournament.date ||
            "",

          slot:
            newSlot,

          tournamentId

        });

      if (fee > 0) {

        await database()
          .ref(
            `users/${uid}/walletTransactions`
          )
          .push()
          .set({

            type:
              "Tournament Entry",

            amount:
              fee,

            balanceAfter:
              transaction.snapshot.val(),

            referenceId:
              tournamentId,

            timestamp:
              admin.database
                .ServerValue
                .TIMESTAMP

          });

      }

      return res.json({

        success: true,

        message:
          "Tournament joined successfully."

      });

    } catch (err) {

      console.error(
        "Join:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not join tournament."

      });

    }

  }
);


/* =====================================================
   USER - WITHDRAWAL
===================================================== */

app.post(
  "/api/withdrawals",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.firebaseUser.uid;

      const amount =
        Number(
          req.body?.amount
        );

      const details =
        String(
          req.body?.details || ""
        ).trim();

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !details
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Enter a valid amount and UPI ID."

        });

      }

      const walletRef =
        database().ref(
          `users/${uid}/wallet/balance`
        );

      const transaction =
        await walletRef.transaction(
          balance => {

            const current = Number(balance == null ? 0 : balance);

            if (current < amount) {
              return undefined;
            }

            return current - amount;

          }
        );

      if (!transaction.committed) {

        return res.status(400).json({

          success: false,

          message:
            `Insufficient wallet balance. Available: ₹${Number((await walletRef.once("value")).val() || 0).toFixed(2)}`

        });

      }

      const userSnap =
        await database()
          .ref(`users/${uid}`)
          .once("value");

      const user =
        userSnap.val() || {};

      const profile =
        user.profile || {};

      const withdrawalRef =
        database()
          .ref("withdrawals")
          .push();

      await withdrawalRef.set({

        uid,

        userName:
          profile.fullName ||
          "User",

        phone:
          profile.phone ||
          "",

        amount,

        details,

        status:
          "Pending",

        createdAt:
          admin.database
            .ServerValue
            .TIMESTAMP

      });

      await database()
        .ref(
          `users/${uid}/walletTransactions`
        )
        .push()
        .set({

          type:
            "Withdrawal Hold",

          amount,

          balanceAfter:
            transaction.snapshot.val(),

          referenceId:
            withdrawalRef.key,

          timestamp:
            admin.database
              .ServerValue
              .TIMESTAMP

        });

      return res.json({

        success: true,

        message:
          "Withdrawal request submitted."

      });

    } catch (err) {

      console.error(
        "Withdrawal:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          "Withdrawal service error."

      });

    }

  }
);

/* =====================================================
   FCM TOKEN REGISTRATION
===================================================== */

app.post("/api/fcm/token", requireAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ success: false, message: "FCM token is required." });
    await database().ref(`users/${req.firebaseUser.uid}/fcmTokens/${tokenKey(token)}`).set({
      token,
      platform: "web",
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    res.json({ success: true, message: "Push notification device registered." });
  } catch (err) {
    console.error("FCM token:", err);
    res.status(500).json({ success: false, message: "Could not register push device." });
  }
});

/* =====================================================
   ADMIN - NOTIFICATIONS
===================================================== */

app.post(
  "/api/admin/notifications",
  requireAdmin,
  async (req, res) => {

    try {

      const title =
        String(
          req.body?.title || ""
        ).trim();

      const message =
        String(
          req.body?.message || ""
        ).trim();

      const targetUser =
        String(
          req.body?.targetUser ||
          "ALL"
        ).trim();

      if (!title || !message) {

        return res.status(400).json({

          success: false,

          message:
            "Title and message are required."

        });

      }

      const notification =
        await Notification.create({

          title,

          message,

          targetUser

        });

      const users =
        (
          await database()
            .ref("users")
            .once("value")
        ).val() || {};

      const updates = {};

      if (targetUser === "ALL") {

        Object.keys(users)
          .forEach(uid => {

            updates[
              `notifications/${uid}/${notification._id}`
            ] = {

              title,

              message,

              read: false,

              sentAt:
                admin.database
                  .ServerValue
                  .TIMESTAMP

            };

          });

      } else {

        updates[
          `notifications/${targetUser}/${notification._id}`
        ] = {

          title,

          message,

          read: false,

          sentAt:
            admin.database
              .ServerValue
              .TIMESTAMP

        };

      }

      if (Object.keys(updates).length) {
        await database().ref().update(updates);
      }

      const targetUids = targetUser === "ALL" ? Object.keys(users) : [targetUser];
      const push = await sendPushToUsers(targetUids, title, message, { type: "admin_notification" });

      return res.json({
        success: true,
        message: `Notification sent${push.sent ? ` and pushed to ${push.sent} device(s)` : ". No registered mobile/browser push device found"}.`
      });

    } catch (err) {

      console.error(
        "Notification:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not send notification."

      });

    }

  }
);


/* =====================================================
   ADMIN - COUPONS
===================================================== */

app.post(
  "/api/admin/coupons",
  requireAdmin,
  async (req, res) => {

    try {

      const code =
        (
          String(
            req.body?.code || ""
          )
          .trim()
          .toUpperCase()
        ) ||
        (
          "FFX" +
          Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase()
        );

      const amount =
        Number(
          req.body?.amount
        );

      const maxUses =
        Math.max(
          1,
          Number(
            req.body?.maxUses || 1
          )
        );

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid reward amount."

        });

      }

      const coupon =
        await Coupon.create({

          code,

          amount,

          maxUses,

          expiryDate:
            req.body?.expiryDate
              ? new Date(
                  req.body.expiryDate
                )
              : undefined

        });

      return res.json({

        success: true,

        coupon

      });

    } catch (err) {

      return res.status(400).json({

        success: false,

        message:
          err.code === 11000
            ? "Coupon code already exists."
            : err.message

      });

    }

  }
);

app.get(
  "/api/admin/coupons",
  requireAdmin,
  async (req, res) => {

    const coupons =
      await Coupon.find()
        .sort({
          createdAt: -1
        })
        .lean();

    res.json({
      success: true,
      coupons
    });

  }
);

app.delete(
  "/api/admin/coupons/:id",
  requireAdmin,
  async (req, res) => {

    await Coupon.findByIdAndDelete(
      req.params.id
    );

    res.json({

      success: true,

      message:
        "Coupon deleted."

    });

  }
);


/* =====================================================
   ADMIN - USERS
===================================================== */

app.post(
  "/api/admin/users/:uid/block",
  requireAdmin,
  async (req, res) => {

    const blocked =
      !!req.body?.blocked;

    await database()
      .ref(
        `users/${req.params.uid}/profile/isBlocked`
      )
      .set(blocked);

    res.json({

      success: true,

      message:
        blocked
          ? "User blocked."
          : "User unblocked."

    });

  }
);


app.post(
  "/api/admin/users/:uid/wallet",
  requireAdmin,
  async (req, res) => {

    try {

      const uid =
        req.params.uid;

      const amount =
        Number(
          req.body?.amount
        );

      const reason =
        String(
          req.body?.reason ||
          "Admin adjustment"
        );

      if (
        !Number.isFinite(amount) ||
        amount === 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Amount cannot be zero."

        });

      }

      const walletRef =
        database()
          .ref(
            `users/${uid}/wallet/balance`
          );

      const transaction =
        await walletRef.transaction(
          balance =>
            Number(balance || 0) +
            amount
        );

      if (
        !transaction.committed ||
        Number(
          transaction.snapshot.val()
        ) < 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Wallet adjustment failed."

        });

      }

      await database()
        .ref(
          `users/${uid}/walletTransactions`
        )
        .push()
        .set({

          type:
            "Admin Adjustment",

          amount:
            Math.abs(amount),

          direction:
            amount > 0
              ? "Credit"
              : "Debit",

          reason,

          balanceAfter:
            transaction.snapshot.val(),

          timestamp:
            admin.database
              .ServerValue
              .TIMESTAMP

        });

      res.json({

        success: true,

        balance:
          transaction.snapshot.val()

      });

    } catch (err) {

      res.status(500).json({

        success: false,

        message:
          err.message

      });

    }

  }
);


/*
=====================================================
   ADMIN - WITHDRAWALS
===================================================== */

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {

    const withdrawals =
      (
        await database()
          .ref("withdrawals")
          .once("value")
      ).val() || {};

    res.json({

      success: true,

      withdrawals

    });

  }
);


app.post(
  "/api/admin/withdrawals/:id/process",
  requireAdmin,
  async (req, res) => {

    try {

      const status =
        req.body?.status;

      const id =
        req.params.id;

      if (
        ![
          "Approved",
          "Rejected"
        ].includes(status)
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid withdrawal status."

        });

      }

      const withdrawalRef =
        database()
          .ref(
            `withdrawals/${id}`
          );

      const snap =
        await withdrawalRef
          .once("value");

      const withdrawal =
        snap.val();

      if (!withdrawal) {

        return res.status(404).json({

          success: false,

          message:
            "Withdrawal not found."

        });

      }

      if (
        withdrawal.status !==
        "Pending"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Withdrawal already processed."

        });

      }

      /* Refund only on rejection */

      if (
        status === "Rejected"
      ) {

        const walletRef =
          database()
            .ref(
              `users/${withdrawal.uid}/wallet/balance`
            );

        const transaction =
          await walletRef.transaction(
            balance =>
              Number(balance || 0) +
              Number(
                withdrawal.amount || 0
              )
          );

        await database()
          .ref(
            `users/${withdrawal.uid}/walletTransactions`
          )
          .push()
          .set({

            type:
              "Withdrawal Refund",

            amount:
              Number(
                withdrawal.amount || 0
              ),

            balanceAfter:
              transaction.snapshot.val(),

            referenceId:
              id,

            timestamp:
              admin.database
                .ServerValue
                .TIMESTAMP

          });

      }

      await withdrawalRef.update({

        status,

        processedAt:
          admin.database
            .ServerValue
            .TIMESTAMP,

        processedBy:
          req.firebaseUser.uid

      });

      res.json({

        success: true,

        message:
          `Withdrawal ${status}.`

      });

    } catch (err) {

      res.status(500).json({

        success: false,

        message:
          err.message

      });

    }

  }
);


/* =====================================================
   ADMIN - DEPOSITS
===================================================== */

app.get(
  "/api/admin/deposits",
  requireAdmin,
  async (req, res) => {

    const deposits =
      await PaymentOrder.find()
        .sort({
          createdAt: -1
        })
        .limit(200)
        .lean();

    res.json({

      success: true,

      deposits

    });

  }
);


/* =====================================================
   ADMIN - CANCEL MATCH + AUTOMATIC REFUNDS
===================================================== */

app.post("/api/admin/cancel-match", requireAdmin, async (req, res) => {
  try {
    const tournamentId = String(req.body?.tournamentId || "").trim();
    const reason = String(req.body?.reason || "").trim();
    const customReason = String(req.body?.customReason || "").trim();
    if (!tournamentId || !reason) return res.status(400).json({ success:false, message:"Tournament and cancellation reason are required." });

    const allowedReasons = [
      "Low number of players",
      "Technical issue",
      "Room unavailable",
      "Schedule / server issue",
      "Prize or match configuration issue",
      "Admin decision",
      "Other"
    ];
    if (!allowedReasons.includes(reason)) return res.status(400).json({ success:false, message:"Invalid cancellation reason." });
    const finalReason = reason === "Other" && customReason ? customReason : reason;

    const tournamentRef = database().ref(`tournaments/${tournamentId}`);
    const snap = await tournamentRef.once("value");
    const tournament = snap.val();
    if (!tournament) return res.status(404).json({ success:false, message:"Tournament not found." });
    if (["Completed","Finished"].includes(String(tournament.status || ""))) {
      return res.status(400).json({ success:false, message:`Match is already ${String(tournament.status).toLowerCase()}.` });
    }
    if (String(tournament.status || "") === "Cancelled" && Number(tournament.refundFailedPlayers || 0) <= 0) {
      return res.status(400).json({ success:false, message:"Match is already cancelled and refunded." });
    }

    const participants = tournament.participants || {};
    const fee = Math.max(0, Number(tournament.entryFee || 0));
    const refundResults = [];

    for (const uid of Object.keys(participants)) {
      const claimRef = database().ref(`tournaments/${tournamentId}/refunds/${uid}`);
      const claim = await claimRef.transaction(current => {
        if (current && current.status === "Completed") return;
        if (current && current.status === "Processing") return;
        return { status:"Processing", amount:fee, startedAt:admin.database.ServerValue.TIMESTAMP };
      });
      if (!claim.committed) continue;

      try {
        const walletRef = database().ref(`users/${uid}/wallet/balance`);
        const walletTx = await walletRef.transaction(balance => Number(balance || 0) + fee);
        const balanceAfter = Number(walletTx.snapshot.val() || 0);
        await database().ref(`users/${uid}/walletTransactions`).push().set({
          type:"Tournament Refund", amount:fee, balanceBefore:balanceAfter-fee, balanceAfter,
          referenceId:tournamentId, reason:finalReason, timestamp:admin.database.ServerValue.TIMESTAMP
        });
        await database().ref(`users/${uid}/joinedMatches/${tournamentId}`).remove();
        await claimRef.update({ status:"Completed", amount:fee, completedAt:admin.database.ServerValue.TIMESTAMP });
        refundResults.push({uid, amount:fee, success:true});
      } catch (refundErr) {
        await claimRef.update({ status:"Failed", error:String(refundErr.message || refundErr) });
        refundResults.push({uid, amount:fee, success:false});
      }
    }

    const failed = refundResults.filter(x => !x.success);
    const refunded = refundResults.filter(x => x.success);
    await tournamentRef.update({
      status: failed.length ? "Cancellation Pending Refunds" : "Cancelled", cancellationReason:finalReason, cancelledBy:req.firebaseUser.uid,
      cancelledAt:admin.database.ServerValue.TIMESTAMP, refundAmountPerPlayer:fee,
      refundedPlayers:refunded.length, refundFailedPlayers:failed.length
    });

    const affectedUids = Object.keys(participants);
    const pushMessage = fee > 0
      ? `Your match "${tournament.name || "Tournament"}" was cancelled. Refund: ${fee} coins. Reason: ${finalReason}.`
      : `Your match "${tournament.name || "Tournament"}" was cancelled. Reason: ${finalReason}.`;
    const push = await sendPushToUsers(affectedUids, "Match Cancelled", pushMessage, {
      type:"match_cancelled", tournamentId, reason:finalReason, refund:String(fee)
    });

    res.json({
      success:true,
      message: failed.length ? `Match cancelled. ${refunded.length} refund(s) completed; ${failed.length} refund(s) need retry.` : `Match cancelled and ${refunded.length} refund(s) completed.`,
      reason:finalReason, refunded:refunded.length, failed:failed.length, pushSent:push.sent
    });
  } catch (err) {
    console.error("Cancel match:", err);
    res.status(500).json({ success:false, message:"Could not cancel match and process refunds." });
  }
});

/* =====================================================
   ADMIN - MATCH SETTLEMENT
===================================================== */

app.post(
  "/api/admin/settle-match",
  requireAdmin,
  async (req, res) => {

    try {

      const {
        tournamentId,
        players
      } = req.body || {};

      const tournamentRef =
        database()
          .ref(
            `tournaments/${tournamentId}`
          );

      const snap =
        await tournamentRef
          .once("value");

      const tournament =
        snap.val();

      if (!tournament) {

        return res.status(404).json({

          success: false,

          message:
            "Tournament not found."

        });

      }

      if (
        tournament.settlementStatus ===
        "Completed"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Match is already settled."

        });

      }

      const resultList =
        Array.isArray(players)
          ? players
          : [];

      const results = {};

      for (
        const player of resultList
      ) {

        const uid =
          String(
            player.uid || ""
          );

        if (!uid) continue;

        let reward = 0;

        /* Per Kill */

        if (
          tournament.rewardMode ===
          "Per Kill"
        ) {

          reward =
            Math.max(
              0,
              Number(
                player.kills || 0
              )
            ) *
            Number(
              tournament.rewardPerKill ||
              0
            );

        }

        /* Prize Pool */

        else if (
          tournament.payoutMode ===
          "Position"
        ) {

          const prizes =
            tournament
              .prizesByPosition || {};

          reward =
            Number(
              prizes[
                String(
                  player.position
                )
              ] || 0
            );

        }

        /* Win / Lose / Booyah */

        else {

          const outcome =
            String(
              player.outcome || ""
            ).toLowerCase();

          if (
            outcome ===
            "booyah"
          ) {

            reward =
              Number(
                tournament.booyahPrize ||
                tournament.winPrize ||
                0
              );

          } else if (
            outcome === "win" ||
            outcome === "won"
          ) {

            reward =
              Number(
                tournament.winPrize ||
                0
              );

          } else if (
            outcome === "lose" ||
            outcome === "lost"
          ) {

            reward =
              Number(
                tournament.losePrize ||
                0
              );

          }

        }

        const walletRef =
          database()
            .ref(
              `users/${uid}/wallet/balance`
            );

        const transaction =
          await walletRef.transaction(
            balance =>
              Number(balance || 0) +
              reward
          );

        const balanceAfter =
          Number(
            transaction.snapshot.val()
          );

        if (reward > 0) {

          await database()
            .ref(
              `users/${uid}/walletTransactions`
            )
            .push()
            .set({

              type:
                tournament.rewardMode ===
                "Per Kill"
                  ? "Per Kill Reward"
                  : "Match Reward",

              amount:
                reward,

              balanceAfter,

              referenceId:
                tournamentId,

              timestamp:
                admin.database
                  .ServerValue
                  .TIMESTAMP

            });

        }

        results[uid] = {

          kills:
            Number(
              player.kills || 0
            ),

          position:
            Number(
              player.position || 0
            ),

          outcome:
            player.outcome || "",

          rewardAmount:
            reward,

          settlementStatus:
            "Completed"

        };

        await database()
          .ref(
            `users/${uid}/wallet/totalKills`
          )
          .transaction(
            value =>
              Number(value || 0) +
              Number(
                player.kills || 0
              )
          );

        await database()
          .ref(
            `users/${uid}/wallet/totalEarnings`
          )
          .transaction(
            value =>
              Number(value || 0) +
              reward
          );

      }

      await tournamentRef.update({

        results,

        settlementStatus:
          "Completed",

        status:
          "Completed",

        settledAt:
          admin.database
            .ServerValue
            .TIMESTAMP

      });

      res.json({

        success: true,

        message:
          "Match settled successfully.",

        results

      });

    } catch (err) {

      console.error(
        "Settlement:",
        err
      );

      res.status(500).json({

        success: false,

        message:
          "Settlement failed."

      });

    }

  }
);

/* =====================================================
   BANNERS
===================================================== */

app.get(
  "/api/banners",
  async (req, res) => {

    res.json(
      await Banner.find().lean()
    );

  }
);

app.post(
  "/api/admin/banners",
  requireAdmin,
  async (req, res) => {

    res.json({

      success: true,

      banner:
        await Banner.create(
          req.body
        )

    });

  }
);

app.delete(
  "/api/admin/banners/:id",
  requireAdmin,
  async (req, res) => {

    await Banner.findByIdAndDelete(
      req.params.id
    );

    res.json({
      success: true
    });

  }
);


/* =====================================================
   TUTORIALS
===================================================== */

app.get(
  "/api/tutorials",
  async (req, res) => {

    res.json(
      await Tutorial.find().lean()
    );

  }
);

app.post(
  "/api/admin/tutorials",
  requireAdmin,
  async (req, res) => {

    res.json({

      success: true,

      tutorial:
        await Tutorial.create(
          req.body
        )

    });

  }
);

app.delete(
  "/api/admin/tutorials/:id",
  requireAdmin,
  async (req, res) => {

    await Tutorial.findByIdAndDelete(
      req.params.id
    );

    res.json({
      success: true
    });

  }
);


/* =====================================================
   SYSTEM MODE
===================================================== */

app.get(
  "/api/config/mode",
  async (req, res) => {

    let config =
      await Config.findOne();

    if (!config) {

      config =
        await Config.create({
          appMode: "Live"
        });

    }

    res.json(config);

  }
);


app.post(
  "/api/admin/config/mode",
  requireAdmin,
  async (req, res) => {

    const config =
      await Config.findOneAndUpdate(
        {},

        {
          $set: {
            appMode:
              req.body.appMode
          }
        },

        {
          upsert: true,
          new: true
        }
      );

    res.json({

      success: true,

      config

    });

  }
);


/* =====================================================
   COMPATIBILITY
===================================================== */

app.get(
  "/api/notifications",
  requireAuth,
  async (req, res) => {

    const notifications =
      await Notification.find({

        $or: [

          {
            targetUser:
              "ALL"
          },

          {
            targetUser:
              req.firebaseUser.uid
          }

        ]

      })
      .sort({
        sentAt: -1
      })
      .limit(50)
      .lean();

    res.json({

      success: true,

      notifications

    });

  }
);

app.get(
  "/api/coupons",
  requireAdmin,
  async (req, res) => {

    res.json(
      await Coupon.find()
        .sort({
          createdAt: -1
        })
        .lean()
    );

  }
);


/* =====================================================
   START
===================================================== */

const PORT =
  process.env.PORT || 5000;

app.listen(
  PORT,
  () =>
    console.log(
      `FFX API running on ${PORT}`
    )
);
 