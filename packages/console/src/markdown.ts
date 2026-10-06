import { escapeHtml } from '@gatehouse/workflows';

/** Just enough Markdown for Gatehouse's own summaries: headings, lists, bold, inline code, paragraphs. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let list = false;
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/_([^_]+)_/g, '<em>$1</em>');
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,4}) (.*)$/.exec(line);
    const li = /^- (.*)$/.exec(line);
    if (!li && list) {
      out.push('</ul>');
      list = false;
    }
    if (h) out.push(`<h${h[1]!.length + 1}>${inline(h[2]!)}</h${h[1]!.length + 1}>`);
    else if (li) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(li[1]!)}</li>`);
    } else if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}
