const path = require('node:path');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./src/db');
const auth = require('./src/auth');
const { router, NotFound } = require('./src/routes');
const { tempText } = require('./src/engine');
const profiles = require('./src/profiles');
const temperature = require('./src/temperature');
const format = require('./src/format');

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

Object.assign(app.locals, profiles, temperature, format, { tempText });

app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieSession({
  name: 'bj',
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: isProd,
}));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(auth.sessionLocals);
app.use(auth.csrfCheck);

app.use(auth.router);
app.use(router);

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'There is nothing at this address.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof NotFound) {
    return res.status(404).render('error', { title: 'Not found', message: err.message });
  }
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Your data is safe — please try again.' });
});

async function start() {
  const { embedded } = await db.connect();
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`Brew Journal on http://localhost:${port} (${embedded ? 'embedded dev MongoDB, data in .mongo-data/' : 'MongoDB'})`);
  });
  const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
}

module.exports = app;
