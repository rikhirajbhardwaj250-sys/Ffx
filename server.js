const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(express.json());
app.use(cors());

// ============================================================
// FIREBASE ADMIN SETUP
// ============================================================

let firebaseAdminReady = false;

try {
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '')
        .replace(/\\n/g, '\n');

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

        firebaseAdminReady = true;
        console.log('✅ Firebase Admin initialized!');
    } else {
        console.warn(
            '⚠️ Firebase Admin environment variables are missing.'
        );
    }
} catch (err) {
    console.error(
        '❌ Firebase Admin initialization error:',
        err
    );
}

// ============================================================
// FIREBASE AUTH MIDDLEWARE
// ============================================================

async function requireFirebaseAuth(req, res, next) {
    try {
        if (!firebaseAdminReady) {
            return res.status(500).json({
                success: false,
                message:
                    'Firebase Admin is not configured on the server.'
            });
        }

        const authHeader = req.headers.authorization || '';

        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Authentication token is required.'
            });
        }

        const token = authHeader.substring(7);

        const decoded = await admin.auth().verifyIdToken(token);

        req.firebaseUser = decoded;

        next();

    } catch (err) {
        console.error(
            'Firebase auth error:',
            err.message
        );

        return res.status(401).json({
            success: false,
            message:
                'Invalid or expired authentication token.'
        });
    }
}

// ============================================================
// MONGODB CONNECTION
// ============================================================

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error(
        '❌ MONGO_URI environment variable is missing.'
    );
    process.exit(1);
}

mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000
})
.then(() => {
    console.log('✅ Connected to MongoDB Atlas!');
})
.catch(err => {
    console.error(
        '❌ MongoDB Connection Error:',
        err
    );
});

// ============================================================
// SCHEMAS & MODELS
// ============================================================

// ---------------- STAFF ----------------

const staffSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },

    email: {
        type: String,
        required: true,
        unique: true
    },

    phone: {
        type: String
    },

    password: {
        type: String,
        required: true
    },

    role: {
        type: String,
        enum: [
            'Admin',
            'Editor',
            'Support',
            'Moderator',
            'Match Organizer'
        ],
        default: 'Support'
    },

    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Staff = mongoose.model(
    'Staff',
    staffSchema
);

// ---------------- GATEWAY ----------------

const gatewaySchema = new mongoose.Schema({
    provider: {
        type: String,
        default: 'ZapUPI'
    },

    apiKey: {
        type: String,
        required: true
    },

    merchantId: {
        type: String
    },

    isLive: {
        type: Boolean,
        default: false
    }
});

const Gateway = mongoose.model(
    'Gateway',
    gatewaySchema
);

// ---------------- PAYMENT ORDER ----------------

const paymentOrderSchema = new mongoose.Schema({
    orderId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    uid: {
        type: String,
        required: true,
        index: true
    },

    email: {
        type: String
    },

    amount: {
        type: Number,
        required: true
    },

    status: {
        type: String,
        default: 'Pending'
    },

    credited: {
        type: Boolean,
        default: false
    },

    txnId: {
        type: String
    },

    utr: {
        type: String
    },

    createdAt: {
        type: Date,
        default: Date.now
    },

    updatedAt: {
        type: Date,
        default: Date.now
    }
});

const PaymentOrder = mongoose.model(
    'PaymentOrder',
    paymentOrderSchema
);

// ---------------- NOTIFICATIONS ----------------

const notificationSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },

    message: {
        type: String,
        required: true
    },

    targetUser: {
        type: String,
        default: 'ALL'
    },

    sentAt: {
        type: Date,
        default: Date.now
    }
});

const Notification = mongoose.model(
    'Notification',
    notificationSchema
);

// ---------------- TUTORIALS ----------------

const tutorialSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },

    videoUrl: {
        type: String,
        required: true
    },

    category: {
        type: String,
        default: 'General'
    }
});

const Tutorial = mongoose.model(
    'Tutorial',
    tutorialSchema
);

// ---------------- COUPONS ----------------

const couponSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true
    },

    amount: {
        type: Number,
        required: true
    },

    maxUses: {
        type: Number,
        default: 1
    },

    usedCount: {
        type: Number,
        default: 0
    },

    expiryDate: {
        type: Date
    }
});

