import express from 'express';
const router = express.Router();

// NOTE: This routes file previously used Supabase. Supabase was removed per user request.
// You should update these routes to interact with Google Sheets (Apps Script) instead, or remove the server.

export default function routerPlaceholder(req, res) {
  res.json({ success: false, error: 'Supabase integration removed. Use Google Sheets endpoints instead.' });
}
