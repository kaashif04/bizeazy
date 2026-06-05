import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
// Supabase server helper removed per user request
import authRoutes from './authRoutes.js';
import gasRoutes from './gasRoutes.js';

dotenv.config();
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || 'change-me', resave: false, saveUninitialized: false, cookie: { maxAge: 24*60*60*1000 } }));

// Simple CORS / origin guard for /gas endpoints
app.use('/gas', (req, res, next) => {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || req.headers.referer || req.headers.host;
  if (allowed.length === 0) return next(); // no restriction configured
  if (!origin) return res.status(403).json({ success: false, error: 'Origin not allowed' });
  const matched = allowed.some(o => origin.includes(o));
  if (!matched) return res.status(403).json({ success: false, error: 'Origin not allowed' });
  next();
});

// Note: Supabase removed — routes should call Apps Script web app instead if you want server-side proxying
app.use('/auth', authRoutes);
app.use('/gas', gasRoutes);

app.get('/api/me', async (req, res) => {
  res.json({ user: null, note: 'Supabase removed. Connect directly to Google Sheets via Apps Script.' });
});

export default app;