const Coupon = mongoose.model(
    'Coupon',
    couponSchema
);

// ---------------- BANNERS ----------------

const bannerSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },

    imageUrl: {
        type: String,
        required: true
    },

    targetUrl: {
        type: String
    },

    isActive: {
        type: Boolean,
        default: true
    }
});

const Banner = mongoose.model(
    'Banner',
    bannerSchema
);

// ---------------- CONFIG ----------------

const configSchema = new mongoose.Schema({
    appMode: {
        type: String,
        enum: [
            'Live',
            'Maintenance',
            'Testing'
        ],
        default: 'Live'
    }
});

const Config = mongoose.model(
    'Config',
    configSchema
);

// ============================================================
// STAFF MANAGEMENT
// ============================================================

app.get('/api/staff', async (req, res) => {
    try {
        const staff = await Staff
            .find()
            .select('-password');

        res.json(staff);

    } catch (err) {
        res.status(500).json({
            error: err.message
        });
    }
});


app.post('/api/staff', async (req, res) => {
    try {
        const {
            name,
            email,
            phone,
            password,
            role
        } = req.body;

        const newStaff = new Staff({
            name,
            email,
            phone,
            password,
            role
        });

        await newStaff.save();

        res.status(201).json({
            success: true,
            data: newStaff
        });

    } catch (err) {
        res.status(400).json({
            success: false,
            message: err.message
        });
    }
});

// ============================================================
// ZAPUPI GATEWAY SETTINGS
// ============================================================

app.get(
    '/api/gateway/zapupi',
    async (req, res) => {

        try {
            const settings = await Gateway.findOne({
                provider: 'ZapUPI'
            });

            res.json(settings || {});

        } catch (err) {
            res.status(500).json({
                error: err.message
            });
        }
    }
);


app.post(
    '/api/gateway/zapupi',
    async (req, res) => {

        try {
            const {
                apiKey,
                merchantId,
                isLive
            } = req.body;

            const settings =
                await Gateway.findOneAndUpdate(
                    {
                        provider: 'ZapUPI'
                    },
                    {
                        apiKey,
                        merchantId,
                        isLive
                    },
                    {
                        upsert: true,
                        new: true
                    }
                );

            res.json({
                success: true,
                message:
                    'ZapUPI Settings Saved Successfully!',
                settings
            });

        } catch (err) {
            res.status(400).json({
                success: false,
                message: err.message
            });
        }
    }
);

// ============================================================
// ZAPUPI CREATE ORDER
// ============================================================

