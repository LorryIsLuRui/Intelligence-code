import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
    if (!pool) {
        pool = new Pool({
            connectionString: env.pgUrl,
            max: 10,
        });
    }
    return pool;
}
