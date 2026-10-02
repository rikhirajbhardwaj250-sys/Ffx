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

function requirePermission(permission) {
  return (req, res, next) => {
    if (req.isAdmin) return next();
    const permissions = req.staff?.permissions || {};
    if (permissions[permission] === true) return next();
    return res.status(403).json({ success:false, message:`Permission denied: ${permission}` });
  };
}

function walletAvailable(wallet) {
  const w = wallet || {};
  const parts = ['deposited','winning','bonus'].map(k => Number(w[k] || 0));
  if (parts.some(v => v > 0)) return parts.reduce((a,b)=>a+b,0);
  const balance = Number(w.balance);
  return Number.isFinite(balance) ? balance : 0;
}

function deductWallet(wallet, amount) {
  const w = wallet || {};
  const hasBuckets = ['deposited','winning','bonus'].some(k => Number(w[k] || 0) > 0);
  if (!hasBuckets) { w.balance = Number(w.balance || 0) - amount; return w; }
  let left = amount;
  for (const key of ['deposited','winning','bonus']) {
    const v = Math.max(0, Number(w[key] || 0));
    const take = Math.min(v, left); w[key] = v - take; left -= take;
  }
  w.balance = ['deposited','winning','bonus'].reduce((a,k)=>a+Number(w[k]||0),0);
  return w;
}