app.post(
    '/api/gateway/zapupi/create-order',
    requireFirebaseAuth,
    async (req, res) => {

        const requestId =
            `PAY_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2, 7)
                .toUpperCase()}`;

        try {

            console.log(
                `🟦 [${requestId}] Payment create request received.`
            );

            const {
                amount,
                email
            } = req.body || {};

            const uid =
                req.firebaseUser.uid;

            const numericAmount =
                Number(amount);

            console.log(
                `🟦 [${requestId}] Firebase auth OK. UID=${uid}, amount=${amount}`
            );

            // Validate amount
            if (
                !Number.isFinite(numericAmount) ||
                numericAmount <= 0
            ) {

                console.warn(
                    `🟨 [${requestId}] Invalid amount:`,
                    amount
                );

                return res.status(400).json({
                    success: false,
                    message:
                        'Please enter a valid deposit amount.'
                });
            }

            // Minimum deposit
            if (numericAmount < 10) {

                console.warn(
                    `🟨 [${requestId}] Amount below minimum: ₹${numericAmount}`
                );

                return res.status(400).json({
                    success: false,
                    message:
                        'Minimum deposit amount is ₹10.'
                });
            }

            // Get secret from Render environment
            const zapKey =
                process.env.ZAPUPI_KEY;

            if (!zapKey) {

                console.error(
                    `🟥 [${requestId}] ZAPUPI_KEY is missing from Render environment variables.`
                );

                return res.status(500).json({
                    success: false,
                    message:
                        'ZapUPI is not configured on the server.'
                });
            }

            // Generate unique order ID
            const orderId =
                'FFX_' +
                Date.now() +
                '_' +
                Math.random()
                    .toString(36)
                    .slice(2, 8)
                    .toUpperCase();

            console.log(
                `🟦 [${requestId}] Creating MongoDB payment order: ${orderId}`
            );

            // Save payment order
            await PaymentOrder.create({
                orderId,
                uid,
                email:
                    email ||
                    req.firebaseUser.email ||
                    '',
                amount: numericAmount,
                status: 'Pending'
            });

            console.log(
                `🟩 [${requestId}] MongoDB payment order created: ${orderId}`
            );

            // ZapUPI request
            const zapPayload = {

                zap_key: zapKey,

                order_id: orderId,

                amount: numericAmount,

                success_url:
                    'https://ffx-tournament.netlify.app/?payment=success',

                failed_url:
                    'https://ffx-tournament.netlify.app/?payment=failed',

                timeout_url:
                    'https://ffx-tournament.netlify.app/?payment=timeout',

                webhook_url:
                    'https://ffx-2.onrender.com/api/gateway/zapupi/webhook'
            };

            console.log(
                `🟦 [${requestId}] Sending create-order request to ZapUPI. orderId=${orderId}, amount=₹${numericAmount}`
            );

            let zapRes;

            try {

                zapRes = await fetch(
                    'https://pay.zapupi.com/api/create-order',
                    {
                        method: 'POST',

                        headers: {
                            'Content-Type':
                                'application/json'
                        },

                        body:
                            JSON.stringify(
                                zapPayload
                            ),

                        signal:
                            AbortSignal.timeout(
                                20000
                            )
                    }
                );

            } catch (gatewayErr) {

                console.error(
                    `🟥 [${requestId}] ZapUPI network/fetch error:`,
                    gatewayErr?.name,
                    gatewayErr?.message
                );

                await PaymentOrder.updateOne(
                    { orderId },
                    {
                        status:
                            'CreateFailed',
                        updatedAt:
                            new Date()
                    }
                );

                return res.status(502).json({
                    success: false,
                    message:
                        `Unable to connect to ZapUPI: ${gatewayErr?.message || 'Unknown gateway error'}`,
                    requestId
                });
            }

            // Read raw response first
            const rawZapResponse =
                await zapRes.text();

            let zapData = {};

            try {

                zapData =
                    rawZapResponse
                        ? JSON.parse(
                            rawZapResponse
                        )
                        : {};

            } catch (parseErr) {

                console.error(
                    `🟥 [${requestId}] ZapUPI returned non-JSON response. HTTP=${zapRes.status}`
                );

                console.error(
                    `🟥 [${requestId}] ZapUPI raw response (truncated):`,
                    rawZapResponse.slice(
                        0,
                        1000
                    )
                );

                await PaymentOrder.updateOne(
                    { orderId },
                    {
                        status:
                            'CreateFailed',
                        updatedAt:
                            new Date()
                    }
                );

                return res.status(502).json({
                    success: false,
                    message:
                        `ZapUPI returned an invalid response (HTTP ${zapRes.status}).`,
                    requestId
                });
            }

            console.log(
                `🟩 [${requestId}] ZapUPI responded. HTTP=${zapRes.status}, status=${zapData?.status || 'unknown'}, message=${zapData?.message || 'none'}`
            );

            // Check ZapUPI response
            if (
                !zapRes.ok ||
                zapData.status !== 'success' ||
                !zapData.payment_url
            ) {

                await PaymentOrder.updateOne(
                    { orderId },
                    {
                        status:
                            'CreateFailed',
                        updatedAt:
                            new Date()
                    }
                );

                console.error(
                    `🟥 [${requestId}] ZapUPI create-order failed. HTTP=${zapRes.status}`
                );

                console.error(
                    `🟥 [${requestId}] ZapUPI response:`,
                    {
                        status:
                            zapData?.status,

                        message:
                            zapData?.message,

                        order_id:
                            zapData?.order_id,

                        txn_id:
                            zapData?.txn_id,

                        has_payment_url:
                            Boolean(
                                zapData?.payment_url
                            )
                    }
                );

                return res.status(
                    zapRes.ok
                        ? 400
                        : 502
                ).json({

                    success: false,

                    message:
                        zapData.message ||
                        `ZapUPI order creation failed (HTTP ${zapRes.status}).`,

                    requestId
                });
            }

            console.log(
                `🟩 [${requestId}] ZapUPI order created successfully. orderId=${orderId}`
            );

            return res.json({

                success: true,

                paymentUrl:
                    zapData.payment_url,

                orderId,

                requestId
            });

        } catch (err) {

            console.error(
                `🟥 [${requestId}] Payment Create Order Error:`,
                err
            );

            console.error(
                `🟥 [${requestId}] Error name:`,
                err?.name
            );

            console.error(
                `🟥 [${requestId}] Error message:`,
                err?.message
            );

            console.error(
                `🟥 [${requestId}] Error stack:`,
                err?.stack
            );

            return res.status(500).json({

                success: false,

                message:
                    'Server error while creating payment order.',

                requestId
            });
        }
    }
);

