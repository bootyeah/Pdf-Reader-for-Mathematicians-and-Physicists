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
        if (!allCardBounds || !allCardBounds.length || !pts || pts.length < 2) return hits;
        const pad = 3;
        const seen = new Set();
        for (let i = 0; i < pts.length - 1; i++) {
            const x1 = pts[i][0], y1 = pts[i][1];
            const x2 = pts[i + 1][0], y2 = pts[i + 1][1];
            const minX = x1 < x2 ? x1 : x2;
            const maxX = x1 > x2 ? x1 : x2;
            const minY = y1 < y2 ? y1 : y2;
            const maxY = y1 > y2 ? y1 : y2;
            for (let j = 0; j < allCardBounds.length; j++) {
                const c = allCardBounds[j];
                if (c.id === fromId || c.id === toId || seen.has(c.id)) continue;
                if (maxX > c.left - pad && minX < c.right + pad &&
                    maxY > c.top - pad && minY < c.bottom + pad) {
                    seen.add(c.id);
                    hits.push(c);
                }
            }
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
        const pts = new Array(steps + 1);
        let length = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let prevX = 0, prevY = 0;
        for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const mt = 1 - t;
            const mt2 = mt * mt;
            const t2 = t * t;
            const c0 = mt2 * mt;
            const c1 = 3 * mt2 * t;
            const c2 = 3 * mt * t2;
            const c3 = t2 * t;
            const x = c0 * p1.x + c1 * cp1.x + c2 * cp2.x + c3 * p2.x;
            const y = c0 * p1.y + c1 * cp1.y + c2 * cp2.y + c3 * p2.y;
            if (k > 0) {
                const dx = x - prevX, dy = y - prevY;
                length += Math.sqrt(dx * dx + dy * dy);
            }
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            pts[k] = { x, y };
            prevX = x;
            prevY = y;
        }
        return { pts, length, minX, maxX, minY, maxY };
    }

    function scoreMergeCandidate(cand, fromId, toId, ctx, bestScore = Infinity) {
        const {
            allCardBounds = [],
            solidEndpoints = [],
            solidEndpointsByNode = null,
            solidSegments = [],
            placedMergeRoutes = []
        } = ctx || {};
        const { p1, cp1, cp2, p2, basePenalty } = cand;
        let score = basePenalty || 0;
        if (score >= bestScore) return score;

        // 1. 避免与实线共用同一卡片锚点（防止虚线起点/终点压在实线箭头上）
        if (solidEndpointsByNode) {
            const fromEps = solidEndpointsByNode.get(fromId);
            if (fromEps) {
                for (let i = 0; i < fromEps.length; i++) {
                    const ep = fromEps[i];
                    const dx = p1.x - ep.x, dy = p1.y - ep.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < 121) score += (11 - Math.sqrt(d2)) * 48;
                }
            }
            if (toId !== fromId) {
                const toEps = solidEndpointsByNode.get(toId);
                if (toEps) {
                    for (let i = 0; i < toEps.length; i++) {
                        const ep = toEps[i];
                        const dx = p2.x - ep.x, dy = p2.y - ep.y;
                        const d2 = dx * dx + dy * dy;
                        if (d2 < 121) score += (11 - Math.sqrt(d2)) * 48;
                    }
                }
            }
        } else {
            for (let i = 0; i < solidEndpoints.length; i++) {
                const ep = solidEndpoints[i];
                if (ep.nodeId === fromId) {
                    const dx = p1.x - ep.x, dy = p1.y - ep.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < 121) score += (11 - Math.sqrt(d2)) * 48;
                } else if (ep.nodeId === toId) {
                    const dx = p2.x - ep.x, dy = p2.y - ep.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < 121) score += (11 - Math.sqrt(d2)) * 48;
                }
            }
        }
        if (score >= bestScore) return score;

        for (let i = 0; i < placedMergeRoutes.length; i++) {
            const mr = placedMergeRoutes[i];
            const dx1 = p1.x - mr.p1.x, dy1 = p1.y - mr.p1.y;
            if (dx1 * dx1 + dy1 * dy1 < 81) score += 220;
            const dx2 = p2.x - mr.p2.x, dy2 = p2.y - mr.p2.y;
            if (dx2 * dx2 + dy2 * dy2 < 81) score += 220;
        }
        if (score >= bestScore) return score;

        // 2. 沿贝塞尔曲线采样检测卡片穿透与实线平行重叠（AABB 预裁剪 + 分支定界剪枝）
        const { pts, length, minX: cMinX, maxX: cMaxX, minY: cMinY, maxY: cMaxY } = sampleCubicBezier(p1, cp1, cp2, p2, 24);
        score += length * 0.025;
        if (score >= bestScore) return score;

        const localCards = [];
        for (let i = 0; i < allCardBounds.length; i++) {
            const c = allCardBounds[i];
            if (cMaxX > c.left - 6 && cMinX < c.right + 6 && cMaxY > c.top - 6 && cMinY < c.bottom + 6) {
                localCards.push(c);
            }
        }
        const localSegments = [];
        for (let i = 0; i < solidSegments.length; i++) {
            const seg = solidSegments[i];
            const sMinX = seg.minX !== undefined ? seg.minX : (seg.x1 < seg.x2 ? seg.x1 : seg.x2);
            const sMaxX = seg.maxX !== undefined ? seg.maxX : (seg.x1 > seg.x2 ? seg.x1 : seg.x2);
            const sMinY = seg.minY !== undefined ? seg.minY : (seg.y1 < seg.y2 ? seg.y1 : seg.y2);
            const sMaxY = seg.maxY !== undefined ? seg.maxY : (seg.y1 > seg.y2 ? seg.y1 : seg.y2);
            if (cMaxX > sMinX - 15 && cMinX < sMaxX + 15 && cMaxY > sMinY - 15 && cMinY < sMaxY + 15) {
                localSegments.push(seg);
            }
        }
        const localMergeRoutes = [];
        for (let i = 0; i < placedMergeRoutes.length; i++) {
            const mr = placedMergeRoutes[i];
            if (mr.maxX === undefined || (cMaxX > mr.minX - 12 && cMinX < mr.maxX + 12 && cMaxY > mr.minY - 12 && cMinY < mr.maxY + 12)) {
                localMergeRoutes.push(mr);
            }
        }

        const nCards = localCards.length;
        const nSegs = localSegments.length;
        const nMerges = localMergeRoutes.length;
        const lastIdx = pts.length - 1;

        for (let k = 1; k < lastIdx; k++) {
            const pt = pts[k];
            const px = pt.x, py = pt.y;

            if (nCards > 0 && k >= 2 && k <= lastIdx - 2) {
                const allowSelf = k >= 3 && k <= lastIdx - 3;
                for (let i = 0; i < nCards; i++) {
                    const c = localCards[i];
                    if (c.id === fromId || c.id === toId) {
                        if (allowSelf &&
                            px > c.left + 2 && px < c.right - 2 &&
                            py > c.top + 2 && py < c.bottom - 2) {
                            score += 1200;
                        }
                    } else if (px > c.left - 6 && px < c.right + 6 &&
                               py > c.top - 6 && py < c.bottom + 6) {
                        score += 950;
                    }
                }
                if (score >= bestScore) return score;
            }

            if (nSegs > 0) {
                const prev = pts[k - 1];
                const next = pts[k + 1];
                const dtx = next.x - prev.x, dty = next.y - prev.y;
                const tLen = Math.sqrt(dtx * dtx + dty * dty) || 1;
                const tx = dtx / tLen;
                const ty = dty / tLen;
                for (let i = 0; i < nSegs; i++) {
                    const seg = localSegments[i];
                    const sMinX = seg.minX !== undefined ? seg.minX : (seg.x1 < seg.x2 ? seg.x1 : seg.x2);
                    if (px < sMinX - 15) continue;
                    const sMaxX = seg.maxX !== undefined ? seg.maxX : (seg.x1 > seg.x2 ? seg.x1 : seg.x2);
                    if (px > sMaxX + 15) continue;
                    const sMinY = seg.minY !== undefined ? seg.minY : (seg.y1 < seg.y2 ? seg.y1 : seg.y2);
                    if (py < sMinY - 15) continue;
                    const sMaxY = seg.maxY !== undefined ? seg.maxY : (seg.y1 > seg.y2 ? seg.y1 : seg.y2);
                    if (py > sMaxY + 15) continue;
                    let proj = (px - seg.x1) * seg.ux + (py - seg.y1) * seg.uy;
                    if (proj < 0) proj = 0;
                    else if (proj > seg.len) proj = seg.len;
                    const dx = px - (seg.x1 + seg.ux * proj);
                    const dy = py - (seg.y1 + seg.uy * proj);
                    const d2 = dx * dx + dy * dy;
                    if (d2 < 225) {
                        const d = Math.sqrt(d2);
                        const align = Math.abs(tx * seg.ux + ty * seg.uy);
                        if (align > 0.68) {
                            score += (15 - d) * 40 * align;
                        } else if (d < 6) {
                            score += (6 - d) * 10;
                        }
                    }
                }
                if (score >= bestScore) return score;
            }

            if (nMerges > 0) {
                for (let i = 0; i < nMerges; i++) {
                    const mrPt = localMergeRoutes[i].pts[k];
                    const dx = px - mrPt.x;
                    if (dx <= -12 || dx >= 12) continue;
                    const dy = py - mrPt.y;
                    if (dy <= -12 || dy >= 12) continue;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < 144) {
                        score += (12 - Math.sqrt(d2)) * 24;
                    }
                }
                if (score >= bestScore) return score;
            }
        }

        cand.pts = pts;
        cand.minX = cMinX;
        cand.maxX = cMaxX;
        cand.minY = cMinY;
        cand.maxY = cMaxY;
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
