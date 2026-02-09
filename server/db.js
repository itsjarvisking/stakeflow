// Simple JSON-based database for Railway compatibility
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

// Load or initialize database
let data = {
    users: {},
    challenges: {},
    challenge_players: [],
    transactions: [],
    selfies: []
};

if (fs.existsSync(DB_PATH)) {
    try {
        data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        console.log('Starting with fresh database');
    }
}

// Save database
function save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Auto-save every 30 seconds
setInterval(save, 30000);

// Database wrapper that mimics better-sqlite3 API
const db = {
    prepare: (sql) => ({
        run: (...params) => {
            // Parse and execute SQL-like operations
            const result = executeSQL(sql, params);
            save();
            return result;
        },
        get: (...params) => executeSQL(sql, params, 'get'),
        all: (...params) => executeSQL(sql, params, 'all')
    }),
    exec: (sql) => {
        // Schema creation - ignore for JSON db
        return;
    }
};

function executeSQL(sql, params, mode = 'run') {
    const sqlLower = sql.toLowerCase().trim();
    
    // INSERT INTO users
    if (sqlLower.includes('insert into users')) {
        const id = params[0];
        // Parse which columns are being inserted
        const hasAppleId = sqlLower.includes('apple_id');
        const user = {
            id,
            email: params[1] || null,
            password_hash: params[2] || null,
            apple_id: hasAppleId ? params[3] : null,
            name: hasAppleId ? (params[4] || 'Anonymous') : (params[3] || 'Anonymous'),
            avatar_url: null,
            balance: 0,
            stripe_customer_id: null,
            stripe_connect_id: null,
            stripe_connect_verified: 0,
            total_sessions: 0,
            total_wins: 0,
            total_focus_minutes: 0,
            money_won: 0,
            money_lost: 0,
            current_streak: 0,
            best_streak: 0,
            last_session_date: null,
            created_at: new Date().toISOString()
        };
        data.users[id] = user;
        return { changes: 1 };
    }
    
    // SELECT * FROM users WHERE id = ?
    if (sqlLower.includes('select') && sqlLower.includes('from users') && sqlLower.includes('where id')) {
        return data.users[params[0]] || null;
    }
    
    // SELECT * FROM users WHERE email = ?
    if (sqlLower.includes('select') && sqlLower.includes('from users') && sqlLower.includes('where email')) {
        return Object.values(data.users).find(u => u.email === params[0]) || null;
    }
    
    // SELECT * FROM users WHERE apple_id = ?
    if (sqlLower.includes('select') && sqlLower.includes('from users') && sqlLower.includes('where apple_id')) {
        return Object.values(data.users).find(u => u.apple_id === params[0]) || null;
    }
    
    // SELECT id FROM users WHERE email = ?
    if (sqlLower.includes('select id from users') && sqlLower.includes('where email')) {
        const user = Object.values(data.users).find(u => u.email === params[0]);
        return user ? { id: user.id } : null;
    }
    
    // UPDATE users SET ...
    if (sqlLower.includes('update users set')) {
        const userId = params[params.length - 1];
        if (data.users[userId]) {
            if (sqlLower.includes('balance = balance +')) {
                data.users[userId].balance += params[0];
            } else if (sqlLower.includes('balance = balance -')) {
                data.users[userId].balance -= params[0];
            } else if (sqlLower.includes('stripe_customer_id')) {
                data.users[userId].stripe_customer_id = params[0];
            } else if (sqlLower.includes('stripe_connect_id')) {
                data.users[userId].stripe_connect_id = params[0];
            } else if (sqlLower.includes('stripe_connect_verified')) {
                data.users[userId].stripe_connect_verified = 1;
            } else if (sqlLower.includes('name =')) {
                data.users[userId].name = params[0];
            } else if (sqlLower.includes('apple_id =')) {
                data.users[userId].apple_id = params[0];
            } else if (sqlLower.includes('total_wins')) {
                // Stats update
                const user = data.users[userId];
                if (sqlLower.includes('money_lost')) {
                    user.money_lost += params[0];
                    user.current_streak = 0;
                } else {
                    user.total_wins += 1;
                    user.total_sessions += 1;
                    user.current_streak += 1;
                    user.best_streak = Math.max(user.best_streak, user.current_streak);
                }
            }
        }
        return { changes: 1 };
    }
    
    // INSERT INTO transactions
    if (sqlLower.includes('insert into transactions')) {
        data.transactions.push({
            id: data.transactions.length + 1,
            user_id: params[0],
            type: params[1],
            amount: params[2],
            description: params[3],
            challenge_id: params[4] || null,
            stripe_payment_id: params[4] || null,
            created_at: new Date().toISOString()
        });
        return { changes: 1 };
    }
    
    // SELECT * FROM transactions WHERE user_id = ?
    if (sqlLower.includes('select') && sqlLower.includes('from transactions')) {
        const userId = params[0];
        return data.transactions.filter(t => t.user_id === userId).reverse().slice(0, 50);
    }
    
    // INSERT INTO challenges
    if (sqlLower.includes('insert into challenges')) {
        data.challenges[params[0]] = {
            id: params[0],
            type: params[1],
            creator_id: params[2],
            stake_amount: params[3],
            duration_minutes: params[4],
            max_players: params[5],
            status: 'pending',
            winner_id: null,
            started_at: null,
            ended_at: null,
            created_at: new Date().toISOString()
        };
        return { changes: 1 };
    }
    
    // SELECT * FROM challenges WHERE id = ?
    if (sqlLower.includes('select') && sqlLower.includes('from challenges') && sqlLower.includes('where id')) {
        return data.challenges[params[0]] || null;
    }
    
    // UPDATE challenges SET status
    if (sqlLower.includes('update challenges set')) {
        const id = params[params.length - 1];
        if (data.challenges[id]) {
            if (sqlLower.includes("status = 'active'")) {
                data.challenges[id].status = 'active';
                data.challenges[id].started_at = params[0];
            } else if (sqlLower.includes("status = 'completed'")) {
                data.challenges[id].status = 'completed';
                data.challenges[id].winner_id = params[0];
                data.challenges[id].ended_at = params[1];
            }
        }
        return { changes: 1 };
    }
    
    // INSERT INTO challenge_players
    if (sqlLower.includes('insert into challenge_players')) {
        data.challenge_players.push({
            id: data.challenge_players.length + 1,
            challenge_id: params[0],
            user_id: params[1],
            user_name: params[2],
            paid: params[3] || 0,
            ready: 0,
            failed: 0,
            failed_at: null,
            completed: 0,
            joined_at: new Date().toISOString()
        });
        return { changes: 1 };
    }
    
    // SELECT * FROM challenge_players WHERE challenge_id = ?
    if (sqlLower.includes('select') && sqlLower.includes('from challenge_players') && sqlLower.includes('where challenge_id')) {
        return data.challenge_players.filter(p => p.challenge_id === params[0]);
    }
    
    // UPDATE challenge_players
    if (sqlLower.includes('update challenge_players')) {
        const challengeId = params[params.length - 2];
        const oderId = params[params.length - 1];
        const player = data.challenge_players.find(p => p.challenge_id === challengeId && p.user_id === oderId);
        if (player) {
            if (sqlLower.includes('ready = 1')) player.ready = 1;
            if (sqlLower.includes('failed = 1')) {
                player.failed = 1;
                player.failed_at = params[0];
            }
            if (sqlLower.includes('completed = 1')) player.completed = 1;
        }
        return { changes: 1 };
    }
    
    // Leaderboards
    if (sqlLower.includes('order by total_wins desc')) {
        return Object.values(data.users).filter(u => u.total_wins > 0).sort((a, b) => b.total_wins - a.total_wins).slice(0, 10);
    }
    if (sqlLower.includes('order by money_won desc')) {
        return Object.values(data.users).filter(u => u.money_won > 0).sort((a, b) => b.money_won - a.money_won).slice(0, 10);
    }
    if (sqlLower.includes('order by best_streak desc')) {
        return Object.values(data.users).filter(u => u.best_streak > 0).sort((a, b) => b.best_streak - a.best_streak).slice(0, 10);
    }
    if (sqlLower.includes('order by total_focus_minutes desc')) {
        return Object.values(data.users).filter(u => u.total_focus_minutes > 0).sort((a, b) => b.total_focus_minutes - a.total_focus_minutes).slice(0, 10);
    }
    
    // Selfies
    if (sqlLower.includes('insert into selfies')) {
        data.selfies.push({
            id: data.selfies.length + 1,
            challenge_id: params[0],
            user_id: params[1],
            image_path: params[2],
            captured_at: new Date().toISOString(),
            ai_roast: null
        });
        return { changes: 1 };
    }
    
    if (sqlLower.includes('from selfies') && sqlLower.includes('where')) {
        const challengeId = params[0];
        const selfies = data.selfies.filter(s => s.challenge_id === challengeId);
        return selfies.map(s => {
            const player = data.challenge_players.find(p => p.challenge_id === s.challenge_id && p.user_id === s.user_id);
            return { ...s, user_name: player?.user_name || 'Anonymous' };
        });
    }
    
    // Default
    if (mode === 'all') return [];
    if (mode === 'get') return null;
    return { changes: 0 };
}

module.exports = db;
