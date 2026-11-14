const { execFile } = require('node:child_process');
const tokenCache = new Map();
const resources = new Set(['https://ai.azure.com', 'https://management.azure.com', 'https://api.applicationinsights.io']);

function runAzure(args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    execFile('az', args, { shell: process.platform === 'win32', timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(Object.assign(new Error('Azure CLI is unavailable or not signed in. Install Azure CLI and sign in using Settings or az login.'), { status: 424 }));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Azure CLI returned invalid JSON.')); }
    });
  });
}

async function azToken(resource = 'https://ai.azure.com') {
  if (!resources.has(resource)) throw new Error('Unsupported Azure token resource.');
  const cached = tokenCache.get(resource);
  if (cached && Date.now() < cached.exp) return cached.value;
  const data = await runAzure(['account', 'get-access-token', '--resource', resource, '-o', 'json']);
  if (!data.accessToken) throw new Error('Azure CLI did not return an access token.');
  const expiration = data.expires_on ? Number(data.expires_on) * 1000 : Date.parse(data.expiresOn);
  tokenCache.set(resource, { value: data.accessToken, exp: Math.min(expiration || Date.now() + 5 * 60000, Date.now() + 30 * 60000) - 60000 });
  return data.accessToken;
}

let loginState = { status: 'idle' };
let loginChild;
function startLogin() {
  if (loginState.status === 'pending') return { ...loginState };
  tokenCache.clear();
  loginState = { status: 'pending', verificationUrl: 'https://microsoft.com/devicelogin', userCode: '' };
  loginChild = execFile('az', ['login', '--use-device-code', '--allow-no-subscriptions', '--output', 'none'], {
    shell: process.platform === 'win32', timeout: 180000, windowsHide: true, maxBuffer: 65536,
  }, (err) => {
    loginChild = null;
    tokenCache.clear();
    loginState = err
      ? { status: 'error', error: 'Azure sign-in failed or expired. Ensure Azure CLI is installed and retry, or run az login in the backend environment.' }
      : { status: 'ok' };
  });
  let output = '';
  const capture = (chunk) => {
    output = (output + chunk.toString()).slice(-4096);
    const code = output.match(/code\s+([A-Z0-9-]{6,16})\b/i);
    if (code && loginState.status === 'pending') loginState.userCode = code[1];
  };
  loginChild.stdout.on('data', capture);
  loginChild.stderr.on('data', capture);
  return { ...loginState };
}

async function status() {
  const account = await runAzure(['account', 'show', '-o', 'json']);
  return { connected: true, username: account.user?.name || '', subscription: account.name || '', tenantId: account.tenantId || '' };
}

function stopLogin() { if (loginChild) loginChild.kill(); }

module.exports = { azToken, status, startLogin, loginStatus: () => ({ ...loginState }), stopLogin };
