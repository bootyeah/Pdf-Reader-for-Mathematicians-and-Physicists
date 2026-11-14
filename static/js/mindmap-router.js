(function () {
    'use strict';

    // 思维导图 SVG 路径几何、障碍物避让与贝塞尔合并评分引擎（供 mindmap.js 调用）

    function segmentHitsAnyCard(allCardBounds, x1, y1, x2, y2, ignoreId1, ignoreId2, pad = 4) {
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
        return (allCardBounds || []).filter(c => {
            if (c.id === ignoreId1 || c.id === ignoreId2) return false;
            return maxX > c.left - pad && minX < c.right + pad &&
                   maxY > c.top - pad && minY < c.bottom + pad;
        });
    }

    function routeHitsObstacles(allCardBounds, pts, fromId, toId) {
        const hits = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const segHits = segmentHitsAnyCard(allCardBounds, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], fromId, toId, 3);
            segHits.forEach(h => { if (!hits.some(x => x.id === h.id)) hits.push(h); });
        }
        return hits;
    }

    // 圆角折线沿布局留白走线。分叉共用出口，汇合共用入口，采用柔和圆弧过渡，末端留 5px 呼吸空间。
    function roundedRoute(points) {
        // 1. 消除极近重复点并拉直 <= 1.2px 的微像素抖动
        const raw = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) >= 0.4);
        if (raw.length === 0) return '';
        if (raw.length === 1) return `M ${raw[0].join(' ')}`;
        if (raw.length === 4) {
            if (Math.abs(raw[0][1] - raw[3][1]) <= 1.2 && raw[3][0] > raw[0][0]) {
                return `M ${raw[0][0]} ${raw[0][1]} L ${raw[3][0]} ${raw[3][1]}`;
            }
            if (Math.abs(raw[0][0] - raw[3][0]) <= 1.2 && raw[3][1] > raw[0][1]) {
                return `M ${raw[0][0]} ${raw[0][1]} L ${raw[3][0]} ${raw[3][1]}`;
            }
        }
        // 2. 合并共线中间顶点，确保圆角半径按完整直线段长度计算
        const clean = [raw[0]];
        for (let i = 1; i < raw.length - 1; i++) {
            const prev = clean[clean.length - 1], cur = raw[i], next = raw[i + 1];
            const dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
            const dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
            const collinearSameDir = Math.abs(dx1 * dy2 - dy1 * dx2) < 1.0 && (dx1 * dx2 + dy1 * dy2) >= 0;
            if (!collinearSameDir) clean.push(cur);
        }
        clean.push(raw[raw.length - 1]);
        if (clean.length === 2) {
            return `M ${clean[0].join(' ')} L ${clean[1].join(' ')}`;
        }

        let d = `M ${clean[0].join(' ')}`;
        for (let i = 1; i < clean.length - 1; i++) {
            const prev = clean[i - 1], cur = clean[i], next = clean[i + 1];
            const lenIn = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
            const lenOut = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
            if (lenIn < 0.5 || lenOut < 0.5) {
                d += ` L ${cur.join(' ')}`;
                continue;
            }
            const r = Math.min(14, lenIn / 2, lenOut / 2);
            const entry = cur.map((v, k) => v + (prev[k] - v) * r / lenIn);
            const exit = cur.map((v, k) => v + (next[k] - v) * r / lenOut);
            d += ` L ${entry.join(' ')} Q ${cur.join(' ')} ${exit.join(' ')}`;
        }
        return d + ` L ${clean[clean.length - 1].join(' ')}`;
    }

    function getMergeCardPort(rect, side, isTarget, shift = 0) {
        const gap = isTarget ? 5 : 2;
        if (side === 'left' || side === 'right') {
            const maxShift = Math.max(0, (rect.bottom - rect.top) / 2 - 9);
            const s = Math.max(-maxShift, Math.min(maxShift, shift));
            return {
                x: side === 'left' ? rect.left - gap : rect.right + gap,
                y: rect.cy + s,
                nx: side === 'left' ? -1 : 1,
                ny: 0,
                side
            };
        }
        const maxShift = Math.max(0, (rect.right - rect.left) / 2 - 14);
        const s = Math.max(-maxShift, Math.min(maxShift, shift));
        return {
            x: rect.cx + s,
            y: side === 'top' ? rect.top - gap : rect.bottom + gap,
            nx: 0,
            ny: side === 'top' ? -1 : 1,
            side
        };
    }

    function pointToSolidSegDist(px, py, seg) {
        const proj = Math.max(0, Math.min(seg.len, (px - seg.x1) * seg.ux + (py - seg.y1) * seg.uy));
        const cx = seg.x1 + seg.ux * proj;
        const cy = seg.y1 + seg.uy * proj;
        return Math.hypot(px - cx, py - cy);
    }

    function sampleCubicBezier(p1, cp1, cp2, p2, steps = 24) {
        const pts = [];
        let length = 0;
        for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const mt = 1 - t;
            const x = mt * mt * mt * p1.x + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * p2.x;
            const y = mt * mt * mt * p1.y + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * p2.y;
            if (k > 0) length += Math.hypot(x - pts[k - 1].x, y - pts[k - 1].y);
            pts.push({ x, y });
        }
        return { pts, length };
    }

    function scoreMergeCandidate(cand, fromId, toId, ctx) {
        const { allCardBounds = [], solidEndpoints = [], solidSegments = [], placedMergeRoutes = [] } = ctx || {};
        const { p1, cp1, cp2, p2, basePenalty } = cand;
        let score = basePenalty || 0;

        // 1. 避免与实线共用同一卡片锚点（防止虚线起点/终点压在实线箭头上）
        for (const ep of solidEndpoints) {
            if (ep.nodeId === fromId) {
                const d = Math.hypot(p1.x - ep.x, p1.y - ep.y);
                if (d < 11) score += (11 - d) * 48;
            } else if (ep.nodeId === toId) {
                const d = Math.hypot(p2.x - ep.x, p2.y - ep.y);
                if (d < 11) score += (11 - d) * 48;
            }
        }
        for (const mr of placedMergeRoutes) {
            if (Math.hypot(p1.x - mr.p1.x, p1.y - mr.p1.y) < 9) score += 220;
            if (Math.hypot(p2.x - mr.p2.x, p2.y - mr.p2.y) < 9) score += 220;
        }

        // 2. 沿贝塞尔曲线采样检测卡片穿透与实线平行重叠
        const { pts, length } = sampleCubicBezier(p1, cp1, cp2, p2, 24);
        score += length * 0.025;

        for (let k = 1; k < pts.length - 1; k++) {
            const pt = pts[k];
            const prev = pts[k - 1];
            const next = pts[k + 1];
            const tLen = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
            const tx = (next.x - prev.x) / tLen;
            const ty = (next.y - prev.y) / tLen;

            if (k >= 2 && k <= pts.length - 3) {
                for (const c of allCardBounds) {
                    if (c.id === fromId || c.id === toId) {
                        if (k >= 3 && k <= pts.length - 4 &&
                            pt.x > c.left + 2 && pt.x < c.right - 2 &&
                            pt.y > c.top + 2 && pt.y < c.bottom - 2) {
                            score += 1200;
                        }
                    } else if (pt.x > c.left - 6 && pt.x < c.right + 6 &&
                               pt.y > c.top - 6 && pt.y < c.bottom + 6) {
                        score += 950;
                    }
                }
            }

            for (const seg of solidSegments) {
                const d = pointToSolidSegDist(pt.x, pt.y, seg);
                if (d < 15) {
                    const align = Math.abs(tx * seg.ux + ty * seg.uy);
                    if (align > 0.68) {
                        score += (15 - d) * 40 * align;
                    } else if (d < 6) {
                        score += (6 - d) * 10;
                    }
                }
            }

            for (const mr of placedMergeRoutes) {
                const dm = Math.hypot(pt.x - mr.pts[k].x, pt.y - mr.pts[k].y);
                if (dm < 12) {
                    score += (12 - dm) * 24;
                }
            }
        }

        cand.pts = pts;
        return score;
    }

    window.MindMapRouter = {
        segmentHitsAnyCard,
        routeHitsObstacles,
        roundedRoute,
        getMergeCardPort,
        pointToSolidSegDist,
        sampleCubicBezier,
        scoreMergeCandidate
    };
})();
