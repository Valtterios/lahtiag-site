// node scripts/handbook/shoot.mjs scripts/handbook/shots.json scripts/handbook/shots [name,name]
// Full-page screenshots of the local site (wrangler dev on :8788) plus the
// page coordinates of the clip and highlight elements; cropping and drawing
// happen in post.py. Needs `npm i --no-save playwright-core` and the
// throwaway cookies from mint.mjs next to this file.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const [manifestPath, outDir] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cookies = JSON.parse(readFileSync(new URL('./cookies.json', import.meta.url), 'utf8'));
const only = process.argv[4] ? new Set(process.argv[4].split(',')) : null;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const base = manifest.base;
for (const shot of manifest.shots) {
  if (only && !only.has(shot.name)) continue;
  const mobile = shot.device === 'mobile';
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: shot.width ?? 1280, height: shot.height ?? 900 },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: 'light',
    locale: 'en-GB',
    timezoneId: 'Europe/Helsinki',
  });
  const jar = [];
  const add = (name, value) => jar.push({ name, value, domain: new URL(base).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  const names = { admin: 'Aino', member: 'Mikko', ben: 'Ben', sara: 'Sara' };
  if (names[shot.as]) {
    add('__Host-session', cookies[shot.as]);
    add('__Host-account', names[shot.as]);
  }
  if (shot.as === 'admin' || shot.as === 'board') add('__Host-board', cookies.board);
  if (jar.length) {
    // __Host- cookies over plain http: Chrome's jar may refuse them, in
    // which case the header goes on every request instead.
    try {
      await ctx.addCookies(jar);
    } catch {
      await ctx.setExtraHTTPHeaders({ cookie: jar.map((c) => `${c.name}=${c.value}`).join('; ') });
    }
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  const response = await page.goto(base + shot.url, { waitUntil: 'networkidle' });
  for (const sel of shot.open ?? []) {
    await page.evaluate((s) => document.querySelectorAll(s).forEach((d) => { d.open = true; }), sel);
  }
  for (const sel of shot.click ?? []) await page.click(sel);
  for (const [sel, value] of shot.fill ?? []) await page.fill(sel, value);
  if (shot.eval) await page.evaluate(shot.eval);
  // The floating "Board view" pill lands mid-page in a full-page capture.
  if (!shot.keepPill) await page.evaluate(() => document.querySelectorAll('.view-as').forEach((el) => el.remove()));
  // Lazy pictures never load in a full-page capture unless asked to.
  await page.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
    await Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => {}))));
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(shot.wait ?? 400);
  // Open <details> by the start of their summary text.
  for (const text of shot.openText ?? []) {
    await page.evaluate((t) => {
      const norm = (v) => v.replace(/\s+/g, ' ').trim().toLowerCase();
      for (const sum of document.querySelectorAll('summary')) {
        if (norm(sum.textContent).startsWith(norm(t))) sum.parentElement.open = true;
      }
    }, text);
  }
  await page.waitForTimeout(150);
  const rects = await page.evaluate(({ clip, hl }) => {
    const norm = (v) => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    // A target: a CSS selector, {sel, i}, 'text=Exact', 'text^=Prefix',
    // 'details^=Prefix' (the details behind that summary) or
    // {text, prefix, closest, i}.
    const byText = (t, prefix, tags = 'a, button, summary, label, h1, h2, h3, strong, input[type=submit]') => {
      const out = [];
      for (const el of document.querySelectorAll(tags)) {
        const v = norm(el.value && el.tagName === 'INPUT' ? el.value : el.textContent);
        if (prefix ? v.startsWith(norm(t)) : v === norm(t)) out.push(el);
      }
      return out;
    };
    const find = (spec) => {
      if (typeof spec === 'string') {
        if (spec.startsWith('details^=')) return byText(spec.slice(9), true, 'summary')[0]?.parentElement ?? null;
        if (spec.startsWith('text^=')) return byText(spec.slice(6), true)[0] ?? null;
        if (spec.startsWith('text=')) return byText(spec.slice(5), false)[0] ?? null;
        return document.querySelector(spec);
      }
      if (spec.text) {
        const el = byText(spec.text, spec.prefix)[spec.i ?? 0] ?? null;
        return el && spec.closest ? el.closest(spec.closest) : el;
      }
      return document.querySelectorAll(spec.sel)[spec.i ?? 0] ?? null;
    };
    const rect = (spec) => {
      const el = find(spec);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    };
    return {
      clip: clip ? rect(clip) : null,
      hl: (hl ?? []).map(rect),
      page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    };
  }, { clip: shot.clip ?? null, hl: shot.hl ?? [] });
  const png = await page.screenshot({ fullPage: !shot.viewportOnly, type: 'png' });
  writeFileSync(`${outDir}/${shot.name}.png`, png);
  writeFileSync(`${outDir}/${shot.name}.json`, JSON.stringify({ ...rects, status: response?.status(), errors, shot }));
  console.log(shot.name, response?.status(), 'clip', rects.clip ? 'ok' : (shot.clip ? 'MISSING' : '-'), 'hl', rects.hl.filter(Boolean).length + '/' + (shot.hl ?? []).length, errors.length ? 'console errors: ' + errors.length : '');
  await ctx.close();
}
await browser.close();
