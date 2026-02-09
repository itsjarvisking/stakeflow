require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Stripe = require('stripe');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Config
const PORT = process.env.PORT || 3000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// Tiered platform fees
function getPlatformFee(stakeAmountCents) {
    const dollars = stakeAmountCents / 100;
    if (dollars >= 100) return 15; // 15% for $100+
    return 10; // 10% for under $100
}

// Streak bonus multiplier
function getStreakBonus(streak) {
    if (streak >= 7) return 0.10; // 10% bonus for 7+ day streak
    if (streak >= 5) return 0.07; // 7% bonus for 5-6 day streak
    if (streak >= 3) return 0.05; // 5% bonus for 3-4 day streak
    return 0; // No bonus under 3 days
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Database setup
const db = new Database(path.join(__dirname, 'stakeflow.db'));
db.exec(`
    CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL, -- 'solo', 'friend', 'royale', 'group'
        creator_id TEXT NOT NULL,
        stake_amount INTEGER NOT NULL,
        duration_minutes INTEGER, -- null for royale (unlimited)
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
    
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
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
    
    CREATE TABLE IF NOT EXISTS leaderboard_cache (
        type TEXT PRIMARY KEY,
        data TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
`);

// Add indexes
try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_players_challenge ON challenge_players(challenge_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_players_user ON challenge_players(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_selfies_challenge ON selfies(challenge_id)`);
} catch(e) {}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..')));
app.use('/uploads', express.static(uploadsDir));

function generateCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Get or create user
function getOrCreateUser(userId, userName) {
    let user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
        db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(userId, userName || 'Anonymous');
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    }
    return user;
}

// API Routes

// Create challenge
app.post('/api/challenges', async (req, res) => {
    try {
        const { type, stake, duration, creatorId, creatorName, maxPlayers } = req.body;
        
        const id = generateCode();
        const stakeAmount = Math.round(stake * 100);
        
        getOrCreateUser(creatorId, creatorName);
        
        // Duration is null for royale mode (unlimited)
        const durationMinutes = type === 'royale' ? null : duration;
        const players = maxPlayers || (type === 'solo' ? 1 : type === 'friend' ? 2 : 5);
        
        db.prepare(`
            INSERT INTO challenges (id, type, creator_id, stake_amount, duration_minutes, max_players)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, type, creatorId, stakeAmount, durationMinutes, players);
        
        // Add creator as first player
        db.prepare(`
            INSERT INTO challenge_players (challenge_id, user_id, user_name, paid)
            VALUES (?, ?, ?, 1)
        `).run(id, creatorId, creatorName || 'Anonymous');
        
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

// Join challenge (pay)
app.post('/api/challenges/:id/join', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, userName } = req.body;
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(id);
        
        // Check if already joined
        const existing = players.find(p => p.user_id === userId);
        if (existing) {
            if (!existing.paid) {
                db.prepare('UPDATE challenge_players SET paid = 1 WHERE challenge_id = ? AND user_id = ?').run(id, userId);
            }
        } else {
            // Check max players
            if (players.length >= challenge.max_players) {
                return res.status(400).json({ error: 'Challenge is full' });
            }
            
            getOrCreateUser(userId, userName);
            db.prepare(`
                INSERT INTO challenge_players (challenge_id, user_id, user_name, paid)
                VALUES (?, ?, ?, 1)
            `).run(id, userId, userName || 'Anonymous');
        }
        
        const updated = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        const updatedPlayers = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(id);
        
        io.to(id).emit('challenge:updated', { ...updated, players: updatedPlayers });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Join error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mark ready
app.post('/api/challenges/:id/ready', (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;
        
        db.prepare('UPDATE challenge_players SET ready = 1 WHERE challenge_id = ? AND user_id = ?').run(id, userId);
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(id);
        
        // Check if all paid players are ready
        const paidPlayers = players.filter(p => p.paid);
        const allReady = paidPlayers.every(p => p.ready);
        const minPlayers = challenge.type === 'solo' ? 1 : 2;
        
        if (allReady && paidPlayers.length >= minPlayers) {
            db.prepare(`UPDATE challenges SET status = 'active', started_at = ? WHERE id = ?`)
                .run(new Date().toISOString(), id);
        }
        
        const updated = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        io.to(id).emit('challenge:updated', { ...updated, players });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload selfie
app.post('/api/challenges/:id/selfie', (req, res) => {
    try {
        const { id } = req.params;
        const { userId, imageData } = req.body;
        
        // Save base64 image
        const filename = `${id}_${userId}_${Date.now()}.jpg`;
        const filepath = path.join(uploadsDir, filename);
        
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filepath, base64Data, 'base64');
        
        db.prepare(`
            INSERT INTO selfies (challenge_id, user_id, image_path)
            VALUES (?, ?, ?)
        `).run(id, userId, `/uploads/${filename}`);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Selfie error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Report failure
app.post('/api/challenges/:id/fail', (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        
        db.prepare(`UPDATE challenge_players SET failed = 1, failed_at = ? WHERE challenge_id = ? AND user_id = ?`)
            .run(new Date().toISOString(), id, userId);
        
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ? AND paid = 1').all(id);
        const activePlayers = players.filter(p => !p.failed);
        
        // Update user stats
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (user) {
            db.prepare(`UPDATE users SET 
                total_sessions = total_sessions + 1,
                money_lost = money_lost + ?,
                current_streak = 0
            WHERE id = ?`).run(challenge.stake_amount, userId);
        }
        
        // Check if challenge should end
        let shouldEnd = false;
        let winnerId = null;
        
        if (challenge.type === 'solo') {
            shouldEnd = true;
        } else if (challenge.type === 'royale' || challenge.type === 'group') {
            // Last one standing wins
            if (activePlayers.length <= 1) {
                shouldEnd = true;
                winnerId = activePlayers[0]?.user_id || null;
            }
        } else if (challenge.type === 'friend') {
            shouldEnd = true;
            winnerId = activePlayers[0]?.user_id || null;
        }
        
        if (shouldEnd) {
            db.prepare(`UPDATE challenges SET status = 'completed', winner_id = ?, ended_at = ? WHERE id = ?`)
                .run(winnerId, new Date().toISOString(), id);
            
            // Update winner stats
            if (winnerId) {
                const fee = getPlatformFee(challenge.stake_amount);
                const totalPot = challenge.stake_amount * players.length;
                let winnings = Math.round(totalPot * (100 - fee) / 100);
                
                // Apply streak bonus
                const winner = db.prepare('SELECT * FROM users WHERE id = ?').get(winnerId);
                if (winner) {
                    const streakBonus = getStreakBonus(winner.current_streak);
                    const bonus = Math.round(winnings * streakBonus);
                    winnings += bonus;
                }
                
                db.prepare(`UPDATE users SET 
                    total_sessions = total_sessions + 1,
                    total_wins = total_wins + 1,
                    money_won = money_won + ?,
                    current_streak = current_streak + 1,
                    best_streak = MAX(best_streak, current_streak + 1)
                WHERE id = ?`).run(winnings, winnerId);
            }
            
            // Get selfies for recap
            const selfies = db.prepare('SELECT * FROM selfies WHERE challenge_id = ?').all(id);
            
            const fee = getPlatformFee(challenge.stake_amount);
            const final = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
            
            // Calculate winnings with potential streak bonus
            let displayWinnings = 0;
            if (winnerId) {
                const winner = db.prepare('SELECT * FROM users WHERE id = ?').get(winnerId);
                const baseWinnings = Math.round(challenge.stake_amount * players.length * (100 - fee) / 100);
                const streakBonus = winner ? getStreakBonus(winner.current_streak - 1) : 0; // -1 because we just incremented
                displayWinnings = Math.round(baseWinnings * (1 + streakBonus)) / 100;
            }
            
            io.to(id).emit('challenge:completed', { 
                ...final, 
                players,
                selfies,
                winnings: displayWinnings,
                platform_fee: fee
            });
        } else {
            const updated = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
            io.to(id).emit('challenge:player_failed', { 
                ...updated, 
                players,
                failedUserId: userId 
            });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Fail error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Complete challenge (timer finished)
app.post('/api/challenges/:id/complete', (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        
        db.prepare(`UPDATE challenge_players SET completed = 1 WHERE challenge_id = ? AND user_id = ?`)
            .run(id, userId);
        
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ? AND paid = 1').all(id);
        
        // Update focus minutes
        if (challenge.duration_minutes) {
            db.prepare(`UPDATE users SET total_focus_minutes = total_focus_minutes + ? WHERE id = ?`)
                .run(challenge.duration_minutes, userId);
        }
        
        // Check if all non-failed players completed
        const activePlayers = players.filter(p => !p.failed);
        const allCompleted = activePlayers.every(p => p.completed);
        
        if (allCompleted && challenge.type !== 'royale') {
            // Everyone finished - handle based on type
            const failedPlayers = players.filter(p => p.failed);
            const winners = activePlayers;
            
            if (challenge.type === 'solo') {
                db.prepare(`UPDATE challenges SET status = 'completed', winner_id = ?, ended_at = ? WHERE id = ?`)
                    .run(userId, new Date().toISOString(), id);
                
                db.prepare(`UPDATE users SET 
                    total_sessions = total_sessions + 1,
                    total_wins = total_wins + 1,
                    current_streak = current_streak + 1,
                    best_streak = MAX(best_streak, current_streak + 1)
                WHERE id = ?`).run(userId);
            } else if (challenge.type === 'group' && failedPlayers.length > 0) {
                // Survivors split losers' money
                const fee = getPlatformFee(challenge.stake_amount);
                const loserPot = challenge.stake_amount * failedPlayers.length;
                const winningsPerPerson = Math.round((loserPot * (100 - fee) / 100) / winners.length);
                
                db.prepare(`UPDATE challenges SET status = 'completed', ended_at = ? WHERE id = ?`)
                    .run(new Date().toISOString(), id);
                
                for (const winner of winners) {
                    db.prepare(`UPDATE users SET 
                        total_sessions = total_sessions + 1,
                        total_wins = total_wins + 1,
                        money_won = money_won + ?,
                        current_streak = current_streak + 1,
                        best_streak = MAX(best_streak, current_streak + 1)
                    WHERE id = ?`).run(winningsPerPerson, winner.user_id);
                }
            } else {
                // Draw - everyone keeps their money
                db.prepare(`UPDATE challenges SET status = 'completed', winner_id = 'draw', ended_at = ? WHERE id = ?`)
                    .run(new Date().toISOString(), id);
                
                for (const player of activePlayers) {
                    db.prepare(`UPDATE users SET 
                        total_sessions = total_sessions + 1,
                        current_streak = current_streak + 1,
                        best_streak = MAX(best_streak, current_streak + 1)
                    WHERE id = ?`).run(player.user_id);
                }
            }
            
            const selfies = db.prepare('SELECT * FROM selfies WHERE challenge_id = ?').all(id);
            const final = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
            io.to(id).emit('challenge:completed', { ...final, players, selfies });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Complete error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get leaderboards
app.get('/api/leaderboards', (req, res) => {
    try {
        const topWins = db.prepare(`
            SELECT id, name, total_wins, total_sessions, money_won, current_streak, best_streak
            FROM users 
            WHERE total_sessions > 0
            ORDER BY total_wins DESC 
            LIMIT 20
        `).all();
        
        const topEarners = db.prepare(`
            SELECT id, name, money_won, total_wins, total_sessions
            FROM users 
            WHERE money_won > 0
            ORDER BY money_won DESC 
            LIMIT 20
        `).all();
        
        const topStreaks = db.prepare(`
            SELECT id, name, best_streak, current_streak, total_wins
            FROM users 
            WHERE best_streak > 0
            ORDER BY best_streak DESC 
            LIMIT 20
        `).all();
        
        const topFocus = db.prepare(`
            SELECT id, name, total_focus_minutes, total_sessions, total_wins
            FROM users 
            WHERE total_focus_minutes > 0
            ORDER BY total_focus_minutes DESC 
            LIMIT 20
        `).all();
        
        res.json({
            topWins,
            topEarners: topEarners.map(u => ({ ...u, money_won: u.money_won / 100 })),
            topStreaks,
            topFocus
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
                money_lost: 0,
                current_streak: 0,
                best_streak: 0
            });
        }
        
        res.json({
            ...user,
            money_won: user.money_won / 100,
            money_lost: user.money_lost / 100
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Vote for best setup
app.post('/api/challenges/:id/vote', (req, res) => {
    try {
        const { id } = req.params;
        const { votedUserId, oduserId } = req.body;
        
        // Broadcast vote to other players
        io.to(id).emit('challenge:vote', { votedUserId, oduserId });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Generate AI roast for selfies (mock for now)
app.post('/api/challenges/:id/generate-recap', async (req, res) => {
    try {
        const { id } = req.params;
        const selfies = db.prepare('SELECT * FROM selfies WHERE challenge_id = ?').all(id);
        
        // Mock AI roasts - in production, call OpenAI Vision API
        const roasts = [
            "Looking focused... or is that just your 'pretending to work' face? 😏",
            "Ah yes, the classic 'I'm definitely not watching YouTube' expression 🎭",
            "That's the face of someone who's questioning all their life choices 💀",
            "10/10 concentration face. Very believable. Much focus. 🐕",
            "POV: You told yourself 'just 5 more minutes' 3 hours ago 😅",
            "The determination in those eyes says 'I need that money back' 💰",
            "Somewhere between 'locked in' and 'existential crisis' - respect 🫡",
            "That's either deep focus or you fell asleep with your eyes open 😴"
        ];
        
        for (const selfie of selfies) {
            const roast = roasts[Math.floor(Math.random() * roasts.length)];
            db.prepare('UPDATE selfies SET ai_roast = ? WHERE id = ?').run(roast, selfie.id);
        }
        
        const updated = db.prepare('SELECT * FROM selfies WHERE challenge_id = ?').all(id);
        res.json({ selfies: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('join:challenge', (challengeId) => {
        socket.join(challengeId);
        
        const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId);
        const players = db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?').all(challengeId);
        
        if (challenge) {
            socket.emit('challenge:updated', { ...challenge, players });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Serve frontend
app.get('/challenge/:id', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 StakeFlow server running on port ${PORT}`);
});
