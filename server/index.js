require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Stripe = require('stripe');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const appleSignin = require('apple-signin-auth');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Config
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stakeflow_secret_change_in_production';
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || 'com.stakeflow.app';

// Tiered platform fees
function getPlatformFee(stakeAmountCents) {
    const dollars = stakeAmountCents / 100;
    if (dollars >= 100) return 15;
    return 10;
}

// Streak bonus multiplier
function getStreakBonus(streak) {
    if (streak >= 7) return 0.10;
    if (streak >= 5) return 0.07;
    if (streak >= 3) return 0.05;
    return 0;
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Database setup
const db = new Database(path.join(__dirname, 'stakeflow.db'));
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT,
        apple_id TEXT UNIQUE,
        name TEXT,
        avatar_url TEXT,
        balance INTEGER DEFAULT 0,
        stripe_customer_id TEXT,
        stripe_connect_id TEXT,
        stripe_connect_verified INTEGER DEFAULT 0,
        total_sessions INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0,
        total_focus_minutes INTEGER DEFAULT 0,
        money_won INTEGER DEFAULT 0,
        money_lost INTEGER DEFAULT 0,
        current_streak INTEGER DEFAULT 0,
        best_streak INTEGER DEFAULT 0,
        last_session_date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT,
        challenge_id TEXT,
        stripe_payment_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        stake_amount INTEGER NOT NULL,
        duration_minutes INTEGER,
        max_players INTEGER DEFAULT 2,
        status TEXT DEFAULT 'pending',
        winner_id TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS challenge_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        paid INTEGER DEFAULT 0,
        ready INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        failed_at TEXT,
        completed INTEGER DEFAULT 0,
        joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (challenge_id) REFERENCES challenges(id)
    );
    
    CREATE TABLE IF NOT EXISTS selfies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        image_path TEXT NOT NULL,
        captured_at TEXT DEFAULT CURRENT_TIMESTAMP,
        ai_roast TEXT,
        FOREIGN KEY (challenge_id) REFERENCES challenges(id)
    );
`);

// Add indexes
try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_apple ON users(apple_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_players_challenge ON challenge_players(challenge_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_players_user ON challenge_players(user_id)`);
} catch(e) {}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..')));
app.use('/uploads', express.static(uploadsDir));

// Auth middleware
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
        if (!req.user) {
            return res.status(401).json({ error: 'User not found' });
        }
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Optional auth - doesn't fail if no token
function optionalAuth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.userId = decoded.userId;
            req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
        } catch (e) {}
    }
    next();
}

function generateCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateUserId() {
    return 'user_' + Math.random().toString(36).substring(2, 15);
}

// =====================
// AUTH ROUTES
// =====================

