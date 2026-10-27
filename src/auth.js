const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { validateCredentials } = require('./validate');

// Per-request helpers: CSRF token, one-time flash message, current user.
async function sessionLocals(req, res, next) {
  try {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    req.flash = (message) => { req.session.flash = message; };

    res.locals.user = null;
    if (req.session.userId) {
      req.user = await db.one('SELECT id, email FROM users WHERE id = $1', [req.session.userId]);
      if (!req.user) req.session.userId = null;
      res.locals.user = req.user || null;
    }
    next();
  } catch (err) {
    next(err);
  }
}

function csrfCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const sent = String(req.body?._csrf || '');
  const expected = req.session.csrf || '';
  const ok = sent.length === expected.length && sent.length > 0
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (ok) return next();
  res.status(403).render('error', { title: 'Session expired', message: 'Your session expired or the form was stale. Go back, refresh the page and try again.' });
}

function requireUser(req, res, next) {
  if (req.user) return next();
  req.flash('Please log in first.');
  res.redirect('/login');
}

// Simple in-memory limiter for login attempts: 10 per 15 minutes per IP.
const attempts = new Map();
function loginLimiter(req, res, next) {
  const now = Date.now();
  const entry = attempts.get(req.ip) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) Object.assign(entry, { count: 0, reset: now + 15 * 60 * 1000 });
  entry.count += 1;
  attempts.set(req.ip, entry);
  if (entry.count > 10) {
    return res.status(429).render('auth', { title: 'Log in', mode: 'login', values: { email: req.body.email || '' }, errors: { form: 'Too many attempts. Try again in a few minutes.' } });
  }
  next();
}

const router = express.Router();

router.get('/register', (req, res) => res.render('auth', { title: 'Create account', mode: 'register', values: {}, errors: {} }));
router.get('/login', (req, res) => res.render('auth', { title: 'Log in', mode: 'login', values: {}, errors: {} }));

router.post('/register', async (req, res, next) => {
  try {
    const { values, errors } = validateCredentials(req.body);
    if (Object.keys(errors).length) {
      return res.status(422).render('auth', { title: 'Create account', mode: 'register', values, errors });
    }
    const hash = await bcrypt.hash(values.password, 10);
    let user;
    try {
      user = await db.one(
        'INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
        [values.email, hash, new Date().toISOString()],
      );
    } catch (err) {
      if (!db.isUniqueViolation(err)) throw err;
      return res.status(409).render('auth', { title: 'Create account', mode: 'register', values, errors: { email: 'An account with this email already exists. Log in instead.' } });
    }
    req.session.userId = user.id;
    req.flash('Welcome! Add your first coffee or tea to get started.');
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await db.one('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    const ok = user && await bcrypt.compare(String(req.body.password || ''), user.password_hash);
    if (!ok) {
      return res.status(401).render('auth', { title: 'Log in', mode: 'login', values: { email }, errors: { form: 'Email or password is incorrect.' } });
    }
    attempts.delete(req.ip);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = { router, sessionLocals, csrfCheck, requireUser };
