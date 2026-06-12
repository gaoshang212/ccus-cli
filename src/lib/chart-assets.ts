import fs from "node:fs";
import path from "node:path";

/**
 * uPlot 资源接入与「容器 + 内联数据 + 客户端初始化」渲染辅助。
 *
 * 看板的折线与纵向柱状图都改用 uPlot 渲染：服务端只输出一个容器 `<div>` 加一段
 * `<script type="application/json">` 内联的图表配置 + 数据，页面底部再一次性内联
 * uPlot 库与一段 bootstrap 脚本，由浏览器端 `new uPlot` 真正绘制。这样既拿到 uPlot 原生
 * 的「十字线 + legend 跟随读数」，又保证 `dashboard build` 产物用 `file://` 离线打开仍可渲染。
 *
 * vendored 资源放在 `src/vendor`，build 时拷到 `dist/vendor`；运行时用 `__dirname` + `../vendor`
 * 定位（dist 与 tsx 直跑源码都成立，照搬 `src/lib/version.ts` 读 package.json 的相对定位套路）。
 */

let cachedJs: string | null = null;
let cachedCss: string | null = null;

function readVendorFile(fileName: string): string {
  // dist/lib/chart-assets.js 与 src/lib/chart-assets.ts 距离 vendor 目录都是 `../vendor`。
  const assetPath = path.join(__dirname, "..", "vendor", fileName);
  return fs.readFileSync(assetPath, "utf8");
}

/** 读取 vendored uPlot 库源码（IIFE 压缩版），内联进页面。 */
export function getUplotJs(): string {
  if (cachedJs === null) {
    cachedJs = readVendorFile("uplot.iife.min.js");
  }
  return cachedJs;
}

/** 读取 vendored uPlot 官方 CSS，内联进页面。 */
export function getUplotCss(): string {
  if (cachedCss === null) {
    cachedCss = readVendorFile("uplot.min.css");
  }
  return cachedCss;
}

/** 单条 series 的服务端描述（不含函数，可 JSON 序列化）。 */
export interface ChartSeriesSpec {
  label: string;
  stroke: string;
  fill?: string;
  /** 虚线 dash 数组（如 [6, 4]）；省略为实线。 */
  dash?: number[];
  width?: number;
}

/** 一张 uPlot 图表的服务端描述。客户端 bootstrap 据此构造 uPlot opts。 */
export interface ChartSpec {
  height: number;
  /** time：x 为 unix 秒、走时间轴；category：x 为 0..n-1 索引、配 xLabels 文本。 */
  xType: "time" | "category";
  /** category 模式下每个索引对应的轴标签。 */
  xLabels?: string[];
  /** y 轴数值单位后缀（如 "%"），用于 legend 与 y 轴刻度展示。 */
  yUnit?: string;
  /** 固定 y 轴范围（如 [0, 100]）；省略则自适应。 */
  yRange?: [number, number];
  /** 自适应但强制下限为 0（计数类图用）。 */
  yMin0?: boolean;
  /** 单系列纵向柱状图：用 uPlot.paths.bars 画柱并在柱顶标注数值。 */
  bars?: boolean;
  series: ChartSeriesSpec[];
  /**
   * 自定义图例分组：每组渲染成一个图例项（一个名字），点击同时切换该组下所有 series 显隐。
   *
   * 多人 5h/7d 详细曲线里一个人有 5h + 7d 两条 series，但图例只显示一个人名、勾选联动两条线。
   * `seriesIdx` 为 uPlot series 索引（1-based，0 是 x 轴）。省略则不渲染图例。
   */
  legendGroups?: Array<{ label: string; color: string; seriesIdx: number[] }>;
}

/** uPlot data 矩阵：第 0 行是 x，其余每行对应一条 series。 */
export type ChartData = Array<Array<number | null>>;

/**
 * 把图表配置 + 数据安全序列化进 `<script type="application/json">`。
 *
 * 关键是规避 `</script>` 注入：把 `<`/`>`/`&` 转成 `\uXXXX` 转义。数据落在
 * `<script type="application/json">` 内、由 `JSON.parse(textContent)` 读取，转义后既不破坏
 * JSON 语义，又保证浏览器不会把内联数据误当成标签或脚本结束。
 */
