// dario shim runtime — loaded into a CC child process via NODE_OPTIONS=--require
//
// CommonJS by necessity: --require only accepts CJS. Hand-written, no build step.
//
// Responsibilities, in order of importance:
//   1. Patch globalThis.fetch so outbound POSTs to *.anthropic.com/v1/messages
//      are rewritten with the dario template (system blocks, tools, fingerprint headers).
//   2. Peek the response headers and relay billing markers
//      (anthropic-ratelimit-unified-representative-claim and friends) to the
//      dario host over a unix/named-pipe socket if DARIO_SHIM_SOCK is set.
//   3. Be invisible when DARIO_SHIM is unset — so dario can install the require
//      globally without breaking unrelated Node processes.
//   4. Failsafe: any internal error falls through to the original fetch. The shim
//      must never break the host process. CC's retry/auth/streaming logic stays intact.

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const TEMPLATE_PATH = process.env.DARIO_SHIM_TEMPLATE
  || path.join(os.homedir(), '.dario', 'cc-template.live.json');
const RELAY_SOCK = process.env.DARIO_SHIM_SOCK || null;
const VERBOSE = process.env.DARIO_SHIM_VERBOSE === '1';

function log(msg) {
  if (VERBOSE) {
    try { process.stderr.write(`[dario-shim] ${msg}\n`); } catch (_) { /* noop */ }
  }
}

let template = null;
function loadTemplate() {
  if (template) return template;
  try {
    const raw = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.agent_identity && parsed.system_prompt && Array.isArray(parsed.tools)) {
      template = parsed;
      log(`template loaded from ${TEMPLATE_PATH} (cc_version=${parsed.cc_version || 'unknown'})`);
      return template;
    }
    log(`template at ${TEMPLATE_PATH} missing required fields — passthrough`);
  } catch (e) {
    log(`template load failed: ${e.message} — passthrough`);
  }
  return null;
}

let relaySock = null;
function relay(event) {
  if (!RELAY_SOCK) return;
  try {
    if (!relaySock) {
      relaySock = net.createConnection(RELAY_SOCK);
      relaySock.on('error', () => { relaySock = null; });
    }
    relaySock.write(JSON.stringify(event) + '\n');
  } catch (_) { /* relay is best-effort */ }
}

function isAnthropicMessages(url) {
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    return /(^|\.)anthropic\.com$/.test(u.hostname) && u.pathname === '/v1/messages';
  } catch (_) {
    return false;
  }
}

function rewriteBody(bodyText, tmpl) {
  let body;
  try { body = JSON.parse(bodyText); } catch (_) { return null; }
  if (!body || typeof body !== 'object') return null;

  // CC system shape: array of 3 blocks — billing tag, agent identity, system prompt.
  // We replace blocks [1] and [2] with template values; block [0] (the billing tag)
  // is left alone since the host process owns its OAuth context.
  if (Array.isArray(body.system) && body.system.length >= 1) {
    const billingTag = body.system[0];
    body.system = [
      billingTag,
      { type: 'text', text: tmpl.agent_identity, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: tmpl.system_prompt,  cache_control: { type: 'ephemeral', ttl: '1h' } },
    ];
  }
  body.tools = tmpl.tools;
  return JSON.stringify(body);
}

function rewriteHeaders(headers, tmpl) {
  // Headers in fetch() init can be Headers, plain object, or array of pairs.
  // Normalize into a plain object so we can mutate, then return Headers.
  const out = new Headers(headers || {});
  if (tmpl.cc_version) {
    out.set('user-agent', `claude-cli/${tmpl.cc_version} (external, cli)`);
    out.set('x-anthropic-billing-header', `cc_version=${tmpl.cc_version}`);
  }
  out.set('anthropic-beta', tmpl.anthropic_beta || 'claude-code-20250219');
  return out;
}

function shouldIntercept(input, init) {
  const method = (init && init.method) || (input && input.method) || 'GET';
  if (String(method).toUpperCase() !== 'POST') return false;
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  return isAnthropicMessages(url);
}

const originalFetch = globalThis.fetch;

function installFetchPatch() {
  if (typeof originalFetch !== 'function') {
    log('globalThis.fetch is not a function — shim disabled');
    return;
  }
  globalThis.fetch = darioShimFetch;
}

async function darioShimFetch(input, init) {
  try {
    if (!shouldIntercept(input, init)) {
      return originalFetch.call(this, input, init);
    }

    const tmpl = loadTemplate();
    if (!tmpl) return originalFetch.call(this, input, init);

    let bodyText;
    if (init && typeof init.body === 'string') {
      bodyText = init.body;
    } else if (input && typeof input.text === 'function') {
      bodyText = await input.clone().text();
    } else {
      log('unsupported body shape — passthrough');
      return originalFetch.call(this, input, init);
    }

    const rewritten = rewriteBody(bodyText, tmpl);
    if (!rewritten) {
      log('body rewrite failed — passthrough');
      return originalFetch.call(this, input, init);
    }

    const newInit = Object.assign({}, init || {}, {
      method: 'POST',
      body: rewritten,
      headers: rewriteHeaders((init && init.headers) || (input && input.headers), tmpl),
    });
    const url = typeof input === 'string' ? input : input.url;

    relay({ kind: 'request', timestamp: Date.now(), bytes: rewritten.length });
    const response = await originalFetch.call(this, url, newInit);

    const claim = response.headers.get('anthropic-ratelimit-unified-representative-claim');
    const overage = response.headers.get('anthropic-ratelimit-unified-overage-utilization');
    relay({
      kind: 'response',
      timestamp: Date.now(),
      status: response.status,
      claim: claim || null,
      overageUtil: overage ? parseFloat(overage) : null,
    });
    return response;
  } catch (e) {
    log(`shim fetch error: ${e.message} — passthrough`);
    return originalFetch.call(this, input, init);
  }
};

if (process.env.DARIO_SHIM === '1') {
  installFetchPatch();
}

// Internal hooks for unit tests. Always exported so tests can require this
// file without setting DARIO_SHIM (which would patch the test process's fetch).
module.exports = {
  _rewriteBody: rewriteBody,
  _rewriteHeaders: rewriteHeaders,
  _shouldIntercept: shouldIntercept,
  _isAnthropicMessages: isAnthropicMessages,
  _darioShimFetch: darioShimFetch,
  _installFetchPatch: installFetchPatch,
};
