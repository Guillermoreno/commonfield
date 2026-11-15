import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
/** Never log arbitrary exception messages or SQL: either may contain secrets. */
export async function diagnostic(phase, error, mutation = 'uncertain', dir = '/tmp') {
  const runId = randomUUID();
  const report = {release:'0.1.0',runId,phase,reason:error?.constructor?.name === 'EmailConfigurationError' ? 'email_configuration_invalid' : 'operation_failed',exception:error?.constructor?.name ?? 'Unknown',mutation,exitStatus:1,
    stackLocations: String(error?.stack ?? '').split('\n').slice(1,7).map(x=>x.replace(/\(.*\//,'(')).filter(x=>/^\s+at /.test(x))};
  const path = `${dir}/commonfield-${phase}-${runId}.json`;
  try { await writeFile(path,JSON.stringify(report,null,2),{mode:0o600}); console.error(`Commonfield ${phase} failed (${report.reason}); sanitized diagnostic: ${path}`); }
  catch { console.error(JSON.stringify({...report,stackLocations:[],reason:'diagnostic_sink_unavailable'})); }
}
