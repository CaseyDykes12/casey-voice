/**
 * Casey Voice Bridge
 * Receives voice text from phone → feeds to Claude Code CLI → returns response
 */

import http from 'http';
import { execFile } from 'child_process';

const PORT = 3456;
const CLAUDE_PATH = 'C:\\Users\\Cdyke\\.local\\bin\\claude.exe';
const WORKING_DIR = 'C:\\Users\\Cdyke';

let processing = false;

function runClaude(text) {
  return new Promise((resolve) => {
    console.log(`\n[Voice] Casey said: "${text}"`);
    console.log('[Claude] Processing...');

    execFile(
      CLAUDE_PATH,
      ['--print', text, '--continue', '--output-format', 'text'],
      {
        cwd: WORKING_DIR,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error && !stdout) {
          console.error('[Claude] Error:', error.message);
          resolve('Sorry, I had trouble processing that. Try again.');
          return;
        }
        const response = stdout.trim();
        console.log(`[Claude] Response: ${response.slice(0, 150)}${response.length > 150 ? '...' : ''}`);
        resolve(response);
      }
    );
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

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', processing }));
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
          res.end(JSON.stringify({ error: 'Still processing, hang on' }));
          return;
        }
        processing = true;
        const response = await runClaude(text.trim());
        processing = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response }));
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
  console.log('  CASEY VOICE BRIDGE');
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
  console.log('Waiting for messages from phone...');
});
