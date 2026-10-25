        let isWheelZooming = false;

        window.addEventListener('wheel', (e) => {
            if (e.ctrlKey) { 
                e.preventDefault(); 
                if (!isWheelZooming) {
                    isWheelZooming = true;
                    requestAnimationFrame(() => {
                        changeZoom(e.deltaY > 0 ? -0.1 : 0.1); 
                        isWheelZooming = false;
                    });
                }
            } else if (e.deltaX !== 0 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                // 🌟 【终极极速版】横向滚动
                e.preventDefault();
                
                const absDelta = Math.abs(e.deltaX);

                // ⚙️ 参数 1：死区拦截 (Deadzone)
                // 专门用来砍掉鼠标松开后的长尾巴。小于这个数值的系统信号一律被直接扔进垃圾桶。
                // 如果你的鼠标推一下反应迟钝，把 5 改小（比如 2）；如果还是觉得松开后有轻微滑行，把 5 改大（比如 8）。
                if (absDelta < 5) return;

                // ⚙️ 参数 2：爆发倍率 (Multiplier)
                // 因为我们砍掉了长尾巴，单次拨动可能会觉得距离偏短。
                // 这里的 2.5 就是倍率！推得越重，乘得越多，画面飞得越快！
                // 觉得一次滑太短，改大（比如 3.5）；觉得一次滑太猛，改小（比如 1.5）。
                const moveAmount = e.deltaX * 1.5;

                // 🚀 直接暴力赋值给滚动条，没有任何动画队列延迟，松手瞬间绝对刹死！
                els.container.scrollLeft += moveAmount;
            }
        }, { passive: false });

        document.addEventListener('mousedown', (e) => {
            if (e.target.closest('header') || e.target.closest('#note-modal')) return;

            // 🚀 【阶段二/三：多阶段复杂图形拦截器 (自由高亮块 & 自由跨行括号)】
            if (['free-parenthesis', 'highlight-block'].includes(state.currentTool) && state.drawingArrow.isDrawing) {
                e.preventDefault();
                const rect = state.drawingArrow.pageWrapper.getBoundingClientRect();
                
                if (state.currentTool === 'highlight-block' && state.drawingArrow.phase === 2) {
                    document.getElementById('temp-drawing-svg')?.remove();
                    performAction(() => {
                        addAnnotation(state.drawingArrow.pageNum, {
                            id: Date.now().toString(),
                            type: 'highlight-block',
                            color: state.currentColor,
                            start: { x: state.drawingArrow.startX / rect.width, y: state.drawingArrow.startY / rect.height },
                            end: { x: state.drawingArrow.endX / rect.width, y: state.drawingArrow.endY / rect.height },
                            thickness: state.drawingArrow.thickness / rect.width, // 依据容器宽度计算相对比例
                            note: '', text: '[自由高亮块]', timestamp: new Date().toLocaleString()
                        });
                    });
                    state.drawingArrow.isDrawing = false;
                    state.drawingArrow.pageWrapper = null;
                    return; // 拦截结束，直接退出
                }

                if (state.currentTool === 'free-parenthesis') {
                    if (state.drawingArrow.phase === 2) {
                        // 阶段2点击：定宽完成，进入跃迁阶段3
                        state.drawingArrow.phase = 3;
                        return; 
                    } else if (state.drawingArrow.phase === 3) {
                        // 阶段3点击：定型并保存
                        document.getElementById('temp-drawing-svg')?.remove();
                        performAction(() => {
                            addAnnotation(state.drawingArrow.pageNum, {
                                id: Date.now().toString(),
                                type: 'free-parenthesis',
                                color: state.currentColor,
                                start: { x: state.drawingArrow.startX / rect.width, y: state.drawingArrow.startY / rect.height },
                                end: { x: state.drawingArrow.endX / rect.width, y: state.drawingArrow.endY / rect.height },
                                thickness: state.drawingArrow.thickness / rect.height, 
                                localX: state.drawingArrow.finalLocalX / rect.width,
                                lineOffset: state.drawingArrow.finalLineOffset,
                                note: '', text: '[自由括号]', timestamp: new Date().toLocaleString()
                            });
                        });
                        state.drawingArrow.isDrawing = false;
                        state.drawingArrow.pageWrapper = null;
                        return; 
                    }
                }
            }

            if (['arrow', 'brace', 'line', 'rect', 'implies', 'equivalence', 'highlight-block', 'free-parenthesis'].includes(state.currentTool)) {
                const wrapper = e.target.closest('.page-wrapper');
                if (!wrapper) return;
                e.preventDefault();
                const rect = wrapper.getBoundingClientRect();
                
                // 注入初始状态与 phase 1 标识
                state.drawingArrow = {
                    isDrawing: true,
                    phase: 1, 
                    startX: e.clientX - rect.left,
                    startY: e.clientY - rect.top,
                    pageWrapper: wrapper,
                    pageNum: parseInt(wrapper.dataset.pageNum),
                    tempSvgLine: null
                };
                
                const svgNS = "http://www.w3.org/2000/svg";
                const svg = document.createElementNS(svgNS, "svg");
                svg.setAttribute("class", "vector-svg");
                svg.id = "temp-drawing-svg";
                let shape;
                
                if (state.currentTool === 'arrow' || state.currentTool === 'line') {
                    shape = document.createElementNS(svgNS, "line");
                    shape.setAttribute("x1", state.drawingArrow.startX); shape.setAttribute("y1", state.drawingArrow.startY);
                    shape.setAttribute("x2", state.drawingArrow.startX); shape.setAttribute("y2", state.drawingArrow.startY);
                    shape.setAttribute("stroke", state.currentColor); 
                    shape.setAttribute("stroke-width", "2"); 
                    shape.setAttribute("opacity", "0.5");
                } else if (state.currentTool === 'highlight-block') {
                    shape = document.createElementNS(svgNS, "rect");
                    shape.setAttribute("x", "0");
                    shape.setAttribute("y", "-2");
                    shape.setAttribute("width", "0");
                    shape.setAttribute("height", "4");
                    shape.setAttribute("rx", "4");
                    shape.setAttribute("fill", state.currentColor);
                    shape.setAttribute("stroke", "none");
                    shape.setAttribute("opacity", "0.45");
                    shape.style.mixBlendMode = "multiply";
                } else if (state.currentTool === 'free-parenthesis') {
                    shape = document.createElementNS(svgNS, "g");
                    shape.innerHTML = `
                        <path class="fp-left" fill="none" stroke="${state.currentColor}" stroke-width="2"></path>
                        <path class="fp-right" fill="none" stroke="${state.currentColor}" stroke-width="2"></path>
                        <line class="fp-base" stroke="${state.currentColor}" stroke-dasharray="4 4" stroke-width="1" opacity="0.4"></line>
                        <line class="fp-assist" stroke="${state.currentColor}" stroke-dasharray="2 4" stroke-width="1" opacity="0.2"></line>
                    `;
                } else if (state.currentTool === 'rect') {
                    shape = document.createElementNS(svgNS, "rect");
                    shape.setAttribute("x", state.drawingArrow.startX); shape.setAttribute("y", state.drawingArrow.startY);
                    shape.setAttribute("width", "0"); shape.setAttribute("height", "0");
                    shape.setAttribute("fill", "none");
                    shape.setAttribute("stroke", state.currentColor); 
                    shape.setAttribute("stroke-width", "2"); 
                    shape.setAttribute("opacity", "0.5");
                } else if (['implies', 'equivalence'].includes(state.currentTool)) {
                    shape = document.createElementNS(svgNS, "path");
                    shape.setAttribute("d", getImpliesPath(state.drawingArrow.startX, state.drawingArrow.startY, state.drawingArrow.startX, state.drawingArrow.startY, state.scale, state.currentTool === 'equivalence'));
                    shape.setAttribute("fill", "none");
                    shape.setAttribute("stroke", state.currentColor); 
                    shape.setAttribute("stroke-width", "2"); 
                    shape.setAttribute("opacity", "0.5");
                } else {
                    shape = document.createElementNS(svgNS, "path");
                    shape.setAttribute("d", getBracePath(state.drawingArrow.startX, state.drawingArrow.startY, state.drawingArrow.startX, state.drawingArrow.startY));
                    shape.setAttribute("fill", "none");
                    shape.setAttribute("stroke", state.currentColor); 
                    shape.setAttribute("stroke-width", "2"); 
                    shape.setAttribute("opacity", "0.5");
                }
                
                svg.appendChild(shape);
                wrapper.querySelector('.annotation-layer').appendChild(svg);
                state.drawingArrow.tempSvgLine = shape; 
                state.drawingArrow.type = state.currentTool; 
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (['arrow', 'brace', 'line', 'rect', 'implies', 'equivalence', 'highlight-block', 'free-parenthesis'].includes(state.currentTool) && state.drawingArrow.isDrawing) {
                const rect = state.drawingArrow.pageWrapper.getBoundingClientRect();
                if (state.drawingArrow.tempSvgLine) {
                    let currentX = e.clientX - rect.left;
                    let currentY = e.clientY - rect.top;

                    if (currentX > rect.width * 0.98 && typeof toggleSidecar === 'function') {
                        toggleSidecar(true, true);
                    }

                    // 💡 【阶段一】直线的智能正交吸附 (支持高亮块的定轴阶段)
                    if (state.drawingArrow.type === 'line' || (state.drawingArrow.type === 'highlight-block' && state.drawingArrow.phase === 1)) {
                        const dx = currentX - state.drawingArrow.startX;
                        const dy = currentY - state.drawingArrow.startY;
                        const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
                        const threshold = 0.05; 
                        if (angle < threshold) currentY = state.drawingArrow.startY; 
                        else if (Math.abs(angle - Math.PI/2) < threshold) currentX = state.drawingArrow.startX; 
                    }

                    // 🚀 【核心隔离区】：自由高亮块的专属逻辑流 (支持带圆角的旋转矩形)
                    if (state.drawingArrow.type === 'highlight-block') {
                        if (state.drawingArrow.phase === 1) {
                            state.drawingArrow.endX = currentX;
                            state.drawingArrow.endY = currentY;
                            
                            // 运用三角函数计算两点距离与绝对旋转角度
                            const dx = currentX - state.drawingArrow.startX;
                            const dy = currentY - state.drawingArrow.startY;
                            const length = Math.hypot(dx, dy);
                            const angle = Math.atan2(dy, dx) * (180 / Math.PI);
                            
                            state.drawingArrow.tempSvgLine.setAttribute("width", length);
                            // 将矩形原点锁定在起始处，并旋转
                            state.drawingArrow.tempSvgLine.setAttribute("transform", `translate(${state.drawingArrow.startX}, ${state.drawingArrow.startY}) rotate(${angle})`);
                        } else if (state.drawingArrow.phase === 2) {
                            const x1 = state.drawingArrow.startX, y1 = state.drawingArrow.startY;
                            const x2 = state.drawingArrow.endX, y2 = state.drawingArrow.endY;
                            // 点到直线的垂直距离
                            const num = Math.abs((y2 - y1)*currentX - (x2 - x1)*currentY + x2*y1 - y2*x1);
                            const den = Math.hypot(y2 - y1, x2 - x1);
                            const distance = den === 0 ? 0 : num / den;
                            
                            state.drawingArrow.thickness = Math.max(6, distance * 2); 
                            state.drawingArrow.tempSvgLine.setAttribute("height", state.drawingArrow.thickness);
                            // 保持轴线绝对居中
                            state.drawingArrow.tempSvgLine.setAttribute("y", -state.drawingArrow.thickness / 2); 
                        }
                        return; // 🛑 独立闭环，拦截后续常规图形代码
                    }

                    // 🚀 【核心隔离区】：三段式自由跨行括号专属逻辑流
                    if (state.drawingArrow.type === 'free-parenthesis') {
                        const g = state.drawingArrow.tempSvgLine;
                        const leftP = g.querySelector('.fp-left');
                        const rightP = g.querySelector('.fp-right');
                        const baseL = g.querySelector('.fp-base');
                        const assistL = g.querySelector('.fp-assist');
                        
                        const dx = currentX - state.drawingArrow.startX;
                        const dy = currentY - state.drawingArrow.startY;

                        if (state.drawingArrow.phase === 1) {
                            // Phase 1: 确定方向轴
                            state.drawingArrow.endX = currentX;
                            state.drawingArrow.endY = currentY;
                            const angle = Math.atan2(dy, dx) * (180 / Math.PI);
                            const length = Math.hypot(dx, dy);
                            
                            g.setAttribute("transform", `translate(${state.drawingArrow.startX}, ${state.drawingArrow.startY}) rotate(${angle})`);
                            baseL.setAttribute("x2", length); baseL.setAttribute("y2", 0);
                        } 
                        else if (state.drawingArrow.phase === 2) {
                            // Phase 2: 确定高度 (点到直线距离)
                            const x1 = state.drawingArrow.startX, y1 = state.drawingArrow.startY;
                            const x2 = state.drawingArrow.endX, y2 = state.drawingArrow.endY;
                            const num = Math.abs((y2 - y1)*currentX - (x2 - x1)*currentY + x2*y1 - y2*x1);
                            const den = Math.hypot(y2 - y1, x2 - x1);
                            state.drawingArrow.thickness = Math.max(12, den === 0 ? 0 : num / den);
                            
                            const h = state.drawingArrow.thickness;
                            leftP.setAttribute("d", `M 6 0 Q -4 ${h/2} 6 ${h}`);
                            // 辅助线移到下方暗示行高
                            baseL.setAttribute("y1", h); baseL.setAttribute("y2", h);
                        } 
                        else if (state.drawingArrow.phase === 3) {
                            // Phase 3: 量子吸附与空间跃迁
                            const x1 = state.drawingArrow.startX, y1 = state.drawingArrow.startY;
                            const x2 = state.drawingArrow.endX, y2 = state.drawingArrow.endY;
                            const angleRad = Math.atan2(y2 - y1, x2 - x1);
                            
                            // 🚀 二维旋转矩阵：将鼠标全局坐标降维到局部坐标系！
                            const localX = dx * Math.cos(angleRad) + dy * Math.sin(angleRad);
                            const localY = -dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
                            
                            const h = state.drawingArrow.thickness;
                            // 阶梯函数量子化 Y 轴
                            let lineOffset = Math.round(localY / h);
                            
                            state.drawingArrow.finalLocalX = localX;
                            state.drawingArrow.finalLineOffset = lineOffset;
                            
                            const yOffset = lineOffset * h;
                            // 右括号：X轴平滑，Y轴跳跃
                            rightP.setAttribute("d", `M ${localX - 6} ${yOffset} Q ${localX + 4} ${yOffset + h/2} ${localX - 6} ${yOffset + h}`);
                            
                            // 视觉微弱连线指示跨行
                            assistL.setAttribute("x1", 6); assistL.setAttribute("y1", h/2);
                            assistL.setAttribute("x2", localX - 6); assistL.setAttribute("y2", yOffset + h/2);
                        }
                        return; // 🛑 独立闭环，拦截后续常规图形代码
                    }

                    state.drawingArrow.endX = currentX;
                    state.drawingArrow.endY = currentY;

                    if (state.drawingArrow.type === 'arrow' || state.drawingArrow.type === 'line') {
                        state.drawingArrow.tempSvgLine.setAttribute("x2", currentX);
                        state.drawingArrow.tempSvgLine.setAttribute("y2", currentY);
                    } else if (state.drawingArrow.type === 'rect') {
                        const minX = Math.min(state.drawingArrow.startX, currentX);
                        const minY = Math.min(state.drawingArrow.startY, currentY);
                        const w = Math.abs(currentX - state.drawingArrow.startX);
                        const h = Math.abs(currentY - state.drawingArrow.startY);
                        state.drawingArrow.tempSvgLine.setAttribute("x", minX);
                        state.drawingArrow.tempSvgLine.setAttribute("y", minY);
                        state.drawingArrow.tempSvgLine.setAttribute("width", w);
                        state.drawingArrow.tempSvgLine.setAttribute("height", h);
                    } else if (['implies', 'equivalence'].includes(state.drawingArrow.type)) {
                        state.drawingArrow.tempSvgLine.setAttribute("d", getImpliesPath(state.drawingArrow.startX, state.drawingArrow.startY, currentX, currentY, state.scale, state.drawingArrow.type === 'equivalence'));
                    } else {
                        state.drawingArrow.tempSvgLine.setAttribute("d", getBracePath(state.drawingArrow.startX, state.drawingArrow.startY, currentX, currentY));
                    }
                }
            }
             
            if (state.draggingBubble && state.draggingBubble.isPressed) {
                const { startX, startY, baseRx, baseRy, ax, ay, el, tail, wrapperW, wrapperH } = state.draggingBubble;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                
                // 拖动阈值判定
                if (!state.draggingBubble.isDragging && Math.hypot(dx, dy) > 5) {
                    state.draggingBubble.isDragging = true;
                    document.body.style.cursor = 'grabbing';
                    el.style.zIndex = 9999;
                }

                if (state.draggingBubble.isDragging) {
                    e.preventDefault();
                    // 转换出新的相对偏移量
                    const newRx = baseRx + (dx / wrapperW);
                    const newRy = baseRy + (dy / wrapperH);
                    
                    const newCx = (ax + newRx) * wrapperW;
                    const newCy = (ay + newRy) * wrapperH;
                    
                    el.style.left = `${newCx}px`;
                    el.style.top = `${newCy}px`;
                    
                    updateBubbleTail(tail, newCx, newCy, ax * wrapperW, ay * wrapperH, state.scale);
                    
                    state.draggingBubble.currentRx = newRx;
                    state.draggingBubble.currentRy = newRy;
                }
                return; 
            }

            if (state.draggingText.isPressed && draggingElement) {
                if (e.buttons !== 1) {
                    if (state.draggingText.isDragging) {
                        if (draggingElement.parentNode === document.body) draggingElement.remove();
                        refreshUI(); 
                    }
                    state.draggingText.isPressed = false;
                    state.draggingText.isDragging = false;
                    draggingElement = null;
                    document.body.style.cursor = '';
                    return;
                }

                const dx = e.clientX - state.draggingText.startX;
                const dy = e.clientY - state.draggingText.startY;
                const dist = Math.hypot(dx, dy);

                if (!state.draggingText.isDragging && dist > 10) {
                    state.draggingText.isDragging = true;
                    const rect = draggingElement.getBoundingClientRect();
                    draggingElement.style.position = 'fixed';
                    draggingElement.style.left = rect.left + 'px';
                    draggingElement.style.top = rect.top + 'px';
                    draggingElement.style.width = rect.width + 'px'; 
                    draggingElement.style.zIndex = 9999;
                    draggingElement.style.cursor = 'grabbing';
                    draggingElement.classList.add('dragging'); 
                    draggingElement.style.pointerEvents = 'none'; 
                    document.body.appendChild(draggingElement);
                }

                if (state.draggingText.isDragging) {
                    e.preventDefault();
                    draggingElement.style.left = (e.clientX - state.draggingText.offsetX) + 'px';
                    draggingElement.style.top = (e.clientY - state.draggingText.offsetY) + 'px';

                    const wrapper = document.getElementById(`page-wrapper-${state.draggingText.pageNum}`);
                    if (wrapper) {
                        const wrapperRect = wrapper.getBoundingClientRect();
                        if (e.clientX > wrapperRect.right - 20 && typeof toggleSidecar === 'function') {
                            toggleSidecar(true, true);
                        }
                    }
                }
             }
        });

        document.addEventListener('mouseup', (e) => {
            if (state.draggingBubble && state.draggingBubble.isPressed) {
                if (state.draggingBubble.isDragging) {
                    const { anno, pageNum, currentRx, currentRy } = state.draggingBubble;
                    performAction(() => {
                        const targetAnno = state.annotations[pageNum].find(a => a.id === anno.id);
                        if (targetAnno) {
                            targetAnno.bubbleOffset = { x: currentRx, y: currentRy };
                        }
                    });
                }
                state.draggingBubble = null;
                document.body.style.cursor = '';
                return;
            }

            if (state.draggingText.isPressed) {
                const { id, pageNum, offsetX, offsetY, isDragging } = state.draggingText;
                
                if (isDragging && draggingElement) {
                    draggingElement.style.display = 'none'; 
                    const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
                    draggingElement.style.display = 'block'; 
                    
                    const targetWrapper = elemBelow ? elemBelow.closest('.page-wrapper') : null;
                    
                    if (targetWrapper) {
                        const targetPageNum = parseInt(targetWrapper.dataset.pageNum);
                        const rect = targetWrapper.getBoundingClientRect();
                        
                        const absLeft = e.clientX - offsetX;
                        const absTop = e.clientY - offsetY;
                        
                        const newX = (absLeft - rect.left) / rect.width;
                        const newY = (absTop - rect.top) / rect.height;

                        performAction(() => {
                            const originalAnno = state.annotations[pageNum].find(a => a.id === id);
                            if (originalAnno) {
                                originalAnno.x = newX;
                                originalAnno.y = newY;
                                if (targetPageNum !== pageNum) {
                                    state.annotations[pageNum] = state.annotations[pageNum].filter(a => a.id !== id);
                                    if (!state.annotations[targetPageNum]) state.annotations[targetPageNum] = [];
                                    state.annotations[targetPageNum].push(originalAnno);
                                    
                                    if (state.isEditingNote && state.activeAnnotationId === id) {
                                        state.activePageNum = targetPageNum;
                                    }
                                }
                            }
                        });
                    } else {
                        refreshUI(); 
                    }
                } 
                
                if (draggingElement && draggingElement.parentNode === document.body) {
                    draggingElement.remove(); 
                }
                state.draggingText.isPressed = false;
                state.draggingText.isDragging = false;
                draggingElement = null;
                document.body.style.cursor = '';
                return;
            }

            // 🚀 【绘图松手核心处理】
            if (['arrow', 'brace', 'line', 'rect', 'implies', 'equivalence', 'highlight-block', 'free-parenthesis'].includes(state.currentTool) && state.drawingArrow.isDrawing) {
                
                // 🛑 拦截 1：阶段一向阶段二跃迁时的安全断口
                if ((state.drawingArrow.type === 'highlight-block' || state.drawingArrow.type === 'free-parenthesis') && state.drawingArrow.phase === 1) {
                    const rect = state.drawingArrow.pageWrapper.getBoundingClientRect();
                    const endX = state.drawingArrow.endX !== undefined ? state.drawingArrow.endX : e.clientX - rect.left;
                    const endY = state.drawingArrow.endY !== undefined ? state.drawingArrow.endY : e.clientY - rect.top;
                    
                    // 防误触：如果原地点击，直接退出
                    if (Math.hypot(endX - state.drawingArrow.startX, endY - state.drawingArrow.startY) < 5) {
                        document.getElementById('temp-drawing-svg')?.remove();
                        state.drawingArrow.isDrawing = false;
                    } else {
                        // 🚀 跃迁至阶段二
                        state.drawingArrow.phase = 2; 
                        // 自由括号的默认厚度（行高）可以稍微设大一点，高亮块较小
                        state.drawingArrow.thickness = state.drawingArrow.type === 'free-parenthesis' ? 24 : 10; 
                    }
                    return; // 强制拦截！不能走到下面的保存逻辑中去
                }

                // 🛑 拦截 2：防止事件穿透！(解决你括号消失的关键)
                // 如果多阶段工具处于阶段 2 或 3，松开鼠标时绝对什么都不做！
                // 因为阶段 2 和 3 的跃迁是由按下(mousedown)触发的，不能让随后的松开(mouseup)去销毁图形！
                if ((state.drawingArrow.type === 'highlight-block' || state.drawingArrow.type === 'free-parenthesis') && state.drawingArrow.phase > 1) {
                    return; 
                }

                // --- 只有常规的【单阶段图形】(如直线、普通矩形) 才会走到下面瞬间定型保存 ---
                const rect = state.drawingArrow.pageWrapper.getBoundingClientRect();
                const endX = state.drawingArrow.endX !== undefined ? state.drawingArrow.endX : e.clientX - rect.left;
                const endY = state.drawingArrow.endY !== undefined ? state.drawingArrow.endY : e.clientY - rect.top;
                document.getElementById('temp-drawing-svg')?.remove();

                if (Math.hypot(endX - state.drawingArrow.startX, endY - state.drawingArrow.startY) > 5) {
                    
                    let textLabel = '[标注]';
                    if (state.drawingArrow.type === 'arrow') textLabel = '[箭头]';
                    if (state.drawingArrow.type === 'implies') textLabel = '[推出箭头]';
                    if (state.drawingArrow.type === 'equivalence') textLabel = '[等价箭头]';
                    if (state.drawingArrow.type === 'brace') textLabel = '[大括号]';
                    if (state.drawingArrow.type === 'line') textLabel = '[直线]';
                    if (state.drawingArrow.type === 'rect') textLabel = '[矩形框]';

                    performAction(() => {
                        addAnnotation(state.drawingArrow.pageNum, {
                            id: Date.now().toString(),
                            type: state.drawingArrow.type,
                            color: state.currentColor,
                            start: { x: state.drawingArrow.startX / rect.width, y: state.drawingArrow.startY / rect.height },
                            end: { x: endX / rect.width, y: endY / rect.height },
                            note: '', text: textLabel, timestamp: new Date().toLocaleString()
                        });
                    });
                }
                
                // 只有常规图形才会在这里结束生命周期
                state.drawingArrow.isDrawing = false;
                state.drawingArrow.pageWrapper = null;
                state.drawingArrow.endX = undefined;
                state.drawingArrow.endY = undefined;
                return;
            }

            // ... 以下的点击生成文本/图章/选中高亮 逻辑保持不变 ...
            if (state.currentTool === 'text') {
                const wrapper = e.target.closest('.page-wrapper');
                if (!wrapper) return;
                
                if (e.target.closest('.annotation-layer') && !e.target.classList.contains('annotation-layer')) return;

                const rect = wrapper.getBoundingClientRect();
        const currentScale = state.scale;
        const starBaseSize = 24 * currentScale; // 星星的基础物理像素大小
        
        // 减去半个星星的尺寸，让点击位置正好在星星中央
        const x = (e.clientX - rect.left - starBaseSize/2) / rect.width;
        const y = (e.clientY - rect.top - starBaseSize/2) / rect.height;

                performAction(() => {
                    addAnnotation(parseInt(wrapper.dataset.pageNum), {
                        id: Date.now().toString(),
                        type: 'text',
                        color: state.currentColor,
                        x: x, y: y,
                        text: '点击编辑文本', 
                        timestamp: new Date().toLocaleString()
                    });
                });
                
                state.currentTool = 'cursor';
                updateToolButtons();
                return;
            }

            if (MARKER_CONFIG[state.currentTool]) {
                const wrapper = e.target.closest('.page-wrapper');
                if (!wrapper) return;
                if (e.target.closest('.annotation-layer') && !e.target.classList.contains('annotation-layer')) return;

                const conf = MARKER_CONFIG[state.currentTool];
                // 动态读取字典中的专属默认尺寸
                const MARKER_SIZE = conf.defaultSize; 
                const rect = wrapper.getBoundingClientRect();
                const actualPixelSize = MARKER_SIZE * state.scale; 
                
                const x = (e.clientX - rect.left - actualPixelSize / 2) / rect.width;
                const y = (e.clientY - rect.top - actualPixelSize / 2) / rect.height;
                
                performAction(() => {
                    addAnnotation(parseInt(wrapper.dataset.pageNum), {
                        id: Date.now().toString(),
                        type: state.currentTool,
                        // 📌 颜色跟随取色器：选中图章时已自动同步为该图章默认色，用户可随时自选
                        color: state.currentColor, 
                        x: x, y: y,
                        size: MARKER_SIZE, 
                        note: '', text: conf.label, timestamp: new Date().toLocaleString()
                    });
                });
                
                state.currentTool = 'cursor';
                updateToolButtons();
                return;
            }

            if (['highlight', 'underline', 'parenthesis'].includes(state.currentTool)) {
                const selection = window.getSelection();
                if (selection.isCollapsed) return;
                const wrapper = selection.anchorNode.parentElement?.closest('.page-wrapper');
                if (!wrapper) return;
                createAnnotationFromSelection(selection, parseInt(wrapper.dataset.pageNum), wrapper);
                selection.removeAllRanges();
            }
        });

        const originalRenderAnnotations = renderAnnotations;

        function createAnnotationFromSelection(selection, pageNum, wrapperElement) {
            const rawRects = Array.from(selection.getRangeAt(0).getClientRects());
            const wrapperRect = wrapperElement.getBoundingClientRect();
            const filteredRects = rawRects.filter(r => r.width > 1 && r.height > 1);
            if (filteredRects.length === 0) return;

            filteredRects.sort((a, b) => a.top - b.top);
            
            const mergedLines = [];
            let currentLine = null;

            const isSameLine = (rect1, rect2) => {
                const overlapY = Math.min(rect1.bottom, rect2.bottom) - Math.max(rect1.top, rect2.top);
                if (overlapY <= 0) return false;
                const h1 = rect1.bottom - rect1.top;
                const h2 = rect2.bottom - rect2.top;
                return overlapY > Math.min(h1, h2) * 0.4;
            };

            filteredRects.forEach(rect => {
                if (!currentLine) {
                    currentLine = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
                    return;
                }
                if (isSameLine(currentLine, rect)) {
                    currentLine.top = Math.min(currentLine.top, rect.top);
                    currentLine.bottom = Math.max(currentLine.bottom, rect.bottom);
                    currentLine.left = Math.min(currentLine.left, rect.left);
                    currentLine.right = Math.max(currentLine.right, rect.right);
                } else {
                    mergedLines.push(currentLine);
                    currentLine = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
                }
            });
            if (currentLine) mergedLines.push(currentLine);

            const rectsData = mergedLines.map(r => {
                const paddingX = 2;
                const relativeX = (r.left - wrapperRect.left - paddingX) / wrapperRect.width;
                const relativeY = (r.top - wrapperRect.top) / wrapperRect.height;
                const relativeW = (r.right - r.left + (paddingX * 2)) / wrapperRect.width;
                const relativeH = (r.bottom - r.top) / wrapperRect.height;
                return { x: relativeX, y: relativeY, w: relativeW, h: relativeH };
            });

            const text = selection.toString().trim().substring(0, 30) + '...';
            performAction(() => {
                addAnnotation(pageNum, {
                    id: Date.now().toString(),
                    type: state.currentTool,
                    color: state.currentColor,
                    rects: rectsData,
                    note: '', text, timestamp: new Date().toLocaleString()
                });
            });
        }

        function addAnnotation(pageNum, anno) {
            if (!state.annotations[pageNum]) state.annotations[pageNum] = [];
            state.annotations[pageNum].push(anno);
        }

        function clearPageAnnotations(pageNum) {
            if (!state.annotations[pageNum] || state.annotations[pageNum].length === 0) return;
            if (confirm(`确定要清除第 ${pageNum} 页的所有批注吗？`)) {
                performAction(() => { state.annotations[pageNum] = []; });
            }
        }

        function updateToolButtons() {
            if (['arrow', 'line', 'rect', 'brace', 'implies', 'equivalence', 'highlight-block', 'free-parenthesis'].includes(state.currentTool)) {
                els.container.classList.add('cursor-crosshair');
            } else {
                els.container.classList.remove('cursor-crosshair');
            }

            els.toolBtns.forEach(btn => {
                const tool = btn.dataset.tool;
                btn.style.color = ''; // 清掉图章按钮的内联颜色，由下方逻辑重新决定
                
                // 这样绝对不会再发生紫色和蓝色同时存在互相打架的情况
                btn.classList.remove(
                    'active', 'bg-blue-50', 'bg-yellow-50', 'bg-red-50', 'bg-purple-50', 'bg-orange-50', 'bg-gray-100', 
                    'text-blue-600', 'text-blue-500', 'text-yellow-600', 'text-red-600', 'text-red-500', 'text-purple-600', 'text-orange-500', 'text-gray-950', 
                    'border-blue-200', 'border-yellow-200', 'border-red-200', 'border-purple-200', 'border-orange-200', 'border-gray-300','bg-gray-100', 'text-gray-800', 'border-gray-300',
                    'border-transparent', 'text-gray-500' // 把未选中的灰底也扒掉
                );

                const isActive = 
                    (tool === state.currentTool) || 
                    (tool === 'underline' && state.currentTool === 'line') ||
                    (tool === 'arrow' && ['implies', 'equivalence'].includes(state.currentTool)) ||
                    (tool === 'parenthesis' && state.currentTool === 'rect') ||
                    (tool === 'parenthesis' && state.currentTool === 'free-parenthesis') ||
                    (tool === 'highlight' && state.currentTool === 'highlight-block') || 
                    (MARKER_CONFIG[tool] && MARKER_CONFIG[state.currentTool]); 

                if (isActive) {
                    // --- 独立工具高亮 ---
                    if(tool === 'highlight') {
                        if (state.currentTool === 'highlight') {
                            btn.classList.add('active', 'bg-yellow-50', 'text-yellow-600', 'border-yellow-200');
                            btn.title = "文本高亮 (再点切换为自由高亮块)";
                            btn.innerHTML = `<i class="ph ph-highlighter text-[22px]"></i>`;
                        } else if (state.currentTool === 'highlight-block') {
                            btn.classList.add('active', 'bg-gray-100', 'text-gray-800', 'border-gray-300');
                            btn.title = "自由高亮块 (再点关闭)";
                            // 使用加粗线段代表宽体高亮块
                            btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-[22px] h-[22px]" stroke="currentColor" stroke-width="7" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
                        }
                    }
                    if(tool === 'brace') btn.classList.add('active', 'bg-orange-50', 'text-orange-500', 'border-orange-200');
                    if(tool === 'text') btn.classList.add('active', 'bg-gray-100', 'text-gray-950', 'border-gray-300'); 

                    // --- 下划线 / 直线 ---
                    if(tool === 'underline') {
                        if (state.currentTool === 'underline') {
                            btn.classList.add('active', 'bg-red-50', 'text-red-600', 'border-red-200');
                            btn.title = "文本下划线 (再点切换为任意直线)";
                            btn.innerHTML = `<i class="ph ph-text-underline text-[22px]"></i>`;
                        } else if (state.currentTool === 'line') {
                            btn.classList.add('active', 'bg-gray-100', 'text-gray-800', 'border-gray-300');
                            btn.title = "任意直线 (再点关闭)";
                            btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-[22px] h-[22px]" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="20" x2="20" y2="4"/></svg>`;
                        }
                    }

                    // --- 括号 / 矩形框 / 自由括号 ---
                    if(tool === 'parenthesis') {
                        if (state.currentTool === 'parenthesis') {
                            btn.classList.add('active', 'bg-purple-50', 'text-purple-600', 'border-purple-200');
                            btn.title = "括号标注 (再点切换为矩形框)";
                            btn.innerHTML = `<i class="ph ph-brackets-round text-[22px]"></i>`;
                        } else if (state.currentTool === 'rect') {
                            btn.classList.add('active', 'bg-gray-100', 'text-gray-800', 'border-gray-300');
                            btn.title = "矩形框 (再点切换为自由括号)";
                            btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-[22px] h-[22px]" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/></svg>`;
                        } else if (state.currentTool === 'free-parenthesis') {
                            btn.classList.add('active', 'bg-gray-100', 'text-gray-800', 'border-gray-300');
                            btn.title = "自由跨行括号 (再点关闭)";
                            // 使用带有错位的左右括号图标暗示跨行功能
                            btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-[22px] h-[22px]" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><path d="M 9 4 Q 4 12 9 20 M 15 8 Q 20 16 15 24"/></svg>`;
                        }
                    }

                    // --- 普通箭头 / 推出箭头 / 等价箭头 ---
                    if(tool === 'arrow') {
                        if (state.currentTool === 'arrow') {
                            btn.classList.add('active', 'bg-blue-50', 'text-blue-600', 'border-blue-200');
                            btn.title = "单线箭头 (再点切换为双线推出箭头)";
                            btn.innerHTML = `<i class="ph ph-arrow-up-right text-[22px]"></i>`;
                        } else if (state.currentTool === 'implies') {
                            btn.classList.add('active', 'bg-gray-100', 'text-gray-800', 'border-gray-300');
                            btn.title = "双线推出箭头 (再点切换为等价箭头)";
                            btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-[22px] h-[22px]" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"><line x1="4" y1="10" x2="15" y2="10"/><line x1="4" y1="14" x2="15" y2="14"/><polyline points="11,5 20,12 11,19"/></svg>`;
                        }
                    }

                    // 等价箭头沿用推出箭头的图标尺寸。
                    if (tool === 'arrow' && state.currentTool === 'equivalence') {
                        btn.classList.add('active', 'bg-gray-100', 'text-gray-800', 'border-gray-300');
                        btn.title = "等价箭头 (再点关闭)";
                        btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-[22px] h-[22px]" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"><path d="M 7 10 H 17 M 7 14 H 17 M 9 5 L 2 12 L 9 19 M 15 5 L 22 12 L 15 19"/></svg>`;
                    }

                    // --- 标记集合引擎 ---
                    if(MARKER_CONFIG[tool]) {
                        if (MARKER_CONFIG[state.currentTool]) {
                            const conf = MARKER_CONFIG[state.currentTool];
                            // 激活态图标实时预览当前所选颜色（未自选时 = 该图章默认色）
                            btn.classList.add('active', 'bg-gray-50', 'border-gray-300');
                            btn.style.color = state.currentColor;
                            btn.title = `放置${conf.label} (悬停选择更多)`;
                            
                            let sizeClass = "w-[22px] h-[22px]"; // 默认大小
                            if (state.currentTool === 'asterisk') sizeClass = "w-[18px] h-[18px]"; // 蓝*变小
                            if (state.currentTool === 'exclamation' || state.currentTool === 'question') sizeClass = "w-[26px] h-[26px]"; // ！和？变大
                            
                            btn.innerHTML = getMarkerSvg(state.currentTool, sizeClass);
                        }
                    }

                } else {
                    if(tool === 'highlight') {
                        btn.title = "高亮 (点击切换 文本/自由块)";
                        btn.innerHTML = `<i class="ph ph-highlighter text-[22px]"></i>`;
                    }
                    if(tool === 'arrow') {
                        btn.title = "绘制箭头 (点击切换 普通/推出/等价)";
                        btn.innerHTML = `<i class="ph ph-arrow-up-right text-[22px]"></i>`;
                    }
                    if(MARKER_CONFIG[tool]) {
                        const conf = MARKER_CONFIG[tool];
                        btn.title = `放置${conf.label} (悬停选择更多)`;
                        
                        let sizeClass = "w-[22px] h-[22px]";
                        if (tool === 'asterisk') sizeClass = "w-[18px] h-[18px]"; 
                        if (tool === 'exclamation' || tool === 'question') sizeClass = "w-[26px] h-[26px]"; 
                        
                        btn.innerHTML = getMarkerSvg(tool, sizeClass);
                    }
                    if(tool === 'underline') {
                        btn.title = "下划线 (点击切换 下划线/直线)";
                        btn.innerHTML = `<i class="ph ph-text-underline text-[22px]"></i>`;
                    }
                    if(tool === 'parenthesis') {
                        btn.title = "括号标注 (点击切换 括号/矩形框)";
                        btn.innerHTML = `<i class="ph ph-brackets-round text-[22px]"></i>`;
                    }
                    
                    // 重新挂上灰色的未选中状态
                    btn.classList.add('border-transparent', 'text-gray-500');
                }
            });
        }

        const TOOL_COLORS = {
            'highlight': '#fde047', 'highlight-block': '#fde047', 'underline': '#f87171', 'line': '#f87171', 'parenthesis': '#f87171', 'free-parenthesis': '#f87171',
            'rect': '#f87171', 'brace': '#f87171', 'arrow': '#f87171', 'implies': '#f87171', 'equivalence': '#f87171', 'text': '#000000',
            'star': '#ef4444', 'asterisk': '#3b82f6', 'exclamation': '#ef4444', 
            'question': '#ef4444', 'check': '#ef4444', 'cross': '#ef4444',
            'triangle': '#ef4444', 'exText': '#ef4444' 
        };

        els.toolBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                
                if (MARKER_CONFIG[tool]) {
                    state.currentTool = (state.currentTool === tool) ? 'cursor' : tool;
                }
                else if (tool === 'highlight') {
                    if (state.currentTool === 'highlight') state.currentTool = 'highlight-block';
                    else if (state.currentTool === 'highlight-block') state.currentTool = 'cursor';
                    else state.currentTool = 'highlight';
                }
                else if (tool === 'arrow') {
                    if (state.currentTool === 'arrow') state.currentTool = 'implies';
                    else if (state.currentTool === 'implies') state.currentTool = 'equivalence';
                    else if (state.currentTool === 'equivalence') state.currentTool = 'cursor';
                    else state.currentTool = 'arrow';
                }
                else if (tool === 'underline') {
                    if (state.currentTool === 'underline') state.currentTool = 'line';
                    else if (state.currentTool === 'line') state.currentTool = 'cursor';
                    else state.currentTool = 'underline';
                }
                else if (tool === 'parenthesis') {
                    if (state.currentTool === 'parenthesis') state.currentTool = 'rect';
                    else if (state.currentTool === 'rect') state.currentTool = 'free-parenthesis';
                    else if (state.currentTool === 'free-parenthesis') state.currentTool = 'cursor';
                    else state.currentTool = 'parenthesis';
                }
                else {
                    state.currentTool = (state.currentTool === tool) ? 'cursor' : tool;
                }

                if (state.currentTool !== 'cursor' && TOOL_COLORS[state.currentTool]) {
                    updateColorSelection(TOOL_COLORS[state.currentTool]);
                }
                updateToolButtons();
                
                if (state.currentTool !== 'cursor' && !state.showAnnotations) {
                    els.toggleVisBtn.click();
                }
            });
        });

        document.querySelectorAll('.marker-select-btn').forEach(selectBtn => {
            selectBtn.addEventListener('click', (e) => {
                e.stopPropagation(); 
                const selectedType = selectBtn.dataset.type;
                
                state.currentTool = selectedType;
                // 巧妙替换主按钮的灵魂，使其动态变为刚选中的工具
                document.getElementById('active-marker-btn').dataset.tool = selectedType;
                
                updateColorSelection(MARKER_CONFIG[selectedType].color);
                updateToolButtons();
            });
        });

        const updateColorSelection = (color) => {
            state.currentColor = color;
            els.colorBtns.forEach(btn => {
                if (btn.dataset.color === color) btn.classList.add('selected');
                else btn.classList.remove('selected');
            });
            if (![...els.colorBtns].some(b => b.dataset.color === color)) els.customColorInput.value = color;
            // 图章工具激活时，让工具栏主按钮图标实时预览所选颜色
            if (state.currentTool && MARKER_CONFIG[state.currentTool]) {
                updateToolButtons();
            }
        };

        els.colorBtns.forEach(btn => btn.addEventListener('click', () => updateColorSelection(btn.dataset.color)));
        els.customColorInput.addEventListener('input', (e) => {
            els.colorBtns.forEach(btn => btn.classList.remove('selected'));
            state.currentColor = e.target.value;
            // 自定义取色时同样实时刷新图章按钮预览
            if (state.currentTool && MARKER_CONFIG[state.currentTool]) {
                updateToolButtons();
            }
        });
        
        document.getElementById('zoom-in').addEventListener('click', () => changeZoom(0.2));
        document.getElementById('zoom-out').addEventListener('click', () => changeZoom(-0.2));
        const sliderWrapper = document.getElementById('zoom-slider-wrapper');
        const sliderTrack = document.getElementById('zoom-slider-track');
        const sliderThumb = document.getElementById('zoom-slider-thumb');
        let isSliderDragging = false;

        // 根据 scale 计算滑块的物理 top 百分比 (3.0在0%，1.0在100%)
        function updateSliderUI(scale, animate = true) {
            if (!sliderThumb) return;
            if (animate) sliderThumb.classList.add('transition-all', 'duration-200');
            else sliderThumb.classList.remove('transition-all', 'duration-200');
            
            let clampedScale = Math.min(Math.max(scale, 1.0), 3.0);
            let ratio = (3.0 - clampedScale) / 2.0; // 转换为 0.0 到 1.0
            sliderThumb.style.top = `${ratio * 100}%`;
        }

        // 拖动中：关闭动画，实时跟手
        const handleSliderMove = (e) => {
            if (!isSliderDragging) return;
            const rect = sliderTrack.getBoundingClientRect();
            let ratio = (e.clientY - rect.top) / rect.height;
            if (ratio < 0) ratio = 0;
            if (ratio > 1) ratio = 1;
            
            sliderThumb.classList.remove('transition-all', 'duration-200');
            sliderThumb.style.top = `${ratio * 100}%`;
        };

        // 松手时：计算就近点并吸附
        const handleSliderEnd = (e) => {
            if (!isSliderDragging) return;
            isSliderDragging = false;
            document.removeEventListener('mousemove', handleSliderMove);
            document.removeEventListener('mouseup', handleSliderEnd);
            
            const rect = sliderTrack.getBoundingClientRect();
            let ratio = (e.clientY - rect.top) / rect.height;
            
            // 磁性吸附逻辑：根据松手位置划分为 3 个区间
            if (ratio < 0.25) ratio = 0;       // 靠上吸附 -> 300%
            else if (ratio > 0.75) ratio = 1;  // 靠下吸附 -> 100%
            else ratio = 0.5;                  // 居中吸附 -> 200%

            const targetScale = 3.0 - (ratio * 2.0);
            updateZoom(targetScale); // 触发全局缩放，updateZoom内部会重新绑定动画
        };

        // 鼠标按下触发
        sliderWrapper.addEventListener('mousedown', (e) => {
            if(e.button !== 0) return; // 只响应左键
            e.preventDefault();
            isSliderDragging = true;
            document.addEventListener('mousemove', handleSliderMove);
            document.addEventListener('mouseup', handleSliderEnd);
            handleSliderMove(e); // 让滑块瞬间跳到点击位置
        });

        // =========================================================================
        // 🚀 核心视界侦测引擎 (Viewport Radar Engine)
        // =========================================================================
        let scrollRadarFrameId = null;

        function updateHUDAndOutline() {
            if (state.pageDimensions.length === 0 || !state.pdfDoc) return;

            const container = els.container;
            const viewportHeight = container.clientHeight;
            const centerY = container.scrollTop + (viewportHeight / 2);
            const pageMargin = 24; 

            let accumulatedHeight = 0;
            let currentPhysicalPage = 1;

            // 1. O(N) 极速高度累加定位（数组通常小于万级，耗时 < 0.1ms）
            for (let i = 0; i < state.pageDimensions.length; i++) {
                const currentPageHeight = (state.pageDimensions[i].height * state.scale) + pageMargin;
                if (accumulatedHeight + currentPageHeight >= centerY) {
                    currentPhysicalPage = i + 1;
                    break;
                }
                accumulatedHeight += currentPageHeight;
            }

            if (currentPhysicalPage !== state.currentPhysicalPage) {
                state.currentPhysicalPage = currentPhysicalPage;

                // 2. 更新 HUD UI
                let logicalPage = currentPhysicalPage - state.pageOffset;
                // 如果逻辑页码 <= 0，显示物理罗马数字或者干脆显示负数。这里简单处理为：如果偏移前，加前缀
                els.hudCurrent.textContent = logicalPage > 0 ? logicalPage : `前 ${Math.abs(logicalPage - 1)}`;
                
                const physicalTotal = state.pdfDoc.numPages;
                if (state.pageOffset > 0) {
                    els.hudTotal.textContent = physicalTotal - state.pageOffset;
                    els.hudPhysicalNumber.textContent = physicalTotal;
                    els.hudPhysicalTotal.classList.remove('hidden');
                } else {
                    els.hudTotal.textContent = physicalTotal;
                    els.hudPhysicalTotal.classList.add('hidden');
                }

                // 3. O(logN) 目录精准高亮逻辑
                if (state.outlineMap.length > 0) {
                    // 先移除旧高亮
                    document.querySelectorAll('.outline-item.active-outline').forEach(el => el.classList.remove('active-outline'));
                    
                    // 寻找 <= 当前物理页码的最后一个目录节点
                    // （因为如果是同页的父子目录，子目录排在后面，恰好被选中，实现完美的多级穿透！）
                    let activeItem = null;
                    for (let i = state.outlineMap.length - 1; i >= 0; i--) {
                        if (state.outlineMap[i].pageNum <= currentPhysicalPage) {
                            activeItem = state.outlineMap[i].element;
                            break;
                        }
                    }
                    
                    // 挂载高亮并智能滚动目录面板
                    if (activeItem) {
                        activeItem.classList.add('active-outline');
                        // 当目录面板打开时，如果目标不在视野内，静默将其滚动到可视区
                        if (state.isOutlineOpen) {
                            activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    }
                }
            }
        }

        // 绑定容器的 Scroll 事件（使用 rAF 节流，保证绝对 60fps 不掉帧）
        els.container.addEventListener('scroll', () => {
            if (scrollRadarFrameId) cancelAnimationFrame(scrollRadarFrameId);
            scrollRadarFrameId = requestAnimationFrame(updateHUDAndOutline);
        }, { passive: true });

        // HUD 偏移控制逻辑
        els.setOffsetBtn.addEventListener('click', () => {
            state.pageOffset = state.currentPhysicalPage - 1; // 设当前页为 1
            // 丝滑切换按钮
            els.setOffsetBtn.classList.add('hidden');
            els.setOffsetBtn.classList.remove('flex');
            els.resetOffsetBtn.classList.remove('hidden');
            els.resetOffsetBtn.classList.add('flex');
            
            state.currentPhysicalPage = -1; // 强制打断缓存，触发下一帧的数值刷新
            updateHUDAndOutline();

            if (!state.annotations['settings']) state.annotations['settings'] = {};
            state.annotations['settings'].pageOffset = state.pageOffset;
            saveAnnotationsToStorage();
            updateSaveStatus(true);
        });

        els.resetOffsetBtn.addEventListener('click', () => {
            state.pageOffset = 0;
            // 丝滑切换按钮
            els.resetOffsetBtn.classList.add('hidden');
            els.resetOffsetBtn.classList.remove('flex');
            els.setOffsetBtn.classList.remove('hidden');
            els.setOffsetBtn.classList.add('flex');
            
            state.currentPhysicalPage = -1; 
            updateHUDAndOutline();

            if (!state.annotations['settings']) state.annotations['settings'] = {};
            state.annotations['settings'].pageOffset = 0;
            saveAnnotationsToStorage();
            updateSaveStatus(true);
        });

        function updateZoom(newScale) {
            if (newScale > 5.0) newScale = 5.0; 
            if (newScale < 0.5) newScale = 0.5;
            if (state.scale === newScale) return; 

            if (state.isEditingNote) {
                document.getElementById('save-note-btn').click();
            }

            state.isZooming = true;
            clearTimeout(state.zoomEndTimer);
            state.zoomEndTimer = setTimeout(() => { state.isZooming = false; }, 300);

            const container = els.container;
            const viewportHeight = container.clientHeight;
            
            const centerY = container.scrollTop + (viewportHeight / 2);
            const pageMargin = 24; 
            let accumulatedHeight = 0;
            let centerPageNum = 1;
            let pageTopY = 0;
            let currentPageHeight = 0;

            // 1. 缩放前：算出屏幕正中央停留在哪一页，以及在该页的相对位置 (%)
            if (state.pageDimensions.length > 0) {
                for (let i = 0; i < state.pageDimensions.length; i++) {
                    currentPageHeight = (state.pageDimensions[i].height * state.scale) + pageMargin;
                    if (accumulatedHeight + currentPageHeight >= centerY) {
                        centerPageNum = i + 1;
                        pageTopY = accumulatedHeight;
                        break;
                    }
                    accumulatedHeight += currentPageHeight;
                }
            }
            const centerRatioY = currentPageHeight === 0 ? 0 : (centerY - pageTopY) / currentPageHeight;

            state.scale = newScale;
            els.zoomLevel.textContent = Math.round(state.scale * 100) + '%';
            if (typeof updateSliderUI === 'function') updateSliderUI(state.scale);

            // 只更新 DOM 骨架尺寸
            generatePageSkeletons();
            
            // 2. 缩放后：利用缩放后的新尺寸，将屏幕正中央完美还原
            if (state.pageDimensions.length > 0) {
                let newTargetPageTopY = 0;
                for (let i = 0; i < centerPageNum - 1; i++) {
                    newTargetPageTopY += (state.pageDimensions[i].height * state.scale) + pageMargin;
                }
                const newCurrentPageHeight = (state.pageDimensions[centerPageNum - 1].height * state.scale) + pageMargin;
                const newCenterY = newTargetPageTopY + (newCurrentPageHeight * centerRatioY);
                
                // 瞬间物理死锁还原滚动条！
                container.scrollTop = newCenterY - (viewportHeight / 2);
            }

            // 3. 计算视野内需要渲染的页码
            const viewTop = container.scrollTop;
            const viewBottom = container.scrollTop + viewportHeight;
            
            accumulatedHeight = 0;
            let startPage = 1;
            let endPage = state.pdfDoc.numPages;
            let foundStart = false;

            // 遍历每一页的高度，精准定位当前视口覆盖的页码范围
            for (let i = 0; i < state.pageDimensions.length; i++) {
                const currentH = (state.pageDimensions[i].height * state.scale) + pageMargin;
                accumulatedHeight += currentH;

                // 找到视口上方扩容 4 页的起点
                if (!foundStart && accumulatedHeight >= viewTop - (currentH * 4)) {
                    startPage = Math.max(1, i + 1);
                    foundStart = true;
                }
                // 找到视口下方扩容 4 页的终点
                if (accumulatedHeight >= viewBottom + (currentH * 4)) {
                    endPage = Math.min(state.pdfDoc.numPages, i + 1);
                    break;
                }
            }

            const visiblePages = new Set();
            for (let i = startPage; i <= endPage; i++) visiblePages.add(i);

            // 清空底层图像渲染状态，等待 observer 触发高清画布重绘
            state.pagesRendered.clear();

            // 瞬间重绘视野内的批注，让批注死死咬住页面，绝不闪烁！
            visiblePages.forEach(pageNum => {
                renderAnnotations(pageNum);
            });

            // 销毁视野外的批注，释放 400 页带来的沉重 DOM 内存
            for (let i = 1; i <= state.pdfDoc.numPages; i++) {
                if (!visiblePages.has(i)) {
                    const annoLayer = document.getElementById(`annotation-layer-${i}`);
                    if (annoLayer && annoLayer.innerHTML !== '') annoLayer.innerHTML = '';
                }
            }

            clearTimeout(zoomRenderTimer);
            zoomRenderTimer = setTimeout(() => {
                const wrappers = els.pagesContainer.children;
                for (let i = 0; i < wrappers.length; i++) {
                    observer.unobserve(wrappers[i]);
                    observer.observe(wrappers[i]);
                }
            }, 100);
        }

        function changeZoom(delta) { updateZoom(state.scale + delta); }

