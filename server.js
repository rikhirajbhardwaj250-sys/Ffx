const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(express.json());
app.use(cors());

// --- MONGODB CONNECTION SETUP ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://rishix:18112009@cluster0.riyat42.mongodb.net/admin_panel?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000
})
.then(() => console.log('✅ Connected to MongoDB Atlas!'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS & MODELS ---
const staffSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String },
    password: { type: String, required: true },
    role: { type: String, enum: ['Admin', 'Editor', 'Support', 'Moderator', 'Match Organizer'], default: 'Support' },
    createdAt: { type: Date, default: Date.now }
});
const Staff = mongoose.model('Staff', staffSchema);

const gatewaySchema = new mongoose.Schema({
    provider: { type: String, default: 'ZapUPI' },
    apiKey: { type: String, required: true },
    merchantId: { type: String },
    isLive: { type: Boolean, default: false }
});
const Gateway = mongoose.model('Gateway', gatewaySchema);

const notificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    message: { type: String, required: true },
    targetUser: { type: String, default: 'ALL' },
    sentAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', notificationSchema);

const tutorialSchema = new mongoose.Schema({
    title: { type: String, required: true },
    videoUrl: { type: String, required: true },
    category: { type: String, default: 'General' }
});
const Tutorial = mongoose.model('Tutorial', tutorialSchema);

const couponSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    maxUses: { type: Number, default: 1 },
    usedCount: { type: Number, default: 0 },
    expiryDate: { type: Date }
});
const Coupon = mongoose.model('Coupon', couponSchema);

const bannerSchema = new mongoose.Schema({
    title: { type: String, required: true },
    imageUrl: { type: String, required: true },
    targetUrl: { type: String },
    isActive: { type: Boolean, default: true }
});
const Banner = mongoose.model('Banner', bannerSchema);

const configSchema = new mongoose.Schema({
    appMode: { type: String, enum: ['Live', 'Maintenance', 'Testing'], default: 'Live' }
});
const Config = mongoose.model('Config', configSchema);

// --- API ROUTES ---

// Staff Management
app.get('/api/staff', async (req, res) => {
    try {
        const staff = await Staff.find().select('-password');
        res.json(staff);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/staff', async (req, res) => {
    try {
        const { name, email, phone, password, role } = req.body;
        const newStaff = new Staff({ name, email, phone, password, role });
        await newStaff.save();
        res.status(201).json({ success: true, data: newStaff });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// ZapUPI Gateway Settings
app.get('/api/gateway/zapupi', async (req, res) => {
    try {
        const settings = await Gateway.findOne({ provider: 'ZapUPI' });
        res.json(settings || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gateway/zapupi', async (req, res) => {
    try {
        const { apiKey, merchantId, isLive } = req.body;
        const settings = await Gateway.findOneAndUpdate(
            { provider: 'ZapUPI' },
            { apiKey, merchantId, isLive },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'ZapUPI Settings Saved Successfully!', settings });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// ZapUPI Create Order (User App Deposit)
app.post('/api/gateway/zapupi/create-order', async (req, res) => {
    try {
        const { uid, amount, email } = req.body;

        const settings = await Gateway.findOne({ provider: 'ZapUPI' });
        if (!settings || !settings.apiKey) {
            return res.status(400).json({ success: false, message: 'Payment gateway not configured in Admin Panel.' });
        }

        const orderId = 'ORD_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000);

        const postData = JSON.stringify({
            api_key: settings.apiKey,
            order_id: orderId,
            amount: amount,
            customer_email: email || `${uid}@cyberstrike.app`,
            redirect_url: 'https://ffx-tournament.netlify.app/payment-status'
        });

        const options = {
            hostname: 'zapupi.in',
            port: 443,
            path: '/api/create-order',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const zapReq = https.request(options, (zapRes) => {
            let body = '';
            zapRes.on('data', chunk => body += chunk);
            zapRes.on('end', () => {
                try {
                    const zapData = JSON.parse(body);
                    if (zapRes.statusCode === 200 && (zapData.status === 'success' || zapData.payment_url || zapData.url)) {
                        return res.json({
                            success: true,
                            paymentUrl: zapData.payment_url || zapData.url,
                            orderId: orderId
                        });
                    } else {
                        return res.status(400).json({
                            success: false,
                            message: zapData.message || 'ZapUPI Order creation failed'
                        });
                    }
                } catch (e) {
                    return res.status(500).json({ success: false, message: 'Invalid response from payment provider' });
                }
            });
        });

        zapReq.on('error', (err) => {
            console.error('ZapUPI HTTPS Error:', err);
            return res.status(500).json({ success: false, message: 'Server error connecting to payment gateway.' });
        });

        zapReq.write(postData);
        zapReq.end();

    } catch (err) {
        console.error('Payment Route Error:', err);
        res.status(500).json({ success: false, message: 'Server error connecting to payment gateway.' });
    }
});

// Push Notifications
app.get('/api/notifications', async (req, res) => {
    try {
        const notifications = await Notification.find().sort({ sentAt: -1 }).limit(20);
        res.json({ success: true, notifications });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const handleSendNotification = async (req, res) => {
    try {
        const { title, message, targetUser } = req.body;
        if (!title || !message) {
            return res.status(400).json({ success: false, message: 'Title and message are required' });
        }
        const notif = new Notification({ title, message, targetUser: targetUser || 'ALL' });
        await notif.save();
        res.json({ success: true, message: 'Push Notification Sent Successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

app.post('/api/notifications', handleSendNotification);
app.post('/api/notifications/send', handleSendNotification);

// Tutorials
app.get('/api/tutorials', async (req, res) => {
    try {
        const tutorials = await Tutorial.find();
        res.json(tutorials);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tutorials', async (req, res) => {
    try {
        const tutorial = new Tutorial(req.body);
        await tutorial.save();
        res.json({ success: true, tutorial });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Coupons
app.get('/api/coupons', async (req, res) => {
    try {
        const coupons = await Coupon.find();
        res.json(coupons);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/coupons/generate', async (req, res) => {
    try {
        const { code, amount, maxUses, expiryDate } = req.body;
        const generatedCode = code || 'REDEEM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const coupon = new Coupon({ code: generatedCode, amount, maxUses, expiryDate });
        await coupon.save();
        res.json({ success: true, coupon });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Banners
app.get('/api/banners', async (req, res) => {
    try {
        const banners = await Banner.find();
        res.json(banners);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/banners', async (req, res) => {
    try {
        const banner = new Banner(req.body);
        await banner.save();
        res.json({ success: true, banner });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Config
app.get('/api/config/mode', async (req, res) => {
    try {
        let config = await Config.findOne();
        if (!config) config = await Config.create({ appMode: 'Live' });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/config/mode', async (req, res) => {
    try {
        const { appMode } = req.body;
        const config = await Config.findOneAndUpdate({}, { appMode }, { upsert: true, new: true });
        res.json({ success: true, message: `System Mode Updated to ${appMode}`, config });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Admin Server Running on Port ${PORT}`));
