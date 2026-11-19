// =============================================================================
// 纯图片 PDF 页面自动分格引擎 (Scheme A: 前端 Canvas 像素级切格 + AI 编号识字 + 行内墨迹簇对齐)
// -----------------------------------------------------------------------------
// 1. 本地毫秒级切格：自适应积分图二值化 + 行/栏连通域切分 + 行内墨迹簇检测，物理坐标零漂移；
// 2. 左侧扩展导引栏绘号：绝不遮挡原文墨迹，发给 API Manager「页面自动分格」配置的 GLM 模型；
// 3. 行内字宽与墨迹簇对齐：将识别文本精准锚定至墨迹区间，交由 text-layer-precision.js 渲染；
// 4. 独立存储：写入 state.pageGrids、本地 IndexedDB 与 PDF InfoDict (ReaderProGrids)，不上传云端。
// =============================================================================
(function () {
    'use strict';

    const API_URL = '/api/page-grid';
    const WORK_MAX_PX = 1400;
    const GUIDE_MAX_PX = 1800;
    const GUTTER_PX = 52;
    const runningPages = new Set();

    let measureCanvas = null;
    let measureCtx = null;
    function measureTextWeight(str) {
        if (!str) return 0;
        if (!measureCtx) {
            measureCanvas = document.createElement('canvas');
            measureCanvas.width = 0;
            measureCanvas.height = 0;
            measureCtx = measureCanvas.getContext('2d');
        }
        measureCtx.font = '400 20px Arial, Helvetica, sans-serif';
        return Math.max(1, measureCtx.measureText(str).width);
    }

    function round4(v) {
        return Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
    }

    // =========================================================================
    // 一、Canvas 像素级自适应二值化与文字行/墨迹簇提取
    // =========================================================================
    function extractCanvasTextLines(sourceCanvas) {
        const srcW = sourceCanvas.width;
        const srcH = sourceCanvas.height;
        if (!(srcW > 16 && srcH > 16)) return [];

        const scale = Math.min(1, WORK_MAX_PX / Math.max(srcW, srcH));
        const W = Math.max(32, Math.round(srcW * scale));
        const H = Math.max(32, Math.round(srcH * scale));

        const workCanvas = document.createElement('canvas');
        workCanvas.width = W;
        workCanvas.height = H;
        const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(sourceCanvas, 0, 0, W, H);

        const rgba = ctx.getImageData(0, 0, W, H).data;
        const lum = new Uint8Array(W * H);
        const stride = W + 1;
        const integral = new Int32Array(stride * (H + 1));

        for (let y = 0; y < H; y++) {
            let rowSum = 0;
            const rowOff = y * W;
            const intRow = (y + 1) * stride;
            const intPrev = y * stride;
            for (let x = 0; x < W; x++) {
                const idx = (rowOff + x) * 4;
                const g = (rgba[idx] * 77 + rgba[idx + 1] * 150 + rgba[idx + 2] * 29) >> 8;
                lum[rowOff + x] = g;
                rowSum += g;
                integral[intRow + x + 1] = integral[intPrev + x + 1] + rowSum;
            }
        }

        // 局部自适应二值化：抗扫描阴影、书脊暗角与泛黄底色，并剔除 1% 页面边缘扫描黑线
        const ink = new Uint8Array(W * H);
        const radius = Math.max(12, Math.round(Math.min(W, H) * 0.022));
        const marginX = Math.max(2, Math.round(W * 0.01));
        const marginY = Math.max(2, Math.round(H * 0.01));
        const deltaThresh = 26;

        for (let y = marginY; y < H - marginY; y++) {
            const y0 = Math.max(0, y - radius);
            const y1 = Math.min(H, y + radius + 1);
            const r0 = y0 * stride;
            const r1 = y1 * stride;
            const rowOff = y * W;
            for (let x = marginX; x < W - marginX; x++) {
                const x0 = Math.max(0, x - radius);
                const x1 = Math.min(W, x + radius + 1);
                const area = (x1 - x0) * (y1 - y0);
                const sum = integral[r1 + x1] - integral[r0 + x1] - integral[r1 + x0] + integral[r0 + x0];
                const localMean = sum / area;
                if (localMean - lum[rowOff + x] > deltaThresh && lum[rowOff + x] < 225) {
                    ink[rowOff + x] = 1;
                }
            }
        }

        // 第一步：行内水平形态学桥接（RLSA），连接同行字符与词间空格，保持多栏间距断开
        const bridgeX = Math.max(4, Math.round(W * 0.017));
        const rowRuns = new Array(H);
        for (let y = 0; y < H; y++) {
            const runs = [];
            const rowOff = y * W;
            let inRun = false;
            let startX = 0;
            let lastInkX = 0;
            let inkCount = 0;
            for (let x = 0; x < W; x++) {
                if (ink[rowOff + x]) {
                    if (!inRun) {
                        inRun = true;
                        startX = x;
                        inkCount = 1;
                    } else {
                        inkCount++;
                    }
                    lastInkX = x;
                } else if (inRun && (x - lastInkX) > bridgeX) {
                    runs.push({ x0: startX, x1: lastInkX + 1, y, inkCount, comp: -1 });
                    inRun = false;
                }
            }
            if (inRun) {
                runs.push({ x0: startX, x1: lastInkX + 1, y, inkCount, comp: -1 });
            }
            rowRuns[y] = runs;
        }

        // 第二步：纵向连通合并（允许 1px 断笔容差以吸附 i/j 点号与断划）
        const parent = [];
        const comps = [];
        function find(i) {
            while (parent[i] !== i) {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            return i;
        }
        function union(a, b) {
            const ra = find(a);
            const rb = find(b);
            if (ra === rb) return ra;
            const ca = comps[ra];
            const cb = comps[rb];
            ca.x0 = Math.min(ca.x0, cb.x0);
            ca.y0 = Math.min(ca.y0, cb.y0);
            ca.x1 = Math.max(ca.x1, cb.x1);
            ca.y1 = Math.max(ca.y1, cb.y1);
            ca.inkCount += cb.inkCount;
            parent[rb] = ra;
            return ra;
        }

        for (let y = 0; y < H; y++) {
            const runs = rowRuns[y];
            for (let i = 0; i < runs.length; i++) {
                const run = runs[i];
                for (let py = Math.max(0, y - 2); py < y; py++) {
                    const prevRuns = rowRuns[py];
                    for (let j = 0; j < prevRuns.length; j++) {
                        const pr = prevRuns[j];
                        if (pr.x1 >= run.x0 - 1 && pr.x0 <= run.x1 + 1) {
                            if (run.comp === -1) {
                                run.comp = find(pr.comp);
                                const c = comps[run.comp];
                                c.x0 = Math.min(c.x0, run.x0);
                                c.y0 = Math.min(c.y0, run.y0 ?? run.y);
                                c.x1 = Math.max(c.x1, run.x1);
                                c.y1 = Math.max(c.y1, run.y + 1);
                                c.inkCount += run.inkCount;
                            } else {
                                run.comp = union(run.comp, pr.comp);
                            }
                        }
                    }
                }
                if (run.comp === -1) {
                    const id = comps.length;
                    parent.push(id);
                    comps.push({ x0: run.x0, y0: run.y, x1: run.x1, y1: run.y + 1, inkCount: run.inkCount });
                    run.comp = id;
                }
            }
        }

        // 收集有效根连通块并过滤明显噪点与长分割线
        const rawBlocks = [];
        const minH = Math.max(5, Math.round(H * 0.0055));
        const minW = Math.max(5, Math.round(W * 0.0055));
        for (let i = 0; i < comps.length; i++) {
            if (parent[i] !== i) continue;
            const c = comps[i];
            const bw = c.x1 - c.x0;
            const bh = c.y1 - c.y0;
            if (bh < minH || bw < minW || c.inkCount < 8) continue;
            // 排除页眉/页脚细长横线与竖向边框线
            if (bw > bh * 28 && bh < H * 0.0075) continue;
            if (bh > bw * 18 && bw < W * 0.008) continue;
            rawBlocks.push(c);
        }
        if (!rawBlocks.length) return [];

        // 估算页面标准单行字高（取常规行高区间的水平加权中位数）
        const lineHeightCandidates = rawBlocks
            .filter(b => {
                const bh = b.y1 - b.y0;
                const bw = b.x1 - b.x0;
                return bh >= H * 0.007 && bh <= H * 0.045 && bw >= bh * 0.8;
            })
            .map(b => b.y1 - b.y0)
            .sort((a, b) => a - b);
        const medianH = lineHeightCandidates.length
            ? lineHeightCandidates[Math.floor(lineHeightCandidates.length * 0.5)]
            : Math.round(H * 0.018);

        // 第三步：将纵向粘连的多行块在水平投影波谷处切开，并提取紧致行框与行内墨迹簇
        function splitBlockIntoLines(block) {
            const bx0 = block.x0, by0 = block.y0, bx1 = block.x1, by1 = block.y1;
            const bh = by1 - by0;
            const rowProj = new Int32Array(bh);
            let maxRowInk = 0;
            for (let y = by0; y < by1; y++) {
                let cnt = 0;
                const off = y * W;
                for (let x = bx0; x < bx1; x++) {
                    if (ink[off + x]) cnt++;
                }
                rowProj[y - by0] = cnt;
                if (cnt > maxRowInk) maxRowInk = cnt;
            }
            if (maxRowInk === 0) return [];

            // 若块高度超过 1.75 倍标准行高，寻找波谷切分多行
            const yIntervals = [];
            if (bh > medianH * 1.75) {
                const valleyThresh = Math.max(1, Math.floor(maxRowInk * 0.14));
                const minSplitH = Math.max(minH, Math.round(medianH * 0.55));
                let segStart = 0;
                let dy = 0;
                while (dy < bh) {
                    if (dy - segStart >= minSplitH && rowProj[dy] <= valleyThresh) {
                        let vStart = dy;
                        let vEnd = dy;
                        let minVal = rowProj[dy];
                        let minPos = dy;
                        while (vEnd < bh && rowProj[vEnd] <= valleyThresh) {
                            if (rowProj[vEnd] < minVal) {
                                minVal = rowProj[vEnd];
                                minPos = vEnd;
                            }
                            vEnd++;
                        }
                        if (bh - minPos >= minSplitH) {
                            yIntervals.push([by0 + segStart, by0 + minPos]);
                            segStart = vEnd;
                            dy = vEnd;
                            continue;
                        }
                    }
                    dy++;
                }
                if (bh - segStart >= minH) {
                    yIntervals.push([by0 + segStart, by1]);
                }
            } else {
                yIntervals.push([by0, by1]);
            }

            const extracted = [];
            for (let s = 0; s < yIntervals.length; s++) {
                const [sy0, sy1] = yIntervals[s];
                const sh = sy1 - sy0;
                if (sh < minH || sh > H * 0.14) continue;

                // 检查该行带内是否有跨栏大空隙
                const colSplitGap = Math.max(Math.round(W * 0.032), Math.round(Math.max(sh, medianH) * 2.2));
                const colInk = new Int32Array(bx1 - bx0);
                for (let y = sy0; y < sy1; y++) {
                    const off = y * W;
                    for (let x = bx0; x < bx1; x++) {
                        if (ink[off + x]) colInk[x - bx0]++;
                    }
                }

                const xSpans = [];
                let inSpan = false, sx0 = 0, lastX = 0;
                for (let dx = 0; dx < colInk.length; dx++) {
                    if (colInk[dx] > 0) {
                        if (!inSpan) { inSpan = true; sx0 = dx; }
                        lastX = dx;
                    } else if (inSpan && (dx - lastX) > colSplitGap) {
                        xSpans.push([bx0 + sx0, bx0 + lastX + 1]);
                        inSpan = false;
                    }
                }
                if (inSpan) xSpans.push([bx0 + sx0, bx0 + lastX + 1]);

                for (let k = 0; k < xSpans.length; k++) {
                    const [cx0, cx1] = xSpans[k];
                    // 紧致裁剪上下左右墨迹边界
                    let ty0 = sy1, ty1 = sy0, tx0 = cx1, tx1 = cx0, totalInk = 0;
                    for (let y = sy0; y < sy1; y++) {
                        const off = y * W;
                        for (let x = cx0; x < cx1; x++) {
                            if (ink[off + x]) {
                                if (y < ty0) ty0 = y;
                                if (y + 1 > ty1) ty1 = y + 1;
                                if (x < tx0) tx0 = x;
                                if (x + 1 > tx1) tx1 = x + 1;
                                totalInk++;
                            }
                        }
                    }
                    const tw = tx1 - tx0;
                    const th = ty1 - ty0;
                    if (tw < minW || th < minH || totalInk < 6) continue;
                    const density = totalInk / (tw * th);
                    if (density < 0.025 || density > 0.9) continue;
                    if (tw > th * 28 && th < H * 0.0075) continue;

                    // 提取行内词/字墨迹簇（用于将 AI 识别出的词精准吸附到对应水平区间）
                    const clusterGap = Math.max(2, Math.round(th * 0.22));
                    const clusters = [];
                    let cIn = false, cStart = 0, cLast = 0;
                    for (let x = tx0; x < tx1; x++) {
                        let cCnt = 0;
                        for (let y = ty0; y < ty1; y++) {
                            if (ink[y * W + x]) cCnt++;
                        }
                        if (cCnt > 0) {
                            if (!cIn) { cIn = true; cStart = x; }
                            cLast = x;
                        } else if (cIn && (x - cLast) >= clusterGap) {
                            clusters.push({ x: cStart / W, w: (cLast + 1 - cStart) / W });
                            cIn = false;
                        }
                    }
                    if (cIn) {
                        clusters.push({ x: cStart / W, w: (cLast + 1 - cStart) / W });
                    }

                    extracted.push({
                        x: tx0 / W,
                        y: ty0 / H,
                        w: tw / W,
                        h: th / H,
                        clusters
                    });
                }
            }
            return extracted;
        }

        const lineBoxes = [];
        for (let i = 0; i < rawBlocks.length; i++) {
            const lines = splitBlockIntoLines(rawBlocks[i]);
            for (let j = 0; j < lines.length; j++) lineBoxes.push(lines[j]);
        }

        // 第四步：按自然阅读顺序排序并合并同一水平线上紧邻的碎片（如公式中的等号或标点）
        lineBoxes.sort((a, b) => {
            const cyA = a.y + a.h / 2;
            const cyB = b.y + b.h / 2;
            const tol = Math.min(a.h, b.h) * 0.45;
            if (Math.abs(cyA - cyB) <= tol) return a.x - b.x;
            return cyA - cyB;
        });

        const mergedLines = [];
        for (let i = 0; i < lineBoxes.length; i++) {
            const cur = lineBoxes[i];
            if (!mergedLines.length) {
                mergedLines.push(cur);
                continue;
            }
            const prev = mergedLines[mergedLines.length - 1];
            const prevCy = prev.y + prev.h / 2;
            const curCy = cur.y + cur.h / 2;
            const overlapY = Math.min(prev.y + prev.h, cur.y + cur.h) - Math.max(prev.y, cur.y);
            const gapX = cur.x - (prev.x + prev.w);
            const maxMergeGap = Math.max(0.035, Math.max(prev.h, cur.h) * 2.2);
            if ((overlapY > Math.min(prev.h, cur.h) * 0.25 || Math.abs(prevCy - curCy) <= Math.max(prev.h, cur.h) * 0.45) &&
                gapX >= -0.008 && gapX <= maxMergeGap) {
                const nx0 = Math.min(prev.x, cur.x);
                const ny0 = Math.min(prev.y, cur.y);
                const nx1 = Math.max(prev.x + prev.w, cur.x + cur.w);
                const ny1 = Math.max(prev.y + prev.h, cur.y + cur.h);
                prev.x = nx0;
                prev.y = ny0;
                prev.w = nx1 - nx0;
                prev.h = ny1 - ny0;
                prev.clusters = [...(prev.clusters || []), ...(cur.clusters || [])].sort((a, b) => a.x - b.x);
            } else {
                mergedLines.push(cur);
            }
        }

        return mergedLines;
    }

    // =========================================================================
    // 二、生成带左侧编号导引栏的 AI 识图位图（零遮挡原文墨迹）
    // =========================================================================
    function buildAnnotatedGuideImage(sourceCanvas, lineBoxes) {
        const srcW = sourceCanvas.width;
        const srcH = sourceCanvas.height;
        const scale = Math.min(1, GUIDE_MAX_PX / Math.max(srcW, srcH));
        const pageW = Math.max(64, Math.round(srcW * scale));
        const pageH = Math.max(64, Math.round(srcH * scale));
        const gutterW = lineBoxes.length > 0 ? GUTTER_PX : 0;

        const guideCanvas = document.createElement('canvas');
        guideCanvas.width = pageW + gutterW;
        guideCanvas.height = pageH;
        const ctx = guideCanvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, guideCanvas.width, guideCanvas.height);
        ctx.drawImage(sourceCanvas, gutterW, 0, pageW, pageH);

        if (lineBoxes.length > 0) {
            // 导引栏分隔细线
            ctx.strokeStyle = 'rgba(203, 213, 225, 0.8)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(gutterW - 1, 0);
            ctx.lineTo(gutterW - 1, pageH);
            ctx.stroke();

            for (let i = 0; i < lineBoxes.length; i++) {
                const box = lineBoxes[i];
                const label = `[${i + 1}]`;
                const bx = gutterW + Math.round(box.x * pageW);
                const by = Math.round(box.y * pageH);
                const bw = Math.max(4, Math.round(box.w * pageW));
                const bh = Math.max(8, Math.round(box.h * pageH));
                const cy = by + bh / 2;

                // 行框淡红细边
                ctx.strokeStyle = 'rgba(220, 38, 38, 0.42)';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx - 1, by - 1, bw + 2, bh + 2);

                // 编号胶囊：优先放在行框紧左侧空白处；若紧贴左边缘则落入左侧 52px 导引栏，绝不遮挡文字
                const fontSize = Math.max(10, Math.min(14, Math.round(bh * 0.72)));
                ctx.font = `bold ${fontSize}px Consolas, "Courier New", monospace`;
                const textW = Math.ceil(ctx.measureText(label).width);
                const pillW = textW + 6;
                const pillH = fontSize + 4;
                const pillX = Math.max(2, bx - pillW - 4);
                const pillY = Math.max(1, Math.min(pageH - pillH - 1, Math.round(cy - pillH / 2)));

                ctx.fillStyle = '#fef2f2';
                ctx.fillRect(pillX, pillY, pillW, pillH);
                ctx.strokeStyle = 'rgba(220, 38, 38, 0.7)';
                ctx.strokeRect(pillX, pillY, pillW, pillH);

                ctx.fillStyle = '#dc2626';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, pillX + 3, pillY + pillH / 2);
            }
        }

        return guideCanvas.toDataURL('image/jpeg', 0.88);
    }

    // =========================================================================
    // 三、行内文字与墨迹簇（Ink Clusters）高精度对齐
    // =========================================================================
    function alignClustersRecursive(words, clusters, itemY, itemH, out) {
        if (!words.length) return;
        const firstC = clusters[0];
        const lastC = clusters[clusters.length - 1];
        const spanX = firstC.x;
        const spanW = Math.max(0.001, (lastC.x + lastC.w) - firstC.x);

        if (words.length === 1 || clusters.length <= 1) {
            out.push({
                x: round4(spanX),
                y: round4(itemY),
                w: round4(spanW),
                h: round4(itemH),
                t: words.join(' ')
            });
            return;
        }

        // 若空格分隔的词数与墨迹簇数严格相等，1:1 物理锚定每个词与词间空格
        if (words.length === clusters.length) {
            for (let i = 0; i < words.length; i++) {
                const c = clusters[i];
                out.push({
                    x: round4(c.x),
                    y: round4(itemY),
                    w: round4(Math.max(0.001, c.w)),
                    h: round4(itemH),
                    t: words[i]
                });
                if (i < words.length - 1) {
                    const nextC = clusters[i + 1];
                    const gapX = c.x + c.w;
                    const gapW = Math.max(0.0005, nextC.x - gapX);
                    out.push({
                        x: round4(gapX),
                        y: round4(itemY),
                        w: round4(gapW),
                        h: round4(itemH),
                        t: ' '
                    });
                }
            }
            return;
        }

        // 寻找行内最显著的水平墨迹间隙（如定理号与正文间距、公式与右端编号间距）进行递归锚定
        let maxGap = -1;
        let maxGapIdx = -1;
        for (let i = 0; i < clusters.length - 1; i++) {
            const gap = clusters[i + 1].x - (clusters[i].x + clusters[i].w);
            if (gap > maxGap) {
                maxGap = gap;
                maxGapIdx = i;
            }
        }

        if (maxGapIdx >= 0 && maxGap >= itemH * 0.45) {
            const gapLeftEnd = clusters[maxGapIdx].x + clusters[maxGapIdx].w;
            const gapRelPos = (gapLeftEnd - spanX) / spanW;

            const weights = words.map(measureTextWeight);
            const totalW = weights.reduce((a, b) => a + b, 0) || 1;
            let bestWordSplit = -1;
            let bestDiff = Infinity;
            let acc = 0;
            for (let i = 0; i < words.length - 1; i++) {
                acc += weights[i];
                const rel = acc / totalW;
                const diff = Math.abs(rel - gapRelPos);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestWordSplit = i;
                }
            }

            if (bestWordSplit >= 0 && bestDiff <= 0.22) {
                const leftWords = words.slice(0, bestWordSplit + 1);
                const rightWords = words.slice(bestWordSplit + 1);
                const leftClusters = clusters.slice(0, maxGapIdx + 1);
                const rightClusters = clusters.slice(maxGapIdx + 1);

                alignClustersRecursive(leftWords, leftClusters, itemY, itemH, out);
                const gapX = clusters[maxGapIdx].x + clusters[maxGapIdx].w;
                const gapW = Math.max(0.0005, clusters[maxGapIdx + 1].x - gapX);
                out.push({
                    x: round4(gapX),
                    y: round4(itemY),
                    w: round4(gapW),
                    h: round4(itemH),
                    t: ' '
                });
                alignClustersRecursive(rightWords, rightClusters, itemY, itemH, out);
                return;
            }
        }

        out.push({
            x: round4(spanX),
            y: round4(itemY),
            w: round4(spanW),
            h: round4(itemH),
            t: words.join(' ')
        });
    }

    function buildPageGridItems(lineBoxes, linesMap, fallbackBoxes) {
        const items = [];

        if (lineBoxes.length > 0 && linesMap && Object.keys(linesMap).length > 0) {
            const heights = lineBoxes.map(b => b.h).filter(h => h > 0).sort((a, b) => a - b);
            const medianH = heights.length ? heights[Math.floor(heights.length * 0.5)] : 0.018;

            for (let i = 0; i < lineBoxes.length; i++) {
                const rawText = linesMap[String(i + 1)];
                const text = typeof rawText === 'string' ? rawText.trim() : '';
                if (!text) continue;

                const box = lineBoxes[i];
                const cy = box.y + box.h / 2;
                // 适度扩展选区高度以包络上下行距，且与相邻行不重叠；除以 1.12 抵消 CSS 行框比
                let targetBoxH = Math.max(box.h * 1.14, Math.min(box.h * 1.36, medianH * 1.06));
                const itemY = Math.max(0, cy - targetBoxH / 2);
                const itemH = Math.max(0.004, targetBoxH / 1.12);

                const words = text.split(/\s+/).filter(Boolean);
                const clusters = (box.clusters && box.clusters.length)
                    ? box.clusters
                    : [{ x: box.x, w: box.w }];

                const lineItems = [];
                alignClustersRecursive(words, clusters, itemY, itemH, lineItems);
                if (lineItems.length > 0) {
                    lineItems[lineItems.length - 1].eol = 1;
                    for (let k = 0; k < lineItems.length; k++) items.push(lineItems[k]);
                }
            }
            return items;
        }

        // 回退模式：当图像对比度极低未切出预置行框时，采用 AI 返回的归一化坐标 [ymin, xmin, ymax, xmax]
        if (Array.isArray(fallbackBoxes) && fallbackBoxes.length > 0) {
            for (let i = 0; i < fallbackBoxes.length; i++) {
                const entry = fallbackBoxes[i];
                const text = String(entry?.text || '').trim();
                const b = entry?.box;
                if (!text || !Array.isArray(b) || b.length < 4) continue;
                const ymin = Math.max(0, Math.min(1000, Number(b[0]) || 0)) / 1000;
                const xmin = Math.max(0, Math.min(1000, Number(b[1]) || 0)) / 1000;
                const ymax = Math.max(ymin + 0.005, Math.min(1000, Number(b[2]) || 0) / 1000);
                const xmax = Math.max(xmin + 0.01, Math.min(1000, Number(b[3]) || 0) / 1000);
                const boxH = ymax - ymin;
                items.push({
                    x: round4(xmin),
                    y: round4(ymin),
                    w: round4(xmax - xmin),
                    h: round4(Math.max(0.004, boxH / 1.12)),
                    t: text,
                    eol: 1
                });
            }
        }
        return items;
    }

    // =========================================================================
    // 四、与 PDF.js / text-layer-precision.js / 全文搜索无缝桥接
    // =========================================================================
    function buildPageGridTextContent(pageNum, page = null) {
        const grid = state.pageGrids?.[pageNum];
        const rawItems = grid?.items || [];
        let pageWidth = 595, pageHeight = 842, pageX = 0, pageY = 0;
        if (page && typeof page.getViewport === 'function') {
            const vp = page.getViewport({ scale: 1 });
            if (vp?.rawDims) {
                pageWidth = vp.rawDims.pageWidth || vp.width || pageWidth;
                pageHeight = vp.rawDims.pageHeight || vp.height || pageHeight;
                pageX = vp.rawDims.pageX || 0;
                pageY = vp.rawDims.pageY || 0;
            } else if (vp) {
                pageWidth = vp.width || pageWidth;
                pageHeight = vp.height || pageHeight;
            }
        } else if (state.pageDimensions?.[pageNum - 1]) {
            pageWidth = state.pageDimensions[pageNum - 1].width || pageWidth;
            pageHeight = state.pageDimensions[pageNum - 1].height || pageHeight;
        }

        const items = rawItems.map(g => {
            const leftPt = g.x * pageWidth;
            const topPt = g.y * pageHeight;
            const widthPt = g.w * pageWidth;
            const heightPt = g.h * pageHeight;
            return {
                str: String(g.t ?? ''),
                dir: 'ltr',
                width: widthPt,
                height: heightPt,
                transform: [heightPt, 0, 0, heightPt, pageX + leftPt, pageY + pageHeight - (topPt + heightPt * 0.8)],
                fontName: 'g_ocr',
                hasEOL: Boolean(g.eol),
                _ocrBox: { x: g.x, y: g.y, w: g.w, h: g.h }
            };
        });

        return {
            items,
            styles: {
                g_ocr: {
                    fontFamily: 'sans-serif',
                    ascent: 0.8,
                    descent: -0.2,
                    vertical: false
                }
            }
        };
    }

    async function refreshPageTextLayer(pageNum) {
        pageNum = Number(pageNum);
        if (!state.pdfDoc || !Number.isInteger(pageNum) || pageNum < 1) return false;
        if (typeof invalidatePdfPageTextCache === 'function') {
            invalidatePdfPageTextCache(pageNum, state.pdfDoc);
        }
        if (typeof evictCachedPdfPage === 'function' && typeof cachedPdfPages !== 'undefined' && cachedPdfPages.has(pageNum)) {
            evictCachedPdfPage(pageNum);
        }
        const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
        const textLayer = document.getElementById(`text-layer-${pageNum}`);
        if (!wrapper || !textLayer) return false;

        const doc = state.pdfDoc;
        const loadToken = state.loadToken;
        const page = await doc.getPage(pageNum);
        if (state.pdfDoc !== doc || state.loadToken !== loadToken) return false;

        const scale = textLayer._pdfScale || state.scale;
        const viewport = page.getViewport({ scale });
        const textContent = await getPdfTextContent(doc, pageNum, page);
        if (state.pdfDoc !== doc || state.loadToken !== loadToken) return false;

        textLayer.style.width = viewport.width + 'px';
        textLayer.style.height = viewport.height + 'px';
        textLayer.style.setProperty('--scale-factor', scale);
        textLayer.replaceChildren();

        const task = typeof window.renderPrecisionTextLayer === 'function'
            ? window.renderPrecisionTextLayer(page, textContent, textLayer, viewport)
            : pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayer, viewport, textDivs: [] });
        await task.promise;
        return true;
    }

    // =========================================================================
    // 五、自动分格主流程与 HUD 极简按钮控制
    // =========================================================================
    async function renderHighResPageCanvas(doc, pageNum) {
        const page = await doc.getPage(pageNum);
        const baseVp = page.getViewport({ scale: 1 });
        const rawW = baseVp.rawDims?.pageWidth || baseVp.width;
        const rawH = baseVp.rawDims?.pageHeight || baseVp.height;

        // 若当前页已在屏幕渲染出高清 Canvas 且长边 >= 1200px，直接复用以节省一次光栅化
        const existingCanvas = document.getElementById(`canvas-${pageNum}`);
        if (existingCanvas && existingCanvas.width >= 900 && existingCanvas.height >= 900) {
            return { canvas: existingCanvas, pageWidth: rawW, pageHeight: rawH };
        }

        const targetScale = Math.min(2.5, GUIDE_MAX_PX / Math.max(rawW, rawH));
        const vp = page.getViewport({ scale: Math.max(1.5, targetScale) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        return { canvas, pageWidth: rawW, pageHeight: rawH };
    }

    function hasGrid(pageNum) {
        return Boolean(state.pageGrids?.[pageNum]?.items?.length);
    }

    function updateHudButton() {
        const btn = els.autoGridBtn || document.getElementById('auto-grid-btn');
        const icon = els.autoGridIcon || document.getElementById('auto-grid-icon');
        if (!btn || !icon) return;

        const pageNum = Number(state.currentPhysicalPage) || 1;
        const isRunning = runningPages.has(pageNum);
        const isDone = hasGrid(pageNum);

        btn.classList.remove(
            'text-gray-400', 'text-blue-600', 'bg-blue-50',
            'hover:text-blue-600', 'hover:bg-blue-50', 'hover:bg-blue-100'
        );

        if (isRunning) {
            btn.classList.add('text-blue-600', 'bg-blue-50');
            icon.className = 'ph ph-spinner animate-spin text-[16px]';
            btn.title = `正在为第 ${pageNum} 页自动分格…`;
        } else if (isDone) {
            const count = state.pageGrids[pageNum].items.filter(it => it.eol).length || state.pageGrids[pageNum].items.length;
            btn.classList.add('text-blue-600', 'bg-blue-50', 'hover:bg-blue-100');
            icon.className = 'ph-fill ph-grid-four text-[16px]';
            btn.title = `第 ${pageNum} 页已完成自动分格（共 ${count} 行 · 左键重新分格 · 右键清除本页分格）`;
        } else {
            btn.classList.add('text-gray-400', 'hover:text-blue-600', 'hover:bg-blue-50');
            icon.className = 'ph ph-grid-four text-[16px]';
            btn.title = '当前页自动分格（AI 识别图片文字并生成可框选文本层 · Shift+点击可指定页码）';
        }
    }

    async function runPage(pageNum) {
        if (!state.pdfDoc) return false;
        pageNum = Number(pageNum) || Number(state.currentPhysicalPage) || 1;
        if (pageNum < 1 || pageNum > state.pdfDoc.numPages) {
            alert(`页码超出范围（1 ~ ${state.pdfDoc.numPages}）`);
            return false;
        }
        if (runningPages.has(pageNum)) return false;

        const doc = state.pdfDoc;
        const loadToken = state.loadToken;
        runningPages.add(pageNum);
        updateHudButton();

        try {
            const { canvas, pageWidth, pageHeight } = await renderHighResPageCanvas(doc, pageNum);
            if (state.pdfDoc !== doc || state.loadToken !== loadToken) return false;

            const lineBoxes = extractCanvasTextLines(canvas);
            const guideDataUrl = buildAnnotatedGuideImage(canvas, lineBoxes);

            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: guideDataUrl,
                    lineCount: lineBoxes.length,
                    pageWidth,
                    pageHeight
                })
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) {
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            if (state.pdfDoc !== doc || state.loadToken !== loadToken) return false;

            const items = buildPageGridItems(lineBoxes, data.lines, data.boxes);
            if (!items.length) {
                alert(`第 ${pageNum} 页未识别到可分格的文字内容。`);
                return false;
            }

            if (!state.pageGrids) state.pageGrids = {};
            state.pageGrids[pageNum] = { v: 1, items };
            updateSaveStatus(true);
            if (typeof savePageGridsToStorage === 'function') savePageGridsToStorage();
            await refreshPageTextLayer(pageNum);
            return true;
        } catch (err) {
            console.error('[自动分格] 失败:', err);
            alert(`第 ${pageNum} 页自动分格失败：\n${err.message || err}`);
            return false;
        } finally {
            runningPages.delete(pageNum);
            updateHudButton();
        }
    }

    async function clearPage(pageNum) {
        pageNum = Number(pageNum) || Number(state.currentPhysicalPage) || 1;
        if (!hasGrid(pageNum)) return false;
        delete state.pageGrids[pageNum];
        const cleanLive = JSON.stringify(typeof serializeAnnotationsClean === 'function' ? serializeAnnotationsClean(state.annotations) : state.annotations);
        const cleanLiveGrids = JSON.stringify(typeof serializePageGridsClean === 'function' ? serializePageGridsClean(state.pageGrids) : (state.pageGrids || {}));
        updateSaveStatus(cleanLive !== state.annotationBase || cleanLiveGrids !== (state.pageGridBase || '{}'));
        if (typeof savePageGridsToStorage === 'function') savePageGridsToStorage();
        await refreshPageTextLayer(pageNum);
        updateHudButton();
        return true;
    }

    function reset() {
        runningPages.clear();
        updateHudButton();
    }

    function bindEvents() {
        const btn = els.autoGridBtn || document.getElementById('auto-grid-btn');
        if (!btn) return;

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!state.pdfDoc) return;

            let targetPage = Number(state.currentPhysicalPage) || 1;
            if (e.shiftKey || e.altKey) {
                const input = prompt(`请输入要自动分格的物理页码（1 ~ ${state.pdfDoc.numPages}）：`, String(targetPage));
                if (!input) return;
                const parsed = parseInt(input.trim(), 10);
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > state.pdfDoc.numPages) {
                    alert(`请输入 1 到 ${state.pdfDoc.numPages} 之间的有效页码`);
                    return;
                }
                targetPage = parsed;
            } else if (hasGrid(targetPage)) {
                if (!confirm(`第 ${targetPage} 页已有自动分格文本层，是否重新识别分格？`)) return;
            }
            runPage(targetPage);
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!state.pdfDoc) return;
            const targetPage = Number(state.currentPhysicalPage) || 1;
            if (hasGrid(targetPage)) {
                if (confirm(`确定清除第 ${targetPage} 页的自动分格文本层吗？`)) {
                    clearPage(targetPage);
                }
            } else {
                const input = prompt(`请输入要自动分格的物理页码（1 ~ ${state.pdfDoc.numPages}）：`, String(targetPage));
                if (!input) return;
                const parsed = parseInt(input.trim(), 10);
                if (Number.isInteger(parsed) && parsed >= 1 && parsed <= state.pdfDoc.numPages) {
                    runPage(parsed);
                }
            }
        });
    }

    bindEvents();

    window.buildPageGridTextContent = buildPageGridTextContent;
    window.PageAutoGrid = {
        runPage,
        clearPage,
        hasGrid,
        refreshPageTextLayer,
        updateHudButton,
        extractCanvasTextLines,
        buildAnnotatedGuideImage,
        buildPageGridItems,
        reset
    };
})();