// ============================================================
// ZAPUPI WEBHOOK
// ============================================================

app.post(
    '/api/gateway/zapupi/webhook',
    async (req, res) => {

        try {

            const webhook =
                req.body || {};

            console.log(
                '🟪 ZapUPI webhook received:',
                {
                    order_id:
                        webhook.order_id,

                    status:
                        webhook.status,

                    amount:
                        webhook.amount,

                    pay_amount:
                        webhook.pay_amount,

                    txn_id:
                        webhook.txn_id,

                    utr:
                        webhook.utr
                }
            );

            const orderId =
                webhook.order_id;

            const webhookStatus =
                String(
                    webhook.status || ''
                ).toLowerCase();

            if (!orderId) {

                return res.status(400).json({
                    success: false,
                    message:
                        'order_id is required.'
                });
            }

            const payment =
                await PaymentOrder.findOne({
                    orderId
                });

            if (!payment) {

                console.warn(
                    'Webhook for unknown order:',
                    orderId
                );

                return res.status(404).json({
                    success: false,
                    message:
                        'Order not found.'
                });
            }

            // Already credited
            if (payment.credited) {

                return res.status(200).json({
                    status: 'ok',
                    success: true,
                    message:
                        'Payment already credited.'
                });
            }

            // Failed / pending webhook
            if (
                ![
                    'success',
                    'successful'
                ].includes(
                    webhookStatus
                )
            ) {

                payment.status =
                    webhook.status ||
                    'Failed';

                payment.txnId =
                    webhook.txn_id ||
                    payment.txnId;

                payment.utr =
                    webhook.utr ||
                    payment.utr;

                payment.updatedAt =
                    new Date();

                await payment.save();

                return res.status(200).json({
                    status: 'ok',
                    success: true,
                    message:
                        'Payment status received.'
                });
            }

            // Get ZapUPI secret
            const zapKey =
                process.env.ZAPUPI_KEY;

            if (!zapKey) {

                return res.status(500).json({
                    success: false,
                    message:
                        'Payment gateway is not configured.'
                });
            }

            // Verify payment directly with ZapUPI
            const statusRes =
                await fetch(
                    'https://pay.zapupi.com/api/order-status',
                    {
                        method: 'POST',

                        headers: {
                            'Content-Type':
                                'application/json'
                        },

                        body:
                            JSON.stringify({
                                zap_key:
                                    zapKey,

                                order_id:
                                    orderId
                            })
                    }
                );

            const statusData =
                await statusRes
                    .json()
                    .catch(
                        () => ({})
                    );

            console.log(
                '🟪 ZapUPI order-status response:',
                {
                    httpStatus:
                        statusRes.status,

                    status:
                        statusData?.status,

                    dataStatus:
                        statusData?.data?.status,

                    amount:
                        statusData?.data?.amount,

                    txnId:
                        statusData?.data?.txn_id,

                    utr:
                        statusData?.data?.utr
                }
            );

            const verifiedStatus =
                String(
                    statusData?.data?.status ||
                    statusData?.status ||
                    ''
                ).toLowerCase();

            const verifiedAmount =
                Number(
                    statusData?.data?.amount ??
                    statusData?.amount ??
                    webhook.amount
                );

            // Payment not verified
            if (
                !statusRes.ok ||
                ![
                    'success',
                    'successful'
                ].includes(
                    verifiedStatus
                )
            ) {

                payment.status =
                    statusData?.data?.status ||
                    webhook.status ||
                    'Pending';

                payment.txnId =
                    statusData?.data?.txn_id ||
                    webhook.txn_id ||
                    payment.txnId;

                payment.utr =
                    statusData?.data?.utr ||
                    webhook.utr ||
                    payment.utr;

                payment.updatedAt =
                    new Date();

                await payment.save();

                return res.status(200).json({
                    status: 'ok',
                    success: true,
                    message:
                        'Payment received but not verified as successful yet.'
                });
            }

            // Amount verification
            if (
                !Number.isFinite(
                    verifiedAmount
                ) ||
                Math.abs(
                    verifiedAmount -
                    payment.amount
                ) > 0.001
            ) {

                payment.status =
                    'AmountMismatch';

                payment.updatedAt =
                    new Date();

                await payment.save();

                console.error(
                    'Amount mismatch:',
                    {
                        orderId,
                        expected:
                            payment.amount,
                        received:
                            verifiedAmount
                    }
                );

                return res.status(400).json({
                    success: false,
                    message:
                        'Payment amount mismatch.'
                });
            }

            if (!firebaseAdminReady) {

                return res.status(500).json({
                    success: false,
                    message:
                        'Firebase is not configured on the server.'
                });
            }

            const db =
                admin.database();

            // ====================================================
            // IDEMPOTENCY LOCK
            // ====================================================

            const creditLockRef =
                db.ref(
                    `paymentOrders/${orderId}/credited`
                );

            const lockResult =
                await creditLockRef.transaction(
                    current =>
                        current === true
                            ? undefined
                            : true
                );

            if (!lockResult.committed) {

                return res.status(200).json({
                    status: 'ok',
                    success: true,
                    message:
                        'Payment was already processed.'
                });
            }

            // ====================================================
            // WALLET CREDIT
            // ====================================================

            const walletRef =
                db.ref(
                    `users/${payment.uid}/wallet/balance`
                );

            const walletBeforeSnap =
                await walletRef.once(
                    'value'
                );

            const balanceBefore =
                Number(
                    walletBeforeSnap.val() || 0
                );

            const balanceAfter =
                balanceBefore +
                payment.amount;

            await walletRef.set(
                balanceAfter
            );

            // ====================================================
            // WALLET TRANSACTION
            // ====================================================

            const transactionRef =
                db.ref(
                    `users/${payment.uid}/walletTransactions`
                ).push();

            await transactionRef.set({

                type: 'Deposit',

                amount:
                    payment.amount,

                balanceBefore,

                balanceAfter,

                referenceId:
                    orderId,

                txnId:
                    statusData?.data?.txn_id ||
                    webhook.txn_id ||
                    null,

                utr:
                    statusData?.data?.utr ||
                    webhook.utr ||
                    null,

                timestamp:
                    admin.database
                        .ServerValue
                        .TIMESTAMP
            });

            // ====================================================
            // FIREBASE PAYMENT RECORD
            // ====================================================

            await db
                .ref(
                    `paymentOrders/${orderId}`
                )
                .update({

                    uid:
                        payment.uid,

                    amount:
                        payment.amount,

                    status:
                        'Success',

                    credited:
                        true,

                    txnId:
                        statusData?.data?.txn_id ||
                        webhook.txn_id ||
                        null,

                    utr:
                        statusData?.data?.utr ||
                        webhook.utr ||
                        null,

                    creditedAt:
                        admin.database
                            .ServerValue
                            .TIMESTAMP
                });

            // ====================================================
            // MONGODB PAYMENT UPDATE
            // ====================================================

            payment.status =
                'Success';

            payment.credited =
                true;

            payment.txnId =
                statusData?.data?.txn_id ||
                webhook.txn_id ||
                null;

            payment.utr =
                statusData?.data?.utr ||
                webhook.utr ||
                null;

            payment.updatedAt =
                new Date();

            await payment.save();

            console.log(
                `✅ Payment credited: ${orderId} → ${payment.uid} → ₹${payment.amount}`
            );

            return res.status(200).json({
                status: 'ok',
                success: true,
                message:
                    'Payment verified and wallet credited.'
            });

        } catch (err) {

            console.error(
                'ZapUPI Webhook Error:',
                err
            );

            return res.status(500).json({
                success: false,
                message:
                    'Webhook processing failed.'
            });
        }
    }
);

