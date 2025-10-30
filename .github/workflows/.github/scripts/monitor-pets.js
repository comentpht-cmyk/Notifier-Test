#!/usr/bin/env node

/**
 * monitor-pets.js
 *
 * - Se DATA_API_URL (env) estiver definido, espera JSON de array de pets a partir dessa URL.
 *   Formato esperado (exemplo): [{ "id": "pet1", "name": "Fofo" }, { "id":"pet2", "name":"Bicho" }]
 *   O script tenta usar campo "id" para comparação; se não existir, usa JSON.stringify do item.
 *
 * - Caso DATA_API_URL não seja fornecido, busca TARGET_URL (a página joiner) e usa o body inteiro como "conteúdo".
 *   Neste modo (HTML fallback) o script só detecta "mudança de conteúdo" — não difere pets individualmente.
 *
 * - Compara com o arquivo pets-state.json no repo. Se houver mudanças:
 *    - Envia webhook para DISCORD_WEBHOOK_URL com detalhes (novos/remoções ou aviso de mudança).
 *    - Atualiza pets-state.json, faz commit e push (se GITHUB_TOKEN estiver disponível).
 *
 * Requisitos: Node 18+ (fetch global). Rodado dentro de GitHub Actions.
 */

const fs = require('fs');
const { execSync } = require('child_process');

const webhook = process.env.DISCORD_WEBHOOK_URL;
const dataApiUrl = (process.env.DATA_API_URL || '').trim();
const targetUrl = (process.env.TARGET_URL || '').trim();
const stateFile = 'pets-state.json';
const githubToken = process.env.GITHUB_TOKEN;
const githubRepo = process.env.GITHUB_REPOSITORY; // owner/repo, disponível no Actions

if (!webhook) {
  console.error('ERRO: DISCORD_WEBHOOK_URL não está definido.');
  process.exit(1);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Erro ao buscar JSON: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Erro ao buscar URL: ${res.status} ${res.statusText}`);
  return res.text();
}

function loadState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function uniqBy(arr, fn) {
  const seen = new Set();
  return arr.filter(item => {
    const k = fn(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function sendDiscord(embed) {
  const payload = { embeds: [embed] };
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao enviar webhook: ${res.status} ${res.statusText} - ${text}`);
  }
}

function shortList(items, limit = 10) {
  if (!items || items.length === 0) return '—';
  return items.slice(0, limit).map(it => `• ${it}`).join('\n') + (items.length > limit ? `\n...(+${items.length - limit})` : '');
}

async function commitAndPushState(commitMessage = 'Atualiza estado dos pets (automatizado)') {
  if (!githubToken || !githubRepo) {
    console.log('GITHUB_TOKEN ou GITHUB_REPOSITORY não disponível — pulando commit');
    return;
  }
  try {
    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    // Ajustar origin para usar token (evita prompt)
    const remote = `https://x-access-token:${githubToken}@github.com/${githubRepo}.git`;
    execSync(`git remote set-url origin ${remote}`);
    execSync('git add ' + stateFile);
    execSync(`git commit -m "${commitMessage}" || true`);
    execSync('git push origin HEAD');
    console.log('Estado salvo e push realizado.');
  } catch (e) {
    console.error('Erro ao commitar/push:', e.message);
  }
}

(async () => {
  try {
    const previous = loadState(); // pode ser null no primeiro run

    if (dataApiUrl) {
      // Espera JSON array
      const json = await fetchJson(dataApiUrl);
      if (!Array.isArray(json)) throw new Error('DATA_API_URL retornou JSON, mas não é um array');
      // Normaliza: cada item terá um keyId (id ou JSON stringify)
      const normalize = item => {
        if (item && (item.id || item.id === 0)) return { key: String(item.id), object: item };
        return { key: JSON.stringify(item), object: item };
      };
      const current = uniqBy(json.map(normalize), x => x.key);

      const prevMap = new Map();
      if (previous && Array.isArray(previous.pets)) {
        for (const p of previous.pets) {
          const key = p.key || (p.id ? String(p.id) : JSON.stringify(p));
          prevMap.set(key, p.object || p);
        }
      }

      const added = [];
      const removed = [];

      for (const c of current) {
        if (!prevMap.has(c.key)) added.push(c.object);
      }
      for (const [k, v] of prevMap.entries()) {
        if (!current.find(x => x.key === k)) removed.push(v);
      }

      if (added.length === 0 && removed.length === 0 && previous) {
        console.log('Nenhuma mudança detectada.');
        return;
      }

      // Monta embed para Discord
      const embed = {
        title: previous ? 'Atualização de pets' : 'Estado inicial dos pets',
        description: dataApiUrl,
        color: added.length ? 3066993 : 15105570,
        fields: [],
        timestamp: new Date().toISOString()
      };

      if (added.length) embed.fields.push({ name: `Novos (${added.length})`, value: shortList(added.map(it => it.name || JSON.stringify(it))), inline: false });
      if (removed.length) embed.fields.push({ name: `Removidos (${removed.length})`, value: shortList(removed.map(it => it.name || JSON.stringify(it))), inline: false });
      if (!added.length && !removed.length) embed.description += '\nConteúdo alterado (diferença não estruturada).';

      await sendDiscord(embed);

      // Salva novo estado (guardando key e object para comparações futuras)
      const newState = { pets: current.map(c => ({ key: c.key, object: c.object })) };
      saveState(newState);
      await commitAndPushState(added.length ? `Adiciona ${added.length} pet(s)` : `Remove ${removed.length} pet(s)`);

      console.log('Notificação enviada e estado atualizado.');

    } else if (targetUrl) {
      // Fallback: baixa HTML/texto e compara por hash (ou por conteúdo)
      const text = await fetchText(targetUrl);
      const hash = require('crypto').createHash('sha256').update(text).digest('hex');
      if (previous && previous.hash === hash) {
        console.log('Nenhuma alteração no conteúdo da página.');
        return;
      }

      const embed = {
        title: previous ? 'Mudança detectada na página' : 'Estado inicial (página salvo)',
        description: targetUrl,
        color: previous ? 15105570 : 3447003,
        fields: [
          { name: 'Hash (SHA-256)', value: hash },
          { name: 'Primeiros 800 chars', value: text.slice(0, 800) || '—' }
        ],
        timestamp: new Date().toISOString()
      };
      await sendDiscord(embed);

      // salva novo estado com hash
      saveState({ hash, updated_at: new Date().toISOString() });
      await commitAndPushState('Atualiza hash da página (detector de mudanças)');

      console.log('Notificação enviada e hash salvo.');
    } else {
      console.error('Nenhuma URL fornecida (TARGET_URL ou DATA_API_URL).');
      process.exit(1);
    }
  } catch (err) {
    console.error('Erro no monitor-pets:', err);
    process.exit(2);
  }
})();
