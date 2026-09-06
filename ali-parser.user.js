// ==UserScript==
// @name         Ali Parser - Parsing Tracker
// @namespace    https://github.com/menteora/ali-parser
// @version      0.4.0
// @description  Mostra e salva lo stato degli articoli AliExpress anche nei suggerimenti dentro le pagine prodotto.
// @author       menteora
// @updateURL    https://raw.githubusercontent.com/menteora/ali-parser/main/ali-parser.user.js
// @downloadURL  https://raw.githubusercontent.com/menteora/ali-parser/main/ali-parser.user.js
// @match        https://aliexpress.com/*
// @match        https://*.aliexpress.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'ali-parser:products:v1';
  const UI_ATTR = 'data-ali-parser-ui';
  const CARD_ATTR = 'data-ali-parser-key';

  const state = {
    currentUrl: location.href,
    observer: null,
    scanTimer: null,
    toolbar: null,
    panel: null,
  };

  function loadRegistry() {
    const value = GM_getValue(STORE_KEY, {});
    return value && typeof value === 'object' ? value : {};
  }

  function saveRegistry(registry) {
    GM_setValue(STORE_KEY, registry);
  }

  function getRecord(key) {
    return loadRegistry()[key] || null;
  }

  function patchRecord(key, patch) {
    const registry = loadRegistry();
    const previous = registry[key] || { key };
    registry[key] = {
      ...previous,
      ...patch,
      key,
      updatedAt: Date.now(),
    };
    saveRegistry(registry);
    refreshUi();
    return registry[key];
  }

  function deleteRecord(key) {
    const registry = loadRegistry();
    delete registry[key];
    saveRegistry(registry);
    refreshUi();
  }

  function safeDecode(value) {
    let current = String(value || '');
    for (let i = 0; i < 3; i += 1) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch (_) {
        break;
      }
    }
    return current;
  }

  function extractProductId(input) {
    if (!input) return null;

    const values = [String(input), safeDecode(input)];
    const patterns = [
      /\/item\/(\d{8,})(?:\.html)?/i,
      /(?:productId|product_id|itemId|item_id)[=/:](\d{8,})/i,
      /(?:productId|product_id|itemId|item_id)%3D(\d{8,})/i,
      /\b(100\d{10,})\b/,
    ];

    for (const value of values) {
      for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) return match[1];
      }

      try {
        const url = new URL(value, location.href);
        for (const name of ['productId', 'product_id', 'itemId', 'item_id']) {
          const candidate = url.searchParams.get(name);
          if (candidate && /^\d{8,}$/.test(candidate)) return candidate;
        }

        for (const name of ['url', 'redirect', 'redirectUrl', 'target', 'targetUrl', 'to']) {
          const nested = url.searchParams.get(name);
          if (!nested) continue;
          const nestedId = extractProductId(nested);
          if (nestedId) return nestedId;
        }
      } catch (_) {
        // Continua con gli altri formati.
      }
    }

    return null;
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeHref(href) {
    try {
      const url = new URL(href, location.href);
      for (const name of [...url.searchParams.keys()]) {
        if (/^(spm|gatewayAdapt|sourceType|channel|aff_|algo_|scm|pvid|utparam|businessType)/i.test(name)) {
          url.searchParams.delete(name);
        }
      }
      url.hash = '';
      return url.toString();
    } catch (_) {
      return String(href || '');
    }
  }

  function productIdentityFromAnchor(anchor) {
    if (!anchor) return null;

    const sources = [
      anchor.href,
      anchor.getAttribute('href'),
      anchor.dataset?.productId,
      anchor.dataset?.itemId,
      anchor.getAttribute('data-product-id'),
      anchor.getAttribute('data-item-id'),
      anchor.outerHTML?.slice(0, 5000),
    ].filter(Boolean);

    let productId = null;
    for (const source of sources) {
      productId = extractProductId(source);
      if (productId) break;
    }

    if (productId) {
      return {
        key: productId,
        productId,
        href: anchor.href || '',
        fallback: false,
      };
    }

    const href = normalizeHref(anchor.href || anchor.getAttribute('href') || '');
    if (!href || !looksLikeProductHref(href)) return null;

    return {
      key: `url:${hashString(href)}`,
      productId: null,
      href,
      fallback: true,
    };
  }

  function looksLikeProductHref(href) {
    const value = safeDecode(href).toLowerCase();
    return value.includes('/item/') ||
      value.includes('productid') ||
      value.includes('itemid') ||
      value.includes('/pdp/') ||
      value.includes('product-detail') ||
      /\b100\d{10,}\b/.test(value);
  }

  function currentProductId() {
    return extractProductId(location.href);
  }

  function isProductPage() {
    return Boolean(currentProductId()) || /\/item\//i.test(location.pathname);
  }

  function visibleImageIn(node) {
    const images = node.querySelectorAll?.('img') || [];
    for (const image of images) {
      const rect = image.getBoundingClientRect();
      if (rect.width >= 70 && rect.height >= 70) return image;
    }
    return null;
  }

  function countProductLinks(node, stopAfter = 3) {
    const keys = new Set();
    const links = node.querySelectorAll?.('a[href]') || [];

    for (const link of links) {
      const identity = productIdentityFromAnchor(link);
      if (!identity) continue;
      keys.add(identity.key);
      if (keys.size >= stopAfter) break;
    }

    return keys.size;
  }

  function findCard(anchor) {
    const preferred = [
      '.search-card-item',
      '[class*="search-card"]',
      '[class*="product-card"]',
      '[class*="productCard"]',
      '[class*="card-out-wrapper"]',
      '[class*="product-item"]',
      '[class*="productItem"]',
      '[class*="recommend"]',
      '[class*="Recommend"]',
      '[data-product-id]',
      '[data-item-id]',
    ];

    for (const selector of preferred) {
      const node = anchor.closest(selector);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 90 && rect.height >= 90 && visibleImageIn(node)) return node;
    }

    let node = anchor;
    let best = null;

    for (let depth = 0; depth < 9 && node && node !== document.body; depth += 1, node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 90 || rect.height < 90 || rect.width > 700 || rect.height > 900) continue;
      if (!visibleImageIn(node)) continue;

      const productLinks = countProductLinks(node, 3);
      if (productLinks > 2) continue;

      best = node;
      if (productLinks === 1 && rect.width >= 140 && rect.height >= 140) break;
    }

    if (best) return best;

    const image = anchor.querySelector('img');
    if (image && anchor instanceof HTMLElement) return anchor;

    return null;
  }

  function statusInfo(record) {
    if (!record) return { label: 'Nuovo', cls: 'ap-new' };
    if (record.status === 'parsed') return { label: 'Parsato', cls: 'ap-parsed' };
    if (record.status === 'flagged') return { label: 'Flag manuale', cls: 'ap-flagged' };
    if (record.lastOpenedAt) return { label: 'Visto', cls: 'ap-viewed' };
    return { label: 'Nuovo', cls: 'ap-new' };
  }

  function toggleManualFlag(identity) {
    const record = getRecord(identity.key);

    if (record?.status === 'parsed') {
      const reset = confirm('Questo articolo risulta gia parsato. Vuoi togliere il check e azzerare lo stato?');
      if (reset) deleteRecord(identity.key);
      return;
    }

    if (record?.status === 'flagged') {
      deleteRecord(identity.key);
      return;
    }

    patchRecord(identity.key, {
      productId: identity.productId,
      status: 'flagged',
      flaggedAt: Date.now(),
      parsedAt: null,
      href: identity.href,
      identityFallback: identity.fallback,
    });
  }

  function mountCheckbox(card, identity) {
    let control = card.querySelector(`:scope > [${UI_ATTR}="card-check"]`);

    if (!control) {
      control = document.createElement('button');
      control.type = 'button';
      control.setAttribute(UI_ATTR, 'card-check');
      control.className = 'ap-card-check';
      control.innerHTML = '<span class="ap-checkmark"></span><span class="ap-card-label"></span>';

      const computed = getComputedStyle(card);
      if (computed.position === 'static') card.style.setProperty('position', 'relative', 'important');

      control.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const key = control.dataset.key;
        const liveIdentity = {
          key,
          productId: control.dataset.productId || null,
          href: control.dataset.href || '',
          fallback: control.dataset.fallback === '1',
        };
        toggleManualFlag(liveIdentity);
      }, true);

      card.appendChild(control);
    }

    control.dataset.key = identity.key;
    control.dataset.productId = identity.productId || '';
    control.dataset.href = identity.href || '';
    control.dataset.fallback = identity.fallback ? '1' : '0';
    updateCheckbox(control, identity.key);
  }

  function updateCheckbox(control, key) {
    const record = getRecord(key);
    const info = statusInfo(record);
    const checkmark = control.querySelector('.ap-checkmark');
    const label = control.querySelector('.ap-card-label');

    control.className = `ap-card-check ${info.cls}`;
    control.title = record?.status === 'parsed'
      ? 'Gia parsato. Clicca per azzerare.'
      : record?.status === 'flagged'
        ? 'Flag manuale attivo. Clicca per rimuoverlo.'
        : record?.lastOpenedAt
          ? 'Gia visto. Clicca per mettere il check manuale.'
          : 'Clicca per segnare questo articolo come gia gestito.';

    control.setAttribute('aria-label', info.label);

    if (record?.status === 'parsed') {
      checkmark.textContent = '✓';
      label.textContent = 'PARSATO';
    } else if (record?.status === 'flagged') {
      checkmark.textContent = '✓';
      label.textContent = 'FLAG';
    } else if (record?.lastOpenedAt) {
      checkmark.textContent = '•';
      label.textContent = 'VISTO';
    } else {
      checkmark.textContent = '';
      label.textContent = '';
    }
  }

  function collectCards() {
    const visibleKeys = new Set();
    const mountedCards = new WeakSet();
    const anchors = document.querySelectorAll('a[href]');
    const current = isProductPage() ? currentIdentity() : null;
    const currentKey = current?.key || null;

    for (const anchor of anchors) {
      if (anchor.closest(`[${UI_ATTR}]`)) continue;

      const identity = productIdentityFromAnchor(anchor);
      if (!identity) continue;

      // Nella pagina prodotto non applicare il badge al prodotto principale.
      // Gli altri link prodotto sono suggerimenti, correlati, sponsorizzati, ecc.
      if (currentKey && identity.key === currentKey) continue;

      const card = findCard(anchor);
      if (!card) continue;
      if (mountedCards.has(card)) continue;

      const existingKey = card.getAttribute(CARD_ATTR);
      if (existingKey && existingKey !== identity.key) continue;

      mountedCards.add(card);
      visibleKeys.add(identity.key);
      card.setAttribute(CARD_ATTR, identity.key);
      mountCheckbox(card, identity);
    }

    return visibleKeys;
  }

  function renderToolbar(visibleKeys) {
    if (isProductPage()) {
      state.toolbar?.remove();
      state.toolbar = null;
      return;
    }

    if (!state.toolbar) {
      state.toolbar = document.createElement('div');
      state.toolbar.setAttribute(UI_ATTR, 'toolbar');
      state.toolbar.className = 'ap-toolbar';
      document.body.appendChild(state.toolbar);
    }

    const keys = visibleKeys || new Set(
      [...document.querySelectorAll(`[${CARD_ATTR}]`)]
        .map((el) => el.getAttribute(CARD_ATTR))
        .filter(Boolean)
    );

    let parsed = 0;
    let flagged = 0;
    let viewed = 0;
    let fresh = 0;

    for (const key of keys) {
      const record = getRecord(key);
      if (record?.status === 'parsed') parsed += 1;
      else if (record?.status === 'flagged') flagged += 1;
      else if (record?.lastOpenedAt) viewed += 1;
      else fresh += 1;
    }

    state.toolbar.innerHTML = `
      <strong>Ali Parser</strong>
      <span>${keys.size} schede</span>
      <span class="ap-tb-parsed">✓ ${parsed} parsate</span>
      <span class="ap-tb-flagged">✓ ${flagged} flag</span>
      <span>● ${viewed} viste</span>
      <span>□ ${fresh} nuove</span>
    `;
  }

  function currentIdentity() {
    const productId = currentProductId();
    if (productId) {
      return {
        key: productId,
        productId,
        href: location.href,
        fallback: false,
      };
    }

    if (/\/item\//i.test(location.pathname)) {
      const href = normalizeHref(location.href);
      return {
        key: `url:${hashString(href)}`,
        productId: null,
        href,
        fallback: true,
      };
    }

    return null;
  }

  function markCurrentOpened(identity) {
    if (!identity) return;
    const current = getRecord(identity.key) || {};
    patchRecord(identity.key, {
      productId: identity.productId,
      status: current.status || null,
      lastOpenedAt: Date.now(),
      href: location.href,
      title: document.querySelector('h1')?.textContent?.trim() || current.title || '',
      identityFallback: identity.fallback,
    });
  }

  function renderProductPanel() {
    const identity = currentIdentity();
    if (!identity) {
      state.panel?.remove();
      state.panel = null;
      return;
    }

    if (!state.panel) {
      state.panel = document.createElement('div');
      state.panel.setAttribute(UI_ATTR, 'product-panel');
      state.panel.className = 'ap-product-panel';
      document.body.appendChild(state.panel);
    }

    const record = getRecord(identity.key);
    const info = statusInfo(record);

    state.panel.innerHTML = `
      <div class="ap-panel-title">Ali Parser</div>
      <div class="ap-panel-status ${info.cls}">${escapeHtml(info.label)}</div>
      <label class="ap-panel-check-row">
        <input type="checkbox" data-action="flag" ${record?.status === 'flagged' || record?.status === 'parsed' ? 'checked' : ''}>
        <span>Gia gestito</span>
      </label>
      <button type="button" class="ap-panel-parsed" data-action="parsed">✓ Segna come parsato</button>
      <button type="button" class="ap-panel-reset" data-action="reset">Azzera stato</button>
    `;

    state.panel.querySelector('[data-action="flag"]').addEventListener('change', () => {
      toggleManualFlag(identity);
    });

    state.panel.querySelector('[data-action="parsed"]').addEventListener('click', () => {
      patchRecord(identity.key, {
        productId: identity.productId,
        status: 'parsed',
        parsedAt: Date.now(),
        flaggedAt: null,
        href: location.href,
        title: document.querySelector('h1')?.textContent?.trim() || '',
        identityFallback: identity.fallback,
      });
    });

    state.panel.querySelector('[data-action="reset"]').addEventListener('click', () => {
      deleteRecord(identity.key);
    });
  }

  function installNavigationGuard() {
    document.addEventListener('click', (event) => {
      if (event.target.closest(`[${UI_ATTR}]`)) return;
      const anchor = event.target.closest('a[href]');
      if (!anchor) return;

      const identity = productIdentityFromAnchor(anchor);
      if (!identity) return;

      const record = getRecord(identity.key);
      if (!record || !['parsed', 'flagged'].includes(record.status)) return;

      const label = record.status === 'parsed' ? 'GIA PARSATO' : 'GIA FLAGGATO';
      const proceed = confirm(`${label}\n\nVuoi aprire comunque questo articolo?`);
      if (!proceed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function refreshUi() {
    document.querySelectorAll(`[${UI_ATTR}="card-check"]`).forEach((control) => {
      if (control.dataset.key) updateCheckbox(control, control.dataset.key);
    });
    renderToolbar();
    renderProductPanel();
  }

  function handlePage() {
    if (isProductPage()) {
      state.toolbar?.remove();
      state.toolbar = null;
      const identity = currentIdentity();
      markCurrentOpened(identity);
      renderProductPanel();
      collectCards();
      return;
    }

    state.panel?.remove();
    state.panel = null;
    const visibleKeys = collectCards();
    renderToolbar(visibleKeys);
  }

  function exportRegistry() {
    const data = JSON.stringify(loadRegistry(), null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ali-parser-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function resetRegistry() {
    if (!confirm('Cancellare TUTTI gli stati salvati da Ali Parser?')) return;
    GM_deleteValue(STORE_KEY);
    refreshUi();
  }

  function installStyles() {
    if (document.querySelector(`[${UI_ATTR}="styles"]`)) return;

    const style = document.createElement('style');
    style.setAttribute(UI_ATTR, 'styles');
    style.textContent = `
      .ap-card-check {
        position: absolute !important;
        top: 8px !important;
        right: 8px !important;
        z-index: 2147483000 !important;
        min-width: 34px !important;
        height: 34px !important;
        padding: 0 8px !important;
        border: 2px solid #111 !important;
        border-radius: 7px !important;
        background: rgba(255,255,255,.96) !important;
        box-shadow: 0 2px 10px rgba(0,0,0,.28) !important;
        color: #111 !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 5px !important;
        pointer-events: auto !important;
        font: 900 12px/1 Arial, sans-serif !important;
        white-space: nowrap !important;
      }
      .ap-card-check:hover { transform: scale(1.05) !important; }
      .ap-card-check.ap-new { width: 34px !important; padding: 0 !important; background: rgba(255,255,255,.96) !important; border-color: #111 !important; }
      .ap-card-check.ap-flagged { background: #d47a00 !important; border-color: #9e5900 !important; color: #fff !important; }
      .ap-card-check.ap-parsed { background: #16813f !important; border-color: #0d5f2c !important; color: #fff !important; }
      .ap-card-check.ap-viewed { background: #fff !important; border-color: #2769ad !important; color: #2769ad !important; }
      .ap-checkmark { display: block !important; font-size: 19px !important; line-height: 1 !important; color: currentColor !important; }
      .ap-card-label { display: block !important; font-size: 10px !important; letter-spacing: .2px !important; color: currentColor !important; }

      .ap-toolbar {
        position: fixed !important;
        left: 14px !important;
        bottom: 14px !important;
        z-index: 2147483646 !important;
        display: flex !important;
        gap: 9px !important;
        align-items: center !important;
        padding: 9px 12px !important;
        border-radius: 10px !important;
        background: rgba(22,22,22,.94) !important;
        color: #fff !important;
        box-shadow: 0 5px 18px rgba(0,0,0,.28) !important;
        font: 12px/1.2 Arial, sans-serif !important;
      }
      .ap-toolbar strong { font-size: 13px !important; }
      .ap-tb-parsed { color: #7ee2a2 !important; }
      .ap-tb-flagged { color: #ffca78 !important; }

      .ap-product-panel {
        position: fixed !important;
        top: 86px !important;
        right: 18px !important;
        z-index: 2147483646 !important;
        width: 230px !important;
        box-sizing: border-box !important;
        padding: 13px !important;
        border: 2px solid #111 !important;
        border-radius: 12px !important;
        background: #fff !important;
        color: #111 !important;
        box-shadow: 0 7px 28px rgba(0,0,0,.32) !important;
        font: 13px/1.3 Arial, sans-serif !important;
      }
      .ap-panel-title { font-size: 15px !important; font-weight: 800 !important; margin-bottom: 8px !important; }
      .ap-panel-status { display: inline-block !important; margin-bottom: 10px !important; padding: 4px 8px !important; border-radius: 999px !important; font-weight: 800 !important; background: #eee !important; }
      .ap-panel-status.ap-parsed { background: #d9f5e3 !important; color: #0d5f2c !important; }
      .ap-panel-status.ap-flagged { background: #fff0d7 !important; color: #8a4b00 !important; }
      .ap-panel-status.ap-viewed { background: #e0efff !important; color: #1c568f !important; }
      .ap-panel-check-row {
        display: flex !important;
        align-items: center !important;
        gap: 9px !important;
        margin: 3px 0 10px !important;
        cursor: pointer !important;
        font-weight: 700 !important;
      }
      .ap-panel-check-row input {
        width: 22px !important;
        height: 22px !important;
        accent-color: #d47a00 !important;
        cursor: pointer !important;
      }
      .ap-product-panel button {
        width: 100% !important;
        box-sizing: border-box !important;
        margin-top: 6px !important;
        padding: 8px 10px !important;
        border-radius: 7px !important;
        cursor: pointer !important;
        font: 700 12px/1.2 Arial, sans-serif !important;
      }
      .ap-panel-parsed { border: 0 !important; background: #16813f !important; color: #fff !important; }
      .ap-panel-reset { border: 1px solid #bbb !important; background: #fff !important; color: #444 !important; }
    `;
    document.head.appendChild(style);
  }

  function scheduleScan(delay = 300) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      const visibleKeys = collectCards();
      if (!isProductPage()) {
        renderToolbar(visibleKeys);
      }
    }, delay);
  }

  function startObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => scheduleScan());
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function watchUrlChanges() {
    setInterval(() => {
      if (state.currentUrl === location.href) return;
      state.currentUrl = location.href;
      setTimeout(handlePage, 250);
    }, 600);
  }

  GM_addValueChangeListener(STORE_KEY, () => refreshUi());
  GM_registerMenuCommand('Ali Parser: esporta registro JSON', exportRegistry);
  GM_registerMenuCommand('Ali Parser: azzera tutti gli stati', resetRegistry);

  installStyles();
  installNavigationGuard();
  startObserver();
  watchUrlChanges();
  handlePage();
  setTimeout(handlePage, 1000);
  setTimeout(handlePage, 2500);
})();