// Sign up with email/password
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        // Check if email exists
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
        if (existing) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = generateUserId();
        
        // Create user
        db.prepare(`
            INSERT INTO users (id, email, password_hash, name)
            VALUES (?, ?, ?, ?)
        `).run(userId, email.toLowerCase(), passwordHash, name || email.split('@')[0]);
        
        // Generate token
        const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        
        res.json({
            success: true,
            token,
            user: sanitizeUser(user)
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Login with email/password
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
        if (!user || !user.password_hash) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        res.json({
            success: true,
            token,
            user: sanitizeUser(user)
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sign in with Apple
app.post('/api/auth/apple', async (req, res) => {
    try {
        const { identityToken, user: appleUser } = req.body;
        
        // Verify the token with Apple
        let appleData;
        try {
            appleData = await appleSignin.verifyIdToken(identityToken, {
                audience: APPLE_CLIENT_ID,
                ignoreExpiration: false
            });
        } catch (e) {
            // For development, allow mock tokens
            if (process.env.NODE_ENV === 'development' && identityToken === 'dev_token') {
                appleData = { sub: appleUser?.id || 'dev_apple_user', email: appleUser?.email };
            } else {
                return res.status(401).json({ error: 'Invalid Apple token' });
            }
        }
        
        const appleId = appleData.sub;
        const email = appleData.email || appleUser?.email;
        const name = appleUser?.name ? `${appleUser.name.firstName || ''} ${appleUser.name.lastName || ''}`.trim() : null;
        
        // Check if user exists
        let user = db.prepare('SELECT * FROM users WHERE apple_id = ?').get(appleId);
        
        if (!user && email) {
            // Check by email
            user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
            if (user) {
                // Link Apple ID to existing account
                db.prepare('UPDATE users SET apple_id = ? WHERE id = ?').run(appleId, user.id);
            }
        }
        
        if (!user) {
            // Create new user
            const userId = generateUserId();
            db.prepare(`
                INSERT INTO users (id, apple_id, email, name)
                VALUES (?, ?, ?, ?)
            `).run(userId, appleId, email?.toLowerCase(), name || 'StakeFlow User');
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        }
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        res.json({
            success: true,
            token,
            user: sanitizeUser(user)
        });
    } catch (error) {
        console.error('Apple auth error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
});

// Update profile
app.patch('/api/auth/me', authMiddleware, (req, res) => {
    try {
        const { name, avatar_url } = req.body;
        
        if (name) {
            db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.userId);
        }
        if (avatar_url) {
            db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatar_url, req.userId);
        }
        
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
        res.json({ user: sanitizeUser(user) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function sanitizeUser(user) {
    if (!user) return null;
    const { password_hash, stripe_customer_id, stripe_connect_id, ...safe } = user;
    return {
        ...safe,
        balance: user.balance / 100, // Convert cents to dollars
        hasStripeConnect: !!stripe_connect_id && user.stripe_connect_verified
    };
}

// =====================
// WALLET ROUTES
// =====================

// Get wallet balance & transactions
app.get('/api/wallet', authMiddleware, (req, res) => {
    try {
        const transactions = db.prepare(`
            SELECT * FROM transactions 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 50
        `).all(req.userId);
        
        res.json({
            balance: req.user.balance / 100,
            transactions: transactions.map(t => ({
                ...t,
                amount: t.amount / 100
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create payment intent to add funds
app.post('/api/wallet/add-funds', authMiddleware, async (req, res) => {
    try {
        const { amount } = req.body; // Amount in dollars
        
        if (!amount || amount < 5) {
            return res.status(400).json({ error: 'Minimum amount is $5' });
        }
        
        if (amount > 500) {
            return res.status(400).json({ error: 'Maximum amount is $500' });
        }
        
        // Get or create Stripe customer
        let customerId = req.user.stripe_customer_id;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: req.user.email,
                name: req.user.name,
                metadata: { userId: req.userId }
            });
            customerId = customer.id;
            db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.userId);
        }
        
        // Create payment intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // Convert to cents
            currency: 'usd',
            customer: customerId,
            metadata: {
                userId: req.userId,
                type: 'add_funds'
            },
            automatic_payment_methods: {
                enabled: true
            }
        });
        
        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
        });
    } catch (error) {
        console.error('Add funds error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Confirm funds added (called after successful payment)
app.post('/api/wallet/confirm-funds', authMiddleware, async (req, res) => {
    try {
        const { paymentIntentId } = req.body;
        
        // Verify payment with Stripe
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({ error: 'Payment not completed' });
        }
        
        if (paymentIntent.metadata.userId !== req.userId) {
            return res.status(403).json({ error: 'Payment does not belong to this user' });
        }
        
        // Check if already processed
        const existing = db.prepare('SELECT id FROM transactions WHERE stripe_payment_id = ?').get(paymentIntentId);
        if (existing) {
            return res.json({ success: true, message: 'Already processed' });
        }
        
        const amount = paymentIntent.amount; // Already in cents
        
        // Add to balance
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, req.userId);
        
        // Record transaction
        db.prepare(`
            INSERT INTO transactions (user_id, type, amount, description, stripe_payment_id)
            VALUES (?, 'deposit', ?, 'Added funds', ?)
        `).run(req.userId, amount, paymentIntentId);
        
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
        
        res.json({
            success: true,
            newBalance: user.balance / 100
        });
    } catch (error) {
        console.error('Confirm funds error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Setup Stripe Connect for withdrawals
app.post('/api/wallet/setup-withdraw', authMiddleware, async (req, res) => {
    try {
        let connectId = req.user.stripe_connect_id;
        
        if (!connectId) {
            // Create Stripe Connect Express account
            const account = await stripe.accounts.create({
                type: 'express',
                country: 'US',
                email: req.user.email,
                capabilities: {
                    transfers: { requested: true }
                },
                metadata: { userId: req.userId }
            });
            connectId = account.id;
            db.prepare('UPDATE users SET stripe_connect_id = ? WHERE id = ?').run(connectId, req.userId);
        }
        
        // Create account link for onboarding
        const accountLink = await stripe.accountLinks.create({
            account: connectId,
            refresh_url: `${req.headers.origin || 'https://stakeflow.work'}/wallet?refresh=true`,
            return_url: `${req.headers.origin || 'https://stakeflow.work'}/wallet?success=true`,
            type: 'account_onboarding'
        });
        
        res.json({ url: accountLink.url });
    } catch (error) {
        console.error('Setup withdraw error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Withdraw funds
app.post('/api/wallet/withdraw', authMiddleware, async (req, res) => {
    try {
        const { amount } = req.body; // Amount in dollars
        const amountCents = Math.round(amount * 100);
        
        if (amountCents < 1000) {
            return res.status(400).json({ error: 'Minimum withdrawal is $10' });
        }
        
        if (amountCents > req.user.balance) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        if (!req.user.stripe_connect_id || !req.user.stripe_connect_verified) {
            return res.status(400).json({ error: 'Please set up withdrawals first' });
        }
        
        // Create transfer to connected account
        const transfer = await stripe.transfers.create({
            amount: amountCents,
            currency: 'usd',
            destination: req.user.stripe_connect_id,
            metadata: { userId: req.userId }
        });
        
        // Deduct from balance
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amountCents, req.userId);
        
        // Record transaction
        db.prepare(`
            INSERT INTO transactions (user_id, type, amount, description, stripe_payment_id)
            VALUES (?, 'withdrawal', ?, 'Withdrawal to bank', ?)
        `).run(req.userId, -amountCents, transfer.id);
        
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
        
        res.json({
            success: true,
            newBalance: user.balance / 100
        });
    } catch (error) {
        console.error('Withdraw error:', error);
        res.status(500).json({ error: error.message });
    }
});

// =====================
// STRIPE WEBHOOKS
// =====================

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    switch (event.type) {
        case 'payment_intent.succeeded':
            // Already handled by confirm-funds endpoint
            break;
            
        case 'account.updated':
            const account = event.data.object;
            if (account.charges_enabled && account.payouts_enabled) {
                db.prepare('UPDATE users SET stripe_connect_verified = 1 WHERE stripe_connect_id = ?').run(account.id);
            }
            break;
    }
    
    res.json({ received: true });
});

// =====================
// CHALLENGE ROUTES (Updated to use auth & wallet)
// =====================

// Create challenge
app.post('/api/challenges', optionalAuth, async (req, res) => {
    try {
        const { type, stake, duration, creatorId, creatorName, maxPlayers } = req.body;
        
        // Use authenticated user if available
        const userId = req.userId || creatorId;
        const userName = req.user?.name || creatorName;
        
        // For non-solo challenges with real accounts, check balance
        if (req.user && type !== 'solo') {
            const stakeAmountCents = Math.round(stake * 100);
            if (req.user.balance < stakeAmountCents) {
                return res.status(400).json({ error: 'Insufficient balance', balance: req.user.balance / 100 });
            }
        }
        
        const id = generateCode();
        const stakeAmount = Math.round(stake * 100);
        const durationMinutes = type === 'royale' ? null : duration;
        const players = maxPlayers || (type === 'solo' ? 1 : type === 'friend' ? 2 : 5);
        
        db.prepare(`
            INSERT INTO challenges (id, type, creator_id, stake_amount, duration_minutes, max_players)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, type, userId, stakeAmount, durationMinutes, players);
        
        db.prepare(`
            INSERT INTO challenge_players (challenge_id, user_id, user_name, paid)
            VALUES (?, ?, ?, 1)
        `).run(id, userId, userName || 'Anonymous');
        
        // Deduct stake from balance if authenticated
        if (req.user && type !== 'solo') {
            db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(stakeAmount, userId);
            db.prepare(`
                INSERT INTO transactions (user_id, type, amount, description, challenge_id)
                VALUES (?, 'stake', ?, 'Staked for challenge', ?)
            `).run(userId, -stakeAmount, id);
        }
        
        res.json({ 
            success: true, 
            challengeId: id,
            shareUrl: `/challenge/${id}`
        });
    } catch (error) {
        console.error('Create challenge error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get challenge details
app.get('/api/challenges/:id', (req, res) => {
    try {
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(req.params.id);
        const creator = players.find(p => p.user_id === challenge.creator_id);
        
        const fee = getPlatformFee(challenge.stake_amount);
        res.json({
            ...challenge,
            stake_dollars: challenge.stake_amount / 100,
            creator_name: creator?.user_name || 'Anonymous',
            players: players,
            player_count: players.length,
            platform_fee: fee,
            potential_winnings: Math.round((challenge.stake_amount * challenge.max_players * (100 - fee)) / 100) / 100
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Join challenge
app.post('/api/challenges/:id/join', optionalAuth, async (req, res) => {
    try {
        const { userId, userName } = req.body;
        const finalUserId = req.userId || userId;
        const finalUserName = req.user?.name || userName;
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        
        if (challenge.status !== 'pending') {
            return res.status(400).json({ error: 'Challenge already started' });
        }
        
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(req.params.id);
        if (players.length >= challenge.max_players) {
            return res.status(400).json({ error: 'Challenge is full' });
        }
        
        // Check balance if authenticated
        if (req.user) {
            if (req.user.balance < challenge.stake_amount) {
                return res.status(400).json({ error: 'Insufficient balance', balance: req.user.balance / 100 });
            }
            
            // Deduct stake
            db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(challenge.stake_amount, finalUserId);
            db.prepare(`
                INSERT INTO transactions (user_id, type, amount, description, challenge_id)
                VALUES (?, 'stake', ?, 'Staked for challenge', ?)
            `).run(finalUserId, -challenge.stake_amount, req.params.id);
        }
        
        db.prepare(`
            INSERT INTO challenge_players (challenge_id, user_id, user_name, paid)
            VALUES (?, ?, ?, 1)
        `).run(req.params.id, finalUserId, finalUserName || 'Anonymous');
        
        const updatedPlayers = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(req.params.id);
        
        io.to(req.params.id).emit('player:joined', { 
            challengeId: req.params.id,
            players: updatedPlayers
        });
        
        res.json({ success: true, players: updatedPlayers });
    } catch (error) {
        console.error('Join error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mark ready
app.post('/api/challenges/:id/ready', (req, res) => {
    try {
        const { userId } = req.body;
        
        db.prepare(`
            UPDATE challenge_players SET ready = 1 
            WHERE challenge_id = ? AND user_id = ?
        `).run(req.params.id, userId);
        
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(req.params.id);
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
        
        const allReady = players.length >= 2 && players.every(p => p.ready);
        
        io.to(req.params.id).emit('player:ready', { 
            challengeId: req.params.id,
            players,
            allReady
        });
        
        if (allReady) {
            db.prepare("UPDATE challenges SET status = 'active', started_at = ? WHERE id = ?")
                .run(new Date().toISOString(), req.params.id);
            
            io.to(req.params.id).emit('challenge:start', { 
                challengeId: req.params.id,
                challenge: { ...challenge, status: 'active' },
                players
            });
        }
        
        res.json({ success: true, players, allReady });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Fail (lose) challenge
app.post('/api/challenges/:id/fail', optionalAuth, async (req, res) => {
    try {
        const { userId, reason } = req.body;
        const finalUserId = req.userId || userId;
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        
        // Mark player as failed
        db.prepare(`
            UPDATE challenge_players SET failed = 1, failed_at = ? 
            WHERE challenge_id = ? AND user_id = ?
        `).run(new Date().toISOString(), req.params.id, finalUserId);
        
        // Update user stats
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(finalUserId);
        if (user) {
            db.prepare(`
                UPDATE users SET 
                    money_lost = money_lost + ?,
                    current_streak = 0
                WHERE id = ?
            `).run(challenge.stake_amount, finalUserId);
            
            // Record loss transaction
            db.prepare(`
                INSERT INTO transactions (user_id, type, amount, description, challenge_id)
                VALUES (?, 'loss', ?, 'Lost stake', ?)
            `).run(finalUserId, -challenge.stake_amount, req.params.id);
        }
        
        io.to(req.params.id).emit('player:failed', { 
            challengeId: req.params.id,
            userId: finalUserId,
            reason
        });
        
        // Check if challenge should end
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(req.params.id);
        const activePlayers = players.filter(p => !p.failed);
        
        if (challenge.type === 'friend' && activePlayers.length === 1) {
            // 1v1: Other person wins
            await endChallengeWithWinner(req.params.id, activePlayers[0].user_id, challenge, players);
        } else if ((challenge.type === 'royale' || challenge.type === 'group') && activePlayers.length === 1) {
            // Royale/Group: Last person standing wins
            await endChallengeWithWinner(req.params.id, activePlayers[0].user_id, challenge, players);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Fail error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Complete challenge (survived)
app.post('/api/challenges/:id/complete', optionalAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        const finalUserId = req.userId || userId;
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        
        // Mark player as completed
        db.prepare(`
            UPDATE challenge_players SET completed = 1 
            WHERE challenge_id = ? AND user_id = ?
        `).run(req.params.id, finalUserId);
        
        // Solo mode: Just return stake (they beat themselves)
        if (challenge.type === 'solo') {
            // Refund stake since they won against themselves
            const user = db.prepare('SELECT * FROM users WHERE id = ?').get(finalUserId);
            if (user) {
                db.prepare(`
                    UPDATE users SET 
                        total_wins = total_wins + 1,
                        total_sessions = total_sessions + 1,
                        total_focus_minutes = total_focus_minutes + ?,
                        current_streak = current_streak + 1,
                        best_streak = MAX(best_streak, current_streak + 1),
                        last_session_date = ?
                    WHERE id = ?
                `).run(challenge.duration_minutes || 0, new Date().toISOString().split('T')[0], finalUserId);
            }
            
            db.prepare("UPDATE challenges SET status = 'completed', winner_id = ?, ended_at = ? WHERE id = ?")
                .run(finalUserId, new Date().toISOString(), req.params.id);
            
            res.json({ 
                success: true, 
                result: 'win',
                message: 'You stayed focused! Stake refunded.',
                winnings: 0
            });
            return;
        }
        
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(req.params.id);
        const completedPlayers = players.filter(p => p.completed);
        const failedPlayers = players.filter(p => p.failed);
        
        // For group mode, check if session time is up
        if (challenge.type === 'group' && completedPlayers.length + failedPlayers.length === players.length) {
            // All players have finished - distribute winnings to survivors
            await endGroupChallenge(req.params.id, challenge, players);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Complete error:', error);
        res.status(500).json({ error: error.message });
    }
});

async function endChallengeWithWinner(challengeId, winnerId, challenge, players) {
    const failedPlayers = players.filter(p => p.failed);
    const totalPot = challenge.stake_amount * players.length;
    const fee = getPlatformFee(challenge.stake_amount);
    const winnings = Math.round(totalPot * (100 - fee) / 100);
    
    // Update challenge
    db.prepare("UPDATE challenges SET status = 'completed', winner_id = ?, ended_at = ? WHERE id = ?")
        .run(winnerId, new Date().toISOString(), challengeId);
    
    // Add winnings to winner's balance
    const winner = db.prepare('SELECT * FROM users WHERE id = ?').get(winnerId);
    if (winner) {
        const streak = winner.current_streak || 0;
        const bonus = getStreakBonus(streak);
        const totalWinnings = Math.round(winnings * (1 + bonus));
        
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(totalWinnings, winnerId);
        
        db.prepare(`
            UPDATE users SET 
                total_wins = total_wins + 1,
                total_sessions = total_sessions + 1,
                money_won = money_won + ?,
                current_streak = current_streak + 1,
                best_streak = MAX(best_streak, current_streak + 1),
                last_session_date = ?
            WHERE id = ?
        `).run(totalWinnings, new Date().toISOString().split('T')[0], winnerId);
        
        db.prepare(`
            INSERT INTO transactions (user_id, type, amount, description, challenge_id)
            VALUES (?, 'win', ?, 'Challenge winnings', ?)
        `).run(winnerId, totalWinnings, challengeId);
    }
    
    io.to(challengeId).emit('challenge:end', {
        challengeId,
        winnerId,
        winnings: winnings / 100
    });
}

async function endGroupChallenge(challengeId, challenge, players) {
    const survivors = players.filter(p => p.completed && !p.failed);
    const losers = players.filter(p => p.failed);
    
    if (survivors.length === 0) {
        // Everyone failed - money goes to platform
        db.prepare("UPDATE challenges SET status = 'completed', ended_at = ? WHERE id = ?")
            .run(new Date().toISOString(), challengeId);
        return;
    }
    
    const loserPot = losers.length * challenge.stake_amount;
    const fee = getPlatformFee(challenge.stake_amount);
    const distributablePot = Math.round(loserPot * (100 - fee) / 100);
    const perSurvivor = Math.floor(distributablePot / survivors.length);
    
    // Refund stakes + distribute winnings
    for (const survivor of survivors) {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(survivor.user_id);
        if (user) {
            const refund = challenge.stake_amount + perSurvivor;
            db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(refund, survivor.user_id);
            
            db.prepare(`
                INSERT INTO transactions (user_id, type, amount, description, challenge_id)
                VALUES (?, 'win', ?, 'Group challenge winnings', ?)
            `).run(survivor.user_id, refund, challengeId);
        }
    }
    
    db.prepare("UPDATE challenges SET status = 'completed', ended_at = ? WHERE id = ?")
        .run(new Date().toISOString(), challengeId);
    
    io.to(challengeId).emit('challenge:end', {
        challengeId,
        survivors: survivors.map(s => s.user_id),
        perSurvivor: perSurvivor / 100
    });
}

// Get user stats
app.get('/api/users/:id/stats', (req, res) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
        if (!user) {
            return res.json({
                total_sessions: 0,
                total_wins: 0,
                total_focus_minutes: 0,
                money_won: 0,
                current_streak: 0,
                best_streak: 0
            });
        }
        res.json({
            total_sessions: user.total_sessions,
            total_wins: user.total_wins,
            total_focus_minutes: user.total_focus_minutes,
            money_won: (user.money_won || 0) / 100,
            current_streak: user.current_streak,
            best_streak: user.best_streak
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Leaderboards
app.get('/api/leaderboards', (req, res) => {
    try {
        const topWins = db.prepare(`
            SELECT id, name, total_wins, total_sessions 
            FROM users 
            WHERE total_wins > 0 
            ORDER BY total_wins DESC 
            LIMIT 10
        `).all();
        
        const topEarners = db.prepare(`
            SELECT id, name, money_won, total_sessions 
            FROM users 
            WHERE money_won > 0 
            ORDER BY money_won DESC 
            LIMIT 10
        `).all().map(u => ({ ...u, money_won: u.money_won / 100 }));
        
        const topStreaks = db.prepare(`
            SELECT id, name, best_streak, total_sessions 
            FROM users 
            WHERE best_streak > 0 
            ORDER BY best_streak DESC 
            LIMIT 10
        `).all();
        
        const topFocus = db.prepare(`
            SELECT id, name, total_focus_minutes, total_sessions 
            FROM users 
            WHERE total_focus_minutes > 0 
            ORDER BY total_focus_minutes DESC 
            LIMIT 10
        `).all();
        
        res.json({ topWins, topEarners, topStreaks, topFocus });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Selfie upload
app.post('/api/challenges/:id/selfie', (req, res) => {
    try {
        const { userId, image } = req.body;
        
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        const filename = `${req.params.id}_${userId}_${Date.now()}.jpg`;
        const filepath = path.join(uploadsDir, filename);
        
        fs.writeFileSync(filepath, base64Data, 'base64');
        
        db.prepare(`
            INSERT INTO selfies (challenge_id, user_id, image_path)
            VALUES (?, ?, ?)
        `).run(req.params.id, userId, `/uploads/${filename}`);
        
        res.json({ success: true, path: `/uploads/${filename}` });
    } catch (error) {
        console.error('Selfie error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get challenge selfies
app.get('/api/challenges/:id/selfies', (req, res) => {
    try {
        const selfies = db.prepare(`
            SELECT s.*, cp.user_name 
            FROM selfies s
            JOIN challenge_players cp ON s.challenge_id = cp.challenge_id AND s.user_id = cp.user_id
            WHERE s.challenge_id = ?
            ORDER BY s.captured_at
        `).all(req.params.id);
        res.json(selfies);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io
io.on('connection', (socket) => {
    socket.on('join:challenge', (challengeId) => {
        socket.join(challengeId);
    });
    
    socket.on('leave:challenge', (challengeId) => {
        socket.leave(challengeId);
    });
});

// Catch-all for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🔥 StakeFlow server running on port ${PORT}`);
});