// ============================================================
// NOTIFICATIONS
// ============================================================

app.get(
    '/api/notifications',
    async (req, res) => {

        try {

            const notifications =
                await Notification
                    .find()
                    .sort({
                        sentAt: -1
                    })
                    .limit(20);

            res.json({
                success: true,
                notifications
            });

        } catch (err) {

            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    }
);


const handleSendNotification =
    async (req, res) => {

        try {

            const {
                title,
                message,
                targetUser
            } = req.body;

            if (!title || !message) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Title and message are required'
                });
            }

            const notif =
                new Notification({
                    title,
                    message,
                    targetUser:
                        targetUser ||
                        'ALL'
                });

            await notif.save();

            res.json({
                success: true,
                message:
                    'Push Notification Sent Successfully!'
            });

        } catch (err) {

            res.status(500).json({
                success: false,
                message:
                    err.message
            });
        }
    };


app.post(
    '/api/notifications',
    handleSendNotification
);

app.post(
    '/api/notifications/send',
    handleSendNotification
);

// ============================================================
// TUTORIALS
// ============================================================

app.get(
    '/api/tutorials',
    async (req, res) => {

        try {

            const tutorials =
                await Tutorial.find();

            res.json(tutorials);

        } catch (err) {

            res.status(500).json({
                error: err.message
            });
        }
    }
);


