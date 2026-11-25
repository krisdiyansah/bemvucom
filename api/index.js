'use strict';

const { createApp } = require('../server');

let app;

module.exports = async function handler(req, res) {
  try {
    app = app || createApp();
    await app.handleRequest(req, res);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'DATABASE_URL or POSTGRES_URL must be configured for Vercel deployments.'
    ) {
      console.error('[Bemvu Config]', error.message);
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    throw error;
  }
};
