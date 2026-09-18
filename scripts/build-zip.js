/**
 * 打包扩展为可提交到 Chrome Web Store / Microsoft Edge Add-ons 的 ZIP。
 *
 * 为什么不用 PowerShell 的 Compress-Archive：它在 Windows 上会把 ZIP 条目
 * 路径写成反斜杠（icons\icon-128.png），违反 ZIP 规范（APPNOTE 4.4.17.1
 * 要求正斜杠），会导致浏览器商店解析不到图标、跨平台解压产生错误文件名。
 * 本脚本自行写入 ZIP 结构，零依赖，保证路径分隔符为正斜杠。
 *
 * 用法：node scripts/build-zip.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'prototype');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(SRC, 'manifest.json');

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ---- 收集文件（相对路径一律用正斜杠）----
function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// ---- 打包 ----
function build() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const version = manifest.version;
  const outName = `bili-follow-recency-v${version}.zip`;
  const outPath = path.join(DIST, outName);

  const files = walk(SRC).sort((a, b) => a.rel.localeCompare(b.rel));
  if (!files.some(f => f.rel === 'manifest.json')) {
    throw new Error('manifest.json 必须位于包根目录');
  }

  const chunks = [];
  const central = [];
  const report = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(data);

    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const { time, date } = dosDateTime(fs.statSync(f.full).mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed to extract
    lh.writeUInt16LE(0x0800, 6);      // general purpose flag: UTF-8 file names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);          // extra field length

    chunks.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk number
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);

    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
    report.push([f.rel, data.length, payload.length]);
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, eocd]));

  // ---- 报告 ----
  console.log(`\n打包完成：dist/${outName}\n`);
  console.log(`${'条目'.padEnd(26)}${'原始'.padStart(10)}${'压缩后'.padStart(10)}`);
  console.log('-'.repeat(46));
  for (const [rel, raw, comp] of report) {
    console.log(`${rel.padEnd(26)}${(raw / 1024).toFixed(1).padStart(9)}K${(comp / 1024).toFixed(1).padStart(9)}K`);
  }
  console.log('-'.repeat(46));
  const total = fs.statSync(outPath).size;
  console.log(`${String(report.length).padEnd(26)}${(files.reduce((s, f) => s + fs.statSync(f.full).size, 0) / 1024).toFixed(1).padStart(9)}K${(total / 1024).toFixed(1).padStart(9)}K`);
  console.log(`\n包版本：${version}（取自 manifest.json）`);
  console.log('路径分隔符：正斜杠（符合 ZIP 规范）');
}

build();
