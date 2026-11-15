import fs from 'node:fs';
import { scan } from '/usr/local/lib/node_modules/@sonar/scan/src/index.js';
// This file is image-owned. No candidate module, config or executable is loaded.
const options = JSON.parse(fs.readFileSync('/config/options.json', 'utf8'));
if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(options['sonar.host.url'])) {
  throw new Error('loopback_server_required');
}
await scan({ options });
