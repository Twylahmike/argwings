/** Turns the simple page syntax into blocks: "# Heading", "- item" lists and blank-line separated paragraphs. No HTML is ever interpreted. */
export type DocBlock = { type: 'h'; text: string } | { type: 'p'; text: string } | { type: 'ul'; items: string[] }

export function parseDoc(body: string): DocBlock[] {
  const blocks: DocBlock[] = []
  let para: string[] = []
  let list: string[] = []
  const flushPara = () => { if (para.length) blocks.push({ type: 'p', text: para.join(' ') }); para = [] }
  const flushList = () => { if (list.length) blocks.push({ type: 'ul', items: list }); list = [] }
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) { flushPara(); flushList(); continue }
    const h = /^#{1,3}\s+(.+)$/.exec(line)
    if (h) { flushPara(); flushList(); blocks.push({ type: 'h', text: h[1] }); continue }
    const li = /^[-*]\s+(.+)$/.exec(line)
    if (li) { flushPara(); list.push(li[1]); continue }
    flushList(); para.push(line)
  }
  flushPara(); flushList()
  return blocks
}

export const slugifyPage = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