function rolePermissions(role) {
  const all = {
    'Matches': true,
    'Match Results': true,
    'Users': true,
    'Withdrawals': true,
    'Deposits': true,
    'Notifications': true,
    'Coupons': true,
    'Content': true,
    'Support': true,
    'Staff Management': true,
    'Payment Settings': true
  };
  const roles = {
    Manager: {...all, 'Staff Management': false, 'Payment Settings': false},
    Tournament: {'Matches':true,'Match Results':true,'Users':false,'Withdrawals':false,'Deposits':false,'Notifications':true,'Coupons':false,'Content':true,'Support':false,'Staff Management':false,'Payment Settings':false},
    Finance: {'Matches':false,'Match Results':false,'Users':true,'Withdrawals':true,'Deposits':true,'Notifications':true,'Coupons':true,'Content':false,'Support':false,'Staff Management':false,'Payment Settings':true},
    Support: {'Matches':false,'Match Results':false,'Users':true,'Withdrawals':false,'Deposits':false,'Notifications':true,'Coupons':false,'Content':false,'Support':true,'Staff Management':false,'Payment Settings':false},
    Content: {'Matches':false,'Match Results':false,'Users':false,'Withdrawals':false,'Deposits':false,'Notifications':true,'Coupons':false,'Content':true,'Support':false,'Staff Management':false,'Payment Settings':false}
  };
  return roles[role] || all;
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
  coverUrl: String,
  isCover: { type: Boolean, default: false },
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

      const tournamentId = String(req.body?.tournamentId || "");
      const selectedSlot = Number(req.body?.slot || 0);
      const selectedPosition = String(req.body?.position || "Solo").trim();
      const playerDetails = req.body?.playerDetails || {};

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
        return res.status(400).json({success:false,message:"You already joined this tournament."});
      }

      const maxPlayers = Math.max(1, Number(tournament.maxPlayers || 48));
      if (!Number.isInteger(selectedSlot) || selectedSlot < 1 || selectedSlot > maxPlayers) {
        return res.status(400).json({success:false,message:`Choose a valid slot from 1 to ${maxPlayers}.`});
      }
      const participants = tournament.participants || {};
      const slotTaken = Object.values(participants).some(p => Number(p?.slot) === selectedSlot);
      if (slotTaken) return res.status(409).json({success:false,message:"That slot has already been taken. Please choose another slot."});

      const fee =
        Number(
          tournament.entryFee || 0
        );

      const walletRef = database().ref(`users/${uid}/wallet`);
      const transaction = await walletRef.transaction(wallet => {
        wallet = wallet || {};
        const current = walletAvailable(wallet);
        if (current < fee) return undefined;
        return deductWallet(wallet, fee);
      });

      if (!transaction.committed) {

        return res.status(400).json({
          success: false,
          message:
            "Insufficient wallet balance."
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
        ign: String(playerDetails.ign || profile.ign || ""),
        ffUid: String(playerDetails.ffUid || profile.freefireUid || ""),
        fullName: String(playerDetails.fullName || profile.fullName || ""),
        slot: selectedSlot,
        team: Math.ceil(selectedSlot / 4),
        position: selectedPosition,
        playerNumber: selectedSlot,
        joinedAt: admin.database.ServerValue.TIMESTAMP
      };

      const newSlot = Object.keys(participants).length + 1;

      await tournamentRef
        .child(
          `participants/${uid}`
        )
        .set(participant);

      await tournamentRef.update({

        occupiedSlots: Math.min(maxPlayers, newSlot)

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

          slot: selectedSlot,
          team: Math.ceil(selectedSlot / 4),
          position: selectedPosition,
          playerNumber: selectedSlot,
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
              Number(transaction.snapshot.val()?.balance || 0),

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

      const walletRef = database().ref(`users/${uid}/wallet`);
      const transaction = await walletRef.transaction(wallet => {
        wallet = wallet || {};
        const current = walletAvailable(wallet);
        if (current < amount) return undefined;
        return deductWallet(wallet, amount);
      });

      if (!transaction.committed) {

        return res.status(400).json({

          success: false,

          message:
            "Insufficient wallet balance."

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
            Number(transaction.snapshot.val()?.balance || 0),

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
   ADMIN - NOTIFICATIONS
===================================================== */

app.post(
  "/api/admin/notifications",
  requireAdmin,
  requirePermission("Notifications"),
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

      // Also send a real device notification when the user has enabled browser push.
      try {
        const tokenRoot = targetUser === 'ALL' ? await database().ref('fcmTokens').once('value') : await database().ref(`fcmTokens/${targetUser}`).once('value');
        const rawTokens = tokenRoot.val() || {};
        const tokens = targetUser === 'ALL'
          ? Object.values(rawTokens).flatMap(x=>Object.values(x||{}).map(v=>v?.token).filter(Boolean))
          : Object.values(rawTokens).map(v=>v?.token).filter(Boolean);
        for(let i=0;i<tokens.length;i+=500){
          if(tokens.slice(i,i+500).length && admin.messaging) await admin.messaging().sendEachForMulticast({tokens:tokens.slice(i,i+500),notification:{title,body:message},data:{type:'FFX_NOTIFICATION'}});
        }
      } catch(pushErr){ console.warn('FCM push skipped:',pushErr.message); }

      return res.json({

        success: true,

        message:
          "Notification sent."

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
  requirePermission("Coupons"),
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
  requirePermission("Withdrawals"),
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
  requirePermission("Withdrawals"),
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
  requirePermission("Deposits"),
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
   ADMIN - MATCH SETTLEMENT
===================================================== */

app.post(
  "/api/admin/settle-match",
  requireAdmin,
  requirePermission("Match Results"),
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
  requirePermission("Content"),
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
  requirePermission("Content"),
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
  requirePermission("Content"),
  async (req, res) => {
    const tutorial = await Tutorial.create({
      title: req.body?.title,
      videoUrl: req.body?.videoUrl,
      category: req.body?.category || "General",
      coverUrl: req.body?.coverUrl || "",
      isCover: !!req.body?.isCover
    });
    if (tutorial.isCover) await Tutorial.updateMany({_id:{$ne:tutorial._id}},{$set:{isCover:false}});
    res.json({success:true,tutorial});
  }
);

app.delete(
  "/api/admin/tutorials/:id",
  requireAdmin,
  requirePermission("Content"),
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
   FFX UPGRADE APIs
===================================================== */

app.get('/api/tournaments', async (req,res)=>{
  try {
    const snap = await database().ref('tournaments').once('value');
    const data = snap.val() || {};
    const tournaments = Object.entries(data).map(([id,t])=>({id,...t}));
    res.json({success:true,tournaments});
  } catch(e){ res.status(500).json({success:false,message:'Unable to load tournaments.'}); }
});

app.get('/api/me/referral', requireAuth, async (req,res)=>{
  try {
    const ref = database().ref(`users/${req.firebaseUser.uid}/profile/referralCode`);
    const snap = await ref.once('value');
    let code = snap.val();
    if (!code || String(code)==='undefined' || String(code)==='null') {
      code = 'CS' + Math.floor(100000 + Math.random()*900000);
      await ref.set(code);
    }
    res.json({success:true, referralCode:code});
  } catch(e){res.status(500).json({success:false,message:'Unable to load referral code.'});}
});

app.get('/api/settings/payment', async (req,res)=>{
  try { const snap=await database().ref('settings/payment').once('value'); res.json(snap.val()||{minDeposit:10,maxDeposit:10000,status:'ON'}); }
  catch(e){res.status(500).json({success:false,message:'Unable to load settings.'});}
});

app.post('/api/admin/settings/payment', requireAdmin, requirePermission('Payment Settings'), async (req,res)=>{
  try {
    const minDeposit=Math.max(0,Number(req.body?.minDeposit||10));
    const maxDeposit=Math.max(minDeposit,Number(req.body?.maxDeposit||10000));
    const status=req.body?.status==='OFF'?'OFF':'ON';
    const value={minDeposit,maxDeposit,status,updatedAt:admin.database.ServerValue.TIMESTAMP,updatedBy:req.firebaseUser.uid};
    await database().ref('settings/payment').set(value);
    res.json({success:true,message:'Payment settings saved successfully.',settings:value});
  } catch(e){res.status(500).json({success:false,message:'Could not save settings.'});}
});

app.post('/api/admin/staff/create', requireAdmin, requirePermission('Staff Management'), async (req,res)=>{
  try {
    const {name,email,password,role='Support'}=req.body||{};
    if(!name||!email||!password) return res.status(400).json({success:false,message:'Name, email and password are required.'});
    const perms=rolePermissions(role);
    const user=await admin.auth().createUser({email:String(email).trim().toLowerCase(),password:String(password),displayName:String(name)});
    await database().ref(`staff/${user.uid}`).set({name,email:user.email,role,status:'Active',permissions:perms,createdAt:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:'Staff account created successfully.',uid:user.uid,role,permissions:perms});
  } catch(e){res.status(400).json({success:false,message:e?.message||'Could not create staff.'});}
});

app.get('/api/admin/staff', requireAdmin, requirePermission('Staff Management'), async (req,res)=>{
  try { const snap=await database().ref('staff').once('value'); const staff=[]; snap.forEach(c=>staff.push({uid:c.key,...c.val()})); res.json({success:true,staff}); }
  catch(e){res.status(500).json({success:false,message:'Unable to load staff.'});}
});

app.post('/api/admin/staff/:uid/role', requireAdmin, requirePermission('Staff Management'), async (req,res)=>{
  try { const role=req.body?.role||'Support'; const permissions=rolePermissions(role); await database().ref(`staff/${req.params.uid}`).update({role,permissions}); res.json({success:true,message:'Staff role updated.',role,permissions}); }
  catch(e){res.status(500).json({success:false,message:'Unable to update role.'});}
});

app.post('/api/admin/staff/:uid/status', requireAdmin, requirePermission('Staff Management'), async (req,res)=>{
  try { const status=req.body?.status==='Inactive'?'Inactive':'Active'; await database().ref(`staff/${req.params.uid}/status`).set(status); res.json({success:true,message:`Staff ${status.toLowerCase()}.`}); }
  catch(e){res.status(500).json({success:false,message:'Unable to update staff status.'});}
});

app.post('/api/admin/support/:ticketId/reply', requireAdmin, requirePermission('Support'), async (req,res)=>{
  try {
    const message=String(req.body?.message||'').trim(); if(!message) return res.status(400).json({success:false,message:'Reply cannot be empty.'});
    const uid=req.body?.uid;
    const ref=database().ref(`supportTickets/${req.params.ticketId}`);
    const snap=await ref.once('value'); if(!snap.exists()) return res.status(404).json({success:false,message:'Ticket not found.'});
    await ref.child('replies').push().set({message,by:req.firebaseUser.email||'FFX Support',role:req.isAdmin?'Admin':'Staff',timestamp:admin.database.ServerValue.TIMESTAMP});
    await ref.update({status:'Replied',lastReplyAt:admin.database.ServerValue.TIMESTAMP});
    if(uid) await database().ref(`notifications/${uid}`).push().set({title:'Support Reply',message:'FFX Support replied to your ticket.',read:false,sentAt:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:'Reply sent.'});
  } catch(e){res.status(500).json({success:false,message:'Could not send reply.'});}
});

app.post('/api/fcm/token', requireAuth, async (req,res)=>{
  try { const token=String(req.body?.token||'').trim(); if(!token) return res.status(400).json({success:false,message:'Token required.'}); await database().ref(`fcmTokens/${req.firebaseUser.uid}/${encodeURIComponent(token)}`).set({token,updatedAt:admin.database.ServerValue.TIMESTAMP}); res.json({success:true}); }
  catch(e){res.status(500).json({success:false,message:'Could not save notification token.'});}
});

app.post('/api/admin/notifications/push', requireAdmin, requirePermission('Notifications'), async (req,res)=>{
  try {
    const title=String(req.body?.title||'').trim(), message=String(req.body?.message||'').trim(), target=String(req.body?.targetUser||'ALL').trim();
    if(!title||!message) return res.status(400).json({success:false,message:'Title and message are required.'});
    const users=target==='ALL'?((await database().ref('fcmTokens').once('value')).val()||{}):{[target]:((await database().ref(`fcmTokens/${target}`).once('value')).val()||{})};
    const tokens=[]; Object.values(users).forEach(bucket=>Object.values(bucket||{}).forEach(x=>x?.token&&tokens.push(x.token)));
    if(tokens.length && admin.messaging){
      for(let i=0;i<tokens.length;i+=500){ await admin.messaging().sendEachForMulticast({tokens:tokens.slice(i,i+500),notification:{title,body:message},data:{type:'FFX_NOTIFICATION'}}); }
    }
    res.json({success:true,message:`Notification sent to ${tokens.length} device(s).`});
  } catch(e){res.status(500).json({success:false,message:'Push notification failed.'});}
});

app.post('/api/admin/tutorials/:id/cover', requireAdmin, requirePermission('Content'), async (req,res)=>{
  try { const id=req.params.id; const cover=!!req.body?.cover; await Tutorial.updateMany({},{$set:{isCover:false}}); await Tutorial.findByIdAndUpdate(id,{$set:{isCover:cover}}); res.json({success:true,message:cover?'Tutorial set as cover.':'Tutorial cover removed.'}); }
  catch(e){res.status(500).json({success:false,message:'Could not update tutorial cover.'});}
});





app.post('/api/support/tickets', requireAuth, async (req,res)=>{
  try{
    const uid=req.firebaseUser.uid; const subject=String(req.body?.subject||'').trim(); const message=String(req.body?.message||'').trim();
    if(!subject||!message) return res.status(400).json({success:false,message:'Subject and message are required.'});
    const user=(await database().ref(`users/${uid}`).once('value')).val()||{}; const p=user.profile||{};
    const ref=database().ref('supportTickets').push();
    await ref.set({uid,userName:p.fullName||'User',phone:p.phone||'',subject,message,status:'Open',timestamp:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:'Support ticket submitted.',ticketId:ref.key});
  }catch(e){res.status(500).json({success:false,message:'Could not submit support ticket.'});}
});

app.get('/api/support/tickets', requireAuth, async (req,res)=>{
  try{
    const snap=await database().ref('supportTickets').orderByChild('uid').equalTo(req.firebaseUser.uid).once('value'); const out=[];
    snap.forEach(c=>out.push({id:c.key,...c.val()})); out.reverse(); res.json({success:true,tickets:out});
  }catch(e){res.status(500).json({success:false,message:'Could not load support tickets.'});}
});

app.post('/api/admin/support/:ticketId/status', requireAdmin, requirePermission('Support'), async (req,res)=>{
  try{const status=['Open','Replied','Resolved'].includes(req.body?.status)?req.body.status:'Resolved'; await database().ref(`supportTickets/${req.params.ticketId}`).update({status}); res.json({success:true,message:'Ticket status updated.'});}
  catch(e){res.status(500).json({success:false,message:'Could not update ticket.'});}
});

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
 