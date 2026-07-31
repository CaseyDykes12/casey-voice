/**
 * Casey Voice Bridge — File Relay
 * Phone voice → file → Claude Code CLI session reads it → response file → phone
 * This connects the phone directly to the active CLI session.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3456;
const INBOX = 'C:\\Users\\Cdyke\\.voice-inbox.json';
const OUTBOX = 'C:\\Users\\Cdyke\\.voice-outbox.json';

let processing = false;
// Completed exchanges, newest last. Lets the phone recover a reply that landed
// while the app was backgrounded (iOS kills the in-flight fetch on app switch).
const history = [];

function waitForOutbox(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      try {
        if (fs.existsSync(OUTBOX)) {
          const data = JSON.parse(fs.readFileSync(OUTBOX, 'utf-8'));
          fs.unlinkSync(OUTBOX); // clean up
          clearInterval(poll);
          resolve(data.response);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error('Timed out waiting for response'));
        }
      } catch (err) {
        // File might be mid-write, just retry
      }
    }, 500);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', processing, mode: 'relay' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exchanges: history.slice(-20) }));
    return;
  }

  if (req.method === 'POST' && req.url === '/message') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || text.trim().length < 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No text' }));
          return;
        }
        if (processing) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Still waiting for response, hang on' }));
          return;
        }

        processing = true;
        console.log(`\n[Voice] Casey said: "${text.trim()}"`);

        // Clean up any stale outbox
        try { fs.unlinkSync(OUTBOX); } catch {}

        // Write to inbox for the CLI session to pick up
        fs.writeFileSync(INBOX, JSON.stringify({
          text: text.trim(),
          timestamp: Date.now()
        }));

        console.log('[Relay] Wrote to inbox, waiting for CLI response...');

        try {
          const response = await waitForOutbox();
          processing = false;
          history.push({ user: text.trim(), assistant: response, ts: Date.now() });
          if (history.length > 50) history.shift();
          console.log(`[Relay] Got response: ${response.slice(0, 200)}${response.length > 200 ? '...' : ''}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response }));
        } catch (err) {
          processing = false;
          console.error('[Relay] Timeout — no response from CLI session');
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No response from CLI — is Claude Code running?' }));
        }
      } catch {
        processing = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  CASEY VOICE BRIDGE — Relay Mode');
  console.log(`  http://localhost:${PORT}`);
  console.log('  Tunnel: voice.dykesmotors.com');
  console.log('');
  console.log('  Phone voice → inbox file → CLI session');
  console.log('  CLI response → outbox file → phone');
  console.log('========================================');
  console.log('Waiting for messages from phone...');
});
