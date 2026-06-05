import test from 'node:test';
import assert from 'node:assert';
import supertest from 'supertest';
import app from '../index.js';

const request = supertest(app);

// Skip tests if Supabase not configured (safer for local dev without secrets)
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  test('skip tests when Supabase env not configured', (t) => {
    t.skip();
  });
}
