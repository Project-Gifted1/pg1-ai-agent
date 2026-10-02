// A very small DOM for running public/index.html's trace code in a vm
// context (the repo has no jsdom). It only understands the well-formed
// markup the page itself generates: quoted attributes, explicit closing
// tags or "/>", text left as written (entities are not decoded).
// Selectors: ".class", "tag", "#id" and "[attr]" / "[attr=value]",
// optionally compounded ("li.trace-row.is-failed"), plus descendant
// selectors separated by spaces.

const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr']);

class Text {
  constructor(text) { this.nodeType = 3; this.text = text; this.parentNode = null; }
  get textContent() { return this.text; }
  get outerHTML() { return this.text; }
}

class ClassList {
  constructor(el) { this.el = el; }
  get list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  set(list) { this.el.setAttribute('class', list.join(' ')); }
  contains(c) { return this.list.includes(c); }
  add(...cs) { const l = this.list; cs.forEach((c) => { if (!l.includes(c)) l.push(c); }); this.set(l); }
  remove(...cs) { this.set(this.list.filter((c) => !cs.includes(c))); }
  toggle(c, force) { const on = force === undefined ? !this.contains(c) : force; if (on) this.add(c); else this.remove(c); return on; }
}

export class Element {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toLowerCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = doc;
    this.classList = new ClassList(this);
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.body; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; this.appendChild(new Text(String(v))); }
  get innerHTML() { return this.childNodes.map((n) => n.outerHTML).join(''); }
  set innerHTML(html) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    parseInto(this, String(html), this.ownerDocument);
  }
  get outerHTML() {
    const attrs = Array.from(this.attrs).map(([k, v]) => (v === '' && k === 'hidden' ? ` ${k}` : ` ${k}="${v}"`)).join('');
    if (VOID.has(this.tagName)) return `<${this.tagName}${attrs}>`;
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
  set outerHTML(html) {
    const parent = this.parentNode;
    if (!parent) return;
    const holder = new Element('div', this.ownerDocument);
    holder.innerHTML = html;
    const idx = parent.childNodes.indexOf(this);
    holder.childNodes.forEach((n) => { n.parentNode = parent; });
    parent.childNodes.splice(idx, 1, ...holder.childNodes);
    this.parentNode = null;
  }
  appendChild(node) {
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  prepend(node) {
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.unshift(node);
  }
  after(node) {
    const parent = this.parentNode;
    if (node.parentNode) node.remove();
    node.parentNode = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  insertAdjacentHTML(where, html) {
    const holder = new Element('div', this.ownerDocument);
    holder.innerHTML = html;
    const nodes = holder.childNodes.slice();
    if (where === 'beforeend') nodes.forEach((n) => this.appendChild(n));
    else if (where === 'afterbegin') nodes.reverse().forEach((n) => this.prepend(n));
    else throw new Error('insertAdjacentHTML: unsupported position ' + where);
  }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) { if (matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  matches(sel) { return matches(this, sel); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => el.children.forEach((c) => { if (matchesChain(c, sel, this)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function matchesSimple(el, sel) {
  const parts = sel.match(/(^[a-z0-9-]+)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])/gi) || [];
  if (parts.join('') !== sel) throw new Error('mini-dom: unsupported selector ' + sel);
  return parts.every((p) => {
    if (p[0] === '.') return el.classList.contains(p.slice(1));
    if (p[0] === '#') return el.id === p.slice(1);
    if (p[0] === '[') {
      const m = p.slice(1, -1).match(/^([\w-]+)(?:="?([^"]*)"?)?$/);
      return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
    }
    return el.tagName === p.toLowerCase();
  });
}

function matches(el, sel) {
  return sel.split(',').some((s) => matchesChain(el, s.trim(), null));
}

function matchesChain(el, sel, root) {
  if (sel.includes(',')) return sel.split(',').some((s) => matchesChain(el, s.trim(), root));
  const chain = sel.trim().split(/\s+/);
  if (!matchesSimple(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let n = el.parentNode;
  while (i >= 0 && n && n !== root && n.nodeType === 1) {
    if (matchesSimple(n, chain[i])) i--;
    n = n.parentNode;
  }
  return i < 0;
}

function parseInto(parent, html, doc) {
  const stack = [parent];
  const re = /<!--[\s\S]*?-->|<\/([a-z0-9-]+)\s*>|<([a-z0-9-]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
    } else if (m[2]) {
      const el = new Element(m[2], doc);
      const attrRe = /([\w:-]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = attrRe.exec(m[3] || ''))) el.attrs.set(a[1], a[2] === undefined ? '' : a[2]);
      top.appendChild(el);
      if (!m[4] && !VOID.has(el.tagName)) stack.push(el);
    } else if (m[5]) {
      top.appendChild(new Text(m[5]));
    }
  }
}

export function createDocument() {
  const doc = {};
  doc.createElement = (tag) => new Element(tag, doc);
  doc.body = new Element('body', doc);
  doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  return doc;
}
