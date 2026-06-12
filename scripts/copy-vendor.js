"use strict";

/**
 * 把 vendored 静态资源（uPlot 库与 CSS）从 src/vendor 拷到 dist/vendor。
 *
 * tsc 只编译 .ts、不会搬运非 ts 文件，所以 build 后需要这一步，否则
 * dist 里缺少 uPlot 资源、看板运行时读不到库、npm 发布包也带不上。
 * 运行时 chart-assets.ts 用 `__dirname/../vendor` 定位，dist 与源码路径对称。
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const src = path.join(root, "src", "vendor");
const dest = path.join(root, "dist", "vendor");

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`copied vendor assets: ${src} -> ${dest}`);
