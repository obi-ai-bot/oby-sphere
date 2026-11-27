// The console's secret (rep.mjs ui), for tests. Each console makes a new one when it starts and
// keeps it in its profile (console-auth.json, 0600, one entry per port). A program of this user's
// reads it there and sends it in the x-obysphere-auth header, as the menu bar does; a browser
// gets it once in a link's fragment (#auth=…) and trades it for a cookie.
import fs from 'node:fs';
import path from 'node:path';

export const AUTH_HEADER = 'x-obysphere-auth';

// the secret of the console at `at` (a port, or its http://127.0.0.1:<port> address)
export function consoleSecret(profileDir, at) {
  const port = String(typeof at === 'number' ? at : new URL(at).port);
  const all = JSON.parse(fs.readFileSync(path.join(profileDir, 'console-auth.json'), 'utf8'));
  const s = all?.[port]?.secret;
  if (typeof s !== 'string') throw new Error(`no console secret for port ${port} in ${profileDir}`);
  return s;
}

// the header a local program sends
export const consoleAuth = (profileDir, at) => ({ [AUTH_HEADER]: consoleSecret(profileDir, at) });
