/**
 * Loads a local `.env` file (for running on your own computer / VS Code).
 * On Railway you use the Variables tab instead, and this file does nothing.
 * Real environment variables always win over values in .env.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.cwd(), '.env');
if (fs.existsSync(file)) {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && value && process.env[key] === undefined) process.env[key] = value;
  }
  console.log('Loaded settings from .env');
}
