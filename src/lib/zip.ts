import zlib from "node:zlib";
import { promisify } from "node:util";

const deflateRawAsync = promisify(zlib.deflateRaw);

export interface ZipEntry {
  /** zip 内部路径，统一用 / 分隔（zip 规范要求）。 */
  name: string;
  data: Buffer;
}

function crc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 把一组内存文件打包成合法的 ZIP 格式 Buffer。
 *
 * 使用 deflate 压缩，文件名按 UTF-8 编码（flags bit 11 置位），不写时间戳。
 * 只依赖 Node.js 内置的 zlib，无外部依赖。
 */
export async function buildZipBuffer(entries: ZipEntry[]): Promise<Buffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;
    const compressed = await deflateRawAsync(entry.data);
    const compressedSize = compressed.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // general purpose bit flag: UTF-8
    local.writeUInt16LE(8, 8);             // compression method: deflate
    local.writeUInt16LE(0, 10);            // last mod time
    local.writeUInt16LE(0, 12);            // last mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);  // central directory signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0x0800, 8);       // general purpose bit flag: UTF-8
    central.writeUInt16LE(8, 10);           // compression method: deflate
    central.writeUInt16LE(0, 12);           // last mod time
    central.writeUInt16LE(0, 14);           // last mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);           // extra field length
    central.writeUInt16LE(0, 32);           // file comment length
    central.writeUInt16LE(0, 34);           // disk number start
    central.writeUInt16LE(0, 36);           // internal file attributes
    central.writeUInt32LE(0, 38);           // external file attributes
    central.writeUInt32LE(offset, 42);      // relative offset of local header
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressedSize;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);   // end of central dir signature
  eocd.writeUInt16LE(0, 4);             // disk number
  eocd.writeUInt16LE(0, 6);             // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);            // zip file comment length

  return Buffer.concat([...locals, ...centrals, eocd]);
}
