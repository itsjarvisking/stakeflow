const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                email VARCHAR(255) UNIQUE,
                password_hash VARCHAR(255),
                apple_id VARCHAR(255),
                name VARCHAR(255) DEFAULT 'Anonymous',
                avatar_url TEXT,
                balance INTEGER DEFAULT 0,
                stripe_customer_id VARCHAR(255),
                stripe_connect_id VARCHAR(255),
                stripe_connect_verified INTEGER DEFAULT 0,
                total_sessions INTEGER DEFAULT 0,
                total_wins INTEGER DEFAULT 0,
                total_focus_minutes INTEGER DEFAULT 0,
                money_won INTEGER DEFAULT 0,
                money_lost INTEGER DEFAULT 0,
                current_streak INTEGER DEFAULT 0,
                best_streak INTEGER DEFAULT 0,
                last_session_date TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS challenges (
                id VARCHAR(20) PRIMARY KEY,
                type VARCHAR(20),
                creator_id VARCHAR(50),
                stake_amount INTEGER,
                duration_minutes INTEGER,
                max_players INTEGER DEFAULT 2,
                status VARCHAR(20) DEFAULT 'pending',
                winner_id VARCHAR(50),
                started_at TIMESTAMP,
                ended_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS challenge_players (
                id SERIAL PRIMARY KEY,
                challenge_id VARCHAR(20),
                user_id VARCHAR(50),
                user_name VARCHAR(255),
                paid INTEGER DEFAULT 0,
                ready INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                failed_at TIMESTAMP,
                completed INTEGER DEFAULT 0,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50),
                type VARCHAR(50),
                amount INTEGER,
                description TEXT,
                challenge_id VARCHAR(20),
                stripe_payment_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS selfies (
                id SERIAL PRIMARY KEY,
                challenge_id VARCHAR(20),
                user_id VARCHAR(50),
                image_path TEXT,
                captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ai_roast TEXT
            )
        `);
        
        console.log('✅ Database tables initialized');
    } finally {
        client.release();
    }
}

// Database wrapper that mimics better-sqlite3 API for compatibility
const db = {
    prepare: (sql) => ({
        run: async (...params) => {
            const result = await executeQuery(sql, params);
            return { changes: result.rowCount };
        },
        get: async (...params) => {
            const result = await executeQuery(sql, params);
            return result.rows[0] || null;
        },
        all: async (...params) => {
            const result = await executeQuery(sql, params);
            return result.rows;
        }
    }),
    exec: async (sql) => {
        await pool.query(sql);
    }
};

async function executeQuery(sql, params) {
    // Convert ? placeholders to $1, $2, etc for PostgreSQL
    let paramIndex = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);
    
    try {
        return await pool.query(pgSql, params);
    } catch (error) {
        console.error('DB Query Error:', error.message);
        console.error('SQL:', pgSql);
        console.error('Params:', params);
        throw error;
    }
}

// Sync wrapper for compatibility (returns promises that need to be awaited)
const dbSync = {
    prepare: (sql) => ({
        run: (...params) => {
            return executeQuery(sql, params).then(r => ({ changes: r.rowCount }));
        },
        get: (...params) => {
            return executeQuery(sql, params).then(r => r.rows[0] || null);
        },
        all: (...params) => {
            return executeQuery(sql, params).then(r => r.rows);
        }
    }),
    exec: (sql) => pool.query(sql)
};

module.exports = { pool, initDB, db: dbSync };
