/**
 * Skill bundles. The API stores a skill as a gzipped tar with SKILL.md at its
 * root. People usually have a .zip, so zips are repacked in the browser: each
 * entry is inflated, written into a ustar archive and gzipped, all with the
 * platform's (De)CompressionStream. A single wrapping folder is stripped.
 */

export type BundleKind = "zip" | "gzip" | "unknown";

export function bundleKind(bytes: Uint8Array): BundleKind {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  return "unknown";
}

export interface BundleFile {
  path: string;
  data: Uint8Array;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const IGNORED = (path: string) => path.startsWith("__MACOSX/") || path.split("/").pop() === ".DS_Store";

/** Files in a zip archive (stored or deflated entries; no zip64 or encryption). */
export async function readZip(bytes: Uint8Array): Promise<BundleFile[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no central directory)");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 archives are not supported; use a .tar.gz");
  const decoder = new TextDecoder();
  const files: BundleFile[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/") || IGNORED(path)) continue;
    if (flags & 1) throw new Error(`${path} is encrypted`);
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error("corrupt zip entry");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await pipe(raw, new DecompressionStream("deflate-raw"));
    else throw new Error(`${path} uses an unsupported compression method (${method})`);
    files.push({ path, data });
  }
  return files;
}

/** Drop one folder that wraps everything (my-skill/SKILL.md → SKILL.md). */
export function stripWrapper(files: BundleFile[]): BundleFile[] {
  if (files.some((f) => f.path === "SKILL.md")) return files;
  const roots = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0]! : "")));
  if (roots.size !== 1 || roots.has("")) return files;
  const [root] = [...roots];
  return files.map((f) => ({ ...f, path: f.path.slice(root!.length + 1) }));
}

function writeString(buf: Uint8Array, offset: number, length: number, value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new Error(`"${value}" is too long for a tar header`);
  buf.set(bytes, offset);
}

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number) {
  writeString(buf, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

function tarHeader(path: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  let name = path;
  let prefix = "";
  if (new TextEncoder().encode(path).length > 100) {
    const cut = path.lastIndexOf("/", 155);
    if (cut <= 0 || path.length - cut - 1 > 100) throw new Error(`path too long for a tar archive: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);
  h[156] = 0x30; // regular file
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  writeString(h, 345, 155, prefix);
  const sum = h.reduce((a, b) => a + b, 0);
  writeString(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** An uncompressed ustar archive of `files`. */
export function tar(files: BundleFile[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const f of files) {
    chunks.push(tarHeader(f.path, f.data.length, mtime), f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const gzip = (data: Uint8Array) => pipe(data, new CompressionStream("gzip"));
export const gunzip = (data: Uint8Array) => pipe(data, new DecompressionStream("gzip"));

export interface PreparedBundle {
  body: Uint8Array;
  /** Files found, when the bundle was a zip we repacked. */
  files?: string[];
  converted: boolean;
}

/** The bytes to POST to /v1/skills: .tar.gz as-is, .zip repacked. Throws with a readable message. */
export async function prepareSkillBundle(bytes: Uint8Array): Promise<PreparedBundle> {
  const kind = bundleKind(bytes);
  if (kind === "gzip") return { body: bytes, converted: false };
  if (kind !== "zip") throw new Error("upload a .zip or .tar.gz skill bundle");
  const files = stripWrapper(await readZip(bytes));
  if (!files.some((f) => f.path === "SKILL.md")) throw new Error("the bundle needs a SKILL.md at its root");
  return { body: await gzip(tar(files)), files: files.map((f) => f.path), converted: true };
}
