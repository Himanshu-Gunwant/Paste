import type { Request, RequestHandler, Response } from 'express';
import hljs from 'highlight.js';
import * as pasteService from '../services/paste.service.js';
import type { PasteWithAuthor } from '../services/paste.service.js';

/**
 * Embeddable paste viewer (docs/ARCHITECTURE.md §4 I):
 * - server-rendered HTML — content is ESCAPED and highlighted with
 *   highlight.js (lexical only, never executed, §13);
 * - strict CSP `default-src 'none'` + `frame-ancestors *`, X-Frame-Options
 *   removed (embed route only);
 * - public + unlisted embeddable; private ONLY with a share token;
 *   password-protected NOT embeddable (uniform 404 HTML — no gate inside
 *   iframes);
 * - burn/max-view consumption applies (an embed view is a view).
 */
interface EmbedOptions {
  theme: 'dark' | 'light';
  showLines: boolean;
  rangeStart?: number;
  rangeEnd?: number;
}

function parseEmbedOptions(query: Record<string, unknown>): EmbedOptions {
  const theme = query['theme'] === 'light' ? 'light' : 'dark';
  const showLines = query['lines'] !== 'off';
  let rangeStart: number | undefined;
  let rangeEnd: number | undefined;
  const range = typeof query['range'] === 'string' ? query['range'] : undefined;
  if (range) {
    const match = /^(\d+)-(\d+)$/.exec(range);
    if (match) {
      const start = Number.parseInt(match[1]!, 10);
      const end = Number.parseInt(match[2]!, 10);
      if (start >= 1 && end >= start && end - start <= 5000) {
        rangeStart = start;
        rangeEnd = end;
      }
    }
  }
  return { theme, showLines, rangeStart, rangeEnd };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderError(status: number): { status: number; html: string } {
  return {
    status,
    html: `<!doctype html><html><body style="font-family:system-ui;padding:24px"><p>This paste cannot be embedded.</p></body></html>`,
  };
}

function renderEmbed(
  paste: PasteWithAuthor,
  highlightedLines: string[],
  options: EmbedOptions,
): string {
  const rows = highlightedLines
    .map(
      (line, index) => `
    <tr><td class="ln">${options.rangeStart ? options.rangeStart + index : index + 1}</td><td class="code">${line || ' '}</td></tr>`,
    )
    .join('');
  const title = paste.title
    ? `<div class="title">${escapeHtml(paste.title)}</div>`
    : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(paste.title ?? 'Paste')}</title>
<style>
  body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--bg);color:var(--fg)}
  :root{--bg:#0d1117;--fg:#c9d1d9;--ln:#6e7681;--accent:#58a6ff}
  .light{--bg:#ffffff;--fg:#24292f;--ln:#8c959f;--accent:#0969da}
  .title{padding:10px 14px;border-bottom:1px solid var(--ln);font-family:system-ui,sans-serif;font-size:13px}
  table{border-collapse:collapse;width:100%}
  td{padding:1px 10px;white-space:pre-wrap;word-break:break-word;vertical-align:top}
  td.ln{text-align:right;color:var(--ln);user-select:none;width:1%;border-right:1px solid var(--ln)}
  .hljs-keyword,.hljs-literal{color:#ff7b72}.hljs-string{color:#a5d6ff}.hljs-comment{color:#8b949e;font-style:italic}.hljs-number{color:#79c0ff}.hljs-function .hljs-title,.hljs-title{color:var(--accent)}
</style>
</head>
<body class="${options.theme === 'light' ? 'light' : ''}">
${title}
<table>${rows}
</table>
</body>
</html>`;
}

export const embed: RequestHandler = async (req: Request, res: Response) => {
  const idOrSlug = typeof req.params['id'] === 'string' ? req.params['id'] : '';
  if (idOrSlug.length < 3 || idOrSlug.length > 64) {
    const error = renderError(404);
    res.status(error.status).type('html').send(error.html);
    return;
  }
  const shareToken = typeof req.query['share_token'] === 'string' ? req.query['share_token'] : undefined;
  const options = parseEmbedOptions(req.query);

  try {
    const result = await pasteService.getPasteForView(idOrSlug, { kind: 'anonymous' }, {
      shareToken,
      visitorIp: req.ip ?? null,
      visitorUserAgent: req.headers['user-agent'] ?? null,
    });
    const paste = result.paste;

    // Password-protected pastes are not embeddable (§4 I, §20.2 item 11).
    if (paste.passwordHash) {
      const error = renderError(404);
      res.status(error.status).type('html').send(error.html);
      return;
    }

    const full = paste.content ?? '';
    let lines = full.split('\n');
    if (options.rangeStart && options.rangeEnd) {
      lines = lines.slice(options.rangeStart - 1, options.rangeEnd);
    }

    const language = paste.language ?? paste.detectedLanguage ?? undefined;
    let html: string;
    if (language && hljs.getLanguage(language)) {
      const highlighted = hljs.highlight(full, { language, ignoreIllegals: true });
      const highlightedLines = highlighted.value.split('\n');
      const sliced = options.rangeStart && options.rangeEnd
        ? highlightedLines.slice(options.rangeStart - 1, options.rangeEnd)
        : highlightedLines;
      html = renderEmbed(paste, sliced, options);
    } else {
      html = renderEmbed(paste, lines.map(escapeHtml), options);
    }

    // Embed framing: replace the site-wide helmet headers.
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors *; base-uri 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.status(200).type('html; charset=utf-8').send(html);
  } catch (err) {
    // Uniform 404 HTML for private/missing/expired/consumed embeds.
    const code = (err as { code?: string }).code;
    if (code === 'PASSWORD_REQUIRED') {
      const error = renderError(404);
      res.status(error.status).type('html').send(error.html);
      return;
    }
    if (code === 'NOT_FOUND' || code === 'GONE') {
      const error = renderError(404);
      res.status(error.status).type('html').send(error.html);
      return;
    }
    const error = renderError(500);
    res.status(error.status).type('html').send(error.html);
  }
};