export function serializeChartPayload(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * 渲染单张 uPlot 图表的容器 + 内联数据。
 *
 * 只产出「容器 + 数据」两段，页面级 uPlot 库与 bootstrap 由 `uplotBodyScripts` 一次性注入。
 * `target` 必须是页面内唯一 id（多图共存时各自定位）。
 */
export function renderUplotChart(target: string, spec: ChartSpec, data: ChartData): string {
  const payload = serializeChartPayload({ spec, data });
  return `<div class="uplot-host" id="${target}"></div>
      <script type="application/json" class="ccus-chart" data-target="${target}">${payload}</script>`;
}

/** uPlot 官方 CSS + 暗色主题适配，内联进 `<head>`。 */
export function uplotHeadAssets(): string {
  return `<style>
${getUplotCss()}
      /* 暗色看板适配：uPlot 默认浅色，这里覆盖宽度与十字线配色。 */
      .uplot { width: 100%; font-family: Georgia, "Times New Roman", serif; }
      .uplot-host { width: 100%; padding: 8px 12px 4px; }
      .u-hz .u-cursor-x, .u-vt .u-cursor-y { border-right-color: rgba(145, 160, 184, 0.55); }
      .u-hz .u-cursor-y, .u-vt .u-cursor-x { border-bottom-color: rgba(145, 160, 184, 0.55); }
      /* 自定义图例：每人/每条只一项，点击同时切换该项下所有 series 显隐；人名按原样不强制大写。 */
      .ccus-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        padding: 10px 20px 4px;
        color: var(--muted);
        font-size: 13px;
      }
      .ccus-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        text-transform: none;
        letter-spacing: normal;
        transition: opacity 0.15s ease;
      }
      .ccus-legend-item:hover { color: var(--text); }
      .ccus-legend-item.is-off { opacity: 0.4; }
      .ccus-legend-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
      /* 跟随鼠标的 tooltip：集中显示当前位置各 series 的读数（替代底部铺值）。 */
      .ccus-tooltip {
        position: absolute;
        z-index: 10;
        pointer-events: none;
        background: rgba(10, 13, 18, 0.92);
        border: 1px solid rgba(120, 141, 173, 0.3);
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 12px;
        color: var(--text);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
        white-space: nowrap;
        max-width: 320px;
        overflow: hidden;
      }
      .ccus-tip-head { color: var(--muted); margin-bottom: 4px; font-size: 11px; }
      .ccus-tip-row { display: flex; align-items: center; gap: 6px; line-height: 1.5; }
      .ccus-tip-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
      .ccus-tip-label { flex: 1; margin-right: 12px; }
      .ccus-tip-val { font-variant-numeric: tabular-nums; }
    </style>`;
}

/**
 * 页面底部一次性注入：内联 uPlot 库 + bootstrap 脚本。
 *
 * bootstrap 扫描页面里所有 `script.ccus-chart`，按 data-target 找容器、解析 spec/data、
 * 构造 uPlot opts（含 legend 读数格式化、纵向柱 bars 路径与柱顶数值标签、缺失填 null 等
 * 无法 JSON 序列化的部分），再 `new uPlot` 绘制；并监听 resize 自适应宽度。
 */
export function uplotBodyScripts(): string {
  return `<script>${getUplotJs()}</script>
    <script>
      (function () {
        var THEME = { axis: "#91a0b8", grid: "rgba(145, 160, 184, 0.15)" };

        function round1(v) { return Math.round(v * 10) / 10; }

        function pad2(n) { return (n < 10 ? "0" : "") + n; }

        function makeValueFmt(unit) {
          return function (u, v) { return v == null ? "--" : round1(v) + unit; };
        }

        // 时间轴刻度标签：uPlot 默认是 12 小时制 + am/pm，这里统一改成 24 小时制 HH:mm。
        // 跨天的 tick 第二行补上「月/日」，复刻原来「边界显示日期、其余只显示时间」的观感；
        // tick 间隔已到天级及以上时主标签直接显示日期。splits 为秒（uPlot time scale 单位）。
        function timeAxisVals(u, splits, axisIdx, foundSpace, foundIncr) {
          var DAY = 86400;
          var incr = foundIncr || 0;
          var prevDay = null;
          return splits.map(function (sec) {
            var d = new Date(sec * 1000);
            var dayKey = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
            var datePart = (d.getMonth() + 1) + "/" + d.getDate();
            var label;
            if (incr >= DAY) {
              label = datePart;
            } else {
              var t = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
              label = dayKey !== prevDay ? t + "\\n" + datePart : t;
            }
            prevDay = dayKey;
            return label;
          });
        }

        // 纵向柱状图：在每根柱顶绘制其数值。canvas 坐标按 devicePixelRatio 放大，
        // 所以取 valToPos(..., true) 的画布像素，并用同比放大的字号绘制。
        function barLabelHook(unit) {
          return function (u) {
            var ser = u.series[1];
            if (!ser || ser.show === false) return;
            var xs = u.data[0];
            var ys = u.data[1];
            var pxr = window.devicePixelRatio || 1;
            var ctx = u.ctx;
            ctx.save();
            ctx.fillStyle = THEME.axis;
            ctx.font = Math.round(11 * pxr) + "px Georgia, serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            for (var i = 0; i < ys.length; i++) {
              var val = ys[i];
              if (val == null || val === 0) continue;
              var x = u.valToPos(xs[i], "x", true);
              var y = u.valToPos(val, "y", true);
              ctx.fillText(String(val) + unit, x, y - 4 * pxr);
            }
            ctx.restore();
          };
        }

        function escapeText(s) {
          return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        // 每条 series 跳过 null，找离 hoveredIdx 最近的有值索引（uPlot nearest-non-null 标准做法）。
        // 多人并集对齐后绝大多数点位只有一个人有值，靠它让每条线在任意 x 都吸附高亮到自己最近的真实点。
        function nearestNonNull(u, seriesIdx, hoveredIdx) {
          var d = u.data[seriesIdx];
          if (d[hoveredIdx] != null) return hoveredIdx;
          var len = d.length;
          var lo = hoveredIdx;
          var hi = hoveredIdx;
          while (lo >= 0 || hi < len) {
            lo--;
            hi++;
            if (lo >= 0 && d[lo] != null) return lo;
            if (hi < len && d[hi] != null) return hi;
          }
          return hoveredIdx;
        }

        // 2D 吸附：横向极窄的尖峰里，多个数据点 x 几乎重合，只按 x 最近会永远吸到靠下的点、读不到峰顶。
        // 这里在 hoveredIdx 左右一个很窄的 x 像素窗口内，改取离鼠标「2D（x+y）最近」的真实点：
        // 鼠标移到竖线顶端就能命中峰值点。窗口外（稀疏区）只剩 hoveredIdx 一个候选，行为与默认一致。
        // 窗口内无有效点 / 无鼠标像素时退回 nearestNonNull。
        function nearestPointIdx(u, seriesIdx, hoveredIdx) {
          var d = u.data[seriesIdx];
          var cl = u.cursor.left;
          var ct = u.cursor.top;
          if (cl == null || ct == null || cl < 0 || ct < 0) {
            return nearestNonNull(u, seriesIdx, hoveredIdx);
          }
          var xs = u.data[0];
          var scaleKey = u.series[seriesIdx].scale || "y";
          var XWIN = 16;
          var best = -1;
          var bestDist = Infinity;
          for (var i = hoveredIdx; i >= 0; i--) {
            var xl = u.valToPos(xs[i], "x");
            if (i !== hoveredIdx && Math.abs(xl - cl) > XWIN) break;
            if (d[i] == null) continue;
            var yl = u.valToPos(d[i], scaleKey);
            var ax = xl - cl;
            var ay = yl - ct;
            var dl = ax * ax + ay * ay;
            if (dl < bestDist) { bestDist = dl; best = i; }
          }
          for (var j = hoveredIdx + 1; j < d.length; j++) {
            var xr = u.valToPos(xs[j], "x");
            if (Math.abs(xr - cl) > XWIN) break;
            if (d[j] == null) continue;
            var yr = u.valToPos(d[j], scaleKey);
            var bx = xr - cl;
            var by = yr - ct;
            var dr = bx * bx + by * by;
            if (dr < bestDist) { bestDist = dr; best = j; }
          }
          return best >= 0 ? best : nearestNonNull(u, seriesIdx, hoveredIdx);
        }

        // tooltip 顶部的 x 标签：time 图显示本地 MM-DD HH:mm，category 图显示对应文本标签。
        function formatXHead(spec, u, idx) {
          var xv = u.data[0][idx];
          if (spec.xType === "category") {
            var li = Math.round(xv);
            return spec.xLabels && spec.xLabels[li] != null ? spec.xLabels[li] : "";
          }
          var d = new Date(xv * 1000);
          function p(n) { return (n < 10 ? "0" : "") + n; }
          return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
        }

        // 跟随鼠标的 tooltip：ready 时建浮层、setCursor 时按 cursor.idxs（每条 series 经 dataIdx 吸附后的索引）
        // 汇总当前各 series 读数。被 legend toggle 隐藏或该处无值的 series 跳过，不占行。
        function makeTooltipHooks(spec, seriesSpecs) {
          var unit = spec.yUnit || "";
          var create = function (u) {
            var tt = document.createElement("div");
            tt.className = "ccus-tooltip";
            tt.style.display = "none";
            u.over.appendChild(tt);
            u._ccusTip = tt;
          };
          var update = function (u) {
            var tt = u._ccusTip;
            if (!tt) return;
            var idx = u.cursor.idx;
            if (idx == null) { tt.style.display = "none"; return; }
            var idxs = u.cursor.idxs || [];
            var rows = "";
            for (var i = 1; i < u.series.length; i++) {
              if (u.series[i].show === false) continue;
              var di = idxs[i];
              if (di == null) continue;
              var val = u.data[i][di];
              if (val == null) continue;
              var spc = seriesSpecs[i - 1] || {};
              rows += '<div class="ccus-tip-row"><span class="ccus-tip-dot" style="background:' + spc.stroke + '"></span>'
                + '<span class="ccus-tip-label">' + escapeText(spc.label) + '</span>'
                + '<span class="ccus-tip-val">' + round1(val) + unit + '</span></div>';
            }
            if (!rows) { tt.style.display = "none"; return; }
            tt.innerHTML = '<div class="ccus-tip-head">' + escapeText(formatXHead(spec, u, idx)) + '</div>' + rows;
            tt.style.display = "block";
            var left = u.cursor.left;
            var top = u.cursor.top;
            var x = left + 14;
            var y = top + 14;
            if (x + tt.offsetWidth > u.over.clientWidth) x = left - tt.offsetWidth - 14;
            if (x < 0) x = 4;
            if (y + tt.offsetHeight > u.over.clientHeight) y = u.over.clientHeight - tt.offsetHeight - 4;
            if (y < 0) y = 4;
            tt.style.left = x + "px";
            tt.style.top = y + "px";
          };
          return { ready: [create], setCursor: [update] };
        }

        function buildOpts(spec, el) {
          var unit = spec.yUnit || "";
          var valueFmt = makeValueFmt(unit);

          var series = [{}];
          spec.series.forEach(function (s) {
            var ser = {
              label: s.label,
              stroke: s.stroke,
              width: s.width || 2,
              value: valueFmt,
              spanGaps: true,
            };
            if (s.fill) ser.fill = s.fill;
            if (s.dash) ser.dash = s.dash;
            if (spec.bars) {
              ser.paths = uPlot.paths.bars({ size: [0.62, 48], align: 0 });
              ser.points = { show: false };
            }
            series.push(ser);
          });

          var xAxis = {
            stroke: THEME.axis,
            grid: { stroke: THEME.grid, width: 1 },
            ticks: { stroke: THEME.grid, width: 1 },
          };
          if (spec.xType === "category") {
            xAxis.values = function (u, splits) {
              return splits.map(function (v) {
                var i = Math.round(v);
                return spec.xLabels && spec.xLabels[i] != null ? spec.xLabels[i] : "";
              });
            };
          } else {
            // time 轴：用 24 小时制刻度（替换 uPlot 默认 12h + am/pm）。
            xAxis.values = timeAxisVals;
          }
          var yAxis = {
            stroke: THEME.axis,
            grid: { stroke: THEME.grid, width: 1 },
            ticks: { stroke: THEME.grid, width: 1 },
            values: function (u, splits) {
              return splits.map(function (v) { return round1(v) + unit; });
            },
          };

          var scales = { x: { time: spec.xType === "time" } };
          if (spec.xType === "category") {
            scales.x = {
              time: false,
              range: function (u, min, max) { return [Math.floor(min) - 0.5, Math.ceil(max) + 0.5]; },
            };
          }
          if (spec.yRange) {
            scales.y = { range: spec.yRange };
          } else if (spec.yMin0) {
            scales.y = {
              range: function (u, min, max) {
                var hi = max == null || max <= 0 ? 1 : max;
                return [0, hi];
              },
            };
          }

          var opts = {
            width: el.clientWidth || 920,
            height: spec.height || 280,
            scales: scales,
            series: series,
            axes: [xAxis, yAxis],
            // 关掉 uPlot 原生底部 legend（每条 series 一行），改用 buildLegend 自绘「每人一项」图例。
            legend: { show: false },
            // dataIdx 2D 吸附：横向重合的尖峰按鼠标高度命中峰顶，稀疏区/缺失退回最近真实点。
            cursor: { show: true, dataIdx: nearestPointIdx },
          };
          var hooks = makeTooltipHooks(spec, spec.series);
          if (spec.bars) {
            hooks.draw = [barLabelHook(unit)];
          }
          opts.hooks = hooks;
          return opts;
        }

        // 自绘图例：每个 legendGroups 项渲染成一个「名字」chip，点击同时切换该项下所有 series 显隐
        // （多人时一个人名联动 5h + 7d 两条线）。人名按 spec 原样（小写），不强制大写。
        function buildLegend(u, spec, host) {
          var groups = spec.legendGroups;
          if (!groups || !groups.length || !host.parentNode) return;
          var wrap = document.createElement("div");
          wrap.className = "ccus-legend";
          groups.forEach(function (g) {
            var item = document.createElement("span");
            item.className = "ccus-legend-item";
            var dot = document.createElement("span");
            dot.className = "ccus-legend-dot";
            dot.style.background = g.color;
            var label = document.createElement("span");
            label.textContent = g.label;
            item.appendChild(dot);
            item.appendChild(label);
            item.addEventListener("click", function () {
              var first = g.seriesIdx[0];
              var shown = u.series[first] ? u.series[first].show !== false : true;
              var next = !shown;
              g.seriesIdx.forEach(function (si) { u.setSeries(si, { show: next }); });
              item.classList.toggle("is-off", !next);
            });
            wrap.appendChild(item);
          });
          host.parentNode.insertBefore(wrap, host.nextSibling);
        }

        var instances = [];
        function initOne(node) {
          var id = node.getAttribute("data-target");
          var el = id ? document.getElementById(id) : null;
          if (!el) return;
          var payload;
          try { payload = JSON.parse(node.textContent); } catch (e) { return; }
          var opts = buildOpts(payload.spec, el);
          var u = new uPlot(opts, payload.data, el);
          buildLegend(u, payload.spec, el);
          instances.push({ u: u, el: el, height: payload.spec.height || 280 });
        }

        function initAll() {
          var nodes = document.querySelectorAll("script.ccus-chart");
          for (var i = 0; i < nodes.length; i++) initOne(nodes[i]);
        }

        var resizeTimer = null;
        window.addEventListener("resize", function () {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function () {
            instances.forEach(function (inst) {
              inst.u.setSize({ width: inst.el.clientWidth || 920, height: inst.height });
            });
          }, 120);
        });

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", initAll);
        } else {
          initAll();
        }
      })();
    </script>`;
}
