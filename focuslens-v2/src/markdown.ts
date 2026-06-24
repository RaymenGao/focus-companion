import katex from "katex";
import { marked } from "marked";
import "katex/dist/katex.min.css";

export function stripJsonFrontmatter(markdown: string): string {
  return markdown.replace(/^---json\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function renderMathMarkdown(markdown: string): string {
  // Auto-close any unclosed math blocks from truncated AI responses
  let closedMarkdown = stripJsonFrontmatter(markdown)
    .replace(
      /\[\[wiki:\/\/([^|\]]+)\|([^\]]+)\]\]/g,
      (_match, pageId, label) => `[${label}](wiki://${encodeURIComponent(pageId)})`,
    )
    .replace(
      /\[\[evidence:\/\/([^|\]]+)\|([^\]]+)\]\]/g,
      (_match, evidenceId, label) => `[${label}](evidence://${encodeURIComponent(evidenceId)})`,
    )
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => `$${expr}$`);
  const doubleDollarCount = (closedMarkdown.match(/\$\$/g) || []).length;
  if (doubleDollarCount % 2 !== 0) {
    closedMarkdown = closedMarkdown + "\n$$";
  }
  const tempText = closedMarkdown.replace(/\$\$/g, "");
  const singleDollarCount = (tempText.match(/\$/g) || []).length;
  if (singleDollarCount % 2 !== 0) {
    closedMarkdown = closedMarkdown + "$";
  }

  const placeholders: string[] = [];

  // Replace display math ($$...$$)
  let temp = closedMarkdown.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    const placeholder = `KATEXDISPLAYPLACEHOLDER${placeholders.length}`;
    try {
      const html = katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false });
      placeholders.push(html);
    } catch {
      placeholders.push(expr);
    }
    return placeholder;
  });

  // Replace inline math ($...$)
  temp = temp.replace(/\$([^$\n]+?)\$/g, (_, expr) => {
    const placeholder = `KATEXINLINEPLACEHOLDER${placeholders.length}`;
    try {
      const html = katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false });
      placeholders.push(html);
    } catch {
      placeholders.push(expr);
    }
    return placeholder;
  });

  // Render markdown to HTML with line breaks enabled
  let htmlResult = marked.parse(temp, { async: false, breaks: true }) as string;

  // Restore the math HTML strings
  for (let i = 0; i < placeholders.length; i++) {
    htmlResult = htmlResult.replace(`KATEXDISPLAYPLACEHOLDER${i}`, placeholders[i]);
    htmlResult = htmlResult.replace(`KATEXINLINEPLACEHOLDER${i}`, placeholders[i]);
  }

  return htmlResult.replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noreferrer"');
}
