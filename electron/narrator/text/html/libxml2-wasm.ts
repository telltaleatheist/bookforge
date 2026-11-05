/**
 * libxml2 2.11.9 as WebAssembly, behind the {@link Libxml2} surface. See `vendor/libxml2-wasm/README.md`.
 *
 * NEVER RUN. The binary does not exist yet: building it waits on installing Emscripten. Written
 * against `shim.c` so the rest of prep has its real shape; the corpus comparison is its test.
 * Sync and heavy, so it belongs off the main thread (`prep-worker.ts`).
 */

import * as fs from 'fs';
import * as path from 'path';

import { Libxml2, LxmlNode, SerializedBody, linkParents } from './lxml';

const BINARY = path.join(__dirname, '..', '..', '..', '..', '..', 'vendor', 'libxml2-wasm', 'libxml2.wasm');
const KINDS: ReadonlyArray<LxmlNode['kind']> = ['element', 'comment', 'pi', 'entity'];

/** What lxml raises when libxml2 hands back nothing. ebooklib's `try` is what catches it. */
export class XmlSyntaxError extends Error {}

interface Exports {
  readonly memory: WebAssembly.Memory;
  bf_alloc(size: number): number;
  bf_free(pointer: number): void;
  bf_parse(text: number, length: number): number;
  bf_parse_xml(text: number, length: number): number;
  bf_free_doc(doc: number): void;
  bf_root(doc: number): number;
  bf_find_body(root: number): number;
  bf_len(element: number): number;
  bf_result_length(): number;
  bf_tostring(doc: number, node: number): number;
  bf_dump(root: number): number;
  _initialize?(): void;
}

class Dump {
  private at = 0;

  constructor(private readonly bytes: Buffer) {}

  private int(): number {
    const value = this.bytes.readInt32LE(this.at);
    this.at += 4;
    return value;
  }

  private string(): string | null {
    const length = this.int();
    if (length < 0) return null;
    const text = this.bytes.toString('utf8', this.at, this.at + length);
    this.at += length;
    return text;
  }

  private pairs<A>(first: () => A): Array<[A, string]> {
    const out: Array<[A, string]> = [];
    for (let left = this.int(); left > 0; left -= 1) out.push([first(), this.string() as string]);
    return out;
  }

  node(): LxmlNode {
    const kind = KINDS[this.bytes[this.at]];
    this.at += 1;
    const tag = this.string() ?? '';
    const prefix = this.string();
    const nsDecls = this.pairs(() => this.string());
    const attrs = this.pairs(() => this.string() as string);
    const text = this.string();
    const tail = this.string();
    const children: LxmlNode[] = [];
    for (let left = this.int(); left > 0; left -= 1) children.push(this.node());
    return { kind, tag, prefix, nsDecls, attrs, text, tail, children, parent: null };
  }
}

export class Libxml2Wasm implements Libxml2 {
  private readonly lib: Exports;

  constructor(binary: string = BINARY) {
    const module = new WebAssembly.Module(fs.readFileSync(binary));
    const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
    for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
      if (kind !== 'function') throw new Error(`libxml2.wasm needs a ${kind} import ${from}.${name}, which nothing here provides.`);
      imports[from] ??= {};
      imports[from][name] = () => {
        throw new Error(`libxml2.wasm called ${from}.${name}, which prep's surface should never reach.`);
      };
    }
    this.lib = new WebAssembly.Instance(module, imports).exports as unknown as Exports;
    this.lib._initialize?.();
  }

  private withBytes<T>(content: Buffer, use: (pointer: number, length: number) => T): T {
    const pointer = this.lib.bf_alloc(content.length + 1);
    if (pointer === 0) throw new Error('libxml2.wasm could not allocate for a document.');
    new Uint8Array(this.lib.memory.buffer, pointer, content.length).set(content);
    try {
      return use(pointer, content.length);
    } finally {
      this.lib.bf_free(pointer);
    }
  }

  private takeResult(pointer: number, what: string): Buffer {
    if (pointer === 0) throw new Error(`libxml2.wasm could not ${what}.`);
    const copy = Buffer.from(new Uint8Array(this.lib.memory.buffer, pointer, this.lib.bf_result_length()));
    this.lib.bf_free(pointer);
    return copy;
  }

  private tree(doc: number): LxmlNode {
    try {
      const root = this.lib.bf_root(doc);
      if (root === 0) throw new XmlSyntaxError('Document is empty');
      return linkParents(new Dump(this.takeResult(this.lib.bf_dump(root), 'dump a tree')).node());
    } finally {
      this.lib.bf_free_doc(doc);
    }
  }

  parseXml(content: Buffer): LxmlNode {
    const doc = this.withBytes(content, (p, n) => this.lib.bf_parse_xml(p, n));
    if (doc === 0) throw new XmlSyntaxError('Document is empty');
    return this.tree(doc);
  }

  parseHtml(content: Buffer): LxmlNode {
    const doc = this.withBytes(content, (p, n) => this.lib.bf_parse(p, n));
    if (doc === 0) throw new XmlSyntaxError('Document is empty');
    return this.tree(doc);
  }

  serializeBody(content: Buffer): SerializedBody | null {
    const doc = this.withBytes(content, (p, n) => this.lib.bf_parse(p, n));
    if (doc === 0) throw new XmlSyntaxError('Document is empty');
    try {
      const root = this.lib.bf_root(doc);
      if (root === 0) throw new XmlSyntaxError('Document is empty');
      const body = this.lib.bf_find_body(root);
      if (body === 0) return null;
      return { tostring: this.takeResult(this.lib.bf_tostring(doc, body), 'serialize a body'), length: this.lib.bf_len(body) };
    } finally {
      this.lib.bf_free_doc(doc);
    }
  }
}
