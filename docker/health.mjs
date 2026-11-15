try {
  const response=await fetch('http://127.0.0.1:4173/api/ready',{signal:AbortSignal.timeout(3000)});
  process.exit(response.ok && (await response.json()).ready ? 0:1);
} catch {process.exit(1);}