app.post(
    '/api/tutorials',
    async (req, res) => {

        try {

            const tutorial =
                new Tutorial(
                    req.body
                );

            await tutorial.save();

            res.json({
                success: true,
                tutorial
            });

        } catch (err) {

            res.status(400).json({
                success: false,
                message:
                    err.message
            });
        }
    }
);

// ============================================================
// COUPONS
// ============================================================

app.get(
    '/api/coupons',
    async (req, res) => {

        try {

            const coupons =
                await Coupon.find();

            res.json(coupons);

        } catch (err) {

            res.status(500).json({
                error: err.message
            });
        }
    }
);


app.post(
    '/api/coupons/generate',
    async (req, res) => {

        try {

            const {
                code,
                amount,
                maxUses,
                expiryDate
            } = req.body;

            const generatedCode =
                code ||
                'REDEEM-' +
                Math.random()
                    .toString(36)
                    .substring(2, 8)
                    .toUpperCase();

            const coupon =
                new Coupon({
                    code:
                        generatedCode,

                    amount,

                    maxUses,

                    expiryDate
                });

            await coupon.save();

            res.json({
                success: true,
                coupon
            });

        } catch (err) {

            res.status(400).json({
                success: false,
                message:
                    err.message
            });
        }
    }
);

// ============================================================
// BANNERS
// ============================================================

app.get(
    '/api/banners',
    async (req, res) => {

        try {

            const banners =
                await Banner.find();

            res.json(banners);

        } catch (err) {

            res.status(500).json({
                error: err.message
            });
        }
    }
);


app.post(
    '/api/banners',
    async (req, res) => {

        try {

            const banner =
                new Banner(
                    req.body
                );

            await banner.save();

            res.json({
                success: true,
                banner
            });

        } catch (err) {

            res.status(400).json({
                success: false,
                message:
                    err.message
            });
        }
    }
);

// ============================================================
// CONFIG
// ============================================================

app.get(
    '/api/config/mode',
    async (req, res) => {

        try {

            let config =
                await Config.findOne();

            if (!config) {

                config =
                    await Config.create({
                        appMode: 'Live'
                    });
            }

            res.json(config);

        } catch (err) {

            res.status(500).json({
                error: err.message
            });
        }
    }
);


app.post(
    '/api/config/mode',
    async (req, res) => {

        try {

            const {
                appMode
            } = req.body;

            const config =
                await Config.findOneAndUpdate(
                    {},
                    {
                        appMode
                    },
                    {
                        upsert: true,
                        new: true
                    }
                );

            res.json({
                success: true,
                message:
                    `System Mode Updated to ${appMode}`,
                config
            });

        } catch (err) {

            res.status(400).json({
                success: false,
                message:
                    err.message
            });
        }
    }
);

// ============================================================
// START SERVER
// ============================================================

const PORT =
    process.env.PORT || 5000;

app.listen(
    PORT,
    () => {
        console.log(
            `🚀 Admin Server Running on Port ${PORT}`
        );
    }
);